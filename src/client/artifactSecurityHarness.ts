import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import './main.css'

import {
  buildHtmlSandboxDocument,
  renderStrictMermaid,
  sanitizeArtifactSvg,
} from './features/artifacts/renderers'
import { createComponent } from 'solid-js'
import { render } from 'solid-js/web'
import { ArtifactSidePanel } from './features/artifacts/ArtifactSidePanel'
import { artifactStore } from './features/artifacts/artifactStore'
import { MarkdownContent } from './features/chatbot/MarkdownContent'

let disposePanel: (() => void) | undefined
let disposeMarkdown: (() => void) | undefined

async function mountMarkdownFixture(content: string) {
  disposeMarkdown?.()
  document.querySelector('#markdown-test-root')?.remove()
  const root = document.createElement('div')
  root.id = 'markdown-test-root'
  document.body.append(root)
  disposeMarkdown = render(
    () => createComponent(MarkdownContent, { source: content }),
    root,
  )
  await new Promise((resolve) => window.setTimeout(resolve, 350))
}

async function mountCommittedArtifactPanel() {
  disposePanel?.()
  document.querySelector('#artifact-panel-test-root')?.remove()
  const root = document.createElement('div')
  root.id = 'artifact-panel-test-root'
  root.style.cssText = 'position:relative;display:flex;justify-content:flex-end;width:100vw;height:600px;overflow:hidden'
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
    '<h1 id="panel-test-content">Visible content</h1>\n<p>Second line</p>',
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

async function commitPanelArtifact(input: {
  streamId: string
  artifactId: string
  logicalId: string
  title: string
  content: string
}) {
  artifactStore.start({
    artifactStreamId: input.streamId,
    generationId: `${input.streamId}-generation`,
    messageId: `${input.streamId}-message`,
    logicalId: input.logicalId,
    operation: 'create',
    artifactType: 'text/html',
    title: input.title,
    baseVersion: null,
    language: 'html',
    textStartIndex: 0,
    partOrder: 0,
  }, 'panel-pair-conversation')
  artifactStore.delta(input.streamId, input.content)
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  artifactStore.commit({
    artifactStreamId: input.streamId,
    artifactId: input.artifactId,
    logicalId: input.logicalId,
    version: 1,
  })
}

async function mountArtifactPair() {
  disposePanel?.()
  document.querySelector('#artifact-panel-test-root')?.remove()
  const root = document.createElement('div')
  root.id = 'artifact-panel-test-root'
  root.style.cssText = 'position:relative;display:flex;justify-content:flex-end;width:100vw;height:600px;overflow:hidden'
  document.body.append(root)
  disposePanel = render(() => createComponent(ArtifactSidePanel, {}), root)

  artifactStore.setVisibleConversation('panel-pair-catalog')
  await commitPanelArtifact({
    streamId: 'panel-pair-a-stream',
    artifactId: 'panel-pair-a',
    logicalId: 'panel-pair-a',
    title: 'Artifact A',
    content: '<h1 id="artifact-a-preview">Artifact A preview</h1>',
  })
  await commitPanelArtifact({
    streamId: 'panel-pair-b-stream',
    artifactId: 'panel-pair-b',
    logicalId: 'panel-pair-b',
    title: 'Artifact B',
    content: '<h1 id="artifact-b-preview">Artifact B preview</h1>',
  })
  artifactStore.setVisibleConversation('panel-pair-conversation')
  await artifactStore.open('panel-pair-a', 1)
  await new Promise((resolve) => window.setTimeout(resolve, 350))
}

async function openSecondArtifactPanel() {
  await artifactStore.open('panel-pair-b', 1)
  await new Promise((resolve) => window.setTimeout(resolve, 350))
}

Object.assign(window, {
  artifactSecurity: {
    buildHtmlSandboxDocument,
    sanitizeArtifactSvg,
    renderStrictMermaid,
    mountMarkdownFixture,
    mountCommittedArtifactPanel,
    switchArtifactPanelConversation,
    mountArtifactPair,
    openSecondArtifactPanel,
  },
})
