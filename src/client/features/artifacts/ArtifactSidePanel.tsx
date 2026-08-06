import { gsap } from 'gsap'
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Match,
  Show,
  Switch,
  untrack,
  type Component,
} from 'solid-js'
import { Tooltip } from '../../shared/ui/Tooltip'
import { ArtifactSourceView } from './ArtifactSourceView'
import { artifactStore } from './artifactStore'
import { artifactRenderers, UnsupportedArtifactRenderer } from './renderers'
import { artifactMimeTypes } from './types'

type PanelPhase = 'closed' | 'opening' | 'open' | 'closing'

export const ArtifactSidePanel: Component = () => {
  const state = artifactStore.state
  const [mounted, setMounted] = createSignal(false)
  const [phase, setPhase] = createSignal<PanelPhase>('closed')
  const [isDesktop, setIsDesktop] = createSignal(false)
  const [notice, setNotice] = createSignal('')
  let slotRef: HTMLDivElement | undefined
  let panelRef: HTMLElement | undefined
  let timeline: gsap.core.Timeline | undefined
  let animationRevision = 0
  let stopResize: (() => void) | undefined
  let desktopQuery: MediaQueryList | undefined
  let reducedMotionQuery: MediaQueryList | undefined
  let noticeTimer: number | undefined

  const artifact = createMemo(() => state.activeArtifactId
    ? state.artifactsById[state.activeArtifactId]
    : undefined)
  const type = () => artifact()?.type
  const title = () => artifact()?.title ?? 'Artifact'
  const version = () => state.activeVersion ?? artifact()?.currentVersion ?? 1
  const renderer = createMemo(() => {
    const current = type()
    return current && artifactMimeTypes.includes(current)
      ? artifactRenderers[current]
      : undefined
  })
  const panelWidth = () => isDesktop()
    ? `${state.panelWidth}px`
    : `min(100vw, ${state.panelWidth}px)`
  const prefersReducedMotion = () => reducedMotionQuery?.matches ?? false

  const finishClosed = (revision: number) => {
    if (revision !== animationRevision) return
    setPhase('closed')
    setMounted(false)
    artifactStore.completePanelClose()
  }

  const playOpen = (revision: number, initialize: boolean) => {
    if (
      revision !== animationRevision ||
      !slotRef ||
      !panelRef ||
      !state.isPanelOpen
    ) return
    timeline?.kill()
    if (initialize) {
      gsap.set(panelRef, { xPercent: 100, opacity: 0 })
      if (isDesktop()) gsap.set(slotRef, { width: 0 })
    }
    setPhase('opening')
    if (prefersReducedMotion()) {
      gsap.set(panelRef, { xPercent: 0, opacity: 1 })
      gsap.set(slotRef, { width: isDesktop() ? state.panelWidth : '100%' })
      setPhase('open')
      return
    }
    timeline = gsap.timeline({
      onComplete: () => {
        if (revision === animationRevision) setPhase('open')
      },
    })
    if (isDesktop()) {
      timeline.to(slotRef, {
        width: state.panelWidth,
        duration: 0.24,
        ease: 'power2.out',
      }, 0)
    } else {
      gsap.set(slotRef, { width: '100%' })
    }
    timeline.to(panelRef, {
      xPercent: 0,
      opacity: 1,
      duration: 0.24,
      ease: 'power2.out',
    }, 0)
  }

  const requestOpen = () => {
    const revision = ++animationRevision
    const initialize = !mounted()
    if (initialize) setMounted(true)
    queueMicrotask(() => playOpen(revision, initialize))
  }

  const requestClose = () => {
    const revision = ++animationRevision
    if (!mounted() || !slotRef || !panelRef) {
      setPhase('closed')
      setMounted(false)
      artifactStore.completePanelClose()
      return
    }
    timeline?.kill()
    setPhase('closing')
    if (prefersReducedMotion()) {
      gsap.set(panelRef, { xPercent: 100, opacity: 0 })
      if (isDesktop()) gsap.set(slotRef, { width: 0 })
      finishClosed(revision)
      return
    }
    timeline = gsap.timeline({
      onComplete: () => finishClosed(revision),
    })
    if (isDesktop()) {
      timeline.to(slotRef, {
        width: 0,
        duration: 0.2,
        ease: 'power2.in',
      }, 0)
    }
    timeline.to(panelRef, {
      xPercent: 100,
      opacity: 0,
      duration: 0.2,
      ease: 'power2.in',
    }, 0)
  }

  createEffect(() => {
    const shouldOpen = state.isPanelOpen
    untrack(() => {
      if (shouldOpen) requestOpen()
      else requestClose()
    })
  })

  createEffect(() => {
    const width = state.panelWidth
    if (
      mounted() &&
      phase() === 'open' &&
      isDesktop() &&
      slotRef
    ) {
      gsap.set(slotRef, { width })
    }
  })

  onMount(() => {
    desktopQuery = window.matchMedia('(min-width: 1024px)')
    reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handleViewportChange = () => {
      setIsDesktop(desktopQuery?.matches ?? false)
      timeline?.kill()
      if (!slotRef || !panelRef || !mounted()) return
      gsap.set(slotRef, {
        width: state.isPanelOpen && desktopQuery?.matches
          ? state.panelWidth
          : desktopQuery?.matches
            ? 0
            : '100%',
      })
      gsap.set(panelRef, {
        xPercent: state.isPanelOpen ? 0 : 100,
        opacity: state.isPanelOpen ? 1 : 0,
      })
      if (state.isPanelOpen) setPhase('open')
      else finishClosed(animationRevision)
    }
    handleViewportChange()
    desktopQuery.addEventListener('change', handleViewportChange)
    onCleanup(() => desktopQuery?.removeEventListener('change', handleViewportChange))
  })

  onCleanup(() => {
    animationRevision += 1
    stopResize?.()
    if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
    timeline?.kill()
    if (slotRef) gsap.killTweensOf(slotRef)
    if (panelRef) gsap.killTweensOf(panelRef)
  })

  const resizeBounds = () => {
    const slotWidth = slotRef?.getBoundingClientRect().width ?? state.panelWidth
    const mainWidth = slotRef?.previousElementSibling?.getBoundingClientRect().width
    const availableWidth = mainWidth === undefined
      ? slotRef?.parentElement?.getBoundingClientRect().width ?? window.innerWidth
      : mainWidth + slotWidth

    return {
      min: 360,
      max: Math.max(360, Math.min(840, availableWidth - 360)),
    }
  }

  const setConstrainedWidth = (width: number) => {
    const bounds = resizeBounds()
    artifactStore.setWidth(Math.min(bounds.max, Math.max(bounds.min, width)))
  }

  const beginResize = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (!isDesktop() || event.button !== 0) return
    event.preventDefault()
    stopResize?.()
    const startX = event.clientX
    const startWidth = state.panelWidth
    const pointerId = event.pointerId
    const handle = event.currentTarget
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    handle.setPointerCapture(pointerId)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return
      setConstrainedWidth(startWidth + startX - next.clientX)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('blur', stop)
      if (handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId)
      }
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      stopResize = undefined
    }
    stopResize = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('blur', stop)
  }

  const resizeWithKeyboard = (event: KeyboardEvent) => {
    const bounds = resizeBounds()
    const nextWidth = event.key === 'ArrowLeft'
      ? state.panelWidth + 16
      : event.key === 'ArrowRight'
        ? state.panelWidth - 16
        : event.key === 'Home'
          ? bounds.min
          : event.key === 'End'
            ? bounds.max
            : undefined
    if (nextWidth === undefined) return
    event.preventDefault()
    setConstrainedWidth(nextWidth)
  }

  const showDownloadUnavailable = () => {
    setNotice('下载功能暂未开放')
    if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(() => {
      setNotice('')
      noticeTimer = undefined
    }, 1_800)
  }

  return (
    <Show when={mounted()}>
      <div
        ref={slotRef}
        class="absolute inset-0 z-40 h-full overflow-visible lg:relative lg:inset-auto lg:z-auto lg:shrink-0"
        classList={{ 'pointer-events-none': phase() === 'closing' }}
        aria-hidden={phase() === 'closing' ? 'true' : undefined}
      >
        <div
          role="separator"
          aria-label="Resize Artifact panel"
          aria-orientation="vertical"
          aria-valuemin={resizeBounds().min}
          aria-valuemax={resizeBounds().max}
          aria-valuenow={state.panelWidth}
          tabIndex={0}
          class="group absolute inset-y-0 -left-1 z-30 hidden w-2 touch-none cursor-col-resize place-items-center outline-none print:hidden lg:grid"
          onPointerDown={beginResize}
          onKeyDown={resizeWithKeyboard}
        >
          <div class="absolute bottom-0 right-1 top-0 w-[0.5px] bg-slate-300 transition-all group-hover:w-px group-hover:translate-x-[0.5px] group-hover:bg-teal-300 group-focus-visible:w-px group-focus-visible:bg-teal-400" />
          <div class="relative h-6 w-2 cursor-col-resize rounded-full border border-slate-300 bg-white shadow transition duration-200 group-hover:border-teal-700 group-hover:bg-teal-700 group-focus-visible:border-teal-700 group-focus-visible:bg-teal-700" />
        </div>
        <aside
          ref={panelRef}
          class="absolute inset-y-0 right-0 flex min-w-0 flex-col border-l border-slate-200 bg-white opacity-0 shadow-2xl will-change-transform"
          style={{ width: panelWidth() }}
          aria-label="Artifact panel"
        >
          <nav class="relative z-20 flex h-16 shrink-0 items-center gap-3 bg-slate-50/85 px-3 backdrop-blur-xl">
            <Show when={type() === 'text/html'}>
              <div class="flex shrink-0 items-center gap-1 rounded-xl bg-white/55 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_1px_8px_rgba(15,23,42,0.06)] ring-1 ring-white/90">
                <Tooltip content="Preview" placement="bottom">
                  <button
                    type="button"
                    aria-label="Preview"
                    aria-pressed={state.activeTab === 'preview'}
                    class={
                      state.activeTab === 'preview'
                        ? 'grid h-8 w-8 place-items-center rounded-lg bg-white text-teal-700 shadow-sm ring-1 ring-slate-200/70 transition'
                        : 'grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-white/80 hover:text-slate-800'
                    }
                    onClick={() => artifactStore.setTab('preview')}
                  >
                    <span aria-hidden="true" class="i-lucide-eye h-4 w-4" />
                  </button>
                </Tooltip>
                <Tooltip content="Code" placement="bottom">
                  <button
                    type="button"
                    aria-label="Code"
                    aria-pressed={state.activeTab === 'code'}
                    class={
                      state.activeTab === 'code'
                        ? 'grid h-8 w-8 place-items-center rounded-lg bg-white text-teal-700 shadow-sm ring-1 ring-slate-200/70 transition'
                        : 'grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-white/80 hover:text-slate-800'
                    }
                    onClick={() => artifactStore.setTab('code')}
                  >
                    <span aria-hidden="true" class="i-lucide-code-2 h-4 w-4" />
                  </button>
                </Tooltip>
              </div>
            </Show>

            <div class="min-w-0 flex-1">
              <h2 class="truncate text-sm font-semibold text-slate-900">{title()}</h2>
              <p class="truncate text-[11px] font-medium text-slate-500">Version {version()}</p>
            </div>

            <div class="flex shrink-0 items-center gap-1">
              <Tooltip content="Download" placement="bottom">
                <button
                  type="button"
                  class="grid h-9 w-9 place-items-center rounded-full text-slate-500 transition hover:bg-white/90 hover:text-slate-800 hover:shadow-sm"
                  onClick={showDownloadUnavailable}
                  aria-label="Download Artifact"
                >
                  <span class="i-lucide-download h-4 w-4" />
                </button>
              </Tooltip>
              <Tooltip content="Close" placement="bottom">
                <button
                  type="button"
                  class="grid h-9 w-9 place-items-center rounded-full text-slate-500 transition hover:bg-white/90 hover:text-slate-800 hover:shadow-sm"
                  onClick={() => artifactStore.close()}
                  aria-label="Close Artifact panel"
                >
                  <span class="i-lucide-x h-4 w-4" />
                </button>
              </Tooltip>
            </div>

            <Show when={notice()}>
              {(message) => (
                <div
                  role="status"
                  aria-live="polite"
                  class="absolute right-3 top-[calc(100%+0.5rem)] rounded-xl border border-white/80 bg-white/90 px-3 py-2 text-xs font-medium text-slate-700 shadow-lg backdrop-blur-xl"
                >
                  {message()}
                </div>
              )}
            </Show>
          </nav>
          <div class="gpas-scrollbar scrollbar-fade min-h-0 flex-1 overflow-auto bg-slate-50">
            <Show when={artifact()} keyed>
              {(activeArtifact) => (
                <Switch>
                  <Match when={state.activeTab === 'preview'}>
                    <Show when={renderer()} fallback={<UnsupportedArtifactRenderer type={activeArtifact.type} />}>
                      {(definition) => {
                        const Renderer = definition().render
                        return (
                          <Renderer
                            artifactId={activeArtifact.id}
                            version={version()}
                            type={activeArtifact.type}
                            title={activeArtifact.title}
                            content={activeArtifact.content ?? ''}
                            language={activeArtifact.language}
                            isStreaming={false}
                          />
                        )
                      }}
                    </Show>
                  </Match>
                  <Match when={state.activeTab === 'code'}>
                    <ArtifactSourceView
                      type={activeArtifact.type}
                      content={activeArtifact.content ?? ''}
                      language={activeArtifact.language}
                    />
                  </Match>
                </Switch>
              )}
            </Show>
          </div>
        </aside>
      </div>
    </Show>
  )
}
