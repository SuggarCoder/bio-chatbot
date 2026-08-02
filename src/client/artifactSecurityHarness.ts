import {
  buildHtmlSandboxDocument,
  renderStrictMermaid,
  sanitizeArtifactSvg,
} from './features/artifacts/renderers'
import { renderMarkdown } from './features/chatbot/markdown'

Object.assign(window, {
  artifactSecurity: {
    buildHtmlSandboxDocument,
    sanitizeArtifactSvg,
    renderStrictMermaid,
    renderMarkdown,
  },
})
