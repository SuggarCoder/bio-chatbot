import { createMemo, For, Show, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { lexer, type Token, type Tokens } from 'marked'

import { CodeBlock } from './CodeBlock'
import { MermaidBlock } from './MermaidBlock'
import { parseMarkdownFenceInfo } from './markdown'

function safeLinkUri(href: string): string | null {
  try {
    const url = new URL(href, 'https://artifact.invalid/')
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : null
  } catch {
    return null
  }
}

function safeImageUri(src: string): string | null {
  return /^(?:data:image\/(?:png|gif|jpeg|webp);base64,|blob:)/i.test(src)
    ? src
    : null
}

function childTokens(token: Token): Token[] {
  if (!('tokens' in token) || !Array.isArray(token.tokens)) {
    return []
  }

  return token.tokens
}

function tokenText(token: Token): string {
  if (!('text' in token) || typeof token.text !== 'string') {
    return ''
  }

  return token.text
}

function TokenList(props: { tokens: Token[] }) {
  return <For each={props.tokens}>{(token) => <MarkdownToken token={token} />}</For>
}

function TableCell(props: {
  cell: Tokens.TableCell
  header: boolean
}) {
  const component = props.header ? 'th' : 'td'
  return (
    <Dynamic
      component={component}
      style={{ 'text-align': props.cell.align ?? undefined }}
    >
      <TokenList tokens={props.cell.tokens} />
    </Dynamic>
  )
}

function MarkdownToken(props: { token: Token }): JSX.Element {
  const token = props.token

  switch (token.type) {
    case 'space':
    case 'def':
    case 'html':
      return null
    case 'hr':
      return <hr />
    case 'br':
      return <br />
    case 'code': {
      const info = parseMarkdownFenceInfo(token.lang)
      return info.language === 'mermaid'
        ? <MermaidBlock source={token.text} />
        : (
            <CodeBlock
              code={token.text}
              filename={info.filename}
              language={info.language}
              showLineNumbers
            />
          )
    }
    case 'codespan':
      return <code>{token.text}</code>
    case 'blockquote':
      return <blockquote><TokenList tokens={childTokens(token)} /></blockquote>
    case 'heading': {
      const component = `h${Math.min(6, Math.max(1, token.depth))}` as keyof JSX.IntrinsicElements
      return <Dynamic component={component}><TokenList tokens={childTokens(token)} /></Dynamic>
    }
    case 'paragraph':
      return <p><TokenList tokens={childTokens(token)} /></p>
    case 'text':
      return childTokens(token).length > 0
        ? <TokenList tokens={childTokens(token)} />
        : tokenText(token)
    case 'escape':
      return token.text
    case 'strong':
      return <strong><TokenList tokens={childTokens(token)} /></strong>
    case 'em':
      return <em><TokenList tokens={childTokens(token)} /></em>
    case 'del':
      return <del><TokenList tokens={childTokens(token)} /></del>
    case 'link': {
      const href = safeLinkUri(token.href)
      return href
        ? (
            <a
              href={href}
              title={token.title ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              <TokenList tokens={childTokens(token)} />
            </a>
          )
        : <TokenList tokens={childTokens(token)} />
    }
    case 'image': {
      const src = safeImageUri(token.href)
      return src
        ? <img src={src} alt={token.text} title={token.title ?? undefined} />
        : token.text
    }
    case 'list': {
      const component = token.ordered ? 'ol' : 'ul'
      return (
        <Dynamic component={component} start={token.ordered && token.start !== '' ? token.start : undefined}>
          <For each={token.items}>
            {(item) => (
              <li>
                <Show when={item.task}>
                  <input
                    type="checkbox"
                    checked={item.checked}
                    disabled
                    aria-label={item.checked ? 'Completed task' : 'Incomplete task'}
                  />
                </Show>
                <TokenList tokens={item.tokens} />
              </li>
            )}
          </For>
        </Dynamic>
      )
    }
    case 'list_item':
      return <li><TokenList tokens={childTokens(token)} /></li>
    case 'table':
      return (
        <table>
          <thead>
            <tr>
              <For each={token.header}>
                {(cell) => <TableCell cell={cell} header />}
              </For>
            </tr>
          </thead>
          <tbody>
            <For each={token.rows}>
              {(row) => (
                <tr>
                  <For each={row}>
                    {(cell) => <TableCell cell={cell} header={false} />}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      )
    default:
      return childTokens(token).length > 0
        ? <TokenList tokens={childTokens(token)} />
        : tokenText(token)
  }
}

export function MarkdownContent(props: {
  source: string
  class?: string
}) {
  const tokens = createMemo(() => lexer(props.source, {
    gfm: true,
    breaks: false,
  }))

  return (
    <div class={`markdown-message ${props.class ?? ''}`}>
      <TokenList tokens={tokens()} />
    </div>
  )
}
