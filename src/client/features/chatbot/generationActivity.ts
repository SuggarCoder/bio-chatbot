import type { ChatMessageDto } from './chatApi'

export type GenerationActivityPhase =
  | 'queued'
  | 'thinking'
  | 'tool'
  | 'reconnecting'
  | 'responding'

export type GenerationActivity = {
  generationId: string
  phase: GenerationActivityPhase
  toolLabel?: string
  steps: ChatMessageDto['executionSteps']
}

export type GenerationActivityAction =
  | {
      type: 'generation-start'
      generationId: string
    }
  | {
      type: 'text-delta'
      generationId: string
    }
  | {
      type: 'tool-start'
      generationId: string
      toolName: string
    }
  | {
      type: 'tool-result'
      generationId: string
    }
  | {
      type: 'reconnecting'
      generationId: string
    }
  | {
      type: 'connected'
      generationId: string
      hasContent: boolean
    }
  | {
      type: 'progress-step'
      generationId: string
      step: ChatMessageDto['executionSteps'][number]
    }
  | {
      type: 'terminal'
      generationId: string
    }

export const thinkingStatusTexts = [
  '正在理解你的问题',
  '正在梳理关键信息',
  '正在组织回答思路',
  '正在完善回答',
] as const

const toolDisplayNames: Record<string, string> = {
  search: '正在搜索相关信息',
  web_search: '正在搜索相关信息',
  rag_search: '正在检索知识库',
  database_query: '正在查询数据',
  file_analysis: '正在分析文件',
  create_analysis_job: '正在创建分析任务',
}

export function getToolActivityLabel(toolName: string): string {
  return toolDisplayNames[toolName] ?? '正在调用工具'
}

export function createGenerationActivity(
  generationId: string,
): GenerationActivity {
  const now = new Date().toISOString()
  return {
    generationId,
    phase: 'queued',
    steps: [
      {
        id: 'request',
        kind: 'request',
        label: '提交请求',
        status: 'completed',
        startedAt: now,
        completedAt: now,
      },
      {
        id: 'queue',
        kind: 'queue',
        label: '任务排队',
        status: 'active',
        startedAt: now,
      },
    ],
  }
}

function upsertStep(
  steps: ChatMessageDto['executionSteps'],
  nextStep: ChatMessageDto['executionSteps'][number],
): ChatMessageDto['executionSteps'] {
  const index = steps.findIndex((step) => step.id === nextStep.id)
  if (index < 0) return [...steps, nextStep]
  return steps.map((step, stepIndex) => stepIndex === index
    ? { ...step, ...nextStep }
    : step)
}

function phaseForStep(
  current: GenerationActivityPhase,
  step: ChatMessageDto['executionSteps'][number],
): GenerationActivityPhase {
  if (step.status !== 'active') return current
  if (step.kind === 'tool') return 'tool'
  if (step.kind === 'response' || step.kind === 'artifact') return 'responding'
  return 'thinking'
}

export function reduceGenerationActivity(
  current: GenerationActivity | undefined,
  action: GenerationActivityAction,
): GenerationActivity | undefined {
  if (!current || current.generationId !== action.generationId) {
    return current
  }

  if (action.type === 'terminal') {
    return undefined
  }

  if (action.type === 'generation-start') {
    const queueStep = current.steps.find((step) => step.id === 'queue')
    return {
      ...current,
      phase: 'thinking',
      steps: queueStep?.status === 'active'
        ? upsertStep(current.steps, {
            ...queueStep,
            status: 'completed',
            completedAt: new Date().toISOString(),
          })
        : current.steps,
    }
  }

  if (action.type === 'text-delta') {
    return {
      ...current,
      phase: 'responding',
      steps: current.steps.some((step) => step.kind === 'response')
        ? current.steps
        : upsertStep(current.steps, {
            id: 'response',
            kind: 'response',
            label: '生成回答',
            status: 'active',
            startedAt: new Date().toISOString(),
          }),
    }
  }

  if (action.type === 'tool-start') {
    const existingTool = current.steps.find(
      (step) => step.kind === 'tool' && step.status === 'active',
    )
    return {
      ...current,
      phase: 'tool',
      toolLabel: getToolActivityLabel(action.toolName),
      steps: existingTool
        ? current.steps
        : upsertStep(current.steps, {
            id: 'tool:legacy',
            kind: 'tool',
            label: getToolActivityLabel(action.toolName).replace(/^正在/, ''),
            status: 'active',
            startedAt: new Date().toISOString(),
          }),
    }
  }

  if (action.type === 'tool-result') {
    const activeTool = current.steps.find(
      (step) => step.kind === 'tool' && step.status === 'active',
    )
    return {
      ...current,
      phase: 'thinking',
      toolLabel: undefined,
      steps: activeTool
        ? upsertStep(current.steps, {
            ...activeTool,
            status: 'completed',
            completedAt: new Date().toISOString(),
          })
        : current.steps,
    }
  }

  if (action.type === 'reconnecting') {
    const now = new Date().toISOString()
    return {
      ...current,
      phase: 'reconnecting',
      steps: upsertStep(current.steps, {
        id: 'transport',
        label: '恢复流式连接',
        status: 'active',
        startedAt: now,
      }),
    }
  }

  if (
    action.type === 'connected' &&
    current.phase === 'reconnecting'
  ) {
    return {
      ...current,
      phase: action.hasContent ? 'responding' : 'thinking',
      steps: current.steps.some((step) => step.id === 'transport')
        ? upsertStep(current.steps, {
            ...current.steps.find((step) => step.id === 'transport')!,
            status: 'completed',
            completedAt: new Date().toISOString(),
          })
        : current.steps,
    }
  }

  if (action.type === 'progress-step') {
    return {
      ...current,
      phase: phaseForStep(current.phase, action.step),
      steps: upsertStep(current.steps, action.step),
    }
  }

  return current
}
