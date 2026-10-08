import { z } from 'zod'

import { AuthenticationError } from '../../auth.js'
import { textCell } from '../../gpas.js'
import { categorySharePct, fileBriefSchema, sampleKeys, sampleLabel, type FileBrief, type FileCard, type SampleKey } from '../../gpasContracts.js'
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

/** Rows of a fileId lookup are taken from the newest page; a batch is at most 10 files. */
const LOOKUP_PAGE_SIZE = 50
const filter = z.string().trim().min(1).max(200).optional()

const pick = (file: z.infer<typeof fileSchema>) => ({
  fileId: file.fileId, fileName: file.fileName, sampleType: file.sampleType, sizeBytes: file.size ?? null,
  status: file.status, qcStatus: file.qcStatus, analysisStatus: file.analysisStatus,
  metaStatus: file.metaStatus, uploadTime: file.uploadTime,
})
export type UploadedFileRow = { paired: boolean; groupId: string | null; files: ReturnType<typeof pick>[] }
export type UploadedFileList = { total: number; rows: UploadedFileRow[]; cards: FileCard[]; missingFileIds: string[] }

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
 * one, keeping a row that has a readable brief; pair files are ordered by name.
 */
export function mergeDuplicateRows(rows: ListRow[]): ListRow[] {
  const merged = new Map<string, ListRow>()
  for (const row of rows) {
    const key = sampleKey(row)
    const kept = merged.get(key)
    if (!kept || (!briefFor(kept.files) && briefFor(row.files))) merged.set(key, row)
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
    analysisStatus: first.analysisStatus,
    metaStatus: first.metaStatus,
    uploadTime: first.uploadTime,
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
  if (data.rows.length === 0 && data.missingFileIds.length === 0) return '没有查询到上传文件。'
  const lines = data.rows.flatMap((row) => row.files.map((file, index) => `| ${[
    file.fileName, row.paired ? `双端 R${index + 1}` : '单端', sampleText(file.sampleType),
    file.status, file.qcStatus, file.analysisStatus, file.metaStatus, file.uploadTime,
  ].map(textCell).join(' | ')} |`))
  const table = lines.length
    ? `| 文件名 | 单/双端 | 样本类型 | 状态 | 质检 | 分析 | 元信息 | 上传时间 |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${lines.join('\n')}`
    : ''
  const missing = data.missingFileIds.length
    ? `\n\n以下文件暂未出现在列表中，可能仍在入库，请稍后再查：${data.missingFileIds.map(textCell).join('、')}`
    : ''
  return `${table}${missing}`.trim()
}

export const fileListTool = defineGpasTool({
  id: 'file.list', domain: 'file', title: '上传文件列表', effect: 'read',
  description: '查询当前团队已上传的测序文件及其状态、质检、分析、元信息状态。传入 fileIds 时只返回这些文件（用于展示刚上传的一批文件）。',
  examples: ['我上传的文件', '刚才上传的测序数据状态', '查一下质检结果', '我的文件列表', '上传的文件分析完了吗'],
  policy: '可以查询当前团队上传文件的列表、状态与分析摘要（各类别丰度前 5 的物种及其它、各类别检出种数占比），结果以卡片展示；不能代为发起分析、提交或删除文件，这些操作请前往 GPAS Web。',
  input: z.object({
    fileIds: z.array(z.string().min(1).max(128)).max(20).optional(),
    fileName: filter,
    status: filter,
    qcStatus: filter,
    analysisStatus: filter,
    page: z.number().int().min(1).max(1000).optional(),
    pageSize: z.number().int().min(1).max(50).optional(),
  }),
  run: async ({ profile, cookie, client }, args) => {
    if (!profile.ownteamId) throw new AuthenticationError('当前用户未关联团队，无法查询文件。', 422, 'team_missing')
    const lookup = args.fileIds?.length ? new Set(args.fileIds) : null
    const { fileIds: _ids, page, pageSize, ...filters } = args
    // GET with query parameters. orderBy is left to the API default
    // (-update_time, -create_time), which already lists new uploads first.
    const data = await client.read(cookie, {
      operation: 'file_merge_list', label: '上传文件列表查询', method: 'GET', path: 'file/dual/merge/list',
      query: {
        ...filters,
        page: lookup ? 1 : page ?? 1,
        pageSize: lookup ? LOOKUP_PAGE_SIZE : pageSize ?? 20,
        ownTeamId: profile.ownteamId,
      },
    }, listSchema)
    const listed = data.dataPage.dataList
      .map((row) => ({
        paired: row.isPair,
        groupId: row.file1.groupId ?? row.file2?.groupId ?? null,
        files: [row.file1, ...(row.file2 ? [row.file2] : [])],
      }))
      .filter((row) => !lookup || row.files.some((file) => lookup.has(file.fileId)))
    const rows = mergeDuplicateRows(listed)
    const found = new Set(rows.flatMap((row) => row.files.map((file) => file.fileId)))
    return {
      total: lookup ? rows.length : data.dataPage.totalData - (listed.length - rows.length),
      rows: rows.map((row) => ({ ...row, files: row.files.map(pick) })),
      cards: rows.slice(0, 20).map(toCard),
      missingFileIds: lookup ? [...lookup].filter((id) => !found.has(id)) : [],
    }
  },
  toModel: (data) => ({
    total: data.total,
    missingFileIds: data.missingFileIds,
    note: '结果已以卡片展示在回复下方，只需简短解读，不要逐条罗列。brief 为分析摘要：top 是该类别内相对丰度前 topN 的物种，'
      + '该类别共检出 speciesCount 种，不是只检出这几种；abundance 为类别内相对丰度。'
      + 'sharePct 是该类别检出种数占全部检出种数的比例，要说“种数占比”，不是丰度或 reads 占比。',
    samples: data.cards.map((card, index) => ({
      files: data.rows[index].files.map((file) => ({ fileId: file.fileId, fileName: file.fileName, qcStatus: file.qcStatus })),
      paired: card.paired,
      sampleType: card.sampleType,
      status: card.status,
      analysisStatus: card.analysisStatus,
      metaStatus: card.metaStatus,
      brief: briefForModel(card.brief),
    })),
  }),
  toReply: (data) => ({
    content: fileListReply(data),
    part: { type: 'gpas', order: 1, ...(data.cards.length ? { files: data.cards } : {}) },
  }),
})
