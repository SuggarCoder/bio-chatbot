import { z } from 'zod'
import { AuthenticationError } from './auth.js'
import type { AppConfig } from './config.js'
import { GpasClient } from './gpas/client.js'
import type { Gpas2UserInfo } from './domain.js'
import { sampleKeys, sampleLabels, sampleCountsSchema, type GpasPart, type ProjectInput, type SampleKey } from './gpasContracts.js'

type SampleCounts = z.infer<typeof sampleCountsSchema>

export { GpasUpstreamError, gpasUrl } from './gpas/client.js'

export const textCell = (value: unknown) => String(value || '未提供').replace(/[\\`*_{}\[\]<>()|#]/g, '\\$&').replace(/[\r\n]+/g, ' ')
export function profileReply(profile: Gpas2UserInfo) {
  return `当前登录用户与团队信息：\n\n| 信息 | 内容 |\n| --- | --- |\n${[
    ['姓名', profile.realName], ['账号', profile.userName], ['用户 ID', profile.userId],
    ['团队', profile.ownteamName], ['团队 ID', profile.ownteamId],
    ['职称', profile.jobTitle], ['联系方式', profile.phone], ['邮箱', profile.email],
  ].map(([label, value]) => `| ${label} | ${textCell(value)} |`).join('\n')}`
}

const seedSchema = z.object({
  projectCode: z.string().min(1), userName: z.string(), projectName: z.string().optional(),
  phone: z.string().optional(), teamId: z.string().min(1),
})
const existenceSchema = z.object({ data: z.boolean(), info: seedSchema.optional() })
const optionalCounts = sampleCountsSchema.partial()
const projectPlanSchema = sampleCountsSchema.extend({ name: z.string(), id: z.string() })
const summarySchema = z.object({
  // A team normally has one project; an array is accepted for multi-project teams.
  projectPlanInfo: z.union([projectPlanSchema, z.array(projectPlanSchema).min(1)]),
  realSubmitInfo: z.array(optionalCounts.extend({ year: z.number().int(), month: z.number().int().min(1).max(12) })),
})
type ProjectPlan = z.infer<typeof projectPlanSchema>
const planList = (info: ProjectPlan | ProjectPlan[]) => Array.isArray(info) ? info : [info]

/**
 * Sample types every project of the team has planned (plan > 0). Multiple
 * projects combine with AND, so an upload type is valid for all of them.
 */
export function plannedSampleTypes(plans: readonly SampleCounts[]): SampleKey[] {
  return sampleKeys.filter((key) => plans.every((plan) => plan[key] > 0))
}

export type BusinessReply = {
  content: string
  part: GpasPart
}

export type SampleProgress = {
  type: typeof sampleKeys[number]
  label: string
  plan: number
  submitted: number
  remaining: number
  /** Percentage with one decimal, or null when no plan is set. */
  completionRate: number | null
}

export type ProjectProgress =
  | { initialized: false; form: BusinessReply }
  | { initialized: true; demo: boolean; projectName: string; teamName: string | null; samples: SampleProgress[] }

export function progressReply(progress: ProjectProgress): BusinessReply {
  if (!progress.initialized) return progress.form
  const prefix = progress.demo ? '（本地演示数据）\n\n' : ''
  const lines = progress.samples.map((row) => {
    const rate = row.completionRate === null ? '未设置计划' : `${row.completionRate.toFixed(1)}%`
    return `| ${row.label} | ${row.plan} | ${row.submitted} | ${row.remaining} | ${rate} |`
  })
  return {
    content: `${prefix}项目：${textCell(progress.projectName)}\n\n团队：${textCell(progress.teamName)}\n\n| 样本类型 | 计划数量 | 已提交 | 剩余 | 完成率 |\n| --- | ---: | ---: | ---: | --- |\n${lines.join('\n')}\n\n已提交数量按接口返回的各年月累计统计。`,
    part: { type: 'gpas', order: 1 },
  }
}

export class GpasService {
  // Development fixtures are isolated to this process and never enabled in production.
  private readonly mockProjects = new Map<string, ProjectInput>()
  private team(profile: Gpas2UserInfo) {
    if (!profile.ownteamId) throw new AuthenticationError('当前用户未关联团队，无法查询项目。', 422, 'team_missing')
    return profile.ownteamId
  }

  readonly client: GpasClient
  constructor(private readonly config: AppConfig) {
    this.client = new GpasClient(config)
  }

  async existence(profile: Gpas2UserInfo, cookie?: string) {
    const team = this.team(profile)
    if (this.config.gpas2AuthMode === 'mock') return {
      data: this.mockProjects.has(team),
      info: { projectCode: 'DEMO-001', userName: '演示项目', phone: '13800000000', teamId: team },
    }
    return this.client.read(cookie, { operation: 'project_exists', label: '项目存在性查询', method: 'GET', path: `project/exist/${encodeURIComponent(team)}` }, existenceSchema)
  }

  private initializationForm(profile: Gpas2UserInfo, exists: z.infer<typeof existenceSchema>): BusinessReply {
    const prefix = this.config.gpas2AuthMode === 'mock' ? '（本地演示数据）\n\n' : ''
    if (!exists.info || exists.info.teamId !== this.team(profile)) throw new AuthenticationError('项目初始化信息缺失或团队不匹配，请联系管理员。', 502, 'gpas_invalid_team')
    return {
      content: `${prefix}你的团队尚未初始化项目。请填写下面的基础信息和四类样本计划数量，确认后创建项目。`,
      part: { type: 'gpas', order: 1, form: {
        projectCode: exists.info.projectCode, projectName: exists.info.userName,
        phone: exists.info.phone ?? profile.phone ?? '', teamId: exists.info.teamId,
      } },
    }
  }

  async initializationStatus(profile: Gpas2UserInfo, cookie?: string): Promise<BusinessReply> {
    const exists = await this.existence(profile, cookie)
    if (!exists.data) return this.initializationForm(profile, exists)
    return {
      content: '当前团队的项目已经初始化。系统仅支持首次初始化，不支持重新初始化项目。如需了解样本提交情况，可以查询“我的任务进度”。',
      part: { type: 'gpas', order: 1 },
    }
  }

  async prepareInitialization(profile: Gpas2UserInfo, cookie?: string): Promise<BusinessReply> {
    // Preparing a form never calls create. Existing projects do not become progress queries.
    return this.initializationStatus(profile, cookie)
  }

  private async summary(profile: Gpas2UserInfo, cookie?: string): Promise<z.infer<typeof summarySchema>> {
    const mock = this.mockProjects.get(this.team(profile))
    return this.config.gpas2AuthMode === 'mock'
      ? { projectPlanInfo: { ...mock!.samples, name: mock!.projectName, id: 'demo-project' }, realSubmitInfo: [] }
      : this.client.read(cookie, { operation: 'project_summary', label: '项目进度汇总查询', method: 'POST', path: `summary/submit/info/${encodeURIComponent(this.team(profile))}` }, summarySchema)
  }

  /**
   * Sample types the team can upload. Without an initialized project all four
   * are offered; otherwise only the types planned in every project.
   */
  async sampleTypes(profile: Gpas2UserInfo, cookie?: string): Promise<{ initialized: boolean; types: SampleKey[] }> {
    const exists = await this.existence(profile, cookie)
    if (!exists.data) return { initialized: false, types: [...sampleKeys] }
    const summary = await this.summary(profile, cookie)
    return { initialized: true, types: plannedSampleTypes(planList(summary.projectPlanInfo)) }
  }

  /** Structured progress data shared by the chat reply and agent tools. */
  async progressData(profile: Gpas2UserInfo, cookie?: string): Promise<ProjectProgress> {
    const exists = await this.existence(profile, cookie)
    if (!exists.data) return { initialized: false, form: this.initializationForm(profile, exists) }
    const summary = await this.summary(profile, cookie)
    const plans = planList(summary.projectPlanInfo)
    const samples = sampleKeys.map((key, index) => {
      const plan = plans.reduce((total, row) => total + row[key], 0)
      const submitted = summary.realSubmitInfo.reduce((total, row) => total + (row[key] ?? 0), 0)
      if (!Number.isSafeInteger(submitted)) throw new AuthenticationError('样本提交总量无效。', 502, 'gpas_invalid_response')
      return {
        type: key, label: sampleLabels[index], plan, submitted,
        remaining: Math.max(0, plan - submitted),
        completionRate: plan > 0 ? Number((submitted / plan * 100).toFixed(1)) : null,
      }
    })
    return {
      initialized: true,
      demo: this.config.gpas2AuthMode === 'mock',
      projectName: plans.map((row) => row.name).join('、'),
      teamName: profile.ownteamName ?? null,
      samples,
    }
  }

  async progress(profile: Gpas2UserInfo, cookie?: string): Promise<BusinessReply> {
    return progressReply(await this.progressData(profile, cookie))
  }

  async create(profile: Gpas2UserInfo, cookie: string | undefined, input: ProjectInput, expected: NonNullable<GpasPart['form']>): Promise<BusinessReply> {
    const exists = await this.existence(profile, cookie)
    if (exists.data) return { content: '项目已存在，无需重复创建。', part: { type: 'gpas', order: 1 } }
    if (!exists.info || exists.info.teamId !== this.team(profile) || exists.info.teamId !== expected.teamId || exists.info.projectCode !== expected.projectCode) {
      throw new AuthenticationError('初始化信息已变化，请重新发送“我的任务进度”获取表单。', 409, 'project_form_stale')
    }
    if (this.config.gpas2AuthMode === 'mock') this.mockProjects.set(this.team(profile), input)
    else await this.client.call(cookie, { operation: 'project_create', label: '项目创建', method: 'POST', path: 'project/create', body: {
      projectCode: exists.info.projectCode, projectName: input.projectName, projectDesc: input.projectDesc,
      ownTeamId: this.team(profile), phone: input.phone, planContent: JSON.stringify(input.samples),
    } })
    return { content: '项目初始化成功。发送“我的任务进度”可查询四类样本的最新提交情况。', part: { type: 'gpas', order: 1 } }
  }
}
