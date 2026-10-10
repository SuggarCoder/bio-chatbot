import { For, Show } from 'solid-js'
import { GPAS_UPLOAD_MAX_FILES, sampleLabel, type GpasUploadBatch } from '../../../server/gpasContracts'
import type { PairingResult } from './fastqPairing'
import { gpasWebUploadUrl } from './gpasUploadApi'
import type { GpasUploadController } from './uploadController'
import type { FileStatus } from './uploadEngine'

const formatSize = (bytes: number) => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

const percent = (sent: number, total: number) => (total > 0 ? Math.floor((sent / total) * 100) : 0)

function layoutLabel(result: PairingResult<File>, groupNumbers: Map<string, number>): { text: string; tone: 'ok' | 'warn' | 'error' } {
  switch (result.status) {
    case 'paired':
      return { text: `双端 R${result.readType} · 第 ${groupNumbers.get(result.pairGroupId!)} 组`, tone: result.mismatchWarning ? 'warn' : 'ok' }
    case 'invalid_dual_name':
      return { text: '双端文件名不规范', tone: 'error' }
    case 'unpaired_dual':
      return { text: '双端 R2 缺少 R1', tone: 'error' }
    case 'invalid_single_name':
      return { text: '文件名含非法字符', tone: 'error' }
    default:
      return { text: result.maybeR1 ? '疑似双端 R1，未找到 R2' : '单端', tone: result.maybeR1 ? 'warn' : 'ok' }
  }
}

const statusLabels: Record<FileStatus, string> = {
  pending: '等待中',
  preparing: '准备中',
  uploading: '上传中',
  uploaded: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const toneClass = {
  ok: 'bg-teal-50 text-teal-700 ring-teal-100',
  warn: 'bg-amber-50 text-amber-700 ring-amber-100',
  error: 'bg-rose-50 text-rose-600 ring-rose-100',
}

/** Selected files, pairing, sample type and upload progress at the top of the composer. */
export function UploadTray(props: { controller: GpasUploadController }) {
  const c = props.controller
  const groupNumbers = () => {
    const numbers = new Map<string, number>()
    for (const result of c.results()) {
      if (result.pairGroupId && !numbers.has(result.pairGroupId)) numbers.set(result.pairGroupId, numbers.size + 1)
    }
    return numbers
  }
  const rows = () => (c.results().length === c.files().length ? c.results() : null)
  const overall = () => {
    const snapshot = c.snapshot()
    return snapshot ? percent(snapshot.sentBytes, snapshot.totalBytes) : 0
  }

  return (
    <div class={`space-y-2 px-3 text-xs ${c.hasFiles() || c.overLimit() || c.notices().length ? 'mb-1 border-b border-slate-100 pb-2 pt-1' : ''}`} data-testid="gpas-upload-tray">
      <Show when={c.overLimit()}>
        <p role="alert" class="font-medium text-rose-500">
          单次最多上传 {GPAS_UPLOAD_MAX_FILES} 个文件，本次选择未添加。更多文件请前往{' '}
          <a class="underline" href={gpasWebUploadUrl()} target="_blank" rel="noopener">{gpasWebUploadUrl()}</a>{' '}上传。
        </p>
      </Show>
      <For each={c.notices()}>{(notice) => <p class="font-medium text-rose-500">{notice}</p>}</For>

      <Show when={c.hasFiles()}>
        {/* Files sit side by side and wrap at the composer's edge. */}
        <ul class="flex flex-wrap gap-1.5" data-testid="gpas-upload-files">
          <Show
            when={rows()}
            fallback={
              <For each={c.files()}>
                {(file) => (
                  <li class="flex min-w-0 max-w-full items-center gap-2 rounded-lg bg-slate-50 px-2 py-1 text-slate-500">
                    <span class="truncate">{file.name}</span>
                    <span class="shrink-0 text-slate-400">{formatSize(file.size)}</span>
                    <span class="shrink-0">正在校验单双端…</span>
                  </li>
                )}
              </For>
            }
          >
            {(list) => (
              <For each={list()}>
                {(result) => {
                  const label = () => layoutLabel(result, groupNumbers())
                  const progress = () => c.snapshot()?.files.get(result.file)
                  return (
                    <li class="flex min-w-0 max-w-full flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-2 py-1" data-testid="gpas-upload-file">
                      <span class="min-w-0 max-w-full truncate font-medium text-slate-700">{result.file.name}</span>
                      <span class="shrink-0 text-slate-400">{formatSize(result.file.size)}</span>
                      <span class={`shrink-0 rounded-full px-2 py-0.5 ring-1 ${toneClass[label().tone]}`}>{label().text}</span>
                      <Show when={result.mismatchWarning}>
                        <span class="shrink-0 text-amber-600">两端 reads 数量差异较大</span>
                      </Show>
                      <Show when={result.maybeR1 && result.status === 'single'}>
                        <label class="inline-flex shrink-0 items-center gap-1 text-slate-600">
                          <input
                            type="checkbox"
                            disabled={c.busy()}
                            checked={c.confirmedSingles().has(result.file)}
                            onChange={(event) => c.confirmSingle(result.file, event.currentTarget.checked)}
                          />
                          按单端上传
                        </label>
                      </Show>
                      <Show when={progress()}>
                        {(item) => (
                          <span class={`shrink-0 ${item().status === 'failed' ? 'text-rose-500' : 'text-slate-500'}`} title={item().error}>
                            {statusLabels[item().status]}
                            <Show when={item().status === 'uploading'}> {percent(item().sentBytes, item().totalBytes)}%</Show>
                            <Show when={item().status === 'failed' && item().error}>：{item().error}</Show>
                          </span>
                        )}
                      </Show>
                      <Show when={!c.busy()}>
                        <button
                          type="button"
                          aria-label={`移除 ${result.file.name}`}
                          onClick={() => c.removeFile(result.file)}
                          class="shrink-0 text-slate-400 hover:text-rose-500"
                        >
                          <span aria-hidden="true" class="i-lucide-x h-3.5 w-3.5" />
                        </button>
                      </Show>
                    </li>
                  )
                }}
              </For>
            )}
          </Show>
        </ul>

        <div class="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="样本类型" data-testid="gpas-sample-types">
          <span class="font-medium text-slate-500">样本类型</span>
          <Show when={c.availableTypes()} fallback={
            <Show when={c.typesError()} fallback={<span class="text-slate-400">正在查询项目样本类型…</span>}>
              {(message) => (
                <span class="text-rose-500">
                  {message()}{' '}
                  <button type="button" onClick={() => c.retrySampleTypes()} class="font-medium text-teal-700 hover:underline">重试</button>
                </span>
              )}
            </Show>
          }>
            {(types) => (
              <Show when={types().length > 0} fallback={
                <span class="text-rose-500">
                  项目计划中没有可共同上传的样本类型，请前往{' '}
                  <a class="underline" href={gpasWebUploadUrl()} target="_blank" rel="noopener">GPAS Web</a>{' '}上传。
                </span>
              }>
                <For each={types()}>
                  {(key) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={c.sampleType() === key}
                      disabled={c.busy()}
                      onClick={() => c.setSampleType(key)}
                      class={`rounded-full px-3 py-1 ring-1 transition ${c.sampleType() === key ? 'bg-teal-600 text-white ring-teal-600' : 'bg-white text-slate-600 ring-slate-200 hover:ring-teal-300'}`}
                    >
                      {sampleLabel(key)}
                    </button>
                  )}
                </For>
              </Show>
            )}
          </Show>
        </div>

        <Show when={c.phase() === 'idle' && rows()}>
          <For each={c.blockers()}>{(blocker) => <p class="font-medium text-rose-500">{blocker}</p>}</For>
          <Show when={c.sampleType() === null && c.availableTypes()?.length}>
            <p class="font-medium text-slate-500">请选择样本类型后发送，发送时开始上传。</p>
          </Show>
        </Show>

        <Show when={c.phase() === 'uploading'}>
          <div class="flex items-center gap-3" role="status" aria-live="polite">
            <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
              <div class="h-full rounded-full bg-teal-500 transition-all" style={{ width: `${overall()}%` }} />
            </div>
            <span class="shrink-0 text-slate-500">正在上传 {overall()}%</span>
            <button type="button" onClick={() => c.cancel()} class="shrink-0 font-medium text-slate-500 hover:text-rose-500">取消上传</button>
          </div>
        </Show>

        <Show when={c.failure()}>
          {(current) => (
            <div class="flex flex-wrap items-center gap-3" role="alert">
              <span class="font-medium text-rose-500">{current().message}</span>
              <Show when={!current().outcome.authFailed}>
                <button type="button" onClick={() => c.retryFailed()} class="font-medium text-teal-700 hover:underline">重试失败文件</button>
                <button type="button" onClick={() => c.sendWithFailures()} class="font-medium text-slate-600 hover:underline">跳过失败并发送</button>
              </Show>
              <button type="button" onClick={() => c.cancel()} class="font-medium text-slate-500 hover:underline">取消</button>
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}

/** Uploaded file list under a user message. */
export function UploadedFilesSummary(props: { batch: GpasUploadBatch }) {
  const uploaded = () => props.batch.items.filter(item => item.status === 'uploaded').length
  return (
    <div class="mt-2 space-y-1 text-xs text-slate-500" data-testid="gpas-upload-summary">
      <p class="font-medium">
        {sampleLabel(props.batch.sampleType)} · 上传成功 {uploaded()}/{props.batch.items.length}
      </p>
      <ul class="space-y-0.5">
        <For each={props.batch.items}>
          {(item) => (
            <li class="flex flex-wrap gap-2">
              <span class="truncate text-slate-600">{item.name}</span>
              <span>{item.layout === 'paired' ? `双端 ${item.role} · ${item.pairKey}` : '单端'}</span>
              <span class={item.status === 'uploaded' ? 'text-teal-700' : 'text-rose-500'}>
                {item.status === 'uploaded' ? '成功' : item.status === 'failed' ? '失败' : '已取消'}
              </span>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}
