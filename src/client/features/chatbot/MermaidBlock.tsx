import {
  createEffect,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
  type Component,
} from 'solid-js'
import { Portal } from 'solid-js/web'

import { CodeBlock } from './CodeBlock'
import { renderStrictMermaid } from './mermaid'

export const MermaidBlock: Component<{
  source: string
  isStreaming?: boolean
}> = (props) => {
  const [activeView, setActiveView] = createSignal<'preview' | 'source'>('preview')
  const [svg, setSvg] = createSignal('')
  const [error, setError] = createSignal('')
  const [rendering, setRendering] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)
  let expandButtonRef: HTMLButtonElement | undefined
  let closeButtonRef: HTMLButtonElement | undefined
  let revision = 0

  createEffect(() => {
    const source = props.source
    const streaming = props.isStreaming ?? false
    const current = ++revision
    setActiveView('preview')
    setExpanded(false)
    setError('')

    if (streaming) {
      setSvg('')
      setRendering(false)
      return
    }

    setRendering(true)
    void renderStrictMermaid(source).then((result) => {
      if (current === revision) setSvg(result)
    }).catch((reason) => {
      if (current === revision) {
        setSvg('')
        setError(reason instanceof Error ? reason.message : 'Mermaid 渲染失败')
      }
    }).finally(() => {
      if (current === revision) setRendering(false)
    })
  })

  const openExpanded = () => {
    if (!svg() || rendering() || error()) return
    setExpanded(true)
    queueMicrotask(() => closeButtonRef?.focus())
  }

  const closeExpanded = () => {
    setExpanded(false)
    queueMicrotask(() => expandButtonRef?.focus())
  }

  createEffect(() => {
    if (!expanded()) return
    const previousOverflow = document.body.style.overflow
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeExpanded()
      } else if (event.key === 'Tab') {
        event.preventDefault()
        closeButtonRef?.focus()
      }
    }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handleKeyDown)
    onCleanup(() => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    })
  })

  onCleanup(() => {
    revision += 1
  })

  return (
    <Show
      when={!props.isStreaming}
      fallback={
        <CodeBlock
          code={props.source}
          language="mermaid"
          isStreaming
          showLineNumbers
        />
      }
    >
      <section class="inline-mermaid my-3 overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-[0_12px_32px_rgba(15,23,42,0.08)]">
        <nav class="flex h-12 items-center justify-between border-b border-slate-200/80 bg-slate-50/85 px-4 backdrop-blur-xl">
          <span class="inline-flex items-center gap-2 text-xs font-semibold text-slate-700">
            <span aria-hidden="true" class="i-lucide-git-fork h-4 w-4 text-teal-700" />
            Mermaid 图形
          </span>
          <div class="flex items-center gap-1 rounded-xl bg-white/90 p-1 shadow-sm ring-1 ring-slate-200/90">
            <button
              type="button"
              class={activeView() === 'preview'
                ? 'rounded-lg bg-teal-600 px-2.5 py-1.5 text-xs font-medium text-white shadow-sm'
                : 'rounded-lg px-2.5 py-1.5 text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-800'}
              aria-label="Mermaid 图形"
              aria-pressed={activeView() === 'preview'}
              onClick={() => setActiveView('preview')}
            >
              图形
            </button>
            <button
              type="button"
              class={activeView() === 'source'
                ? 'rounded-lg bg-teal-600 px-2.5 py-1.5 text-xs font-medium text-white shadow-sm'
                : 'rounded-lg px-2.5 py-1.5 text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-800'}
              aria-label="Mermaid 源码"
              aria-pressed={activeView() === 'source'}
              onClick={() => setActiveView('source')}
            >
              源码
            </button>
            <span aria-hidden="true" class="mx-0.5 h-4 w-px bg-slate-200" />
            <button
              ref={expandButtonRef}
              type="button"
              class="grid h-7 w-7 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35"
              aria-label="Expand Mermaid diagram"
              disabled={!svg() || rendering() || Boolean(error())}
              onClick={openExpanded}
            >
              <span aria-hidden="true" class="i-lucide-maximize-2 h-3.5 w-3.5" />
            </button>
          </div>
        </nav>
        <Switch>
          <Match when={activeView() === 'preview'}>
            <Show when={!rendering()} fallback={
              <p role="status" class="m-0 p-5 text-sm text-slate-500">正在渲染 Mermaid...</p>
            }>
              <Show when={!error()} fallback={
                <div class="p-5">
                  <p role="alert" class="m-0 text-sm text-rose-600">Mermaid 渲染失败：{error()}</p>
                  <button
                    type="button"
                    class="mt-3 text-sm font-medium text-teal-700 hover:text-teal-800"
                    onClick={() => setActiveView('source')}
                  >
                    查看源码
                  </button>
                </div>
              }>
                <div
                  aria-label="Mermaid 图形画布"
                  class="gpas-scrollbar scrollbar-fade grid min-h-56 place-items-center overflow-auto bg-slate-50/70 p-5 sm:p-7"
                  innerHTML={svg()}
                />
              </Show>
            </Show>
          </Match>
          <Match when={activeView() === 'source'}>
            <CodeBlock
              class="rounded-none border-0"
              code={props.source}
              language="mermaid"
              showLineNumbers
            />
          </Match>
        </Switch>
      </section>

      <Show when={expanded()}>
        <Portal>
          <div
            class="fixed inset-0 z-[100] flex bg-slate-950/70 p-3 backdrop-blur-sm sm:p-6"
            onClick={(event) => {
              if (event.target === event.currentTarget) closeExpanded()
            }}
          >
            <section
              role="dialog"
              aria-modal="true"
              aria-label="Expanded Mermaid diagram"
              class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-white/20"
            >
              <header class="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-5">
                <span class="inline-flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <span aria-hidden="true" class="i-lucide-git-fork h-4 w-4 text-teal-700" />
                  Mermaid 图形
                </span>
                <button
                  ref={closeButtonRef}
                  type="button"
                  class="grid h-9 w-9 place-items-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                  aria-label="Close expanded Mermaid diagram"
                  onClick={closeExpanded}
                >
                  <span aria-hidden="true" class="i-lucide-x h-5 w-5" />
                </button>
              </header>
              <div class="gpas-scrollbar scrollbar-fade grid min-h-0 flex-1 place-items-center overflow-auto bg-slate-50 p-4 sm:p-8">
                <div
                  aria-label="Expanded Mermaid diagram canvas"
                  class="grid h-full min-h-full w-full min-w-full place-items-center [&_svg]:h-full [&_svg]:max-h-full [&_svg]:w-full [&_svg]:max-w-full"
                  innerHTML={svg()}
                />
              </div>
            </section>
          </div>
        </Portal>
      </Show>
    </Show>
  )
}
