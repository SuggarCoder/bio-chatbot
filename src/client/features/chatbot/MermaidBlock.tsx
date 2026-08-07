import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  type Component,
} from 'solid-js'
import { Portal } from 'solid-js/web'

import { CodeBlock } from './CodeBlock'
import { renderStrictMermaid } from './mermaid'

type DiagramSize = { width: number; height: number }
type ViewportSize = { width: number; height: number }
type ViewerTransform = { scale: number; x: number; y: number }
type FitMode = 'auto' | 'screen' | 'width' | 'manual'

const VIEWER_PADDING = 24
const MIN_SCALE = 0.05
const MAX_SCALE = 6

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function constrainAxis(offset: number, contentSize: number, viewportSize: number) {
  if (contentSize <= viewportSize - VIEWER_PADDING * 2) {
    return (viewportSize - contentSize) / 2
  }
  return clamp(
    offset,
    viewportSize - contentSize - VIEWER_PADDING,
    VIEWER_PADDING,
  )
}

function constrainTransform(
  transform: ViewerTransform,
  diagram: DiagramSize,
  viewport: ViewportSize,
): ViewerTransform {
  return {
    ...transform,
    x: constrainAxis(
      transform.x,
      diagram.width * transform.scale,
      viewport.width,
    ),
    y: constrainAxis(
      transform.y,
      diagram.height * transform.scale,
      viewport.height,
    ),
  }
}

const MermaidPanZoomViewer: Component<{ svg: string }> = (props) => {
  const [diagram, setDiagram] = createSignal<DiagramSize>({ width: 1, height: 1 })
  const [transform, setTransform] = createSignal<ViewerTransform>({
    scale: 1,
    x: 0,
    y: 0,
  })
  const [fitMode, setFitMode] = createSignal<FitMode>('auto')
  const [dragging, setDragging] = createSignal(false)
  const zoomPercent = createMemo(() => Math.round(transform().scale * 100))
  let viewportRef: HTMLDivElement | undefined
  let contentRef: HTMLDivElement | undefined
  let resizeObserver: ResizeObserver | undefined
  let initializeFrame: number | undefined
  let dragOrigin: {
    pointerId: number
    clientX: number
    clientY: number
    x: number
    y: number
  } | undefined

  const viewportSize = (): ViewportSize => ({
    width: viewportRef?.clientWidth ?? 1,
    height: viewportRef?.clientHeight ?? 1,
  })

  const measureDiagram = (): DiagramSize => {
    const svgElement = contentRef?.querySelector('svg')
    const viewBox = svgElement?.viewBox.baseVal
    const width = viewBox?.width || Number.parseFloat(
      svgElement?.getAttribute('width') ?? '',
    ) || 800
    const height = viewBox?.height || Number.parseFloat(
      svgElement?.getAttribute('height') ?? '',
    ) || 600
    return { width, height }
  }

  const fit = (requestedMode: Exclude<FitMode, 'manual'>) => {
    const nextDiagram = measureDiagram()
    const viewport = viewportSize()
    const graphRatio = nextDiagram.width / nextDiagram.height
    const viewportRatio = viewport.width / viewport.height
    const resolvedMode = requestedMode === 'auto'
      ? graphRatio < viewportRatio * 0.55
        ? 'width'
        : 'screen'
      : requestedMode
    const availableWidth = Math.max(1, viewport.width - VIEWER_PADDING * 2)
    const availableHeight = Math.max(1, viewport.height - VIEWER_PADDING * 2)
    const scale = clamp(
      resolvedMode === 'width'
        ? availableWidth / nextDiagram.width
        : Math.min(
            availableWidth / nextDiagram.width,
            availableHeight / nextDiagram.height,
          ),
      MIN_SCALE,
      MAX_SCALE,
    )
    const next = constrainTransform({
      scale,
      x: (viewport.width - nextDiagram.width * scale) / 2,
      y: resolvedMode === 'width'
        ? VIEWER_PADDING
        : (viewport.height - nextDiagram.height * scale) / 2,
    }, nextDiagram, viewport)
    setDiagram(nextDiagram)
    setTransform(next)
    setFitMode(resolvedMode)
  }

  const zoomAt = (viewportX: number, viewportY: number, factor: number) => {
    const current = transform()
    const nextScale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE)
    if (nextScale === current.scale) return
    const worldX = (viewportX - current.x) / current.scale
    const worldY = (viewportY - current.y) / current.scale
    setTransform(constrainTransform({
      scale: nextScale,
      x: viewportX - worldX * nextScale,
      y: viewportY - worldY * nextScale,
    }, diagram(), viewportSize()))
    setFitMode('manual')
  }

  const zoomFromCenter = (factor: number) => {
    const viewport = viewportSize()
    zoomAt(viewport.width / 2, viewport.height / 2, factor)
  }

  const handleWheel = (event: WheelEvent) => {
    if (!viewportRef) return
    event.preventDefault()
    const bounds = viewportRef.getBoundingClientRect()
    zoomAt(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      Math.exp(-event.deltaY * 0.0015),
    )
  }

  const beginDrag = (
    event: PointerEvent & { currentTarget: HTMLDivElement },
  ) => {
    if (event.button !== 0) return
    event.preventDefault()
    const current = transform()
    dragOrigin = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      x: current.x,
      y: current.y,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }

  const moveDrag = (event: PointerEvent) => {
    if (!dragOrigin || event.pointerId !== dragOrigin.pointerId) return
    setTransform(constrainTransform({
      ...transform(),
      x: dragOrigin.x + event.clientX - dragOrigin.clientX,
      y: dragOrigin.y + event.clientY - dragOrigin.clientY,
    }, diagram(), viewportSize()))
    setFitMode('manual')
  }

  const endDrag = (
    event: PointerEvent & { currentTarget: HTMLDivElement },
  ) => {
    if (!dragOrigin || event.pointerId !== dragOrigin.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    dragOrigin = undefined
    setDragging(false)
  }

  onMount(() => {
    initializeFrame = requestAnimationFrame(() => fit('auto'))
    resizeObserver = new ResizeObserver(() => {
      const mode = fitMode()
      if (mode === 'manual') {
        setTransform((current) => constrainTransform(
          current,
          diagram(),
          viewportSize(),
        ))
      } else {
        fit(mode)
      }
    })
    if (viewportRef) resizeObserver.observe(viewportRef)
  })

  onCleanup(() => {
    if (initializeFrame !== undefined) cancelAnimationFrame(initializeFrame)
    resizeObserver?.disconnect()
  })

  return (
    <div class="relative min-h-0 flex-1 overflow-hidden bg-slate-50">
      <div
        ref={viewportRef}
        aria-label="Expanded Mermaid diagram canvas"
        class={`absolute inset-0 touch-none select-none overflow-hidden ${dragging() ? 'cursor-grabbing' : 'cursor-grab'}`}
        onWheel={handleWheel}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDblClick={() => fit('auto')}
      >
        <div
          ref={contentRef}
          class="absolute left-0 top-0 [&_svg]:block [&_svg]:h-full [&_svg]:w-full [&_svg]:max-w-none"
          style={{
            width: `${diagram().width}px`,
            height: `${diagram().height}px`,
            transform: `translate3d(${transform().x}px, ${transform().y}px, 0) scale(${transform().scale})`,
            'transform-origin': '0 0',
            'will-change': 'transform',
          }}
          innerHTML={props.svg}
        />
      </div>

      <div
        role="toolbar"
        aria-label="Mermaid zoom controls"
        class="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-slate-200/90 bg-white/95 p-1.5 shadow-lg backdrop-blur-xl"
      >
        <button
          type="button"
          class="grid h-8 w-8 place-items-center rounded-lg text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          aria-label="Zoom out Mermaid diagram"
          title="缩小"
          onClick={() => zoomFromCenter(1 / 1.2)}
        >
          <span aria-hidden="true" class="i-lucide-minus h-4 w-4" />
        </button>
        <output class="min-w-13 text-center text-xs font-semibold tabular-nums text-slate-600">
          {zoomPercent()}%
        </output>
        <button
          type="button"
          class="grid h-8 w-8 place-items-center rounded-lg text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          aria-label="Zoom in Mermaid diagram"
          title="放大"
          onClick={() => zoomFromCenter(1.2)}
        >
          <span aria-hidden="true" class="i-lucide-plus h-4 w-4" />
        </button>
        <span aria-hidden="true" class="mx-0.5 h-5 w-px bg-slate-200" />
        <button
          type="button"
          class="grid h-8 w-8 place-items-center rounded-lg text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          classList={{ 'bg-teal-50 text-teal-700': fitMode() === 'screen' }}
          aria-label="Fit Mermaid diagram to screen"
          title="适应窗口"
          onClick={() => fit('screen')}
        >
          <span aria-hidden="true" class="i-lucide-scan h-4 w-4" />
        </button>
        <button
          type="button"
          class="grid h-8 w-8 place-items-center rounded-lg text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
          classList={{ 'bg-teal-50 text-teal-700': fitMode() === 'width' }}
          aria-label="Fit Mermaid diagram to width"
          title="适应宽度"
          onClick={() => fit('width')}
        >
          <span aria-hidden="true" class="i-lucide-move-horizontal h-4 w-4" />
        </button>
      </div>

      <p class="pointer-events-none absolute bottom-5 left-5 m-0 hidden rounded-lg bg-white/85 px-2.5 py-1.5 text-[11px] font-medium text-slate-500 shadow-sm backdrop-blur sm:block">
        滚轮缩放 · 拖拽移动 · 双击重置
      </p>
    </div>
  )
}

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
  let dialogRef: HTMLElement | undefined
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
      } else if (event.key === 'Tab' && dialogRef) {
        const focusable = [...dialogRef.querySelectorAll<HTMLElement>(
          'button:not([disabled])',
        )]
        const first = focusable[0]
        const last = focusable.at(-1)
        if (
          event.shiftKey &&
          (document.activeElement === first || !dialogRef.contains(document.activeElement))
        ) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
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
              ref={dialogRef}
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
              <MermaidPanZoomViewer svg={svg()} />
            </section>
          </div>
        </Portal>
      </Show>
    </Show>
  )
}
