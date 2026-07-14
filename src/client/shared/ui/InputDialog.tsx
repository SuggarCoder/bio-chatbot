import { createEffect, Show } from 'solid-js'
import { ModalDialog } from './ModalDialog'

type InputDialogProps = {
  open: boolean
  title: string
  description?: string
  value: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  onValueChange: (value: string) => void
  onClose: () => void
  onConfirm: () => void
}

export function InputDialog(props: InputDialogProps) {
  let inputRef: HTMLInputElement | undefined

  createEffect(() => {
    if (props.open) {
      queueMicrotask(() => inputRef?.focus())
    }
  })

  return (
    <Show when={props.open}>
      <ModalDialog title={props.title} description={props.description} onClose={props.onClose}>
        <input
          ref={inputRef}
          value={props.value}
          placeholder={props.placeholder}
          class="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 outline-none transition duration-200 focus:border-teal-600"
          onInput={(event) => props.onValueChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              props.onConfirm()
            }

            if (event.key === 'Escape') {
              event.preventDefault()
              props.onClose()
            }
          }}
        />
        <div class="mt-5 flex justify-end gap-3">
          <button
            type="button"
            class="inline-flex h-11 items-center rounded-full px-5 text-sm font-semibold text-slate-300 transition duration-200 hover:text-slate-400"
            onClick={props.onClose}
          >
            {props.cancelLabel ?? '取消'}
          </button>
          <button
            type="button"
            disabled={props.value.trim().length === 0}
            class={
              props.value.trim().length === 0
                ? 'inline-flex h-11 items-center rounded-full bg-slate-200 px-5 text-sm font-semibold text-slate-400'
                : 'inline-flex h-11 items-center rounded-full bg-teal-700 px-5 text-sm font-semibold text-white transition duration-200 hover:bg-teal-800'
            }
            onClick={props.onConfirm}
          >
            {props.confirmLabel ?? '确认'}
          </button>
        </div>
      </ModalDialog>
    </Show>
  )
}
