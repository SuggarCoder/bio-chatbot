import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import './main.css'

import {
  buildHtmlSandboxDocument,
  HTML_ARTIFACT_SANDBOX,
  sanitizeArtifactSvg,
} from './features/artifacts/renderers'
import { createComponent } from 'solid-js'
import { render } from 'solid-js/web'
import { ArtifactSidePanel } from './features/artifacts/ArtifactSidePanel'
import { artifactStore } from './features/artifacts/artifactStore'
import { sanitizeMermaidSvg } from './features/artifacts/sanitizeSvg'
import { MarkdownContent } from './features/chatbot/MarkdownContent'
import { renderStrictMermaid } from './features/chatbot/mermaid'

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

async function mountArtifactPanelFixture(input: {
  suffix: string
  type: 'text/html' | 'image/svg+xml' | 'text/markdown'
  title: string
  content: string
}) {
  disposePanel?.()
  document.querySelector('#artifact-panel-test-root')?.remove()
  const root = document.createElement('div')
  root.id = 'artifact-panel-test-root'
  root.style.cssText = 'position:relative;display:flex;justify-content:flex-end;width:100vw;height:600px;overflow:hidden'
  document.body.append(root)
  disposePanel = render(() => createComponent(ArtifactSidePanel, {}), root)
  const conversationId = `panel-test-${input.suffix}-conversation`
  const streamId = `panel-test-${input.suffix}-stream`
  artifactStore.setVisibleConversation(conversationId)
  artifactStore.start({
    artifactStreamId: streamId,
    generationId: `panel-test-${input.suffix}-generation`,
    messageId: `panel-test-${input.suffix}-message`,
    logicalId: `panel-test-${input.suffix}`,
    operation: 'create',
    artifactType: input.type,
    title: input.title,
    baseVersion: null,
    language: input.type === 'text/html' ? 'html' : null,
    textStartIndex: 0,
    partOrder: 0,
  }, conversationId)
  artifactStore.delta(streamId, input.content)
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  artifactStore.commit({
    artifactStreamId: streamId,
    artifactId: `panel-test-${input.suffix}-artifact`,
    logicalId: `panel-test-${input.suffix}`,
    version: 1,
  })
  await new Promise((resolve) => window.setTimeout(resolve, 350))
}

async function mountCommittedArtifactPanel() {
  await mountArtifactPanelFixture({
    suffix: 'html',
    type: 'text/html',
    title: 'Panel test',
    content: '<h1 id="panel-test-content">Visible content</h1>\n<p>Second line</p>',
  })
}

async function mountSandboxCapabilityPanel() {
  await mountArtifactPanelFixture({
    suffix: 'sandbox-capabilities',
    type: 'text/html',
    title: 'Sandbox capability test',
    content: [
      '<button id="artifact-modal-fixture" onclick="alert(\'Artifact modal\')">Open modal</button>',
      '<a id="artifact-download-fixture" download="artifact-download.txt">Download fixture</a>',
      '<script>document.querySelector(\'#artifact-download-fixture\').href = URL.createObjectURL(new Blob([\'Artifact download\'], { type: \'text/plain\' }))</script>',
    ].join(''),
  })
}

async function mountSvgArtifactPanel() {
  await mountArtifactPanelFixture({
    suffix: 'svg',
    type: 'image/svg+xml',
    title: 'SVG panel test',
    content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8"/></svg>',
  })
}

async function mountMarkdownArtifactPanel() {
  await mountArtifactPanelFixture({
    suffix: 'markdown',
    type: 'text/markdown',
    title: 'Markdown panel test',
    content: '# Markdown preview\n\nRich **content**',
  })
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
    htmlArtifactSandbox: HTML_ARTIFACT_SANDBOX,
    sanitizeArtifactSvg,
    sanitizeMermaidSvg,
    renderStrictMermaid,
    mountMarkdownFixture,
    mountCommittedArtifactPanel,
    mountSandboxCapabilityPanel,
    mountSvgArtifactPanel,
    mountMarkdownArtifactPanel,
    switchArtifactPanelConversation,
    mountArtifactPair,
    openSecondArtifactPanel,
  },
})
