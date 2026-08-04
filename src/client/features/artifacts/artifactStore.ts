import { createStore, produce } from 'solid-js/store'
import { fetchArtifact, fetchArtifactVersion, fetchArtifactVersions } from './artifactApi'
import { shouldRevealCommittedArtifact } from './streamingParts'
import type { ArtifactClientEntity, ArtifactDraftClientState, ArtifactMimeType } from './types'

type ArtifactStoreState = {
  artifactsById: Record<string, ArtifactClientEntity>
  draftsByStreamId: Record<string, ArtifactDraftClientState>
  visibleConversationId: string | null
  activeArtifactId: string | null
  activeStreamId: string | null
  activeVersion: number | null
  isPanelOpen: boolean
  panelInteractionRevision: number
  activeTab: 'preview' | 'code'
  panelWidth: number
}

const [artifactState, setArtifactState] = createStore<ArtifactStoreState>({
  artifactsById: {},
  draftsByStreamId: {},
  visibleConversationId: null,
  activeArtifactId: null,
  activeStreamId: null,
  activeVersion: null,
  isPanelOpen: false,
  panelInteractionRevision: 0,
  activeTab: 'preview',
  panelWidth: 520,
})

const pendingDeltas = new Map<string, string>()
const pendingArtifactLoads = new Map<string, Promise<ArtifactClientEntity>>()
let deltaFrame: number | undefined
let clearSelectionAfterClose = false

type PanelChangeCause = 'artifact-start' | 'artifact-commit' | 'user'

function clearPanelSelection() {
  setArtifactState({
    activeArtifactId: null,
    activeStreamId: null,
    activeVersion: null,
    activeTab: 'preview',
  })
}

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
    generationId: string
    messageId: string
    logicalId: string
    operation: 'create' | 'replace'
    artifactType: string
    title: string
    baseVersion: number | null
    language: string | null
    textStartIndex: number
    partOrder: number
  }, conversationId: string) {
    if (artifactState.draftsByStreamId[input.artifactStreamId]) return
    setArtifactState('draftsByStreamId', input.artifactStreamId, {
      streamId: input.artifactStreamId,
      messageId: input.messageId,
      generationId: input.generationId,
      conversationId,
      logicalId: input.logicalId,
      operation: input.operation,
      type: input.artifactType as ArtifactMimeType,
      title: input.title,
      language: input.language ?? undefined,
      baseVersion: input.baseVersion,
      textStartIndex: input.textStartIndex,
      partOrder: input.partOrder,
      panelRevisionAtStart: artifactState.panelInteractionRevision,
      content: '',
      status: 'streaming',
    })
    setArtifactState('activeStreamId', null)
    setArtifactState('isPanelOpen', false)
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
    setArtifactState('draftsByStreamId', input.artifactStreamId, {
      artifactId: input.artifactId,
      version: input.version,
    })
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
    const shouldReveal = shouldRevealCommittedArtifact({
      visibleConversationId: artifactState.visibleConversationId,
      draftConversationId: draft.conversationId,
      panelInteractionRevision: artifactState.panelInteractionRevision,
      panelRevisionAtStart: draft.panelRevisionAtStart,
    })
    if (shouldReveal) {
      clearSelectionAfterClose = false
      setArtifactState({
        activeArtifactId: input.artifactId,
        activeStreamId: null,
        activeVersion: input.version,
        isPanelOpen: true,
        activeTab: 'preview',
      })
    }
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
    clearSelectionAfterClose = false
    setArtifactState('panelInteractionRevision', (value) => value + 1)
    setArtifactState({
      activeArtifactId: artifactId,
      activeStreamId: null,
      isPanelOpen: true,
      activeVersion: version ?? artifactState.artifactsById[artifactId]?.currentVersion ?? null,
      activeTab: 'preview',
    })
    if (!artifactState.artifactsById[artifactId]) {
      let pending = pendingArtifactLoads.get(artifactId)
      if (!pending) {
        pending = fetchArtifact(artifactId)
        pendingArtifactLoads.set(artifactId, pending)
      }
      try {
        setArtifactState('artifactsById', artifactId, await pending)
      } finally {
        if (pendingArtifactLoads.get(artifactId) === pending) {
          pendingArtifactLoads.delete(artifactId)
        }
      }
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
  close(cause: PanelChangeCause = 'user') {
    if (cause === 'user') {
      setArtifactState('panelInteractionRevision', (value) => value + 1)
    }
    setArtifactState({
      isPanelOpen: false,
      activeTab: 'preview',
    })
  },
  setTab(tab: ArtifactStoreState['activeTab']) {
    if (tab !== artifactState.activeTab) {
      setArtifactState('panelInteractionRevision', (value) => value + 1)
    }
    setArtifactState('activeTab', tab)
  },
  setWidth(width: number) {
    setArtifactState('panelWidth', Math.min(840, Math.max(360, width)))
  },
  setVisibleConversation(conversationId: string | null) {
    if (artifactState.visibleConversationId === conversationId) return
    setArtifactState('visibleConversationId', conversationId)
    if (artifactState.isPanelOpen) {
      clearSelectionAfterClose = true
      setArtifactState({
        isPanelOpen: false,
        activeTab: 'preview',
      })
    } else {
      clearSelectionAfterClose = false
      clearPanelSelection()
    }
  },
  completePanelClose() {
    if (!clearSelectionAfterClose) return
    clearSelectionAfterClose = false
    clearPanelSelection()
  },
  releaseGeneration(generationId: string) {
    setArtifactState(produce((state) => {
      for (const [streamId, draft] of Object.entries(state.draftsByStreamId)) {
        if (draft.generationId !== generationId) continue
        pendingDeltas.delete(streamId)
        delete state.draftsByStreamId[streamId]
      }
    }))
    if (pendingDeltas.size === 0 && deltaFrame !== undefined) {
      cancelAnimationFrame(deltaFrame)
      deltaFrame = undefined
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
