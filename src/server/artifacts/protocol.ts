import { z } from 'zod'

export const artifactMimeTypes = [
  'text/markdown',
  'text/html',
  'image/svg+xml',
] as const

export type ArtifactMimeType = (typeof artifactMimeTypes)[number]

export const artifactProtocolMetadataSchema = z.object({
  v: z.literal('1'),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  op: z.enum(['create', 'replace']),
  type: z.enum(artifactMimeTypes),
  title: z.string().min(1).max(200),
  base_version: z.coerce.number().int().positive().optional(),
  language: z.string().trim().min(1).max(64).optional(),
}).superRefine((value, context) => {
  if (value.op === 'replace' && value.base_version === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['base_version'],
      message: 'replace requires base_version',
    })
  }

  if (value.op === 'create' && value.base_version !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['base_version'],
      message: 'create does not allow base_version',
    })
  }
})

export type ArtifactProtocolMetadata = z.infer<
  typeof artifactProtocolMetadataSchema
>

export type ArtifactParserErrorCode =
  | 'INVALID_OPEN_TAG'
  | 'OPEN_TAG_TOO_LARGE'
  | 'INVALID_METADATA'
  | 'UNSUPPORTED_VERSION'
  | 'UNSUPPORTED_TYPE'
  | 'NESTED_ARTIFACT'
  | 'ARTIFACT_TOO_LARGE'
  | 'UNCLOSED_ARTIFACT'
  | 'ARTIFACT_ABORTED'
  | 'ARTIFACT_LIMIT_EXCEEDED'
  | 'ARTIFACT_ALREADY_EXISTS'
  | 'ARTIFACT_NOT_FOUND'
  | 'ARTIFACT_VERSION_CONFLICT'
  | 'ARTIFACT_STORAGE_FAILED'
  | 'ARTIFACT_COMMIT_FAILED'

export type ArtifactMessagePart =
  | {
      type: 'text'
      order: number
      text: string
    }
  | {
      type: 'artifact_ref'
      order: number
      artifactId: string
      logicalId: string
      version: number
    }

export interface ArtifactStreamParserEvents {
  onTextDelta(delta: string): void
  onArtifactStart(input: {
    streamArtifactId: string
    metadata: ArtifactProtocolMetadata
  }): void
  onArtifactDelta(input: {
    streamArtifactId: string
    sequence: number
    delta: string
  }): void
  onArtifactCommit(input: {
    streamArtifactId: string
    metadata: ArtifactProtocolMetadata
    content: string
    byteLength: number
    sha256: string
  }): void
  onArtifactError(input: {
    streamArtifactId?: string
    code: ArtifactParserErrorCode
    message: string
    recoverable: boolean
  }): void
}

export const ARTIFACT_OPEN_TAG_MAX_BYTES = 4096
export const ARTIFACT_BODY_MAX_BYTES = 1024 * 1024
