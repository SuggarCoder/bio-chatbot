export const artifactMimeTypes = [
  'text/markdown',
  'text/plain',
  'text/html',
  'image/svg+xml',
  'application/vnd.artifact.code',
  'application/vnd.artifact.mermaid',
] as const

export type ArtifactMimeType = (typeof artifactMimeTypes)[number]

export type ArtifactVersionSummary = {
  id: string
  artifactId: string
  version: number
  parentVersion: number | null
  title: string
  type: ArtifactMimeType
  language: string | null
  byteLength: number
  sha256: string
  createdBy: 'assistant' | 'user'
  createdAt: string
}

export type ArtifactClientEntity = {
  id: string
  logicalId: string
  title: string
  type: ArtifactMimeType
  currentVersion: number
  loadedVersion?: number
  versions: ArtifactVersionSummary[]
  content?: string
  language?: string
  renderStatus: 'idle' | 'streaming' | 'compiling' | 'ready' | 'error'
}

export type ArtifactDraftClientState = {
  streamId: string
  messageId: string
  generationId: string
  conversationId: string
  logicalId: string
  operation: 'create' | 'replace'
  type: ArtifactMimeType
  title: string
  language?: string
  baseVersion: number | null
  textStartIndex: number
  partOrder: number
  panelRevisionAtStart: number
  content: string
  status: 'streaming' | 'complete' | 'incomplete' | 'aborted' | 'invalid'
  error?: string
  artifactId?: string
  version?: number
}
