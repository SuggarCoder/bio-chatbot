import type { FastifyRequest } from 'fastify'
import type OpenAI from 'openai'
import { z } from 'zod'

import { AuthenticationError, loadProfile } from '../auth.js'
import type { CapabilityDescription } from '../capabilities/registry.js'
import type { AppConfig } from '../config.js'
import type { CurrentUser, Gpas2UserInfo } from '../domain.js'
import type { FileCard, GpasPart } from '../gpasContracts.js'
import type { GpasClient } from '../gpas/client.js'
import type { GpasToolContext, GpasToolSpec } from '../gpas/defineTool.js'

/** Hard cap on what one tool result may add to the model context (~2k tokens). */
export const MODEL_OUTPUT_LIMIT_BYTES = 8 * 1024

export type AgentFunctionCall = { call_id: string; name: string; arguments: string }

export type AgentToolResult = {
  ok: boolean
  /** JSON string returned to the model as function_call_output. */
  output: string
  toolId?: string
  title?: string
  /** Validated business arguments (never identity), for the ToolRun audit row. */
  args?: Record<string, unknown>
  error?: string
  /** User-facing business part (e.g. a confirmation form), never sent to the model. */
  part?: GpasPart
}

type AnySpec = GpasToolSpec<z.ZodObject, unknown>

/** Function names must match ^[a-zA-Z0-9_-]+$; tool ids use dots. */
export function toolFunctionName(id: string): string {
  return id.replaceAll('.', '__')
}

/** Whether a tool's part has something to show under the reply. */
export function hasVisiblePart(part: GpasPart): boolean {
  return Boolean(part.form || part.files?.length || part.result || part.profile || part.progress)
}

const cardKeys = (card: FileCard) => [
  ...(card.analysisId ? [`analysis:${card.analysisId}`] : []),
  ...(card.groupId ? [`group:${card.groupId}`] : []),
  `files:${card.files.map((file) => file.fileId).sort().join('\n')}`,
]

/**
 * Adds one tool's part to a reply, showing each sample once: repeated detail
 * calls for a task (other pages or categories) share one entry, which keeps
 * the largest total (the unfiltered one), and file cards already shown in the
 * reply are not repeated.
 */
export function addBusinessPart(parts: GpasPart[], part: GpasPart): void {
  let next = part
  const result = part.result
  if (result) {
    const index = parts.findIndex((item) => item.result?.taskId === result.taskId)
    if (index >= 0) {
      const kept = parts[index]
      parts[index] = { ...kept, result: { taskId: result.taskId, total: Math.max(kept.result!.total, result.total) } }
      next = { ...next, result: undefined }
    }
  }
  if (next.files?.length) {
    const shown = new Set(parts.flatMap((item) => item.files ?? []).flatMap(cardKeys))
    next = { ...next, files: next.files.filter((card) => !cardKeys(card).some((key) => shown.has(key))) }
  }
  if (hasVisiblePart(next)) parts.push(next)
}

export function limitModelOutput(value: unknown): string {
  const json = JSON.stringify(value ?? null)
  if (Buffer.byteLength(json, 'utf8') <= MODEL_OUTPUT_LIMIT_BYTES) return json
  // Keep a readable prefix; the user still sees the full data in the UI.
  let preview = json.slice(0, MODEL_OUTPUT_LIMIT_BYTES / 2)
  while (Buffer.byteLength(preview, 'utf8') > MODEL_OUTPUT_LIMIT_BYTES - 512) {
    preview = preview.slice(0, Math.floor(preview.length * 0.9))
  }
  return JSON.stringify({
    truncated: true,
    note: '结果过大，仅提供开头部分；请基于已有数据作答，并提示用户完整数据可在界面中查看或缩小查询范围。',
    preview,
  })
}

const failure = (message: string): AgentToolResult => ({
  ok: false,
  output: JSON.stringify({ error: message }),
  error: message,
})

/**
 * Identity for one agent run. The GPAS profile is loaded lazily with the
 * run's own sealed cookie and must match the user who owns the generation;
 * nothing about identity comes from the model.
 */
export class AgentSession {
  private profilePromise?: Promise<Gpas2UserInfo>

  constructor(
    private readonly config: AppConfig,
    readonly user: CurrentUser,
    readonly cookie: string | undefined,
    readonly signal: AbortSignal,
  ) {}

  profile(): Promise<Gpas2UserInfo> {
    this.profilePromise ??= (async () => {
      const profile = await loadProfile({ headers: { cookie: this.cookie } } as FastifyRequest, this.config)
      if (
        profile.userId !== this.user.externalUserId ||
        (profile.ownteamId || null) !== (this.user.externalTeamId || null)
      ) {
        throw new AuthenticationError('登录身份或团队已变更，请重新提交。', 403, 'request_identity_changed')
      }
      return profile
    })()
    return this.profilePromise
  }
}

export class AgentToolSet {
  readonly tools: OpenAI.Responses.FunctionTool[]
  private readonly byName: Map<string, AnySpec>

  constructor(
    private readonly specs: readonly AnySpec[],
    private readonly client: GpasClient,
    private readonly policies: readonly CapabilityDescription[],
  ) {
    this.byName = new Map(specs.map((spec) => [toolFunctionName(spec.id), spec]))
    this.tools = specs.map((spec) => {
      const { $schema: _schema, ...parameters } = z.toJSONSchema(spec.input, { io: 'input' }) as Record<string, unknown>
      return {
        type: 'function',
        name: toolFunctionName(spec.id),
        description: `${spec.title}：${spec.description}\n规则：${spec.policy}`,
        parameters,
        strict: false,
      }
    })
  }

  title(name: string): string | undefined {
    return this.byName.get(name)?.title
  }

  effect(name: string): AnySpec['effect'] | undefined {
    return this.byName.get(name)?.effect
  }

  instructions(): string {
    const limits = this.policies.map((item) => `- ${item.title}：${item.policy}`).join('\n')
    return [
      '你是 GPAS 业务助手，可以调用工具查询当前登录用户及其团队的业务数据。',
      '规则：',
      '- 业务数据只能来自工具结果，不要编造或推测数字。',
      '- 工具只返回当前登录用户自己的数据，不能查询其他用户或其他团队；用户要求查询他人时直接说明不支持。',
      '- 需要业务数据时先调用工具，再基于结果用中文作答；与业务无关的问题直接回答，不调用工具。',
      '- 准备确认类工具（如首次初始化项目）只会在回复下方展示表单，必须由用户在表单中确认提交；不要声称已经完成创建。',
      '- 用户消息带有 GPAS 文件上传结果时，先调用上传文件列表工具按这批文件名（fileNames）查询，再基于返回的状态和分析结果作答，不要只复述上传进度。',
      '- 用户要查看样本分析详情时调用样本分析详情工具；完整列表在右侧面板展示，只需简短概括。',
      '- 用户按样本名或文件名查看分析详情/结果时：先调用上传文件列表工具（fileName=样本名）找到该样本的 taskId，再调用样本分析详情工具；不要让用户提供 taskId 或分析 ID，回复中用样本名称呼样本，不要展示 taskId。匹配到多个样本时列出样本名请用户选择；样本尚无 taskId（未分析）时如实说明分析状态。',
      '- 上传文件列表是分页的，total 是全部样本数，samples 只是其中一页；不要把一页当成全部，也不要说“仅有这几个样本”。用户只想看已有分析结果（分析已完成，analysisStatus=analysisverified）的样本时，调用上传文件列表工具并传 analyzedOnly=true。',
      '- 同一个样本的分析详情在一次回复中只会展示一个入口；查看详情只需调用一次样本分析详情工具，除非用户要其它页或其它类别。',
      '- 上传文件列表的结果会在回复下方展示（单个样本为卡片，多个样本为表格），只需简短解读；分析摘要只含各类别丰度前几位的物种，要说“丰度前 N”“共检出 X 种”，不要说成只检出这些；类别占比是检出种数占比，不要说成丰度或 reads 占比。',
      '- 工具返回 error 时如实告知用户原因，不要反复调用同一工具。',
      ...(limits ? ['以下业务不支持或有限制，用户问到时按此说明：', limits] : []),
    ].join('\n')
  }

  async execute(call: AgentFunctionCall, session: AgentSession): Promise<AgentToolResult> {
    const spec = this.byName.get(call.name)
    // Only tools offered to this run can execute; the model cannot widen the list.
    if (!spec) return failure('该工具在本次对话中不可用。')

    let rawArgs: unknown
    try {
      rawArgs = call.arguments.trim() ? JSON.parse(call.arguments) : {}
    } catch {
      return { ...failure('工具参数不是有效的 JSON。'), toolId: spec.id, title: spec.title }
    }
    const args = spec.input.safeParse(rawArgs)
    if (!args.success) {
      return {
        ...failure(`工具参数无效：${args.error.issues.map((issue) => `${issue.path.join('.') || '参数'} ${issue.message}`).join('；')}`),
        toolId: spec.id,
        title: spec.title,
      }
    }

    try {
      const context: GpasToolContext = {
        profile: await session.profile(),
        cookie: session.cookie,
        client: this.client,
        signal: session.signal,
      }
      const data = await spec.run(context, args.data)
      const reply = spec.toReply(data, context)
      return {
        ok: true,
        output: limitModelOutput(spec.toModel(data)),
        toolId: spec.id,
        title: spec.title,
        args: args.data as Record<string, unknown>,
        // Forms, cards, tables and the analysis detail entry are shown under the reply.
        ...(hasVisiblePart(reply.part) ? { part: reply.part } : {}),
      }
    } catch (error) {
      if (session.signal.aborted) throw error
      // Business errors carry safe Chinese messages; never forward raw upstream errors.
      const message = error instanceof AuthenticationError
        ? error.message
        : '工具暂时无法完成查询，请稍后重试。'
      return { ...failure(message), toolId: spec.id, title: spec.title, args: args.data as Record<string, unknown> }
    }
  }
}

/** Registered GPAS tools plus the catalog policies the model must respect. */
export class AgentToolbox {
  private readonly byId: Map<string, AnySpec>

  constructor(
    private readonly config: AppConfig,
    specs: readonly GpasToolSpec<any, any>[],
    private readonly client: GpasClient,
    private readonly policies: readonly CapabilityDescription[] = [],
  ) {
    this.byId = new Map(specs.map((spec) => [spec.id, spec as AnySpec]))
  }

  ids(): string[] {
    return [...this.byId.keys()]
  }

  /** Tool set for one run, restricted to ids chosen server-side at ingress. */
  select(ids: readonly string[]): AgentToolSet | null {
    const specs = [...new Set(ids)]
      .map((id) => this.byId.get(id))
      .filter((spec): spec is AnySpec => Boolean(spec))
      .slice(0, this.config.agentToolLimit)
    return specs.length
      ? new AgentToolSet(specs, this.client, this.policies.filter((item) => item.effect === 'unsupported'))
      : null
  }
}
