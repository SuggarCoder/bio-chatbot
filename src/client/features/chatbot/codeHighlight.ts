import type { HighlighterCore, ThemedToken } from 'shiki/core'

import { hashString, LruCache } from './lru'

export const STREAMING_HIGHLIGHT_MAX_CHARS = 128 * 1024
export const STATIC_HIGHLIGHT_MAX_CHARS = 256 * 1024

export type CodeToken = Pick<
  ThemedToken,
  'content' | 'color' | 'bgColor' | 'fontStyle'
>

export type HighlightedCode = {
  source: string
  language: string | null
  lines: CodeToken[][]
  highlighted: boolean
}

const languageAliases: Record<string, string> = {
  bash: 'bash',
  css: 'css',
  docker: 'dockerfile',
  dockerfile: 'dockerfile',
  htm: 'html',
  html: 'html',
  js: 'javascript',
  javascript: 'javascript',
  jsx: 'jsx',
  json: 'json',
  markdown: 'markdown',
  md: 'markdown',
  mermaid: 'mermaid',
  plaintext: 'plaintext',
  py: 'python',
  python: 'python',
  sh: 'bash',
  shell: 'bash',
  sql: 'sql',
  svg: 'xml',
  text: 'plaintext',
  txt: 'plaintext',
  ts: 'typescript',
  tsx: 'tsx',
  typescript: 'typescript',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
}

const languageLoaders: Record<
  string,
  () => Promise<{ default: unknown }>
> = {
  bash: () => import('shiki/langs/bash.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  mermaid: () => import('shiki/langs/mermaid.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
}

let highlighterPromise: Promise<HighlighterCore> | undefined
const languagePromises = new Map<string, Promise<void>>()

export function normalizeCodeLanguage(language?: string): string | null {
  const normalized = language
    ?.trim()
    .toLowerCase()
    .match(/^[a-z0-9_+-]+/)?.[0]
  if (!normalized) return null
  return languageAliases[normalized] ?? null
}

export function splitCodeLines(source: string): string[] {
  return source.split(/\r\n|\r|\n/)
}

export function plainHighlightedCode(
  source: string,
  language?: string,
): HighlightedCode {
  return {
    source,
    language: normalizeCodeLanguage(language),
    lines: splitCodeLines(source).map((line) => [{ content: line }]),
    highlighted: false,
  }
}

async function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
    import('shiki/themes/github-dark-default.mjs'),
  ]).then(([core, engine, theme]) => core.createHighlighterCore({
    engine: engine.createJavaScriptRegexEngine(),
    themes: [theme.default],
    langs: [],
    warnings: false,
  }))
  return highlighterPromise
}

async function ensureLanguage(
  highlighter: HighlighterCore,
  language: string,
): Promise<void> {
  if (highlighter.getLoadedLanguages().includes(language)) return
  let pending = languagePromises.get(language)
  if (!pending) {
    const loader = languageLoaders[language]
    if (!loader) return
    pending = loader().then((module) => highlighter.loadLanguage(
      module.default as Parameters<HighlighterCore['loadLanguage']>[0],
    ))
    languagePromises.set(language, pending)
  }
  await pending
}

export async function highlightCodeWithShiki(
  source: string,
  language?: string,
): Promise<HighlightedCode> {
  const normalized = normalizeCodeLanguage(language)
  if (!normalized || normalized === 'plaintext') {
    return plainHighlightedCode(source, language)
  }

  try {
    const highlighter = await getHighlighter()
    await ensureLanguage(highlighter, normalized)
    if (!highlighter.getLoadedLanguages().includes(normalized)) {
      return plainHighlightedCode(source, language)
    }
    const result = highlighter.codeToTokens(source, {
      lang: normalized,
      theme: 'github-dark-default',
      tokenizeMaxLineLength: 20_000,
      tokenizeTimeLimit: 100,
    })
    return {
      source,
      language: normalized,
      lines: result.tokens.length > 0 ? result.tokens : [[]],
      highlighted: true,
    }
  } catch {
    return plainHighlightedCode(source, language)
  }
}

function sameToken(left: CodeToken, right: CodeToken) {
  return left.content === right.content &&
    left.color === right.color &&
    left.bgColor === right.bgColor &&
    (left.fontStyle ?? 0) === (right.fontStyle ?? 0)
}

export function sameCodeLine(left: CodeToken[], right: CodeToken[]) {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (!sameToken(left[index], right[index])) return false
  }
  return true
}

/**
 * Returns `next` with every line that equals the line at the same index in
 * `previous` replaced by that previous array, so the rendered list keeps the
 * DOM of unchanged lines (a streaming block only changes its last lines).
 */
export function reuseUnchangedLines(
  previous: readonly CodeToken[][],
  next: CodeToken[][],
): CodeToken[][] {
  return next.map((line, index) => {
    const before = previous[index]
    return before && sameCodeLine(before, line) ? before : line
  })
}

/** Finished highlights, so remounting a block (switching back to a conversation) costs nothing. */
const highlightCache = new LruCache<string, HighlightedCode>(100)

function highlightCacheKey(source: string, language?: string) {
  return `${normalizeCodeLanguage(language) ?? ''}:${source.length}:${hashString(source)}`
}

export function cachedHighlight(
  source: string,
  language?: string,
): HighlightedCode | undefined {
  const hit = highlightCache.get(highlightCacheKey(source, language))
  return hit && hit.source === source ? hit : undefined
}

export function rememberHighlight(result: HighlightedCode, language?: string) {
  if (!result.highlighted) return
  highlightCache.set(highlightCacheKey(result.source, language), result)
}
