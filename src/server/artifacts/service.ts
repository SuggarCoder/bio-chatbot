import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { and, eq, isNull } from 'drizzle-orm'

import { enqueueBackgroundJob } from '../backgroundJobs.js'
import type { Database } from '../db.js'
import { artifacts, artifactVersions } from '../db/schema.js'
import type { ObjectStore } from '../storage/objectStore.js'
import type { ArtifactProtocolMetadata } from './protocol.js'
import {
  ArtifactCommitError,
  findArtifactTarget,
  getArtifactVersionForUser,
  type PreparedArtifactVersion,
} from './repository.js'

export class ArtifactServiceError extends Error {
  constructor(
    readonly code:
      | 'ARTIFACT_ALREADY_EXISTS'
      | 'ARTIFACT_NOT_FOUND'
      | 'ARTIFACT_VERSION_CONFLICT'
      | 'ARTIFACT_STORAGE_FAILED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ArtifactServiceError'
  }
}

export type CompletedArtifactDraft = {
  streamArtifactId: string
  metadata: ArtifactProtocolMetadata
  content: string
  byteLength: number
  sha256: string
}

export class ArtifactService {
  constructor(
    private readonly database: Database,
    private readonly objectStore: ObjectStore,
  ) {}

  async prepare(
    userId: string,
    chatId: string,
    draft: CompletedArtifactDraft,
    signal?: AbortSignal,
  ): Promise<PreparedArtifactVersion> {
    const current = await findArtifactTarget(
      this.database,
      userId,
      chatId,
      draft.metadata.id,
    )
    let artifactId: string
    let version: number
    let parentVersion: number | null

    if (draft.metadata.op === 'create') {
      if (current) {
        throw new ArtifactServiceError(
          'ARTIFACT_ALREADY_EXISTS',
          `Artifact ${draft.metadata.id} already exists in this conversation.`,
        )
      }
      artifactId = randomUUID()
      version = 1
      parentVersion = null
    } else {
      if (!current) {
        throw new ArtifactServiceError(
          'ARTIFACT_NOT_FOUND',
          `Artifact ${draft.metadata.id} does not exist in this conversation.`,
        )
      }
      if (current.currentVersion !== draft.metadata.base_version) {
        throw new ArtifactServiceError(
          'ARTIFACT_VERSION_CONFLICT',
          `Artifact ${draft.metadata.id} is now version ${current.currentVersion}.`,
        )
      }
      artifactId = current.id
      version = current.currentVersion + 1
      parentVersion = current.currentVersion
    }

    const storageKey = [
      'artifacts',
      userId,
      chatId,
      artifactId,
      'versions',
      String(version),
      `${draft.streamArtifactId}-${draft.sha256}`,
    ].join('/')

    try {
      const stored = await this.objectStore.putStream({
        key: storageKey,
        body: Readable.from([Buffer.from(draft.content, 'utf8')]),
        contentType: draft.metadata.type,
        contentLength: draft.byteLength,
        metadata: {
          sha256: draft.sha256,
          artifactid: artifactId,
          version: String(version),
        },
        signal,
      })

      if (
        stored.sha256 !== draft.sha256 ||
        stored.sizeBytes !== BigInt(draft.byteLength)
      ) {
        await this.objectStore.delete(storageKey).catch(() => undefined)
        throw new Error('Stored Artifact verification failed')
      }
    } catch (error) {
      if (error instanceof ArtifactServiceError) throw error
      throw new ArtifactServiceError(
        'ARTIFACT_STORAGE_FAILED',
        'Artifact content could not be stored.',
        { cause: error },
      )
    }

    return {
      artifactId,
      streamArtifactId: draft.streamArtifactId,
      metadata: draft.metadata,
      version,
      parentVersion,
      storageProvider: 'seaweedfs-s3',
      storageKey,
      contentHash: draft.sha256,
      byteLength: draft.byteLength,
    }
  }

  async cleanup(prepared: PreparedArtifactVersion[]): Promise<void> {
    await Promise.allSettled(
      prepared.map((item) => this.objectStore.delete(item.storageKey)),
    )
  }

  async readVersion(
    userId: string,
    artifactId: string,
    version: number,
    signal?: AbortSignal,
  ) {
    const record = await getArtifactVersionForUser(
      this.database,
      userId,
      artifactId,
      version,
    )
    if (!record) return null

    const stored = await this.objectStore.getStream(
      record.storageKey,
      undefined,
      signal,
    )
    if (!stored) {
      throw new ArtifactServiceError(
        'ARTIFACT_STORAGE_FAILED',
        'Artifact content is missing from object storage.',
      )
    }
    return { record, stored }
  }

  async readVersionContent(
    userId: string,
    artifactId: string,
    version: number,
    maxBytes = 256 * 1024,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const record = await getArtifactVersionForUser(
      this.database,
      userId,
      artifactId,
      version,
    )
    if (!record || record.byteLength > BigInt(maxBytes)) return null
    const stored = await this.objectStore.getStream(
      record.storageKey,
      undefined,
      signal,
    )
    if (!stored) {
      throw new ArtifactServiceError(
        'ARTIFACT_STORAGE_FAILED',
        'Artifact content is missing from object storage.',
      )
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of stored.body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += bytes.length
      if (total > maxBytes) {
        stored.body.destroy()
        return null
      }
      chunks.push(bytes)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  async readVersionRange(
    userId: string,
    artifactId: string,
    version: number,
    byteStart: number,
    byteEnd: number,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (
      !Number.isSafeInteger(byteStart) ||
      !Number.isSafeInteger(byteEnd) ||
      byteStart < 0 ||
      byteEnd <= byteStart ||
      byteEnd - byteStart > 16 * 1024
    ) {
      throw new ArtifactServiceError(
        'ARTIFACT_STORAGE_FAILED',
        'Artifact byte range is invalid.',
      )
    }
    const record = await getArtifactVersionForUser(
      this.database,
      userId,
      artifactId,
      version,
    )
    if (!record || BigInt(byteEnd) > record.byteLength) return null
    const stored = await this.objectStore.getStream(
      record.storageKey,
      `bytes=${byteStart}-${byteEnd - 1}`,
      signal,
    )
    if (!stored) return null
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of stored.body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += bytes.length
      if (total > byteEnd - byteStart) {
        stored.body.destroy()
        throw new ArtifactServiceError(
          'ARTIFACT_STORAGE_FAILED',
          'Artifact storage returned an oversized byte range.',
        )
      }
      chunks.push(bytes)
    }
    return Buffer.concat(chunks, total).toString('utf8')
  }

  async restoreVersion(
    userId: string,
    artifactId: string,
    sourceVersion: number,
    restoreRequestId: string,
    signal?: AbortSignal,
  ) {
    const findExisting = async () => {
      const [existing] = await this.database
        .select({
          artifactId: artifactVersions.artifactId,
          version: artifactVersions.version,
        })
        .from(artifactVersions)
        .where(and(
          eq(artifactVersions.userId, userId),
          eq(artifactVersions.restoreRequestId, restoreRequestId),
        ))
        .limit(1)
      return existing ?? null
    }
    const existing = await findExisting()
    if (existing) {
      if (existing.artifactId !== artifactId) {
        throw new ArtifactServiceError(
          'ARTIFACT_VERSION_CONFLICT',
          'Idempotency-Key was already used for another Artifact.',
        )
      }
      return { ...existing, created: false }
    }

    const source = await this.readVersion(
      userId,
      artifactId,
      sourceVersion,
      signal,
    )
    if (!source) {
      throw new ArtifactServiceError(
        'ARTIFACT_NOT_FOUND',
        'Artifact version does not exist.',
      )
    }
    const streamArtifactId = randomUUID()
    const storageKey = [
      'artifacts',
      userId,
      artifactId,
      'restores',
      restoreRequestId,
      source.record.sha256,
    ].join('/')
    try {
      const stored = await this.objectStore.putStream({
        key: storageKey,
        body: source.stored.body,
        contentType: source.record.type,
        contentLength: Number(source.record.byteLength),
        metadata: {
          sha256: source.record.sha256,
          artifactid: artifactId,
          restoredfrom: String(sourceVersion),
        },
        signal,
      })
      if (
        stored.sha256 !== source.record.sha256 ||
        stored.sizeBytes !== source.record.byteLength
      ) {
        throw new Error('Stored restored Artifact verification failed')
      }

      return await this.database.transaction(async (transaction) => {
        const [current] = await transaction
          .select({
            id: artifacts.id,
            chatId: artifacts.chatId,
            currentVersion: artifacts.currentVersion,
          })
          .from(artifacts)
          .where(and(
            eq(artifacts.id, artifactId),
            eq(artifacts.userId, userId),
            isNull(artifacts.deletedAt),
          ))
          .for('update', { of: artifacts })
          .limit(1)
        if (!current) {
          throw new ArtifactServiceError(
            'ARTIFACT_NOT_FOUND',
            'Artifact does not exist.',
          )
        }
        const version = current.currentVersion + 1
        const [versionRow] = await transaction
          .insert(artifactVersions)
          .values({
            userId,
            artifactId,
            version,
            parentVersion: current.currentVersion,
            title: source.record.title,
            mimeType: source.record.type,
            language: source.record.language,
            storageProvider: 'seaweedfs-s3',
            storageKey,
            contentHash: source.record.sha256,
            byteLength: source.record.byteLength,
            streamArtifactId,
            restoreRequestId,
            createdBy: 'user',
          })
          .returning({ id: artifactVersions.id })
        await transaction
          .update(artifacts)
          .set({
            currentVersion: version,
            title: source.record.title,
            mimeType: source.record.type,
            format: source.record.type === 'text/html'
              ? 'html'
              : source.record.type === 'image/svg+xml'
                ? 'svg'
                : 'markdown',
            storageProvider: 'seaweedfs-s3',
            storageKey,
            sizeBytes: source.record.byteLength,
            sha256: source.record.sha256,
            metadata: {
              language: source.record.language,
              restoredFromVersion: sourceVersion,
            },
            updatedAt: new Date(),
          })
          .where(eq(artifacts.id, artifactId))
        await enqueueBackgroundJob(transaction, {
          userId,
          type: 'artifact.index',
          dedupeKey: `artifact.index:${artifactId}:${version}`,
          ...(current.chatId ? { chatId: current.chatId } : {}),
          artifactVersionId: versionRow.id,
          payload: { artifactId, version },
        })
        return { artifactId, version, created: true }
      })
    } catch (error) {
      await this.objectStore.delete(storageKey).catch(() => undefined)
      const raced = await findExisting()
      if (raced?.artifactId === artifactId) {
        return { ...raced, created: false }
      }
      if (error instanceof ArtifactServiceError) throw error
      throw new ArtifactServiceError(
        'ARTIFACT_STORAGE_FAILED',
        'Artifact version could not be restored.',
        { cause: error },
      )
    }
  }
}

export function asArtifactCommitError(error: unknown): ArtifactCommitError | null {
  return error instanceof ArtifactCommitError ? error : null
}
