import { gsap } from 'gsap'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
  type Component,
} from 'solid-js'
import { artifactDownloadUrl } from './artifactApi'
import { artifactStore } from './artifactStore'
import { artifactRenderers, UnsupportedArtifactRenderer } from './renderers'
import { artifactMimeTypes } from './types'

type PanelPhase = 'closed' | 'opening' | 'open' | 'closing'

export const ArtifactSidePanel: Component = () => {
  const state = artifactStore.state
  const [mounted, setMounted] = createSignal(false)
  const [phase, setPhase] = createSignal<PanelPhase>('closed')
  const [isDesktop, setIsDesktop] = createSignal(false)
  let slotRef: HTMLDivElement | undefined
  let panelRef: HTMLElement | undefined
  let timeline: gsap.core.Timeline | undefined
  let animationRevision = 0
  let desktopQuery: MediaQueryList | undefined
  let reducedMotionQuery: MediaQueryList | undefined

  const artifact = createMemo(() => state.activeArtifactId
    ? state.artifactsById[state.activeArtifactId]
    : undefined)
  const content = () => artifact()?.content ?? ''
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
    timeline?.kill()
    if (slotRef) gsap.killTweensOf(slotRef)
    if (panelRef) gsap.killTweensOf(panelRef)
  })

  const beginResize = (event: PointerEvent) => {
    const startX = event.clientX
    const startWidth = state.panelWidth
    const move = (next: PointerEvent) => artifactStore.setWidth(
      startWidth + startX - next.clientX,
    )
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  return (
    <Show when={mounted()}>
      <div
        ref={slotRef}
        class="absolute inset-0 z-40 h-full overflow-visible lg:relative lg:inset-auto lg:z-auto lg:shrink-0"
        classList={{ 'pointer-events-none': phase() === 'closing' }}
        aria-hidden={phase() === 'closing' ? 'true' : undefined}
      >
        <aside
          ref={panelRef}
          class="absolute inset-y-0 right-0 flex min-w-0 flex-col border-l border-slate-200 bg-white opacity-0 shadow-2xl will-change-transform"
          style={{ width: panelWidth() }}
          aria-label="Artifact panel"
        >
          <button
            type="button"
            aria-label="Resize Artifact panel"
            class="absolute inset-y-0 -left-1 hidden w-2 cursor-col-resize lg:block"
            onPointerDown={beginResize}
          />
          <header class="flex h-16 items-center gap-3 border-b border-slate-200 px-4">
            <div class="min-w-0 flex-1">
              <h2 class="truncate text-sm font-semibold text-slate-900">{title()}</h2>
              <p class="text-xs text-slate-500">Version {version()}</p>
            </div>
            <Show when={state.activeArtifactId}>
              {(artifactId) => (
                <a
                  class="grid h-9 w-9 place-items-center rounded-full text-slate-500 hover:bg-slate-100"
                  href={artifactDownloadUrl(artifactId(), version())}
                  aria-label="Download Artifact"
                >
                  <span class="i-lucide-download h-4 w-4" />
                </a>
              )}
            </Show>
            <button
              type="button"
              class="grid h-9 w-9 place-items-center rounded-full text-slate-500 hover:bg-slate-100"
              onClick={() => artifactStore.close()}
              aria-label="Close Artifact panel"
            >
              <span class="i-lucide-x h-4 w-4" />
            </button>
          </header>
          <nav class="flex gap-1 border-b border-slate-200 px-3 py-2">
            <For each={['preview', 'code', 'history'] as const}>
              {(tab) => (
                <button
                  type="button"
                  class={`rounded-lg px-3 py-1.5 text-xs font-medium ${state.activeTab === tab ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100'}`}
                  onClick={() => {
                    artifactStore.setTab(tab)
                    if (tab === 'history' && state.activeArtifactId) {
                      void artifactStore.loadHistory(state.activeArtifactId)
                    }
                  }}
                >
                  {tab}
                </button>
              )}
            </For>
          </nav>
          <div class="min-h-0 flex-1 overflow-auto bg-slate-50">
            <Show when={state.activeTab === 'preview'}>
              <Show when={renderer()} fallback={<UnsupportedArtifactRenderer type={type() ?? 'unknown'} />}>
                {(definition) => {
                  const Renderer = definition().render
                  return (
                    <Renderer
                      artifactId={artifact()?.id ?? ''}
                      version={version()}
                      type={type()!}
                      title={title()}
                      content={content()}
                      language={artifact()?.language}
                      isStreaming={false}
                    />
                  )
                }}
              </Show>
            </Show>
            <Show when={state.activeTab === 'code'}>
              <pre class="m-0 whitespace-pre-wrap break-words p-5 text-xs leading-5 text-slate-700">{content()}</pre>
            </Show>
            <Show when={state.activeTab === 'history'}>
              <div class="space-y-2 p-3">
                <For each={artifact()?.versions ?? []} fallback={<p class="p-3 text-sm text-slate-500">No version history loaded.</p>}>
                  {(item) => (
                    <button
                      type="button"
                      class="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white p-3 text-left"
                      onClick={() => void artifactStore.open(item.artifactId, item.version)}
                    >
                      <span>
                        <span class="block text-sm font-medium">Version {item.version}</span>
                        <span class="text-xs text-slate-500">{new Date(item.createdAt).toLocaleString()}</span>
                      </span>
                      <span class="text-xs text-slate-400">{item.byteLength} bytes</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </aside>
      </div>
    </Show>
  )
}
