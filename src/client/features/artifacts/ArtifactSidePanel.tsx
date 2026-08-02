import { For, Show, createMemo, type Component } from 'solid-js'
import { artifactDownloadUrl } from './artifactApi'
import { artifactStore } from './artifactStore'
import { artifactRenderers, UnsupportedArtifactRenderer } from './renderers'
import { artifactMimeTypes } from './types'

export const ArtifactSidePanel: Component = () => {
  const state = artifactStore.state
  const draft = createMemo(() => state.activeStreamId
    ? state.draftsByStreamId[state.activeStreamId]
    : undefined)
  const artifact = createMemo(() => state.activeArtifactId
    ? state.artifactsById[state.activeArtifactId]
    : undefined)
  const content = () => draft()?.content ?? artifact()?.content ?? ''
  const type = () => draft()?.type ?? artifact()?.type
  const title = () => draft()?.title ?? artifact()?.title ?? 'Artifact'
  const version = () => state.activeVersion ?? artifact()?.currentVersion ?? 1
  const renderer = createMemo(() => {
    const current = type()
    return current && artifactMimeTypes.includes(current)
      ? artifactRenderers[current]
      : undefined
  })
  const beginResize = (event: PointerEvent) => {
    const startX = event.clientX
    const startWidth = state.panelWidth
    const move = (next: PointerEvent) => artifactStore.setWidth(startWidth + startX - next.clientX)
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  return (
    <Show when={state.isPanelOpen}>
      <aside
        class="absolute inset-0 z-40 flex min-w-0 flex-col border-l border-slate-200 bg-white shadow-2xl lg:static lg:z-auto lg:h-full lg:shrink-0"
        style={{ width: `min(100vw, ${state.panelWidth}px)` }}
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
            <p class="text-xs text-slate-500">
              {draft() ? 'Generating draft' : `Version ${version()}`}
            </p>
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
          <button type="button" class="grid h-9 w-9 place-items-center rounded-full text-slate-500 hover:bg-slate-100" onClick={() => artifactStore.close()} aria-label="Close Artifact panel">
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
                  if (tab === 'history' && state.activeArtifactId) void artifactStore.loadHistory(state.activeArtifactId)
                }}
              >
                {tab}
              </button>
            )}
          </For>
        </nav>
        <div class="min-h-0 flex-1 overflow-auto bg-slate-50">
          <Show when={draft()?.error}>
            {(error) => <div class="m-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-800">{error()}</div>}
          </Show>
          <Show when={state.activeTab === 'preview'}>
            <Show when={renderer()} fallback={<UnsupportedArtifactRenderer type={type() ?? 'unknown'} />}>
              {(definition) => {
                const Renderer = definition().render
                return <Renderer artifactId={artifact()?.id ?? draft()?.streamId ?? ''} version={version()} type={type()!} title={title()} content={content()} language={artifact()?.language} isStreaming={Boolean(draft() && draft()?.status === 'streaming')} />
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
                  <button type="button" class="flex w-full items-center justify-between rounded-xl border border-slate-200 bg-white p-3 text-left" onClick={() => void artifactStore.open(item.artifactId, item.version)}>
                    <span><span class="block text-sm font-medium">Version {item.version}</span><span class="text-xs text-slate-500">{new Date(item.createdAt).toLocaleString()}</span></span>
                    <span class="text-xs text-slate-400">{item.byteLength} bytes</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </aside>
    </Show>
  )
}

