import { Show, type JSX, type ParentProps } from 'solid-js'

type ModalDialogProps = ParentProps<{
  title: string
  description?: JSX.Element
  onClose: () => void
  maxWidthClass?: string
}>

export function ModalDialog(props: ModalDialogProps) {
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <button
        type="button"
        aria-label="关闭弹窗"
        class="absolute inset-0 bg-slate-950/40"
        onClick={props.onClose}
      />
      <div
        class={`relative z-10 w-full rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl ${props.maxWidthClass ?? 'max-w-md'}`}
      >
        <div>
          <h3 class="text-lg font-semibold text-slate-900">{props.title}</h3>
          <Show when={props.description}>
            <p class="mt-2 text-sm leading-6 text-slate-500">{props.description}</p>
          </Show>
        </div>
        <div class="mt-5">{props.children}</div>
      </div>
    </div>
  )
}
