import { artifactMimeTypes, type ArtifactClientEntity, type ArtifactMimeType, type ArtifactVersionSummary } from './types'

const API_BASE = `${import.meta.env.BASE_URL}api`

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, { credentials: 'include' })
  if (!response.ok) throw new Error(`Artifact request failed (${response.status})`)
  return response.json() as Promise<T>
}

function requireMimeType(value: string): ArtifactMimeType {
  if (!artifactMimeTypes.includes(value as ArtifactMimeType)) {
    throw new Error(`Unsupported Artifact type: ${value}`)
  }
  return value as ArtifactMimeType
}

export async function fetchArtifact(artifactId: string): Promise<ArtifactClientEntity> {
  const value = await requestJson<{
    id: string
    logicalId: string
    title: string
    type: string
    currentVersion: number
    content?: string
  }>(`/artifacts/${encodeURIComponent(artifactId)}`)
  return {
    ...value,
    type: requireMimeType(value.type),
    versions: [],
    loadedVersion: value.currentVersion,
    renderStatus: 'ready',
  }
}

export async function fetchArtifactVersions(artifactId: string) {
  const value = await requestJson<{ versions: Array<Omit<ArtifactVersionSummary, 'type'> & { type: string }> }>(
    `/artifacts/${encodeURIComponent(artifactId)}/versions`,
  )
  return value.versions.map((version) => ({
    ...version,
    type: requireMimeType(version.type),
  }))
}

export async function fetchArtifactVersion(artifactId: string, version: number) {
  const value = await requestJson<ArtifactVersionSummary & { content: string; type: string }>(
    `/artifacts/${encodeURIComponent(artifactId)}/versions/${version}`,
  )
  return { ...value, type: requireMimeType(value.type) }
}

export function artifactDownloadUrl(artifactId: string, version: number) {
  return `${API_BASE}/artifacts/${encodeURIComponent(artifactId)}/versions/${version}/download`
}
