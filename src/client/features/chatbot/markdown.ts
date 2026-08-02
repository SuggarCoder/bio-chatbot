import { lexer } from 'marked'

export function normalizeMarkdownLanguage(language?: string) {
  return language?.trim().toLowerCase().split(/\s+/)[0]
}

export type StreamingMarkdownTail =
  | {
      kind: 'text'
      source: string
    }
  | {
      kind: 'code'
      code: string
      language?: string
      remainder: string
      closed: boolean
    }

export function parseStreamingMarkdownTail(
  source: string,
): StreamingMarkdownTail {
  const opening = /^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/.exec(source)

  if (!opening) return { kind: 'text', source }

  const fence = opening[1]
  const info = opening[2]

  if (fence[0] === '`' && info.includes('`')) {
    return { kind: 'text', source }
  }

  const body = source.slice(opening[0].length)
  const fenceCharacter = fence[0] === '`' ? '`' : '~'
  const closingPattern = new RegExp(
    `(?:^|\\n) {0,3}${fenceCharacter}{${fence.length},}[ \\t]*(?=\\n|$)`,
  )
  const closing = closingPattern.exec(body)
  const language = normalizeMarkdownLanguage(info)

  if (!closing) {
    return {
      kind: 'code',
      code: body,
      language,
      remainder: '',
      closed: false,
    }
  }

  let remainderStart = closing.index + closing[0].length

  if (body[remainderStart] === '\n') remainderStart += 1

  return {
    kind: 'code',
    code: body.slice(0, closing.index),
    language,
    remainder: body.slice(remainderStart),
    closed: true,
  }
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
