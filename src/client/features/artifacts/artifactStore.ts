import { createStore, produce } from 'solid-js/store'
import { fetchArtifact, fetchArtifactVersion, fetchArtifactVersions } from './artifactApi'
import type { ArtifactClientEntity, ArtifactDraftClientState, ArtifactMimeType } from './types'

type ArtifactStoreState = {
  artifactsById: Record<string, ArtifactClientEntity>
  draftsByStreamId: Record<string, ArtifactDraftClientState>
  activeArtifactId: string | null
  activeStreamId: string | null
  activeVersion: number | null
  isPanelOpen: boolean
  activeTab: 'preview' | 'code' | 'history'
  panelWidth: number
}

const [artifactState, setArtifactState] = createStore<ArtifactStoreState>({
  artifactsById: {},
  draftsByStreamId: {},
  activeArtifactId: null,
  activeStreamId: null,
  activeVersion: null,
  isPanelOpen: false,
  activeTab: 'preview',
  panelWidth: 520,
})

const pendingDeltas = new Map<string, string>()
let deltaFrame: number | undefined

function flushDeltas() {
  deltaFrame = undefined
  for (const [streamId, delta] of pendingDeltas) {
    if (artifactState.draftsByStreamId[streamId]) {
      setArtifactState('draftsByStreamId', streamId, 'content', (value) => value + delta)
    }
  }
  pendingDeltas.clear()
}

export const artifactStore = {
  state: artifactState,
  start(input: {
    artifactStreamId: string
    messageId: string
    logicalId: string
    operation: 'create' | 'replace'
    artifactType: string
    title: string
    baseVersion: number | null
  }) {
    setArtifactState('draftsByStreamId', input.artifactStreamId, {
      streamId: input.artifactStreamId,
      messageId: input.messageId,
      logicalId: input.logicalId,
      operation: input.operation,
      type: input.artifactType as ArtifactMimeType,
      title: input.title,
      baseVersion: input.baseVersion,
      content: '',
      status: 'streaming',
    })
    setArtifactState({
      activeStreamId: input.artifactStreamId,
      activeArtifactId: null,
      activeVersion: input.baseVersion,
      isPanelOpen: true,
      activeTab: 'preview',
    })
  },
  delta(streamId: string, delta: string) {
    pendingDeltas.set(streamId, (pendingDeltas.get(streamId) ?? '') + delta)
    deltaFrame ??= requestAnimationFrame(flushDeltas)
  },
  commit(input: {
    artifactStreamId: string
    artifactId: string
    logicalId: string
    version: number
  }) {
    flushDeltas()
    const draft = artifactState.draftsByStreamId[input.artifactStreamId]
    if (!draft) return
    setArtifactState('draftsByStreamId', input.artifactStreamId, 'status', 'complete')
    setArtifactState('artifactsById', input.artifactId, {
      id: input.artifactId,
      logicalId: input.logicalId,
      title: draft.title,
      type: draft.type,
      currentVersion: input.version,
      loadedVersion: input.version,
      versions: [],
      content: draft.content,
      renderStatus: 'ready',
    })
    setArtifactState({
      activeArtifactId: input.artifactId,
      activeStreamId: null,
      activeVersion: input.version,
      isPanelOpen: true,
    })
  },
  error(streamId: string | undefined, code: string, message: string) {
    if (!streamId || !artifactState.draftsByStreamId[streamId]) return
    const status = code === 'ARTIFACT_ABORTED' ? 'aborted' :
      code === 'UNCLOSED_ARTIFACT' ? 'incomplete' : 'invalid'
    setArtifactState('draftsByStreamId', streamId, {
      status,
      error: message,
    })
  },
  async open(artifactId: string, version?: number) {
    setArtifactState({
      activeArtifactId: artifactId,
      activeStreamId: null,
      isPanelOpen: true,
      activeVersion: version ?? artifactState.artifactsById[artifactId]?.currentVersion ?? null,
    })
    if (!artifactState.artifactsById[artifactId]) {
      setArtifactState('artifactsById', artifactId, await fetchArtifact(artifactId))
    }
    const desiredVersion = version ?? artifactState.artifactsById[artifactId]?.currentVersion
    if (
      desiredVersion &&
      desiredVersion !== artifactState.artifactsById[artifactId]?.loadedVersion
    ) {
      const loaded = await fetchArtifactVersion(artifactId, desiredVersion)
      setArtifactState('artifactsById', artifactId, 'content', loaded.content)
      setArtifactState('artifactsById', artifactId, 'language', loaded.language ?? undefined)
      setArtifactState('artifactsById', artifactId, 'loadedVersion', desiredVersion)
    }
  },
  async loadHistory(artifactId: string) {
    const versions = await fetchArtifactVersions(artifactId)
    setArtifactState('artifactsById', artifactId, 'versions', versions)
  },
  close() {
    setArtifactState('isPanelOpen', false)
  },
  setTab(tab: ArtifactStoreState['activeTab']) {
    setArtifactState('activeTab', tab)
  },
  setWidth(width: number) {
    setArtifactState('panelWidth', Math.min(840, Math.max(360, width)))
  },
  hydrateMessageParts(parts: Array<{ type: string; artifactId?: string }>) {
    for (const part of parts) {
      if (part.type === 'artifact_ref' && part.artifactId && !artifactState.artifactsById[part.artifactId]) {
        void fetchArtifact(part.artifactId).then((artifact) => {
          setArtifactState('artifactsById', artifact.id, artifact)
        })
      }
    }
  },
  clearDraftsForMessage(messageId: string) {
    setArtifactState(produce((state) => {
      for (const [streamId, draft] of Object.entries(state.draftsByStreamId)) {
        if (draft.messageId === messageId && draft.status === 'streaming') {
          draft.status = 'aborted'
          draft.error = 'Generation was interrupted.'
          pendingDeltas.delete(streamId)
        }
      }
    }))
  },
  abortStreamingDrafts() {
    setArtifactState(produce((state) => {
      for (const [streamId, draft] of Object.entries(state.draftsByStreamId)) {
        if (draft.status === 'streaming') {
          draft.status = 'aborted'
          draft.error = 'Generation was interrupted. You can regenerate a complete version.'
          pendingDeltas.delete(streamId)
        }
      }
    }))
  },
}
