import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import type { Database } from '../db.js'
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
}

export function asArtifactCommitError(error: unknown): ArtifactCommitError | null {
  return error instanceof ArtifactCommitError ? error : null
}
