import { createSignal, For, Show } from 'solid-js'
import type { GpasPart, ProjectInput } from './chatApi'

const samples = [
  ['clinic', '临床样本'], ['media', '虫媒样本'],
  ['environment', '环境样本'], ['lab', '实验室样本'],
] as const

export function ProjectInitForm(props: {
  form: NonNullable<GpasPart['form']>
  messageId: string
  disabled: boolean
  onSubmit: (input: ProjectInput) => Promise<void>
}) {
  const [pending, setPending] = createSignal(false)
  const [done, setDone] = createSignal(false)
  const [error, setError] = createSignal('')
  const inputClass = 'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800'
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (pending() || done() || props.disabled) return
    const data = new FormData(event.currentTarget as HTMLFormElement)
    const counts = Object.fromEntries(samples.map(([key]) => [key, Number(data.get(key))])) as ProjectInput['samples']
    if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)) {
      setError('样本数量必须为非负整数。')
      return
    }
    setPending(true)
    setError('')
    try {
      await props.onSubmit({
        sourceMessageId: props.messageId,
        projectName: String(data.get('projectName')).trim(),
        projectDesc: String(data.get('projectDesc')).trim(),
        phone: String(data.get('phone')).trim(), samples: counts,
      })
      setDone(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '项目创建失败，请重试。')
    } finally { setPending(false) }
  }
  return (
    <form class="my-3 w-full max-w-xl rounded-2xl border border-slate-200 bg-slate-50 p-4" onSubmit={submit}>
      <fieldset disabled={pending() || done() || props.disabled} class="min-w-0 border-0 p-0">
        <legend class="mb-3 text-base font-semibold">基础信息</legend>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="text-sm">项目编码<input class={`${inputClass} bg-slate-100`} value={props.form.projectCode} readOnly /></label>
          <label class="text-sm">项目名称<input class={inputClass} name="projectName" value={props.form.projectName} required maxLength={200} /></label>
          <label class="text-sm sm:col-span-2">项目说明<textarea class={inputClass} name="projectDesc" rows={2} maxLength={2000} /></label>
          <label class="text-sm sm:col-span-2">联系方式<input class={inputClass} name="phone" type="tel" value={props.form.phone} required maxLength={32} /></label>
        </div>
        <h3 class="mb-3 mt-5 text-base font-semibold">样本数量</h3>
        <div class="grid grid-cols-2 gap-3">
          <For each={samples}>{([key, label]) => (
            <label class="text-sm">{label}<input class={inputClass} name={key} type="number" min="0" max={Number.MAX_SAFE_INTEGER} step="1" value="0" required /></label>
          )}</For>
        </div>
        <button type="submit" class="mt-4 rounded-full bg-teal-700 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {pending() ? '正在创建…' : done() ? '已处理' : '确认创建项目'}
        </button>
      </fieldset>
      <Show when={error()}><p role="alert" class="mt-3 text-sm text-rose-600">{error()}</p></Show>
      <Show when={done()}><p role="status" class="mt-3 text-sm text-teal-700">项目已就绪，可发送“我的任务进度”查看最新进度。</p></Show>
    </form>
  )
}
