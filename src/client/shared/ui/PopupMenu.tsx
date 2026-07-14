import { createEffect, createSignal, For, onCleanup, Show, type JSX, type ParentProps } from 'solid-js'
import { Portal } from 'solid-js/web'

export type PopupMenuItem = {
  type?: 'item'
  label: JSX.Element
  icon?: JSX.Element
  tone?: 'default' | 'danger'
  onSelect: () => void
}

export type PopupMenuDivider = {
  type: 'separator'
}

export type PopupMenuEntry = PopupMenuItem | PopupMenuDivider

type MenuPosition = {
  top: number
  left: number
}

type PopupMenuProps = ParentProps<{
  buttonLabel: string
  buttonClass?: string
  menuClass?: string
  header?: JSX.Element
  menuWidth?: number
  placement?: 'bottom-end' | 'top-end'
  items: PopupMenuEntry[]
}>

export function PopupMenu(props: PopupMenuProps) {
  const VIEWPORT_PADDING = 8
  const MENU_OFFSET = 8
  const menuWidth = () => props.menuWidth ?? 160

  const [isOpen, setIsOpen] = createSignal(false)
  const [menuPosition, setMenuPosition] = createSignal<MenuPosition>({
    top: VIEWPORT_PADDING,
    left: VIEWPORT_PADDING,
  })
  let buttonRef: HTMLButtonElement | undefined
  let menuRef: HTMLDivElement | undefined

  const closeMenu = () => setIsOpen(false)
  const updateMenuPosition = () => {
    if (!buttonRef) {
      return
    }

    const rect = buttonRef.getBoundingClientRect()
    const menuHeight = menuRef?.getBoundingClientRect().height ?? 0
    const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - menuWidth() - VIEWPORT_PADDING)
    const top =
      props.placement === 'top-end'
        ? Math.max(VIEWPORT_PADDING, rect.top - menuHeight - MENU_OFFSET)
        : Math.min(rect.bottom + MENU_OFFSET, Math.max(VIEWPORT_PADDING, window.innerHeight - menuHeight - VIEWPORT_PADDING))

    setMenuPosition({
      top,
      left: Math.min(Math.max(rect.right - menuWidth(), VIEWPORT_PADDING), maxLeft),
    })
  }

  createEffect(() => {
    if (!isOpen()) {
      return
    }

    updateMenuPosition()
    const frameId = window.requestAnimationFrame(updateMenuPosition)

    const handleViewportChange = () => updateMenuPosition()

    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)

    onCleanup(() => {
      window.cancelAnimationFrame(frameId)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    })
  })

  return (
    <div class="relative inline-flex">
      <button
        ref={buttonRef}
        type="button"
        aria-label={props.buttonLabel}
        aria-expanded={isOpen()}
        class={props.buttonClass ?? ''}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          setIsOpen((current) => !current)
        }}
      >
        {props.children}
      </button>

      <Show when={isOpen()}>
        <Portal>
          <>
            <button
              type="button"
              aria-label="关闭操作菜单"
              class="fixed inset-0 z-40 cursor-default"
              onClick={closeMenu}
            />
            <div
              ref={menuRef}
              class={`fixed z-50 rounded-2xl border border-slate-200 bg-white p-2 text-slate-700 shadow-xl ${props.menuClass ?? ''}`}
              style={{
                top: `${menuPosition().top}px`,
                left: `${menuPosition().left}px`,
                width: `${menuWidth()}px`,
              }}
            >
              <Show when={props.header}>
                <div class="border-b border-slate-100 px-3 pb-3 pt-2 text-sm font-semibold text-slate-800">
                  {props.header}
                </div>
              </Show>
              <For each={props.items}>
                {(item, index) => (
                  item.type === 'separator' ? (
                    <div class={`${index() === 0 && !props.header ? '' : 'my-2 '}h-px bg-slate-200`} />
                  ) : (
                    <button
                      type="button"
                      class={
                        item.tone === 'danger'
                          ? `${index() === 0 && !props.header ? '' : 'mt-1 '}flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-[#7a2e2e] transition duration-200 hover:bg-[#f7eded]`
                          : `${index() === 0 && !props.header ? '' : 'mt-1 '}flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-slate-600 transition duration-200 hover:bg-slate-50`
                      }
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        closeMenu()
                        item.onSelect()
                      }}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </button>
                  )
                )}
              </For>
            </div>
          </>
        </Portal>
      </Show>
    </div>
  )
}
