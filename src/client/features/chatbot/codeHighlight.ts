import type { HighlighterCore, ThemedToken } from 'shiki/core'

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
