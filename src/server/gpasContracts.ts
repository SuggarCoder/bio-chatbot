import { z } from 'zod'

export const sampleKeys = ['clinic', 'media', 'environment', 'lab'] as const
export const sampleLabels = ['临床样本', '虫媒样本', '环境样本', '实验室样本']
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const sampleCountsSchema = z.object({
  clinic: count, media: count, environment: count, lab: count,
})
export const projectInputSchema = z.object({
  sourceMessageId: z.string().uuid(),
  projectName: z.string().trim().min(1).max(200),
  projectDesc: z.string().trim().max(2000),
  phone: z.string().trim().min(1).max(32),
  samples: sampleCountsSchema,
})
export const projectFormSchema = z.object({
  projectCode: z.string().min(1),
  projectName: z.string(),
  phone: z.string(),
  teamId: z.string().min(1),
})
export const gpasPartSchema = z.object({
  type: z.literal('gpas'),
  order: z.number().int().nonnegative(),
  form: projectFormSchema.optional(),
  capability: z.object({
    id: z.string().nullable(),
    intent: z.string(),
    outcome: z.enum(['answer', 'execute', 'clarify']),
  }).optional(),
})
export type ProjectInput = z.infer<typeof projectInputSchema>
export type GpasPart = z.infer<typeof gpasPartSchema>

/** Files per chat upload batch; larger batches use the GPAS Web upload page. */
export const GPAS_UPLOAD_MAX_FILES = 10
// Same character rule GPAS applies to sequencing file names.
export const gpasFileNamePattern = /^[\w一-龥.-]+$/
const opaqueId = z.string().min(1).max(128).regex(/^[\w.:-]+$/)
/**
 * Client-reported outcome of uploading one file to GPAS. It only informs the
 * model; nothing on the server acts on it without re-checking GPAS.
 */
export const gpasUploadItemSchema = z.object({
  name: z.string().min(1).max(255).regex(gpasFileNamePattern),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  layout: z.enum(['single', 'paired']),
  role: z.enum(['R1', 'R2']).optional(),
  pairKey: opaqueId.optional(),
  status: z.enum(['uploaded', 'failed', 'cancelled']),
  fileId: opaqueId.optional(),
  groupId: opaqueId.optional(),
  error: z.string().max(500).optional(),
})
export const gpasUploadBatchSchema = z.object({
  sampleType: z.enum(sampleKeys),
  items: z.array(gpasUploadItemSchema).min(1).max(GPAS_UPLOAD_MAX_FILES),
})
export const gpasUploadPartSchema = z.object({
  type: z.literal('gpas_upload'),
  order: z.number().int().nonnegative(),
  batch: gpasUploadBatchSchema,
})
export type GpasUploadItem = z.infer<typeof gpasUploadItemSchema>
export type GpasUploadBatch = z.infer<typeof gpasUploadBatchSchema>
export type GpasUploadPart = z.infer<typeof gpasUploadPartSchema>
export type SampleKey = typeof sampleKeys[number]

export function sampleLabel(key: SampleKey): string {
  return sampleLabels[sampleKeys.indexOf(key)]
}

const uploadStatusLabels = { uploaded: '上传成功', failed: '上传失败', cancelled: '已取消' } as const

/**
 * Model-facing text appended to the user's message. Every field is schema
 * constrained; free text (errors) is flattened to one line.
 */
export function renderUploadContext(batch: GpasUploadBatch): string {
  const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  const lines = batch.items.map((item, index) => {
    const layout = item.layout === 'paired' ? `双端 ${item.role ?? ''}`.trim() : '单端'
    const fields = [
      item.name,
      layout,
      `${item.sizeBytes} 字节`,
      uploadStatusLabels[item.status],
      item.pairKey ? `配对组=${item.pairKey}` : '',
      item.groupId ? `groupId=${item.groupId}` : '',
      item.fileId ? `fileId=${item.fileId}` : '',
      item.error ? `原因=${oneLine(item.error)}` : '',
    ].filter(Boolean)
    return `${index + 1}. ${fields.join('｜')}`
  })
  const uploaded = batch.items.filter(item => item.status === 'uploaded').length
  const fileIds = batch.items.flatMap(item => item.status === 'uploaded' && item.fileId ? [item.fileId] : [])
  return [
    '[GPAS 文件上传结果（由客户端上报）]',
    `样本类型：${sampleLabel(batch.sampleType)}（${batch.sampleType}）`,
    `共 ${batch.items.length} 个文件，成功 ${uploaded} 个。`,
    ...lines,
    fileIds.length
      ? `说明：请先调用 file.list 工具（fileIds=${JSON.stringify(fileIds)}）查询这批文件在 GPAS 中的状态，并用表格展示返回结果；不能代为发起分析、提交或删除文件，这些操作请前往 GPAS Web。`
      : '说明：本批没有上传成功的文件；不能代为发起分析、提交或删除文件，这些操作请前往 GPAS Web。',
  ].join('\n')
}
