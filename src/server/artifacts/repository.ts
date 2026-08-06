import { and, desc, eq, inArray, isNull } from 'drizzle-orm'

import type { Database } from '../db.js'
import {
  artifacts,
  artifactVersions,
  chats,
  type MessagePart,
} from '../db/schema.js'
import type {
  ArtifactMimeType,
  ArtifactProtocolMetadata,
} from './protocol.js'
import { artifactMimeTypes } from './protocol.js'

export type DatabaseTransaction = Parameters<
  Parameters<Database['transaction']>[0]
>[0]

export type ArtifactCommitFailureCode =
  | 'ARTIFACT_ALREADY_EXISTS'
  | 'ARTIFACT_NOT_FOUND'
  | 'ARTIFACT_VERSION_CONFLICT'

export class ArtifactCommitError extends Error {
  constructor(
    readonly code: ArtifactCommitFailureCode,
    message: string,
  ) {
    super(message)
    this.name = 'ArtifactCommitError'
  }
}

export type PreparedArtifactVersion = {
  artifactId: string
  streamArtifactId: string
  metadata: ArtifactProtocolMetadata
  version: number
  parentVersion: number | null
  storageProvider: 'seaweedfs-s3'
  storageKey: string
  contentHash: string
  byteLength: number
}

export type CommittedArtifactVersion = {
  streamArtifactId: string
  artifactId: string
  logicalId: string
  version: number
  sha256: string
  byteLength: number
}

function formatForMime(type: ArtifactMimeType): string {
  return {
    'text/markdown': 'markdown',
    'text/html': 'html',
    'image/svg+xml': 'svg',
  }[type]
}

export async function findArtifactTarget(
  database: Database,
  userId: string,
  chatId: string,
  logicalId: string,
) {
  const [row] = await database
    .select({
      id: artifacts.id,
      currentVersion: artifacts.currentVersion,
      title: artifacts.title,
      mimeType: artifacts.mimeType,
    })
    .from(artifacts)
    .innerJoin(
      chats,
      and(
        eq(chats.id, artifacts.chatId),
        eq(chats.userId, userId),
        isNull(chats.deletedAt),
      ),
    )
    .where(
      and(
        eq(artifacts.userId, userId),
        eq(artifacts.chatId, chatId),
        eq(artifacts.logicalId, logicalId),
        isNull(artifacts.deletedAt),
      ),
    )
    .limit(1)

  return row ?? null
}

export async function commitPreparedArtifact(
  transaction: DatabaseTransaction,
  input: {
    userId: string
    chatId: string
    messageId: string
    generationId: string
    prepared: PreparedArtifactVersion
  },
): Promise<CommittedArtifactVersion> {
  const { prepared } = input
  const metadata = prepared.metadata

  if (metadata.op === 'create') {
    const inserted = await transaction
      .insert(artifacts)
      .values({
        id: prepared.artifactId,
        userId: input.userId,
        chatId: input.chatId,
        messageId: input.messageId,
        generationId: input.generationId,
        logicalId: metadata.id,
        currentVersion: 1,
        title: metadata.title,
        artifactType: 'file',
        format: formatForMime(metadata.type),
        status: 'ready',
        content: null,
        storageProvider: prepared.storageProvider,
        storageKey: prepared.storageKey,
        mimeType: metadata.type,
        sizeBytes: BigInt(prepared.byteLength),
        sha256: prepared.contentHash,
        metadata: {
          protocolVersion: metadata.v,
          language: metadata.language ?? null,
        },
      })
      .onConflictDoNothing()
      .returning({ id: artifacts.id })

    if (inserted.length === 0) {
      throw new ArtifactCommitError(
        'ARTIFACT_ALREADY_EXISTS',
        `Artifact ${metadata.id} already exists in this conversation.`,
      )
    }
  } else {
    const [current] = await transaction
      .select({
        id: artifacts.id,
        currentVersion: artifacts.currentVersion,
      })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.userId, input.userId),
          eq(artifacts.chatId, input.chatId),
          eq(artifacts.logicalId, metadata.id),
          isNull(artifacts.deletedAt),
        ),
      )
      .for('update', { of: artifacts })
      .limit(1)

    if (!current) {
      throw new ArtifactCommitError(
        'ARTIFACT_NOT_FOUND',
        `Artifact ${metadata.id} does not exist in this conversation.`,
      )
    }
    if (
      current.id !== prepared.artifactId ||
      current.currentVersion !== metadata.base_version
    ) {
      throw new ArtifactCommitError(
        'ARTIFACT_VERSION_CONFLICT',
        `Artifact ${metadata.id} changed while this version was generated.`,
      )
    }

    const updated = await transaction
      .update(artifacts)
      .set({
        currentVersion: prepared.version,
        title: metadata.title,
        format: formatForMime(metadata.type),
        status: 'ready',
        content: null,
        storageProvider: prepared.storageProvider,
        storageKey: prepared.storageKey,
        mimeType: metadata.type,
        sizeBytes: BigInt(prepared.byteLength),
        sha256: prepared.contentHash,
        metadata: {
          protocolVersion: metadata.v,
          language: metadata.language ?? null,
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(artifacts.id, current.id),
          eq(artifacts.currentVersion, metadata.base_version),
        ),
      )
      .returning({ id: artifacts.id })

    if (updated.length === 0) {
      throw new ArtifactCommitError(
        'ARTIFACT_VERSION_CONFLICT',
        `Artifact ${metadata.id} changed while this version was generated.`,
      )
    }
  }

  await transaction.insert(artifactVersions).values({
    userId: input.userId,
    artifactId: prepared.artifactId,
    version: prepared.version,
    parentVersion: prepared.parentVersion,
    title: metadata.title,
    mimeType: metadata.type,
    language: metadata.language ?? null,
    storageProvider: prepared.storageProvider,
    storageKey: prepared.storageKey,
    contentHash: prepared.contentHash,
    byteLength: BigInt(prepared.byteLength),
    sourceMessageId: input.messageId,
    sourceGenerationId: input.generationId,
    streamArtifactId: prepared.streamArtifactId,
    createdBy: 'assistant',
  })

  return {
    streamArtifactId: prepared.streamArtifactId,
    artifactId: prepared.artifactId,
    logicalId: metadata.id,
    version: prepared.version,
    sha256: prepared.contentHash,
    byteLength: prepared.byteLength,
  }
}

export function materializeMessageParts(
  parts: Array<
    | { type: 'text'; text: string }
    | { type: 'artifact_draft_ref'; streamArtifactId: string }
  >,
  committed: CommittedArtifactVersion[],
): MessagePart[] {
  const artifactsByStream = new Map(
    committed.map((artifact) => [artifact.streamArtifactId, artifact]),
  )
  const output: MessagePart[] = []

  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text) {
        output.push({ type: 'text', order: output.length, text: part.text })
      }
      continue
    }

    const artifact = artifactsByStream.get(part.streamArtifactId)
    if (artifact) {
      output.push({
        type: 'artifact_ref',
        order: output.length,
        artifactId: artifact.artifactId,
        logicalId: artifact.logicalId,
        version: artifact.version,
      })
    }
  }

  return output
}

export async function listArtifactsForChat(
  database: Database,
  userId: string,
  chatId: string,
) {
  return database
    .select({
      id: artifacts.id,
      logicalId: artifacts.logicalId,
      title: artifacts.title,
      type: artifacts.mimeType,
      currentVersion: artifacts.currentVersion,
      status: artifacts.status,
      updatedAt: artifacts.updatedAt,
    })
    .from(artifacts)
    .innerJoin(
      chats,
      and(
        eq(chats.id, artifacts.chatId),
        eq(chats.userId, userId),
        isNull(chats.deletedAt),
      ),
    )
    .where(
      and(
        eq(artifacts.chatId, chatId),
        eq(artifacts.userId, userId),
        inArray(artifacts.mimeType, artifactMimeTypes),
        isNull(artifacts.deletedAt),
      ),
    )
    .orderBy(desc(artifacts.updatedAt))
}

export async function listArtifactPromptCatalogForChat(
  database: Database,
  userId: string,
  chatId: string,
) {
  return database
    .select({
      id: artifacts.id,
      logicalId: artifacts.logicalId,
      title: artifacts.title,
      type: artifacts.mimeType,
      currentVersion: artifacts.currentVersion,
      updatedAt: artifacts.updatedAt,
    })
    .from(artifacts)
    .innerJoin(
      chats,
      and(
        eq(chats.id, artifacts.chatId),
        eq(chats.userId, userId),
        isNull(chats.deletedAt),
      ),
    )
    .where(
      and(
        eq(artifacts.chatId, chatId),
        eq(artifacts.userId, userId),
        inArray(artifacts.mimeType, artifactMimeTypes),
        isNull(artifacts.deletedAt),
      ),
    )
    .orderBy(desc(artifacts.updatedAt))
    .limit(50)
}

export async function getArtifactForUser(
  database: Database,
  userId: string,
  artifactId: string,
) {
  const [row] = await database
    .select({
      id: artifacts.id,
      chatId: artifacts.chatId,
      logicalId: artifacts.logicalId,
      title: artifacts.title,
      type: artifacts.mimeType,
      currentVersion: artifacts.currentVersion,
      status: artifacts.status,
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.id, artifactId),
        eq(artifacts.userId, userId),
        inArray(artifacts.mimeType, artifactMimeTypes),
        isNull(artifacts.deletedAt),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function listArtifactVersionsForUser(
  database: Database,
  userId: string,
  artifactId: string,
) {
  return database
    .select({
      id: artifactVersions.id,
      artifactId: artifactVersions.artifactId,
      version: artifactVersions.version,
      parentVersion: artifactVersions.parentVersion,
      title: artifactVersions.title,
      type: artifactVersions.mimeType,
      language: artifactVersions.language,
      byteLength: artifactVersions.byteLength,
      sha256: artifactVersions.contentHash,
      createdBy: artifactVersions.createdBy,
      createdAt: artifactVersions.createdAt,
    })
    .from(artifactVersions)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.id, artifactVersions.artifactId),
        eq(artifacts.userId, userId),
        inArray(artifacts.mimeType, artifactMimeTypes),
        isNull(artifacts.deletedAt),
      ),
    )
    .where(
      and(
        eq(artifactVersions.artifactId, artifactId),
        inArray(artifactVersions.mimeType, artifactMimeTypes),
      ),
    )
    .orderBy(desc(artifactVersions.version))
}

export async function getArtifactVersionForUser(
  database: Database,
  userId: string,
  artifactId: string,
  version: number,
) {
  const [row] = await database
    .select({
      id: artifactVersions.id,
      artifactId: artifactVersions.artifactId,
      version: artifactVersions.version,
      parentVersion: artifactVersions.parentVersion,
      title: artifactVersions.title,
      type: artifactVersions.mimeType,
      language: artifactVersions.language,
      storageKey: artifactVersions.storageKey,
      byteLength: artifactVersions.byteLength,
      sha256: artifactVersions.contentHash,
      createdBy: artifactVersions.createdBy,
      createdAt: artifactVersions.createdAt,
    })
    .from(artifactVersions)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.id, artifactVersions.artifactId),
        eq(artifacts.userId, userId),
        inArray(artifacts.mimeType, artifactMimeTypes),
        isNull(artifacts.deletedAt),
      ),
    )
    .where(
      and(
        eq(artifactVersions.artifactId, artifactId),
        eq(artifactVersions.version, version),
        inArray(artifactVersions.mimeType, artifactMimeTypes),
      ),
    )
    .limit(1)
  return row ?? null
}
