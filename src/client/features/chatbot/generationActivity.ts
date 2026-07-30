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
  return {
    generationId,
    phase: 'queued',
  }
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
    return {
      generationId: current.generationId,
      phase: 'thinking',
    }
  }

  if (action.type === 'text-delta') {
    return {
      generationId: current.generationId,
      phase: 'responding',
    }
  }

  if (action.type === 'tool-start') {
    return {
      generationId: current.generationId,
      phase: 'tool',
      toolLabel: getToolActivityLabel(action.toolName),
    }
  }

  if (action.type === 'tool-result') {
    return {
      generationId: current.generationId,
      phase: 'thinking',
    }
  }

  if (action.type === 'reconnecting') {
    return {
      generationId: current.generationId,
      phase: 'reconnecting',
    }
  }

  if (
    action.type === 'connected' &&
    current.phase === 'reconnecting'
  ) {
    return {
      generationId: current.generationId,
      phase: action.hasContent ? 'responding' : 'thinking',
    }
  }

  return current
}
