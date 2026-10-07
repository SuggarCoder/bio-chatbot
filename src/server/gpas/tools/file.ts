import { z } from 'zod'

import { AuthenticationError } from '../../auth.js'
import { textCell } from '../../gpas.js'
import { sampleKeys, sampleLabel, type SampleKey } from '../../gpasContracts.js'
import { defineGpasTool } from '../defineTool.js'

const text = z.string().nullish().transform((value) => value ?? null)
const fileSchema = z.object({
  fileId: z.union([z.string().min(1), z.number()]).transform(String),
  fileName: z.string(),
  groupId: text,
  sampleType: text,
  size: z.number().nullish(),
  status: text,
  qcStatus: text,
  analysisStatus: text,
  metaStatus: text,
  briefAnalysis: text,
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
  metaStatus: file.metaStatus, briefAnalysis: file.briefAnalysis, uploadTime: file.uploadTime,
})
export type UploadedFileRow = { paired: boolean; groupId: string | null; files: ReturnType<typeof pick>[] }
export type UploadedFileList = { total: number; rows: UploadedFileRow[]; missingFileIds: string[] }

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
  policy: '可以查询当前团队上传文件的列表与状态；不能代为发起分析、提交或删除文件，这些操作请前往 GPAS Web。',
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
    const data = await client.read(cookie, {
      operation: 'file_merge_list', label: '上传文件列表查询', method: 'POST', path: 'file/dual/merge/list',
      body: {
        ...filters,
        page: lookup ? 1 : page ?? 1,
        pageSize: lookup ? LOOKUP_PAGE_SIZE : pageSize ?? 20,
        orderBy: ['-create_time'],
        ownTeamId: profile.ownteamId,
      },
    }, listSchema)
    const rows = data.dataPage.dataList
      .map((row) => ({
        paired: row.isPair,
        groupId: row.file1.groupId ?? row.file2?.groupId ?? null,
        files: [row.file1, ...(row.file2 ? [row.file2] : [])],
      }))
      .filter((row) => !lookup || row.files.some((file) => lookup.has(file.fileId)))
    const found = new Set(rows.flatMap((row) => row.files.map((file) => file.fileId)))
    return {
      total: lookup ? rows.length : data.dataPage.totalData,
      rows: rows.map((row) => ({ ...row, files: row.files.map(pick) })),
      missingFileIds: lookup ? [...lookup].filter((id) => !found.has(id)) : [],
    }
  },
  toModel: (data) => data,
  toReply: (data) => ({ content: fileListReply(data), part: { type: 'gpas', order: 1 } }),
})
