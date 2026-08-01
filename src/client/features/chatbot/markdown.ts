import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { lexer, marked, Renderer } from 'marked'

import { recordStreamOperation } from './streamMetrics'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('css', css)
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function renderMarkdown(source: string, generationId?: string) {
  const renderer = new Renderer()

  renderer.html = ({ text }) => `<p>${escapeHtml(text)}</p>`
  renderer.code = ({ text, lang }) => {
    const language = lang?.trim().toLowerCase().split(/\s+/)[0]
    const start = performance.now()
    const highlighted = language && hljs.getLanguage(language)
      ? hljs.highlight(text, {
          language,
          ignoreIllegals: true,
        }).value
      : escapeHtml(text)

    if (generationId) {
      recordStreamOperation(generationId, {
        type: 'highlight',
        duration: performance.now() - start,
        detail: language || 'plain',
      })
    }

    const languageClass = language && hljs.getLanguage(language)
      ? ` language-${language}`
      : ''
    return `<pre><code class="hljs${languageClass}">${highlighted}</code></pre>`
  }

  const start = performance.now()
  const rendered = marked.parse(source, {
    async: false,
    breaks: false,
    gfm: true,
    renderer,
  })
  const clean = DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      'script',
      'style',
      'iframe',
      'object',
      'embed',
      'form',
    ],
    FORBID_ATTR: ['style'],
  })

  if (generationId) {
    recordStreamOperation(generationId, {
      type: 'markdown',
      duration: performance.now() - start,
      detail: `${source.length} chars`,
    })
  }

  return String(clean)
}

function hasClosedFence(source: string) {
  const lines = source.split('\n')
  let fence: { character: '`' | '~'; length: number } | undefined

  for (const line of lines) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line)

    if (!match) continue
    const character = match[1][0] as '`' | '~'

    if (!fence) {
      fence = { character, length: match[1].length }
    } else if (
      character === fence.character &&
      match[1].length >= fence.length &&
      /^\s*$/.test(line.slice(match[0].length))
    ) {
      fence = undefined
    }
  }

  return !fence && /(?:^|\n)\s{0,3}(`{3,}|~{3,})\s*\n?$/.test(source)
}

export function stableMarkdownPrefixLength(source: string) {
  if (!source) return 0
  const tokens = lexer(source, { gfm: true })

  if (tokens.length === 0) return 0
  const last = tokens.at(-1)
  let stableTokens = tokens.length - 1

  if (last?.type === 'space') {
    stableTokens = tokens.length - 1
  } else if (
    last?.type === 'heading' &&
    /\n$/.test(last.raw)
  ) {
    stableTokens = tokens.length
  } else if (
    last?.type === 'code' &&
    hasClosedFence(last.raw)
  ) {
    stableTokens = tokens.length
  }

  let length = 0

  for (let index = 0; index < stableTokens; index += 1) {
    length += tokens[index].raw.length
  }

  return length
}
