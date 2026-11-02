import { createSignal, Show } from 'solid-js'

import {
  deleteAllMemories,
  fetchMemorySettings,
  updateMemorySettings,
} from '../chatbot/chatApi'
import { ModalDialog } from '../../shared/ui/ModalDialog'

const [open, setOpen] = createSignal(false)

/** Opens the memory settings dialog from anywhere (e.g. the account menu). */
export function openMemorySettings() {
  setOpen(true)
}

/** Rendered once in the layout; shows the dialog while it is open. */
export function MemorySettingsHost() {
  return (
    <Show when={open()}>
      <MemorySettingsDialog onClose={() => setOpen(false)} />
    </Show>
  )
}

/**
 * Users decide only whether memory is on and can wipe it; what is
 * remembered and how it ages is managed by the server.
 */
function MemorySettingsDialog(props: { onClose: () => void }) {
  const [enabled, setEnabled] = createSignal<boolean | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [confirmClear, setConfirmClear] = createSignal(false)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '操作失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  void run(async () => {
    const settings = await fetchMemorySettings()
    setEnabled(settings.memoryEnabled && settings.chatSearchEnabled)
  })

  // One switch for the user: memory and references to past chats go together.
  const toggle = (value: boolean) =>
    run(async () => {
      const settings = await updateMemorySettings({ memoryEnabled: value, chatSearchEnabled: value })
      setEnabled(settings.memoryEnabled && settings.chatSearchEnabled)
    })

  const clearAll = () =>
    run(async () => {
      await deleteAllMemories()
      setConfirmClear(false)
      setNotice('已清除全部记忆。')
    })

  return (
    <ModalDialog
      title="记忆"
      description="开启后，助手会记住你的身份、偏好和近期在做的事，并参考你最近的对话，让回答更贴合你。近期内容会随时间自动淘汰。"
      onClose={props.onClose}
    >
      <div class="flex flex-col gap-4">
        <Show when={error()}>
          <p class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error()}</p>
        </Show>
        <Show when={notice()}>
          <p class="rounded-xl bg-teal-50 px-3 py-2 text-sm text-teal-800">{notice()}</p>
        </Show>

        <Show when={enabled() !== null} fallback={<p class="text-sm text-slate-400">正在加载…</p>}>
          <label class="flex cursor-pointer items-center justify-between gap-4 rounded-2xl border border-slate-200 px-4 py-3">
            <span class="text-sm font-semibold text-slate-800">使用记忆</span>
            <input
              type="checkbox"
              class="h-4 w-4 shrink-0 accent-teal-700"
              checked={enabled() ?? false}
              disabled={busy()}
              onChange={(event) => void toggle(event.currentTarget.checked)}
            />
          </label>
        </Show>

        <div class="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 px-4 py-3">
          <Show
            when={confirmClear()}
            fallback={
              <>
                <span class="text-sm font-semibold text-slate-800">清除全部记忆</span>
                <button
                  type="button"
                  class="text-sm font-semibold text-rose-700 hover:text-rose-800 disabled:opacity-50"
                  disabled={busy()}
                  onClick={() => setConfirmClear(true)}
                >
                  清除
                </button>
              </>
            }
          >
            <span class="text-sm text-slate-500">确定清除？此操作无法撤销。</span>
            <div class="flex shrink-0 gap-3 text-sm">
              <button type="button" class="font-semibold text-slate-500" onClick={() => setConfirmClear(false)}>取消</button>
              <button
                type="button"
                class="font-semibold text-rose-700 disabled:opacity-50"
                disabled={busy()}
                onClick={() => void clearAll()}
              >
                确认清除
              </button>
            </div>
          </Show>
        </div>
      </div>
    </ModalDialog>
  )
}
