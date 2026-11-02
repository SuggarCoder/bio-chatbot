import type OpenAI from 'openai'
import { z } from 'zod'

import type { Database } from '../db/client.js'
import {
  deleteUserMemories,
  generatedMemoryKey,
  listRecentUserChats,
  lockUserMemories,
  type MemoryAccess,
  normalizeMemoryContent,
  normalizeMemoryKey,
  searchUserChats,
  upsertUserMemory,
  USER_MEMORY_CATEGORIES,
  USER_MEMORY_CONTENT_MAX_CHARS,
} from '../userMemory.js'
import {
  type AgentFunctionCall,
  type AgentToolResult,
  limitModelOutput,
  type ToolRunner,
} from './tools.js'

type LocalToolContext = {
  database: Database
  userId: string
  chatId: string
}

type LocalTool<Input extends z.ZodObject> = {
  name: string
  label: string
  description: string
  input: Input
  run(context: LocalToolContext, input: z.infer<Input>): Promise<unknown>
}

function defineLocalTool<Input extends z.ZodObject>(tool: LocalTool<Input>): LocalTool<z.ZodObject> {
  return tool as unknown as LocalTool<z.ZodObject>
}

const isoDate = z.string().datetime({ offset: true }).or(z.string().date())

export const memorySaveTool = defineLocalTool({
  name: 'memory__save',
  label: '更新记忆',
  description: [
    '保存或更新一条关于用户的长期记忆。仅在用户明确要求你记住某事、或明确更正已有记忆时调用。',
    '更正已有记忆时传入原条目标识 key 覆盖；新信息可以不传 key。',
  ].join(''),
  input: z.object({
    content: z.string().trim().min(1).max(USER_MEMORY_CONTENT_MAX_CHARS)
      .describe('用第三人称陈述的一条事实，例如“用户偏好用 R 做差异分析”'),
    category: z.enum(USER_MEMORY_CATEGORIES)
      .describe('identity=身份与背景，work=工作与长期项目，preference=偏好与习惯，current=近期关注，other=其他'),
    key: z.string().trim().optional().describe('要覆盖的已有条目标识（snake_case）'),
  }),
  async run(context, input) {
    const content = normalizeMemoryContent(input.content)
    if (!content) throw new ToolInputError('记忆内容为空或过长。')
    const key = input.key === undefined
      ? generatedMemoryKey('mem')
      : normalizeMemoryKey(input.key)
    if (!key) throw new ToolInputError('key 必须是小写字母开头的 snake_case。')
    const saved = await context.database.transaction(async (transaction) => {
      await lockUserMemories(transaction, context.userId)
      return upsertUserMemory(transaction, {
        userId: context.userId,
        key,
        category: input.category,
        content,
        source: 'tool',
        sourceChatId: context.chatId,
      })
    })
    return { saved: { key: saved.key, category: saved.category, content: saved.content } }
  },
})

export const memoryDeleteTool = defineLocalTool({
  name: 'memory__delete',
  label: '删除记忆',
  description: '删除关于用户的记忆条目。用户要求忘记、删除某些信息，或明确说某条记忆不对且不需要替换时调用。',
  input: z.object({
    keys: z.array(z.string().trim()).min(1).max(20).describe('要删除的条目标识'),
  }),
  async run(context, input) {
    const keys = input.keys.map(normalizeMemoryKey).filter((key): key is string => Boolean(key))
    const deleted = await deleteUserMemories(context.database, context.userId, { keys })
    return {
      deleted,
      ...(deleted === 0 ? { note: '没有找到这些条目，可能已被删除；如实告知用户即可。' } : {}),
    }
  },
})

export const chatSearchTool = defineLocalTool({
  name: 'chat__search',
  label: '搜索历史对话',
  description: [
    '按关键词搜索该用户以前的其他对话，返回匹配的对话标题、日期和片段。',
    '用户提到以前聊过的内容，或回答需要过去对话中的信息时调用。用具体名词作关键词，没有结果时可换同义词再试一次。',
  ].join(''),
  input: z.object({
    query: z.string().trim().min(1).max(200).describe('关键词，多个词用空格分隔'),
    limit: z.number().int().min(1).max(10).optional().describe('最多返回的对话数，默认 5'),
  }),
  async run(context, input) {
    const results = await searchUserChats(context.database, {
      userId: context.userId,
      query: input.query,
      excludeChatId: context.chatId,
      limit: input.limit,
    })
    return {
      results,
      ...(results.length === 0 ? { note: '没有找到相关对话。' } : {}),
    }
  },
})

export const chatRecentTool = defineLocalTool({
  name: 'chat__recent',
  label: '查看最近对话',
  description: '按时间列出该用户最近的其他对话（标题、日期、概要）。用户问“最近/上周/之前聊过什么”时调用，可用 before/after 限定时间。',
  input: z.object({
    limit: z.number().int().min(1).max(20).optional().describe('默认 10'),
    before: isoDate.optional().describe('只列出此时间之前更新的对话（ISO 日期）'),
    after: isoDate.optional().describe('只列出此时间之后更新的对话（ISO 日期）'),
  }),
  async run(context, input) {
    const chats = await listRecentUserChats(context.database, {
      userId: context.userId,
      excludeChatId: context.chatId,
      limit: input.limit,
      before: input.before ? new Date(input.before) : undefined,
      after: input.after ? new Date(input.after) : undefined,
    })
    return { chats }
  },
})

class ToolInputError extends Error {}

function memoryInstructions(access: MemoryAccess): string {
  const lines = ['## 记忆与历史对话工具']
  if (access.editMemory) {
    lines.push(
      '- 用户明确要求记住某事（如“记住……”“以后都……”）时调用 memory__save；要求忘记或删除时调用 memory__delete。完成后简短确认，不要展示条目标识。',
      '- 用户没有要求时不要调用 memory__save，日常信息会在对话后自动整理。',
      '- 不要保存密码、密钥、证件号等敏感凭据；用户坚持时说明不能保存此类信息。',
    )
  }
  if (access.searchChats) {
    lines.push(
      '- 用户提到以前的对话（“上次”“之前说过”“我们讨论过的……”），或回答需要过去对话中的信息时，先调用 chat__search（按关键词）或 chat__recent（按时间），再基于结果回答。',
      '- 引用历史对话时说明出自哪次对话（标题和日期）；没有找到就如实说明，不要编造。',
    )
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

export class MemoryToolRunner implements ToolRunner {
  readonly tools: OpenAI.Responses.FunctionTool[]
  private readonly byName: Map<string, LocalTool<z.ZodObject>>

  constructor(
    private readonly context: LocalToolContext,
    private readonly access: MemoryAccess,
  ) {
    const tools = [
      ...(access.editMemory ? [memorySaveTool, memoryDeleteTool] : []),
      ...(access.searchChats ? [chatSearchTool, chatRecentTool] : []),
    ]
    this.byName = new Map(tools.map((tool) => [tool.name, tool]))
    this.tools = tools.map((tool) => {
      const { $schema: _schema, ...parameters } = z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>
      return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters,
        strict: false,
      }
    })
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  label(name: string): string {
    return this.byName.get(name)?.label ?? '调用工具'
  }

  instructions(): string {
    return this.tools.length ? memoryInstructions(this.access) : ''
  }

  async execute(call: AgentFunctionCall): Promise<AgentToolResult> {
    const tool = this.byName.get(call.name)
    const fail = (message: string, args?: Record<string, unknown>): AgentToolResult => ({
      ok: false,
      output: JSON.stringify({ error: message }),
      error: message,
      toolId: tool ? call.name.replace('__', '.') : undefined,
      title: tool?.label,
      ...(args ? { args } : {}),
    })
    if (!tool) return fail('该工具在本次对话中不可用。')
    let raw: unknown
    try {
      raw = call.arguments.trim() ? JSON.parse(call.arguments) : {}
    } catch {
      return fail('工具参数不是有效的 JSON。')
    }
    const parsed = tool.input.safeParse(raw)
    if (!parsed.success) {
      return fail(`工具参数无效：${parsed.error.issues.map((issue) => `${issue.path.join('.') || '参数'} ${issue.message}`).join('；')}`)
    }
    const args = parsed.data as Record<string, unknown>
    try {
      const limited = limitModelOutput(await tool.run(this.context, parsed.data))
      return {
        ok: true,
        output: limited.output,
        rawOutputBytes: limited.rawBytes,
        truncated: limited.truncated,
        toolId: call.name.replace('__', '.'),
        title: tool.label,
        args,
      }
    } catch (error) {
      if (error instanceof ToolInputError) return fail(error.message, args)
      console.warn('Memory tool failed', {
        tool: call.name,
        error: error instanceof Error ? error.message : String(error),
      })
      return fail('工具暂时无法完成操作，请稍后重试。', args)
    }
  }
}

export function createMemoryToolRunner(
  context: LocalToolContext,
  access: MemoryAccess,
): MemoryToolRunner | null {
  return access.editMemory || access.searchChats
    ? new MemoryToolRunner(context, access)
    : null
}
