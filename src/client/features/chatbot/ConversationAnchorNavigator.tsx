import {
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'

export type ConversationAnchorItem = {
  id: string
  label: string
  fullText: string
  position: number
}

type ConversationAnchorNavigatorProps = {
  anchors: ConversationAnchorItem[]
  activeId?: string
  hasMoreMessages: boolean
  loadingOlderMessages: boolean
  olderMessagesError?: string
  onLoadOlder: () => void
  onSelect: (id: string) => void
}

export function ConversationAnchorNavigator(
  props: ConversationAnchorNavigatorProps,
) {
  const [pointerOpen, setPointerOpen] = createSignal(false)
  const [focusOpen, setFocusOpen] = createSignal(false)
  const [desktopFinePointer, setDesktopFinePointer] = createSignal(false)
  let railButtonRef: HTMLButtonElement | undefined
  let mediaQuery: MediaQueryList | undefined
  let suppressFocusOpen = false

  const isOpen = () => pointerOpen() || focusOpen()
  const updateMediaQuery = () => {
    const matches = Boolean(mediaQuery?.matches)
    setDesktopFinePointer(matches)

    if (!matches) {
      close()
    }
  }
  const close = () => {
    setPointerOpen(false)
    setFocusOpen(false)
  }
  const handleFocusOut = (
    event: FocusEvent & { currentTarget: HTMLDivElement },
  ) => {
    const nextTarget = event.relatedTarget

    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      setFocusOpen(false)
    }
  }
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') {
      return
    }

    event.preventDefault()
    suppressFocusOpen = document.activeElement !== railButtonRef
    close()
    railButtonRef?.focus()
  }

  onMount(() => {
    mediaQuery = window.matchMedia(
      '(min-width: 1024px) and (hover: hover) and (pointer: fine)',
    )
    updateMediaQuery()
    mediaQuery.addEventListener('change', updateMediaQuery)
  })

  onCleanup(() => {
    mediaQuery?.removeEventListener('change', updateMediaQuery)
  })

  return (
    <Show when={desktopFinePointer()}>
      <div
        class={`absolute bottom-2 right-3 top-2 z-30 transition-[width] duration-200 ${isOpen() ? 'w-72' : 'w-6'}`}
        onPointerEnter={() => setPointerOpen(true)}
        onPointerLeave={() => setPointerOpen(false)}
        onPointerCancel={() => setPointerOpen(false)}
        onPointerDown={() => {
          suppressFocusOpen = true
          setFocusOpen(false)
        }}
        onPointerUp={() => {
          suppressFocusOpen = false
        }}
        onFocusIn={() => {
          if (suppressFocusOpen) {
            suppressFocusOpen = false
            return
          }

          setFocusOpen(true)
        }}
        onFocusOut={handleFocusOut}
        onKeyDown={handleKeyDown}
      >
        <button
          ref={railButtonRef}
          type="button"
          class="absolute inset-y-0 right-0 z-10 w-6 rounded-full bg-white/88 shadow-sm ring-1 ring-slate-200/90 backdrop-blur transition hover:ring-teal-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          aria-label="打开提问导航"
          aria-expanded={isOpen()}
          aria-controls="conversation-question-anchor-list"
          onClick={() => {
            const nextOpen = !isOpen()
            setPointerOpen(false)
            setFocusOpen(nextOpen)
          }}
        >
          <span class="absolute inset-y-3 left-1/2 w-px -translate-x-1/2 rounded-full bg-slate-200" />
          <For each={props.anchors}>
            {(anchor) => (
              <span
                class={`pointer-events-none absolute left-1/2 h-0.5 -translate-x-1/2 rounded-full transition-all ${anchor.id === props.activeId ? 'w-3.5 bg-teal-600' : 'w-2 bg-slate-400'}`}
                style={{
                  top: `${Math.min(Math.max(anchor.position, 0.02), 0.98) * 100}%`,
                }}
              />
            )}
          </For>
        </button>

        <Show when={isOpen()}>
          <nav
            id="conversation-question-anchor-list"
            aria-label="提问导航"
            class="absolute inset-y-0 left-0 right-8 flex min-h-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/96 shadow-xl backdrop-blur"
          >
            <div class="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <p class="text-sm font-semibold text-slate-700">提问导航</p>
              <span class="text-xs text-slate-400">{props.anchors.length} 个提问</span>
            </div>

            <div class="gpas-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
              <Show when={props.hasMoreMessages}>
                <button
                  type="button"
                  class="mb-1 flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-teal-700 transition hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-wait disabled:opacity-60"
                  disabled={props.loadingOlderMessages}
                  onClick={props.onLoadOlder}
                >
                  <span class={props.loadingOlderMessages ? 'i-lucide-loader-circle h-3.5 w-3.5 generation-status-spin' : 'i-lucide-history h-3.5 w-3.5'} />
                  {props.loadingOlderMessages
                    ? '正在加载更早提问…'
                    : props.olderMessagesError
                      ? '重试加载更早提问'
                      : '加载更早提问'}
                </button>
              </Show>

              <ul class="flex flex-col gap-1">
                <For each={props.anchors}>
                  {(anchor) => (
                    <li>
                      <button
                        type="button"
                        class={`w-full truncate rounded-xl px-3 py-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${anchor.id === props.activeId ? 'bg-teal-50 font-medium text-teal-800' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-800'}`}
                        aria-label={`跳转到提问：${anchor.fullText}`}
                        aria-current={anchor.id === props.activeId ? 'true' : undefined}
                        title={anchor.fullText}
                        onClick={() => props.onSelect(anchor.id)}
                      >
                        {anchor.label}
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </nav>
        </Show>
      </div>
    </Show>
  )
}
