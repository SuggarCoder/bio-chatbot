import {
  buildHtmlSandboxDocument,
  renderStrictMermaid,
  sanitizeArtifactSvg,
} from './features/artifacts/renderers'
import { renderMarkdown } from './features/chatbot/markdown'
import { createComponent } from 'solid-js'
import { render } from 'solid-js/web'
import { ArtifactSidePanel } from './features/artifacts/ArtifactSidePanel'
import { artifactStore } from './features/artifacts/artifactStore'

let disposePanel: (() => void) | undefined

async function mountCommittedArtifactPanel() {
  disposePanel?.()
  document.querySelector('#artifact-panel-test-root')?.remove()
  const root = document.createElement('div')
  root.id = 'artifact-panel-test-root'
  root.style.cssText = 'position:relative;display:flex;width:100vw;height:600px;overflow:hidden'
  document.body.append(root)
  disposePanel = render(() => createComponent(ArtifactSidePanel, {}), root)
  artifactStore.setVisibleConversation('panel-test-conversation')
  artifactStore.start({
    artifactStreamId: 'panel-test-stream',
    generationId: 'panel-test-generation',
    messageId: 'panel-test-message',
    logicalId: 'panel-test',
    operation: 'create',
    artifactType: 'text/html',
    title: 'Panel test',
    baseVersion: null,
    language: 'html',
    textStartIndex: 0,
    partOrder: 0,
  }, 'panel-test-conversation')
  artifactStore.delta(
    'panel-test-stream',
    '<h1 id="panel-test-content">Visible content</h1>',
  )
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  artifactStore.commit({
    artifactStreamId: 'panel-test-stream',
    artifactId: 'panel-test-artifact',
    logicalId: 'panel-test',
    version: 1,
  })
  await new Promise((resolve) => window.setTimeout(resolve, 350))
}

async function switchArtifactPanelConversation() {
  artifactStore.setVisibleConversation('panel-test-other-conversation')
  await new Promise((resolve) => window.setTimeout(resolve, 250))
  return {
    isPanelOpen: artifactStore.state.isPanelOpen,
    activeArtifactId: artifactStore.state.activeArtifactId,
    activeVersion: artifactStore.state.activeVersion,
  }
}

Object.assign(window, {
  artifactSecurity: {
    buildHtmlSandboxDocument,
    sanitizeArtifactSvg,
    renderStrictMermaid,
    renderMarkdown,
    mountCommittedArtifactPanel,
    switchArtifactPanelConversation,
  },
})
