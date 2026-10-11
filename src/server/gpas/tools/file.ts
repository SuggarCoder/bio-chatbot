import { z } from 'zod'

import { AuthenticationError } from '../../auth.js'
import { textCell } from '../../gpas.js'
import { categorySharePct, fileBriefSchema, sampleKeys, sampleNameOf, sampleLabel, type FileBrief, type FileCard, type SampleKey } from '../../gpasContracts.js'
import { defineGpasTool } from '../defineTool.js'

const text = z.string().nullish().transform((value) => value ?? null)
const id = z.union([z.string(), z.number()]).nullish().transform((value) => value == null || value === '' ? null : String(value))
const fileSchema = z.object({
  fileId: z.union([z.string().min(1), z.number()]).transform(String),
  fileName: z.string(),
  groupId: id,
  analysisId: id,
  sampleType: text,
  size: z.number().nullish(),
  status: text,
  qcStatus: text,
  analysisStatus: text,
  metaStatus: text,
  briefAnalysis: z.unknown().optional(),
  uploadTime: text,
}).passthrough()
const listSchema = z.object({
  dataPage: z.object({
    dataList: z.array(z.object({ isPair: z.boolean(), file1: fileSchema, file2: fileSchema.nullish() }).passthrough()),
    totalData: z.number().int().nonnegative(),
  }).passthrough(),
})

/** Rows fetched per file name; the API may match names loosely, exact names are kept. */
const NAME_LOOKUP_PAGE_SIZE = 10
/**
 * `analyzedOnly` reads the newest uploads in pages of this size, at most this
 * many pages: new uploads sort first, so analysed samples are often not on
 * the first page at all.
 */
const SCAN_PAGE_SIZE = 50
const SCAN_MAX_PAGES = 10
const DEFAULT_PAGE_SIZE = 20
const filter = z.string().trim().min(1).max(200).optional()

const pick = (file: z.infer<typeof fileSchema>) => ({
  fileId: file.fileId, fileName: file.fileName, sampleType: file.sampleType, sizeBytes: file.size ?? null,
  status: file.status, qcStatus: file.qcStatus, analysisStatus: file.analysisStatus,
  metaStatus: file.metaStatus, uploadTime: file.uploadTime,
})
export type UploadedFileRow = { paired: boolean; groupId: string | null; files: ReturnType<typeof pick>[] }
export type UploadedFileList = {
  total: number
  rows: UploadedFileRow[]
  cards: FileCard[]
  missingFileNames: string[]
  page?: number
  pageSize?: number
  /** More samples exist past this page. */
  hasMore?: boolean
  /** Set for `analyzedOnly`: how many uploads were read and whether that was all of them. */
  scan?: { uploaded: number; read: number; complete: boolean }
}

/** Species kept per category; the brief is a summary, not the full result. */
export const BRIEF_TOP_SPECIES = 5
const MAX_CATEGORIES = 12

const numeric = z.union([z.number(), z.string()]).nullish().transform((value) => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').replace('%', ''))
  return Number.isFinite(parsed) ? parsed : null
})
const label = z.union([z.string(), z.number()]).nullish().transform((value) => String(value ?? '').trim().slice(0, 200))
const rawBriefSchema = z.object({
  code: z.union([z.string(), z.number()]).transform(String),
  microbialInfo: z.array(z.object({
    microbialType: label,
    microbialName: label,
    microbialNum: numeric,
    maxHazandIndex: numeric,
    topInfos: z.array(z.object({
      taxCnName: label, taxEnName: label, taxId: label, abundance: numeric, hazardIndex: numeric,
    }).passthrough()).nullish(),
  }).passthrough()).nullish(),
  totalReads: numeric,
  dataVolume: numeric,
  tool: z.array(z.object({ tool_name: label }).passthrough()).nullish(),
}).passthrough()

const level = (value: number | null) => Math.min(9, Math.max(0, Math.round(value ?? 0)))

/**
 * Parses GPAS `briefAnalysis`, which arrives as a JSON string (sometimes
 * encoded twice). Anything unexpected yields null so the card degrades to
 * file information only.
 */
export function parseBrief(raw: unknown): FileBrief | null {
  let value = raw
  for (let depth = 0; depth < 2 && typeof value === 'string'; depth += 1) {
    if (!value.trim()) return null
    try { value = JSON.parse(value) } catch { return null }
  }
  const parsed = rawBriefSchema.safeParse(value)
  if (!parsed.success || parsed.data.code !== '0') return null
  const brief = {
    categories: (parsed.data.microbialInfo ?? []).slice(0, MAX_CATEGORIES).map((category) => ({
      type: category.microbialType,
      name: category.microbialName || category.microbialType || '未分类',
      speciesCount: Math.max(0, Math.round(category.microbialNum ?? 0)),
      maxHazard: level(category.maxHazandIndex),
      top: (category.topInfos ?? [])
        .map((item) => ({
          cnName: item.taxCnName || item.taxEnName || item.taxId,
          enName: item.taxEnName,
          taxId: item.taxId,
          abundancePct: Math.min(100, Math.max(0, item.abundance ?? 0)),
          hazard: level(item.hazardIndex),
        }))
        .sort((a, b) => b.abundancePct - a.abundancePct)
        .slice(0, BRIEF_TOP_SPECIES),
    })),
    totalReads: parsed.data.totalReads,
    dataVolume: parsed.data.dataVolume,
    tools: (parsed.data.tool ?? []).map((tool) => tool.tool_name).filter(Boolean).slice(0, 5),
  }
  const checked = fileBriefSchema.safeParse(brief)
  return checked.success ? checked.data : null
}

type ListFile = z.infer<typeof fileSchema>
// Both ends of a pair carry the same analysis as a single-end file, so the
// first readable briefAnalysis stands for the whole sample.
function briefFor(files: ListFile[]): FileBrief | null {
  for (const file of files) {
    const brief = parseBrief(file.briefAnalysis)
    if (brief) return brief
  }
  return null
}

type ListRow = { paired: boolean; groupId: string | null; files: ListFile[] }

/** GPAS marks a finished analysis with this `analysisStatus`; other values mean not finished. */
export const ANALYSIS_DONE_STATUS = 'analysisverified'
const isDoneStatus = (status: string | null) => status?.trim().toLowerCase() === ANALYSIS_DONE_STATUS
const analysisDone = (files: ListFile[]) => files.some((file) => isDoneStatus(file.analysisStatus))
/** Which listing of a sample to keep: a finished analysis first, then a readable brief. */
const rowRank = (row: ListRow) => (analysisDone(row.files) ? 2 : 0) + (briefFor(row.files) ? 1 : 0)

/**
 * A sample's identity: a pair by its groupId, else its analysisId; a
 * single-end file (or a pair carrying neither) by its fileIds.
 */
function sampleKey(row: ListRow) {
  const analysisId = row.files.find((file) => file.analysisId)?.analysisId
  if (row.paired && row.groupId) return `group:${row.groupId}`
  if (row.paired && analysisId) return `analysis:${analysisId}`
  return `files:${row.files.map((file) => file.fileId).sort().join('\n')}`
}

/**
 * merge/list can return the same pair twice (R1/R2 and R2/R1), often with
 * the analysis on only one of them. Rows of the same sample collapse into
 * one, keeping a row whose analysis is finished, else one with a readable
 * brief; pair files are ordered by name.
 */
export function mergeDuplicateRows(rows: ListRow[]): ListRow[] {
  const merged = new Map<string, ListRow>()
  for (const row of rows) {
    const key = sampleKey(row)
    const kept = merged.get(key)
    if (!kept || rowRank(row) > rowRank(kept)) merged.set(key, row)
  }
  return [...merged.values()].map((row) => ({
    ...row,
    files: [...row.files].sort((a, b) => a.fileName.localeCompare(b.fileName)),
  }))
}

function toCard(row: { paired: boolean; groupId: string | null; files: ListFile[] }): FileCard {
  const [first] = row.files
  return {
    groupId: row.groupId,
    paired: row.paired,
    files: row.files.map((file) => ({ fileId: file.fileId, fileName: file.fileName, sizeBytes: file.size ?? null })),
    sampleType: first.sampleType,
    status: first.status,
    analysisStatus: (row.files.find((file) => isDoneStatus(file.analysisStatus)) ?? first).analysisStatus,
    metaStatus: first.metaStatus,
    uploadTime: first.uploadTime,
    analysisId: row.files.find((file) => file.analysisId)?.analysisId ?? null,
    brief: briefFor(row.files),
  }
}

/** Compact model view: species as short strings. */
function briefForModel(brief: FileBrief | null) {
  if (!brief) return null
  return {
    totalReads: brief.totalReads,
    categories: brief.categories.map((category) => ({
      name: category.name,
      speciesCount: category.speciesCount,
      sharePct: categorySharePct(category.speciesCount, brief.categories),
      topN: category.top.length,
      maxHazard: category.maxHazard,
      top: category.top.map((item) => `${item.cnName} ${item.abundancePct}% 危害${item.hazard}`),
    })),
  }
}

const sampleText = (value: string | null) =>
  value && (sampleKeys as readonly string[]).includes(value) ? sampleLabel(value as SampleKey) : value

export function fileListReply(data: UploadedFileList): string {
  if (data.rows.length === 0 && data.missingFileNames.length === 0) return '没有查询到上传文件。'
  const lines = data.rows.flatMap((row) => row.files.map((file, index) => `| ${[
    file.fileName, row.paired ? `双端 R${index + 1}` : '单端', sampleText(file.sampleType),
    file.status, file.qcStatus, file.analysisStatus, file.metaStatus, file.uploadTime,
  ].map(textCell).join(' | ')} |`))
  const table = lines.length
    ? `| 文件名 | 单/双端 | 样本类型 | 状态 | 质检 | 分析 | 元信息 | 上传时间 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${lines.join('\n')}`
    : ''
  const missing = data.missingFileNames.length
    ? `\n\n以下文件暂未出现在列表中，可能仍在入库，请稍后再查：${data.missingFileNames.map(textCell).join('、')}`
    : ''
  return `${table}${missing}`.trim()
}

/** Keeps the model from reading one page as every sample the team has. */
function pagingNote(data: UploadedFileList): string {
  if (!data.page) return ''
  const scope = data.scan
    ? `total 是分析已完成（analysisStatus=${ANALYSIS_DONE_STATUS}）的样本数（服务端读取了最近上传的 ${data.scan.read} 个文件行，共 ${data.scan.uploaded} 个`
      + `${data.scan.complete ? '，已全部检查' : '，更早的上传未检查，回复时要说明是最近上传中的结果，更早的可到 GPAS Web 查看'}）。`
    : 'total 是符合条件的样本总数，samples 只是其中一页；不要把这一页当成全部，也不要据此推断其余样本的分析状态。'
  const more = data.hasMore ? `还有更多样本（hasMore=true），回复时说明共 ${data.total} 个，可继续查看下一页（page=${data.page + 1}）。` : ''
  return scope + more
}

export const fileListTool = defineGpasTool({
  id: 'file.list', domain: 'file', title: '上传文件列表', effect: 'read',
  description: '查询当前团队已上传的测序文件及其状态、质检、分析、元信息状态，结果分页（默认每页 20 个样本，按上传时间从新到旧）。传入 fileNames 时按文件名查询并只返回这些文件（用于展示刚上传的一批文件的分析结果）；fileName 可传样本名，用于按样本名查找样本的 taskId（分析 ID）；用户只想看已有分析结果的样本时传 analyzedOnly=true，服务端会翻阅多页只返回分析已完成的样本。',
  examples: ['我上传的文件', '刚才上传的测序数据状态', '查一下质检结果', '我的文件列表', '上传的文件分析完了吗', '只展示我已经有查询结果的样本', '哪些样本已经分析完了'],
  policy: '可以查询当前团队上传文件的列表、状态与分析摘要（各类别丰度前 5 的物种及其它、各类别检出种数占比），结果以卡片展示；不能代为发起分析、提交或删除文件，这些操作请前往 GPAS Web。',
  input: z.object({
    fileNames: z.array(z.string().trim().min(1).max(255)).max(20).optional(),
    fileName: filter,
    /** Only samples whose analysis is finished (analysisStatus analysisverified). */
    analyzedOnly: z.boolean().optional(),
    status: filter,
    qcStatus: filter,
    analysisStatus: filter,
    page: z.number().int().min(1).max(1000).optional(),
    pageSize: z.number().int().min(1).max(50).optional(),
  }),
  run: async ({ profile, cookie, client }, args) => {
    if (!profile.ownteamId) throw new AuthenticationError('当前用户未关联团队，无法查询文件。', 422, 'team_missing')
    const ownTeamId = profile.ownteamId
    const names = [...new Set(args.fileNames ?? [])]
    const { fileNames: _names, analyzedOnly, page = 1, pageSize = DEFAULT_PAGE_SIZE, ...filters } = args
    // GET with query parameters. orderBy is left to the API default
    // (-update_time, -create_time), which already lists new uploads first.
    const list = (query: Record<string, string | number | undefined>) => client.read(cookie, {
      operation: 'file_merge_list', label: '上传文件列表查询', method: 'GET', path: 'file/dual/merge/list',
      query: { ...query, ownTeamId },
    }, listSchema)
    const toRows = (data: z.infer<typeof listSchema>) => data.dataPage.dataList.map((row) => ({
      paired: row.isPair,
      groupId: row.file1.groupId ?? row.file2?.groupId ?? null,
      files: [row.file1, ...(row.file2 ? [row.file2] : [])],
    }))

    if (names.length) {
      // One query per uploaded file name; both ends of a pair find the same sample.
      const pages = await Promise.all(names.map((fileName) => list({ fileName, page: 1, pageSize: NAME_LOOKUP_PAGE_SIZE })))
      const wanted = new Set(names)
      const rows = mergeDuplicateRows(pages.flatMap(toRows).filter((row) => row.files.some((file) => wanted.has(file.fileName))))
      const found = new Set(rows.flatMap((row) => row.files.map((file) => file.fileName)))
      return {
        total: rows.length,
        rows: rows.map((row) => ({ ...row, files: row.files.map(pick) })),
        cards: rows.slice(0, 20).map(toCard),
        missingFileNames: names.filter((name) => !found.has(name)),
      }
    }

    if (analyzedOnly) {
      const first = await list({ ...filters, page: 1, pageSize: SCAN_PAGE_SIZE })
      const uploaded = first.dataPage.totalData
      const pages = Math.max(1, Math.min(SCAN_MAX_PAGES, Math.ceil(uploaded / SCAN_PAGE_SIZE)))
      const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, index) =>
        list({ ...filters, page: index + 2, pageSize: SCAN_PAGE_SIZE })))
      const listed = [first, ...rest].flatMap(toRows)
      // Merged across pages: a pair's two listings may fall on different pages.
      const analysed = mergeDuplicateRows(listed).filter((row) => analysisDone(row.files))
      const rows = analysed.slice((page - 1) * pageSize, page * pageSize)
      const complete = listed.length >= uploaded
      return {
        total: analysed.length,
        rows: rows.map((row) => ({ ...row, files: row.files.map(pick) })),
        cards: rows.slice(0, 20).map(toCard),
        missingFileNames: [],
        page,
        pageSize,
        hasMore: page * pageSize < analysed.length,
        scan: { uploaded, read: listed.length, complete },
      }
    }

    const data = await list({ ...filters, page, pageSize })
    const listed = toRows(data)
    const rows = mergeDuplicateRows(listed)
    return {
      total: data.dataPage.totalData - (listed.length - rows.length),
      rows: rows.map((row) => ({ ...row, files: row.files.map(pick) })),
      cards: rows.slice(0, 20).map(toCard),
      missingFileNames: [],
      page,
      pageSize,
      hasMore: page * pageSize < data.dataPage.totalData,
    }
  },
  toModel: (data) => ({
    total: data.total,
    ...(data.page ? { page: data.page, pageSize: data.pageSize, hasMore: data.hasMore } : {}),
    ...(data.scan ? { analyzedOnly: true, scan: data.scan } : {}),
    missingFileNames: data.missingFileNames,
    note: pagingNote(data) + '结果已展示在回复下方（单个样本为卡片，多个样本为表格），只需简短解读，不要逐条罗列。brief 为分析摘要：top 是该类别内相对丰度前 topN 的物种，'
      + '该类别共检出 speciesCount 种，不是只检出这几种；abundance 为类别内相对丰度。'
      + 'sharePct 是该类别检出种数占全部检出种数的比例，要说“种数占比”，不是丰度或 reads 占比。'
      + `analysisDone 为 true 表示分析已完成（analysisStatus=${ANALYSIS_DONE_STATUS}），其它 analysisStatus 都是尚未完成；`
      + '向用户说“分析已完成”，不要把状态值直译成“已验证”。'
      + 'taskId 只用于调用样本分析详情工具，不要展示给用户；称呼样本时用 sampleName。',
    samples: data.cards.map((card, index) => ({
      sampleName: sampleNameOf(card.files.map((file) => file.fileName)),
      files: data.rows[index].files.map((file) => ({ fileId: file.fileId, fileName: file.fileName, qcStatus: file.qcStatus })),
      taskId: card.analysisId,
      paired: card.paired,
      sampleType: card.sampleType,
      status: card.status,
      analysisStatus: card.analysisStatus,
      analysisDone: isDoneStatus(card.analysisStatus),
      metaStatus: card.metaStatus,
      brief: briefForModel(card.brief),
    })),
  }),
  toReply: (data) => ({
    content: fileListReply(data),
    part: { type: 'gpas', order: 1, ...(data.cards.length ? { files: data.cards } : {}) },
  }),
})
