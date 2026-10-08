import { z } from 'zod'

import { textCell } from '../../gpas.js'
import {
  FILE_RESULT_PAGE_SIZE,
  fileResultPageSchema,
  fileResultQuerySchema,
  type FileResultPage,
  type FileResultRow,
} from '../../gpasContracts.js'
import { defineGpasTool } from '../defineTool.js'

const cell = z.union([z.string(), z.number()]).nullish().transform((value) => String(value ?? '').trim().slice(0, 200))
const count = z.union([z.number(), z.string()]).nullish().transform((value) => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
})
const rawRowSchema = z.object({
  id: cell,
  speciesType: cell,
  taxCname: cell,
  taxEname: cell,
  coverage: cell,
  coverageUrl: z.string().nullish(),
  colonization: cell,
  colonizationE: cell,
  color: z.string().nullish(),
  barcodeId: cell,
}).passthrough()
const resultListSchema = z.object({
  dataPage: z.object({
    dataList: z.array(rawRowSchema).nullish(),
    page: count,
    pageSize: count,
    totalData: count,
    totalPage: count,
  }).passthrough(),
})

const colorPattern = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i

function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href.slice(0, 2048) : null
  } catch {
    return null
  }
}

function toRow(row: z.infer<typeof rawRowSchema>): FileResultRow {
  const color = row.color?.trim() ?? ''
  return {
    id: row.id,
    speciesType: row.speciesType,
    taxCname: row.taxCname || row.taxEname,
    taxEname: row.taxEname,
    coverage: row.coverage,
    coverageUrl: safeUrl(row.coverageUrl),
    colonization: row.colonization,
    colonizationE: row.colonizationE,
    color: colorPattern.test(color) ? color : null,
    barcodeId: row.barcodeId,
  }
}

export function fileResultReply(data: FileResultPage): string {
  if (data.total === 0) return `样本 ${textCell(data.taskId)} 暂无分析详情。`
  return `样本 ${textCell(data.taskId)} 共检出 ${data.total} 条物种结果，完整列表可在右侧面板按类别和分页查看。`
}

export const fileResultTool = defineGpasTool({
  id: 'file.result', domain: 'file', title: '样本分析详情', effect: 'read',
  description: '按样本的 taskId（上传文件列表中的 taskId / analysisId）查询该样本的物种分析详情，可按大类 speciesType 筛选并分页。',
  examples: ['查看样本:123456分析详情', '这个样本的分析详情', '样本检出了哪些物种', '看一下这个样本的细菌明细', '分析详情下一页'],
  policy: '可以查询当前团队样本的物种分析详情（物种名称、类别、覆盖度、定植情况），完整列表在右侧面板按类别分页展示；不能修改或重新分析样本。',
  input: fileResultQuerySchema,
  run: async ({ cookie, client }, args): Promise<FileResultPage> => {
    const page = args.page ?? 1
    const pageSize = args.pageSize ?? FILE_RESULT_PAGE_SIZE
    const data = await client.read(cookie, {
      operation: 'file_result_list', label: '样本分析详情查询', method: 'GET', path: 'file/result/list',
      query: { taskId: args.taskId, speciesType: args.speciesType, page, pageSize },
    }, resultListSchema)
    const total = data.dataPage.totalData
    return fileResultPageSchema.parse({
      taskId: args.taskId,
      speciesType: args.speciesType ?? null,
      page,
      pageSize,
      total,
      totalPage: data.dataPage.totalPage || Math.ceil(total / pageSize),
      rows: (data.dataPage.dataList ?? []).slice(0, pageSize).map(toRow),
    })
  },
  toModel: (data) => ({
    taskId: data.taskId,
    speciesType: data.speciesType,
    page: data.page,
    pageSize: data.pageSize,
    total: data.total,
    totalPage: data.totalPage,
    note: `这是第 ${data.page} 页；完整列表已在右侧面板展示，可按类别和分页查看。只需简短概括，其它页或其它类别可再次调用本工具（page / speciesType）。`,
    rows: data.rows.map((row) => ({
      taxCname: row.taxCname, taxEname: row.taxEname, speciesType: row.speciesType,
      coverage: row.coverage, colonization: row.colonization, colonizationE: row.colonizationE, barcodeId: row.barcodeId,
    })),
  }),
  toReply: (data) => ({
    content: fileResultReply(data),
    part: { type: 'gpas', order: 1, result: { taskId: data.taskId, total: data.total } },
  }),
})
