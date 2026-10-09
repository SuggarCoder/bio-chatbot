import { createSignal, For, Show } from 'solid-js'
import type { ProfileCard as Profile } from '../../../server/gpasContracts'

type Field = { icon: string; label: string; value: string | null; copy?: boolean }

function FieldRow(props: { field: Field }) {
  const [copied, setCopied] = createSignal(false)
  const copy = async () => {
    if (!props.field.value) return
    try {
      await navigator.clipboard.writeText(props.field.value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be unavailable (permissions, insecure context); the value stays selectable.
    }
  }
  return (
    <div class="group flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 transition hover:bg-slate-50" data-testid="gpas-profile-field">
      <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-teal-50 text-teal-700" aria-hidden="true">
        <span class={`${props.field.icon} h-4 w-4`} />
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-[11px] text-slate-400">{props.field.label}</p>
        <Show when={props.field.value} fallback={<p class="text-sm text-slate-300">未填写</p>}>
          <p class="truncate text-sm font-medium text-slate-700" title={props.field.value!}>{props.field.value}</p>
        </Show>
      </div>
      <Show when={props.field.copy && props.field.value}>
        <button
          type="button"
          class="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 opacity-0 transition hover:bg-white hover:text-teal-700 focus-visible:opacity-100 group-hover:opacity-100"
          aria-label={copied() ? '已复制' : `复制${props.field.label}`}
          title={copied() ? '已复制' : '复制'}
          onClick={() => void copy()}
        >
          <span aria-hidden="true" class={`${copied() ? 'i-lucide-check' : 'i-lucide-copy'} h-3.5 w-3.5`} />
        </button>
      </Show>
    </div>
  )
}

/** The signed-in user and team, shown under a user.profile reply. */
export function ProfileCard(props: { profile: Profile }) {
  const name = () => props.profile.realName ?? props.profile.userName ?? '当前用户'
  const initial = () => Array.from(name())[0] ?? '?'
  const fields = (): Field[] => [
    { icon: 'i-lucide-users', label: '所属团队', value: props.profile.teamName },
    { icon: 'i-lucide-flask-conical', label: '研究方向', value: props.profile.researchField },
    { icon: 'i-lucide-phone', label: '联系方式', value: props.profile.phone, copy: true },
    { icon: 'i-lucide-mail', label: '邮箱', value: props.profile.email, copy: true },
  ]
  return (
    <article class="my-2 max-w-xl overflow-hidden rounded-2xl bg-white ring-1 ring-slate-200" data-testid="gpas-profile-card">
      <div class="h-1.5" style={{ 'background-image': 'linear-gradient(90deg, #2c7378, #4f9095 60%, #b9ced2)' }} aria-hidden="true" />
      <header class="flex items-center gap-4 px-5 pb-3 pt-4">
        <span
          class="grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-xl font-semibold text-white shadow-[0_8px_18px_-10px_rgba(44,115,120,0.9)]"
          style={{ 'background-image': 'linear-gradient(135deg, #2c7378, #4f9095)' }}
          aria-hidden="true"
        >
          {initial()}
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <h3 class="truncate text-lg font-semibold text-slate-900">{name()}</h3>
            <Show when={props.profile.jobTitle}>
              <span class="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-700 ring-1 ring-teal-100">{props.profile.jobTitle}</span>
            </Show>
          </div>
          <Show when={props.profile.userName}>
            <p class="mt-0.5 truncate font-mono text-xs text-slate-400">@{props.profile.userName}</p>
          </Show>
        </div>
      </header>
      <div class="grid gap-1 border-t border-slate-100 px-2 py-2 sm:grid-cols-2">
        <For each={fields()}>{(field) => <FieldRow field={field} />}</For>
      </div>
    </article>
  )
}
