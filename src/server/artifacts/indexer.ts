import { and, eq, sql } from 'drizzle-orm'

import type { BackgroundWorkItem } from '../backgroundJobs.js'
import type { Database } from '../db.js'
import {
  artifactSections,
  artifactVersions,
} from '../db/schema.js'
import type { LocalEmbeddingService } from '../embedding.js'
import type { ObjectStore } from '../storage/objectStore.js'
import { ARTIFACT_BODY_MAX_BYTES } from './protocol.js'
import { extractArtifactOutline } from './outline.js'

async function readText(
  objectStore: ObjectStore,
  key: string,
  maxBytes: number,
): Promise<string> {
  const stored = await objectStore.getStream(key)
  if (!stored) throw new Error('Artifact object is missing')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stored.body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > maxBytes) {
      stored.body.destroy()
      throw new Error('Artifact object exceeds the indexing limit')
    }
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

export class ArtifactIndexer {
  constructor(
    private readonly database: Database,
    private readonly objectStore: ObjectStore,
    private readonly embeddings: LocalEmbeddingService,
  ) {}

  async process(job: BackgroundWorkItem): Promise<void> {
    if (job.type !== 'artifact.index' || !job.artifactVersionId) return
    const [version] = await this.database
      .select({
        id: artifactVersions.id,
        userId: artifactVersions.userId,
        artifactId: artifactVersions.artifactId,
        version: artifactVersions.version,
        mimeType: artifactVersions.mimeType,
        storageKey: artifactVersions.storageKey,
        byteLength: artifactVersions.byteLength,
        outlineStatus: artifactVersions.outlineStatus,
      })
      .from(artifactVersions)
      .where(and(
        eq(artifactVersions.id, job.artifactVersionId),
        eq(artifactVersions.userId, job.userId),
      ))
      .limit(1)
    if (!version || version.outlineStatus === 'ready') return

    await this.database
      .update(artifactVersions)
      .set({
        outlineStatus: 'processing',
        outlineError: null,
      })
      .where(eq(artifactVersions.id, version.id))

    try {
      const content = await readText(
        this.objectStore,
        version.storageKey,
        ARTIFACT_BODY_MAX_BYTES,
      )
      const extracted = extractArtifactOutline(content, version.mimeType)
      const indexed: Array<ReturnType<typeof extractArtifactOutline>['sections'][number] & {
        embedding: number[]
      }> = []
      for (const section of extracted.sections) {
        indexed.push({
          ...section,
          embedding: await this.embeddings.embed(section.embeddingText),
        })
      }

      await this.database.transaction(async (transaction) => {
        await transaction
          .delete(artifactSections)
          .where(and(
            eq(artifactSections.artifactId, version.artifactId),
            eq(artifactSections.version, version.version),
          ))
        for (let index = 0; index < indexed.length; index += 100) {
          const batch = indexed.slice(index, index + 100)
          if (batch.length === 0) continue
          await transaction.insert(artifactSections).values(batch.map((section) => ({
            userId: version.userId,
            artifactId: version.artifactId,
            version: version.version,
            ordinal: section.ordinal,
            byteStart: BigInt(section.byteStart),
            byteEnd: BigInt(section.byteEnd),
            headingPath: section.headingPath,
            preview: section.preview,
            embedding: section.embedding,
          })))
        }
        await transaction
          .update(artifactVersions)
          .set({
            outline: extracted.outline,
            outlineStatus: 'ready',
            outlineError: null,
            outlinedAt: sql`now()`,
          })
          .where(eq(artifactVersions.id, version.id))
      })
    } catch (error) {
      await this.database
        .update(artifactVersions)
        .set({
          outlineStatus: 'failed',
          outlineError: error instanceof Error ? error.message : String(error),
          outlinedAt: sql`now()`,
        })
        .where(eq(artifactVersions.id, version.id))
      throw error
    }
  }
}
