import { z } from 'zod'
import { AuthenticationError } from './auth.js'
import type { AppConfig } from './config.js'
import type { Gpas2UserInfo } from './domain.js'
import { sampleKeys, sampleLabels, sampleCountsSchema, type GpasPart, type ProjectInput } from './gpasContracts.js'

export function gpasIntent(text: string): 'profile' | 'progress' | null {
  const normalized = text.trim().replace(/[\s，。？！?!、：:]/g, '')
  if (normalized.length > 100) return null
  if (/我是谁|我的(?:个人|用户|账号|账户|团队)信息|我的团队(?:是谁|叫什么|是什么)|我(?:属于|所在的?|是)(?:哪个|什么)?团队/.test(normalized)) return 'profile'
  if (/(?:我的?|我们|当前|查询|查看|检查|显示|初始化|创建).*(?:项目|任务|样本).*(?:进度|进展|情况|完成|提交|初始化|创建)|(?:初始化|创建)(?:我的|团队)?项目|(?:我的?|我们).*样本.*(?:还差|还剩|多少|没交)/.test(normalized)) return 'progress'
  return null
}

const textCell = (value: unknown) => String(value || '未提供').replace(/[\\`*_{}\[\]<>()|#]/g, '\\$&').replace(/[\r\n]+/g, ' ')
export function profileReply(profile: Gpas2UserInfo) {
  return `当前登录用户与团队信息：\n\n| 信息 | 内容 |\n| --- | --- |\n${[
    ['姓名', profile.realName], ['账号', profile.userName], ['用户 ID', profile.userId],
    ['团队', profile.ownteamName], ['团队 ID', profile.ownteamId],
    ['职称', profile.jobTitle], ['联系方式', profile.phone], ['邮箱', profile.email],
  ].map(([label, value]) => `| ${label} | ${textCell(value)} |`).join('\n')}`
}

const envelope = z.object({ code: z.number(), message: z.string().optional() }).passthrough()
const seedSchema = z.object({
  projectCode: z.string().min(1), userName: z.string(), projectName: z.string().optional(),
  phone: z.string().optional(), teamId: z.string().min(1),
})
const existenceSchema = z.object({ data: z.boolean(), info: seedSchema.optional() })
const optionalCounts = sampleCountsSchema.partial()
const summarySchema = z.object({
  projectPlanInfo: sampleCountsSchema.extend({ name: z.string(), id: z.string() }),
  realSubmitInfo: z.array(optionalCounts.extend({ year: z.number().int(), month: z.number().int().min(1).max(12) })),
})

export type BusinessReply = {
  content: string
  part: GpasPart
}

export class GpasService {
  // Development fixtures are isolated to this process and never enabled in production.
  private readonly mockProjects = new Map<string, ProjectInput>()
  constructor(private readonly config: AppConfig) {}

  private team(profile: Gpas2UserInfo) {
    if (!profile.ownteamId) throw new AuthenticationError('当前用户未关联团队，无法查询项目。', 422, 'team_missing')
    return profile.ownteamId
  }

  private async request(cookie: string | undefined, path: string, body?: unknown) {
    if (!cookie) throw new AuthenticationError('登录已失效，请重新登录。')
    const url = new URL(`../${path}`, this.config.gpas2UserInfoUrl)
    let response: Response
    try {
      response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { accept: 'application/json', cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      throw new AuthenticationError('项目服务暂时不可用，请稍后重试；若刚提交过表单，请先查询项目进度确认结果。', 502, 'gpas_unavailable')
    }
    if (response.status === 401 || response.status === 403) throw new AuthenticationError('登录已失效或无权访问项目。', response.status)
    if (!response.ok) throw new AuthenticationError('项目服务返回错误，请稍后重试。', 502, 'gpas_upstream_error')
    let payload: z.infer<typeof envelope>
    try { payload = envelope.parse(await response.json()) } catch {
      throw new AuthenticationError('项目服务返回了无效数据。', 502, 'gpas_invalid_response')
    }
    if (payload.code === 401 || payload.code === 403) throw new AuthenticationError('登录已失效或无权访问项目。', payload.code)
    if (payload.code !== 200) throw new AuthenticationError('项目操作未成功，请检查填写信息或稍后重试。', 502, 'gpas_business_error')
    return payload
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new AuthenticationError('项目服务数据不完整，请联系管理员。', 502, 'gpas_invalid_response')
    return parsed.data
  }

  async existence(profile: Gpas2UserInfo, cookie?: string) {
    const team = this.team(profile)
    if (this.config.gpas2AuthMode === 'mock') return {
      data: this.mockProjects.has(team),
      info: { projectCode: 'DEMO-001', userName: '演示项目', phone: '13800000000', teamId: team },
    }
    return this.parse(existenceSchema, await this.request(cookie, `project/exist/${encodeURIComponent(team)}`))
  }

  async progress(profile: Gpas2UserInfo, cookie?: string): Promise<BusinessReply> {
    const exists = await this.existence(profile, cookie)
    const prefix = this.config.gpas2AuthMode === 'mock' ? '（本地演示数据）\n\n' : ''
    if (!exists.data) {
      if (!exists.info || exists.info.teamId !== this.team(profile)) throw new AuthenticationError('项目初始化信息缺失或团队不匹配，请联系管理员。', 502, 'gpas_invalid_team')
      return {
        content: `${prefix}你的团队尚未初始化项目。请填写下面的基础信息和四类样本计划数量，确认后创建项目。`,
        part: { type: 'gpas', order: 1, form: {
          projectCode: exists.info.projectCode, projectName: exists.info.userName,
          phone: exists.info.phone ?? profile.phone ?? '', teamId: exists.info.teamId,
        } },
      }
    }
    const mock = this.mockProjects.get(this.team(profile))
    const summary = this.config.gpas2AuthMode === 'mock'
      ? { projectPlanInfo: { ...mock!.samples, name: mock!.projectName, id: 'demo-project' }, realSubmitInfo: [] }
      : this.parse(summarySchema, await this.request(cookie, `summary/submit/info/${encodeURIComponent(this.team(profile))}`))
    const lines = sampleKeys.map((key, index) => {
      const plan = summary.projectPlanInfo[key]
      const submitted = summary.realSubmitInfo.reduce((total, row) => total + (row[key] ?? 0), 0)
      if (!Number.isSafeInteger(submitted)) throw new AuthenticationError('样本提交总量无效。', 502, 'gpas_invalid_response')
      const rate = plan > 0 ? `${(submitted / plan * 100).toFixed(1)}%` : '未设置计划'
      return `| ${sampleLabels[index]} | ${plan} | ${submitted} | ${Math.max(0, plan - submitted)} | ${rate} |`
    })
    return {
      content: `${prefix}项目：${textCell(summary.projectPlanInfo.name)}\n\n团队：${textCell(profile.ownteamName)}\n\n| 样本类型 | 计划数量 | 已提交 | 剩余 | 完成率 |\n| --- | ---: | ---: | ---: | --- |\n${lines.join('\n')}\n\n已提交数量按接口返回的各年月累计统计。`,
      part: { type: 'gpas', order: 1 },
    }
  }

  async create(profile: Gpas2UserInfo, cookie: string | undefined, input: ProjectInput, expected: NonNullable<GpasPart['form']>): Promise<BusinessReply> {
    const exists = await this.existence(profile, cookie)
    if (exists.data) return { content: '项目已存在，无需重复创建。', part: { type: 'gpas', order: 1 } }
    if (!exists.info || exists.info.teamId !== this.team(profile) || exists.info.teamId !== expected.teamId || exists.info.projectCode !== expected.projectCode) {
      throw new AuthenticationError('初始化信息已变化，请重新发送“我的任务进度”获取表单。', 409, 'project_form_stale')
    }
    if (this.config.gpas2AuthMode === 'mock') this.mockProjects.set(this.team(profile), input)
    else await this.request(cookie, 'project/create', {
      projectCode: exists.info.projectCode, projectName: input.projectName, projectDesc: input.projectDesc,
      ownTeamId: this.team(profile), phone: input.phone, planContent: JSON.stringify(input.samples),
    })
    return { content: '项目初始化成功。发送“我的任务进度”可查询四类样本的最新提交情况。', part: { type: 'gpas', order: 1 } }
  }
}
