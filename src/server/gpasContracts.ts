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
const shortText = z.string().max(200)
/**
 * Parsed GPAS `briefAnalysis`: a summary only. `top` holds the species with
 * the highest relative abundance *within* the category (at most 5); the
 * category itself contains `speciesCount` species. The data has no
 * abundance share between categories, only species counts.
 */
export const fileBriefSchema = z.object({
  categories: z.array(z.object({
    type: shortText,
    name: shortText,
    speciesCount: z.number().int().nonnegative(),
    maxHazard: z.number().int().min(0).max(9),
    top: z.array(z.object({
      cnName: shortText,
      enName: shortText,
      taxId: shortText,
      abundancePct: z.number().min(0).max(100),
      hazard: z.number().int().min(0).max(9),
    })).max(5),
  })).max(12),
  totalReads: z.number().nonnegative().nullable(),
  dataVolume: z.number().nonnegative().nullable(),
  tools: z.array(shortText).max(5),
})
export const fileCardSchema = z.object({
  groupId: shortText.nullable(),
  paired: z.boolean(),
  files: z.array(z.object({ fileId: shortText, fileName: z.string().max(255), sizeBytes: z.number().nonnegative().nullable() })).min(1).max(2),
  sampleType: shortText.nullable(),
  status: shortText.nullable(),
  analysisStatus: shortText.nullable(),
  metaStatus: shortText.nullable(),
  uploadTime: shortText.nullable(),
  /** GPAS analysis id; file/result/list takes it as `taskId`. */
  analysisId: shortText.nullable(),
  brief: fileBriefSchema.nullable(),
})
export type FileBrief = z.infer<typeof fileBriefSchema>

/**
 * A category's share of all detected species, in percent (one decimal).
 * Based on species counts: the brief has no abundance across categories.
 */
export function categorySharePct(speciesCount: number, categories: readonly { speciesCount: number }[]) {
  const total = categories.reduce((sum, category) => sum + category.speciesCount, 0)
  return total > 0 ? Math.round((speciesCount / total) * 1000) / 10 : 0
}
export type FileCard = z.infer<typeof fileCardSchema>

/** Analysis task id accepted by file/result/list (the file list's analysisId). */
export const taskIdSchema = z.string().trim().min(1).max(128).regex(/^[\w.:-]+$/)
export const FILE_RESULT_PAGE_SIZE = 20
export const fileResultQuerySchema = z.object({
  taskId: taskIdSchema,
  speciesType: z.string().trim().min(1).max(64).regex(/^[\w-]+$/).optional(),
  page: z.number().int().min(1).max(10_000).optional(),
  pageSize: z.number().int().min(1).max(50).optional(),
})
/** One species row of file/result/list, normalized for the UI and the model. */
export const fileResultRowSchema = z.object({
  id: shortText,
  speciesType: shortText,
  taxCname: shortText,
  taxEname: shortText,
  coverage: shortText,
  /** Only http(s) links survive parsing. */
  coverageUrl: z.string().max(2048).nullable(),
  colonization: shortText,
  colonizationE: shortText,
  /** Only #hex or rgb() colors survive parsing. */
  color: shortText.nullable(),
  barcodeId: shortText,
  /** 生物学编号. */
  taxId: shortText,
  hazardIndex: z.number().int().min(0).max(9).nullable(),
  /** Coverage as a fraction (0.05 = 5%), for the evidence radar. */
  coverageValue: z.number().nonnegative().nullable(),
  // Evidence radar inputs, raw as GPAS reports them.
  selfAlignRatio: z.number().nullable(),
  onlyMatching: z.number().nullable(),
  /** −log10 P of the genome uniformity test. */
  unifPvalue: z.number().nullable(),
  /** In-sample abundance, in percent. */
  abundance: z.number().nullable(),
  ani95SpeciesNums: z.number().nullable(),
})
export const fileResultPageSchema = z.object({
  taskId: taskIdSchema,
  speciesType: shortText.nullable(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().nonnegative(),
  totalPage: z.number().int().nonnegative(),
  rows: z.array(fileResultRowSchema).max(50),
})
export type FileResultQuery = z.infer<typeof fileResultQuerySchema>

/**
 * The card's "查看详情" sends this text; the analysis id travels in `detail`
 * and reaches only the model context, never the visible message.
 */
export const FILE_RESULT_REQUEST_TEXT = '通过分析ID查看样本详情'
export const gpasDetailRequestSchema = z.object({ taskId: taskIdSchema })
export const gpasDetailPartSchema = z.object({
  type: z.literal('gpas_detail'),
  order: z.number().int().nonnegative(),
  taskId: taskIdSchema,
})
export type GpasDetailRequest = z.infer<typeof gpasDetailRequestSchema>
export type GpasDetailPart = z.infer<typeof gpasDetailPartSchema>

/** Model-facing context appended to a detail request. */
export function renderDetailContext(detail: GpasDetailRequest): string {
  return [
    '[样本分析详情请求（由客户端上报）]',
    `taskId=${detail.taskId}`,
    `说明：请调用 file.result 工具（taskId=${detail.taskId}）。完整物种列表会在右侧面板展示，回复只需 1–2 句简短概括（检出总数、值得关注的高风险物种），不要复述 taskId，不要逐条列举物种。`,
  ].join('\n')
}
export type FileResultRow = z.infer<typeof fileResultRowSchema>
export type FileResultPage = z.infer<typeof fileResultPageSchema>

export const gpasPartSchema = z.object({
  type: z.literal('gpas'),
  order: z.number().int().nonnegative(),
  form: projectFormSchema.optional(),
  /** Uploaded file cards from the file list tool. */
  files: z.array(fileCardSchema).max(20).optional(),
  /** Entry to a sample's analysis detail, opened in the side panel. */
  result: z.object({ taskId: taskIdSchema, total: z.number().int().nonnegative() }).optional(),
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
  const fileNames = batch.items.flatMap(item => item.status === 'uploaded' ? [item.name] : [])
  return [
    '[GPAS 文件上传结果（由客户端上报）]',
    `样本类型：${sampleLabel(batch.sampleType)}（${batch.sampleType}）`,
    `共 ${batch.items.length} 个文件，成功 ${uploaded} 个。`,
    ...lines,
    fileNames.length
      ? `说明：请先调用 file.list 工具（fileNames=${JSON.stringify(fileNames)}）按文件名查询这批文件在 GPAS 中的状态和分析结果；不能代为发起分析、提交或删除文件，这些操作请前往 GPAS Web。`
      : '说明：本批没有上传成功的文件；不能代为发起分析、提交或删除文件，这些操作请前往 GPAS Web。',
  ].join('\n')
}
