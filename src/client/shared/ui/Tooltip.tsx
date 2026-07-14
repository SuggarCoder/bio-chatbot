import { Show, splitProps, type JSX, type ParentProps } from 'solid-js'

type TooltipProps = ParentProps<{
  content: JSX.Element
  class?: string
  contentClass?: string
  placement?: 'top' | 'bottom'
}>

export function Tooltip(props: TooltipProps) {
  const [local, rest] = splitProps(props, ['children', 'content', 'class', 'contentClass', 'placement'])
  const isTop = () => (local.placement ?? 'top') === 'top'

  return (
    <span class={`group relative inline-flex ${local.class ?? ''}`} {...rest}>
      {local.children}

      <span
        role="tooltip"
        class={
          isTop()
            ? `pointer-events-none absolute left-1/2 top-0 z-30 w-max max-w-56 -translate-x-1/2 -translate-y-[calc(100%+0.5rem)] opacity-0 transition duration-150 group-hover:opacity-100 group-focus-within:opacity-100 ${local.contentClass ?? ''}`
            : `pointer-events-none absolute left-1/2 top-full z-30 mt-2 w-max max-w-56 -translate-x-1/2 opacity-0 transition duration-150 group-hover:opacity-100 group-focus-within:opacity-100 ${local.contentClass ?? ''}`
        }
      >
        <span class="block rounded-xl bg-slate-900 px-3 py-2 text-xs font-medium leading-5 text-white shadow-lg">
          {local.content}
        </span>
        <Show when={isTop()}>
          <span class="absolute left-1/2 top-full h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-slate-900" />
        </Show>
        <Show when={!isTop()}>
          <span class="absolute left-1/2 top-0 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-slate-900" />
        </Show>
      </span>
    </span>
  )
}
