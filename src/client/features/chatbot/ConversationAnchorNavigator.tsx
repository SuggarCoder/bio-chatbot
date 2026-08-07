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
  viewportTop: number
  viewportBottom: number
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
        class={`fixed right-4 z-30 transition-[width] duration-200 ${isOpen() ? 'w-72' : 'w-6'}`}
        style={{
          top: `${props.viewportTop}px`,
          bottom: `${props.viewportBottom}px`,
        }}
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
          class="group absolute inset-y-0 right-0 z-10 w-6 bg-transparent focus-visible:outline-none"
          aria-label="打开提问导航"
          aria-expanded={isOpen()}
          aria-controls="conversation-question-anchor-list"
          onClick={() => {
            const nextOpen = !isOpen()
            setPointerOpen(false)
            setFocusOpen(nextOpen)
          }}
        >
          <span class="pointer-events-none absolute inset-y-2 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-slate-300/45 transition-colors group-hover:bg-teal-500/35 group-focus-visible:bg-teal-500/45" />
          <For each={props.anchors}>
            {(anchor) => (
              <span
                class={`pointer-events-none absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all ${anchor.id === props.activeId ? 'h-2.5 w-2.5 bg-teal-600' : 'h-1.5 w-1.5 bg-slate-400/65 group-hover:bg-slate-500'}`}
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
            class="absolute inset-y-0 left-0 right-8 flex min-h-0 flex-col overflow-hidden bg-white border-[0.5px] border-slate-200 rounded-3xl"
          >
            <div class="flex items-center justify-between px-4 py-3">
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
