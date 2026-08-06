import type {
  ExecutionStepKind,
  MessageExecutionStep,
} from './domain.js'

export const MAX_EXECUTION_STEPS = 64
export const MAX_EXECUTION_DETAIL_LENGTH = 160

const executionStepKinds = new Set<ExecutionStepKind>([
  'request',
  'queue',
  'context',
  'artifact_context',
  'model',
  'reasoning',
  'tool',
  'artifact',
  'response',
])
const executionStepStatuses = new Set<MessageExecutionStep['status']>([
  'active',
  'completed',
  'interrupted',
])

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned ? cleaned.slice(0, maxLength) : undefined
}

function cleanIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

function normalizeExecutionStep(value: unknown): MessageExecutionStep | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  const id = cleanText(candidate.id, 128)
  const label = cleanText(candidate.label, 80)
  const status = candidate.status

  if (
    !id ||
    !label ||
    typeof status !== 'string' ||
    !executionStepStatuses.has(status as MessageExecutionStep['status'])
  ) {
    return null
  }

  const kind = typeof candidate.kind === 'string' &&
    executionStepKinds.has(candidate.kind as ExecutionStepKind)
    ? candidate.kind as ExecutionStepKind
    : undefined
  const detail = cleanText(candidate.detail, MAX_EXECUTION_DETAIL_LENGTH)
  const startedAt = cleanIsoDate(candidate.startedAt)
  const completedAt = cleanIsoDate(candidate.completedAt)

  return {
    id,
    ...(kind ? { kind } : {}),
    label,
    status: status as MessageExecutionStep['status'],
    ...(detail ? { detail } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
  }
}

export function normalizeExecutionSteps(value: unknown): MessageExecutionStep[] {
  if (!Array.isArray(value)) return []
  const steps: MessageExecutionStep[] = []
  const seen = new Set<string>()

  for (const valueStep of value) {
    const step = normalizeExecutionStep(valueStep)
    if (!step || seen.has(step.id)) continue
    seen.add(step.id)
    steps.push(step)
    if (steps.length >= MAX_EXECUTION_STEPS) break
  }

  return steps
}

export function upsertExecutionStep(
  steps: readonly MessageExecutionStep[],
  nextStep: MessageExecutionStep,
): MessageExecutionStep[] {
  const normalized = normalizeExecutionSteps([nextStep])[0]
  if (!normalized) return [...steps]
  const existingIndex = steps.findIndex((step) => step.id === normalized.id)

  if (existingIndex >= 0) {
    return steps.map((step, index) => index === existingIndex
      ? { ...step, ...normalized }
      : step)
  }

  return steps.length >= MAX_EXECUTION_STEPS
    ? [...steps]
    : [...steps, normalized]
}

export function settleExecutionSteps(
  value: unknown,
  completed: boolean,
  completedAt = new Date().toISOString(),
): MessageExecutionStep[] {
  return normalizeExecutionSteps(value).map((step) => step.status === 'active'
    ? {
        ...step,
        status: completed ? 'completed' : 'interrupted',
        completedAt,
      }
    : step)
}

export function executionStepsFromMetadata(value: unknown): MessageExecutionStep[] {
  if (!value || typeof value !== 'object') return []
  const trace = (value as Record<string, unknown>).executionTrace
  if (!trace || typeof trace !== 'object') return []
  return normalizeExecutionSteps((trace as Record<string, unknown>).steps)
}

export function metadataWithExecutionSteps(
  value: unknown,
  steps: readonly MessageExecutionStep[],
): Record<string, unknown> {
  const metadata = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    ...metadata,
    executionTrace: {
      version: 1,
      steps: normalizeExecutionSteps(steps),
    },
  }
}
