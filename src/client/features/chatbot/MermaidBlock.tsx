import {
  createEffect,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
  type Component,
} from 'solid-js'

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
  let revision = 0

  createEffect(() => {
    const source = props.source
    const streaming = props.isStreaming ?? false
    const current = ++revision
    setActiveView('preview')
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
    </Show>
  )
}
