import { z } from 'zod'

export const sampleKeys = ['clinic', 'media', 'environment', 'lab'] as const
export const sampleLabels = ['临床样本', '虫媒样本', '环境样本', '实验室样本']
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const sampleCountsSchema = z.object({
  clinic: count, media: count, environment: count, lab: count,
})
export const projectInputSchema = z.object({
  sourceMessageId: z.string().uuid(),
  projectName: z.string().trim().min(1).max(200),
  projectDesc: z.string().trim().max(2000),
  phone: z.string().trim().min(1).max(32),
  samples: sampleCountsSchema,
})
export const projectFormSchema = z.object({
  projectCode: z.string().min(1),
  projectName: z.string(),
  phone: z.string(),
  teamId: z.string().min(1),
})
export const gpasPartSchema = z.object({
  type: z.literal('gpas'),
  order: z.number().int().nonnegative(),
  form: projectFormSchema.optional(),
  capability: z.object({
    id: z.string().nullable(),
    intent: z.string(),
    outcome: z.enum(['answer', 'execute', 'clarify']),
  }).optional(),
})
export type ProjectInput = z.infer<typeof projectInputSchema>
export type GpasPart = z.infer<typeof gpasPartSchema>
