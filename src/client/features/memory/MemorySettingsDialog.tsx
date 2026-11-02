import { createSignal, For, Show } from 'solid-js'

import {
  createMemory,
  deleteAllMemories,
  deleteMemory,
  fetchMemory,
  updateMemory,
  updateMemorySettings,
  type MemoryCategory,
  type MemoryEntryDto,
  type MemorySettingsDto,
} from '../chatbot/chatApi'
import { ModalDialog } from '../../shared/ui/ModalDialog'

export const MEMORY_CATEGORIES: Array<{ value: MemoryCategory; label: string }> = [
  { value: 'identity', label: '身份与背景' },
  { value: 'work', label: '工作与长期项目' },
  { value: 'preference', label: '偏好与习惯' },
  { value: 'current', label: '近期关注' },
  { value: 'other', label: '其他' },
]

const SOURCE_LABELS: Record<MemoryEntryDto['source'], string> = {
  auto: '从对话中整理',
  user: '你填写的',
  tool: '对话中让我记住的',
}

const MEMORY_CONTENT_MAX = 500

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

/** Groups entries by category in display order, skipping empty categories. */
export function groupMemories(entries: MemoryEntryDto[]) {
  return MEMORY_CATEGORIES
    .map((category) => ({
      ...category,
      entries: entries
        .filter((entry) => entry.category === category.value)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    }))
    .filter((group) => group.entries.length > 0)
}

function Toggle(props: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label class="flex cursor-pointer items-start justify-between gap-4 rounded-2xl border border-slate-200 px-4 py-3">
      <span class="min-w-0">
        <span class="block text-sm font-semibold text-slate-800">{props.label}</span>
        <span class="mt-1 block text-xs leading-5 text-slate-500">{props.description}</span>
      </span>
      <input
        type="checkbox"
        class="mt-1 h-4 w-4 shrink-0 accent-teal-700"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
    </label>
  )
}

function MemorySettingsDialog(props: { onClose: () => void }) {
  const [settings, setSettings] = createSignal<MemorySettingsDto | null>(null)
  const [memories, setMemories] = createSignal<MemoryEntryDto[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [editText, setEditText] = createSignal('')
  const [newText, setNewText] = createSignal('')
  const [newCategory, setNewCategory] = createSignal<MemoryCategory>('work')
  const [confirmClear, setConfirmClear] = createSignal(false)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '操作失败，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  void run(async () => {
    const result = await fetchMemory()
    setSettings(result.settings)
    setMemories(result.memories)
  })

  const changeSetting = (key: keyof MemorySettingsDto, value: boolean) =>
    run(async () => {
      setSettings(await updateMemorySettings({ [key]: value }))
    })

  const saveEdit = (entry: MemoryEntryDto) =>
    run(async () => {
      const content = editText().trim()
      if (!content) return
      const updated = await updateMemory(entry.id, { content })
      setMemories((current) => current.map((item) => item.id === updated.id ? updated : item))
      setEditingId(null)
    })

  const remove = (entry: MemoryEntryDto) =>
    run(async () => {
      await deleteMemory(entry.id)
      setMemories((current) => current.filter((item) => item.id !== entry.id))
    })

  const add = () =>
    run(async () => {
      const content = newText().trim()
      if (!content) return
      const created = await createMemory(content, newCategory())
      setMemories((current) => [created, ...current])
      setNewText('')
    })

  const clearAll = () =>
    run(async () => {
      await deleteAllMemories()
      setMemories([])
      setConfirmClear(false)
    })

  return (
    <ModalDialog
      title="记忆"
      description="助手会从你的对话中整理关于你的长期信息（身份、项目、偏好等），在之后的对话中参考。你可以随时查看、修改或删除。无痕对话不会使用或写入记忆。"
      maxWidthClass="max-w-2xl"
      onClose={props.onClose}
    >
      <div class="flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1">
        <Show when={error()}>
          <p class="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error()}</p>
        </Show>

        <Show when={settings()} fallback={<p class="text-sm text-slate-400">正在加载…</p>}>
          {(current) => (
            <div class="grid gap-3">
              <Toggle
                label="使用并更新记忆"
                description="关闭后，新对话既不会参考已有记忆，也不会从对话中整理新的记忆。已有记忆会保留，直到你删除。"
                checked={current().memoryEnabled}
                disabled={busy()}
                onChange={(value) => void changeSetting('memoryEnabled', value)}
              />
              <Toggle
                label="引用历史对话"
                description="允许助手在需要时搜索和查看你以前的对话（不含无痕对话和已删除的对话）。"
                checked={current().chatSearchEnabled}
                disabled={busy()}
                onChange={(value) => void changeSetting('chatSearchEnabled', value)}
              />
            </div>
          )}
        </Show>

        <div class="rounded-2xl border border-slate-200 p-4">
          <p class="text-sm font-semibold text-slate-800">添加一条记忆</p>
          <div class="mt-3 flex flex-col gap-2 sm:flex-row">
            <select
              class="h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700"
              value={newCategory()}
              onChange={(event) => setNewCategory(event.currentTarget.value as MemoryCategory)}
            >
              <For each={MEMORY_CATEGORIES}>
                {(category) => <option value={category.value}>{category.label}</option>}
              </For>
            </select>
            <input
              class="h-10 min-w-0 flex-1 rounded-xl border border-slate-200 px-3 text-sm"
              maxLength={MEMORY_CONTENT_MAX}
              placeholder="例如：我主要做土壤宏基因组的耐药基因分析"
              value={newText()}
              onInput={(event) => setNewText(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void add() }}
            />
            <button
              type="button"
              class="inline-flex h-10 items-center justify-center rounded-full bg-teal-700 px-4 text-sm font-semibold text-white transition duration-200 hover:bg-teal-800 disabled:opacity-50"
              disabled={busy() || !newText().trim()}
              onClick={() => void add()}
            >
              添加
            </button>
          </div>
        </div>

        <Show
          when={memories().length > 0}
          fallback={<p class="py-4 text-center text-sm text-slate-400">还没有记忆。</p>}
        >
          <For each={groupMemories(memories())}>
            {(group) => (
              <section>
                <h4 class="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">{group.label}</h4>
                <ul class="grid gap-2">
                  <For each={group.entries}>
                    {(entry) => (
                      <li class="rounded-2xl border border-slate-200 px-4 py-3">
                        <Show
                          when={editingId() === entry.id}
                          fallback={
                            <div class="flex items-start justify-between gap-3">
                              <div class="min-w-0">
                                <p class="whitespace-pre-wrap break-words text-sm leading-6 text-slate-800">{entry.content}</p>
                                <p class="mt-1 text-xs text-slate-400">
                                  {SOURCE_LABELS[entry.source]} · {new Date(entry.updatedAt).toLocaleDateString()}
                                </p>
                              </div>
                              <div class="flex shrink-0 gap-1">
                                <button
                                  type="button"
                                  aria-label="编辑记忆"
                                  class="grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                                  disabled={busy()}
                                  onClick={() => { setEditingId(entry.id); setEditText(entry.content) }}
                                >
                                  <span aria-hidden="true" class="i-lucide-pencil-line h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  aria-label="删除记忆"
                                  class="grid h-8 w-8 place-items-center rounded-full text-slate-400 hover:bg-rose-50 hover:text-rose-700"
                                  disabled={busy()}
                                  onClick={() => void remove(entry)}
                                >
                                  <span aria-hidden="true" class="i-lucide-trash-2 h-4 w-4" />
                                </button>
                              </div>
                            </div>
                          }
                        >
                          <textarea
                            class="min-h-20 w-full rounded-xl border border-slate-200 p-2 text-sm"
                            maxLength={MEMORY_CONTENT_MAX}
                            value={editText()}
                            onInput={(event) => setEditText(event.currentTarget.value)}
                          />
                          <div class="mt-2 flex justify-end gap-2">
                            <button
                              type="button"
                              class="h-9 rounded-full px-4 text-sm font-semibold text-slate-500 hover:text-slate-700"
                              onClick={() => setEditingId(null)}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              class="h-9 rounded-full bg-teal-700 px-4 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50"
                              disabled={busy() || !editText().trim()}
                              onClick={() => void saveEdit(entry)}
                            >
                              保存
                            </button>
                          </div>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </For>

          <div class="flex justify-end border-t border-slate-100 pt-3">
            <Show
              when={confirmClear()}
              fallback={
                <button
                  type="button"
                  class="text-sm font-semibold text-rose-700 hover:text-rose-800"
                  onClick={() => setConfirmClear(true)}
                >
                  清空全部记忆
                </button>
              }
            >
              <div class="flex items-center gap-3 text-sm">
                <span class="text-slate-500">确定删除全部记忆？此操作无法撤销。</span>
                <button type="button" class="font-semibold text-slate-500" onClick={() => setConfirmClear(false)}>取消</button>
                <button
                  type="button"
                  class="font-semibold text-rose-700 disabled:opacity-50"
                  disabled={busy()}
                  onClick={() => void clearAll()}
                >
                  确认清空
                </button>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </ModalDialog>
  )
}
