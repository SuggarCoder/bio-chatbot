import { z } from 'zod'

const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, {
  target: 'draft-7',
})

const uuid = z.string().uuid()
const isoDate = z.string()
const nullableString = z.string().nullable()

const errorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
})

const currentUser = z.object({
  id: uuid,
  externalUserId: z.string(),
  externalTeamId: nullableString,
  realName: nullableString,
  userName: nullableString,
  jobTitle: nullableString,
  researchField: nullableString,
  email: nullableString,
  name: nullableString,
  image: nullableString,
  gpas2Role: z.number().int().nullable(),
})

const chatSummary = z.object({
  id: uuid,
  title: z.string(),
  chatType: z.string(),
  status: z.string(),
  createdAt: isoDate,
  updatedAt: isoDate,
})

const messagePart = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    order: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('artifact_ref'),
    order: z.number().int().nonnegative(),
    artifactId: uuid,
    logicalId: z.string(),
    version: z.number().int().positive(),
  }),
])

const chatMessage = z.object({
  id: uuid,
  seq: z.number().int().positive(),
  role: z.enum(['user', 'assistant']),
  status: z.enum(['completed', 'cancelled', 'failed']),
  content: z.string(),
  parts: z.array(messagePart),
  createdAt: isoDate,
  vote: z.enum(['up', 'down']).nullable(),
  executionSteps: z.array(z.object({
    id: z.string(),
    label: z.string(),
    status: z.enum(['active', 'completed', 'interrupted']),
  })),
})

const generation = z.object({
  id: uuid,
  chatId: uuid.nullable(),
  streamId: uuid.nullable(),
  status: z.enum(['pending', 'streaming', 'completed', 'failed', 'cancelled']),
  effectiveStatus: z.enum([
    'pending',
    'streaming',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
  ]),
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  errorCode: nullableString,
  errorMessage: nullableString,
  startedAt: nullableString,
  cancelRequestedAt: nullableString,
  cancelSource: z.enum([
    'user_stop',
    'superseded',
    'timeout',
    'server_shutdown',
    'system',
  ]).nullable(),
  createdAt: isoDate,
  finishedAt: nullableString,
})

const pageInfo = z.object({
  hasMore: z.boolean(),
  beforeSeq: z.number().int().positive().nullable(),
})

const messagePage = z.object({
  messages: z.array(chatMessage),
  pageInfo,
})

const activeGeneration = z.object({
  id: uuid,
  streamId: uuid,
  status: z.enum(['pending', 'streaming', 'cancelling']),
  replacesMessageId: uuid.nullable(),
})

const artifactSummary = z.object({
  id: uuid,
  logicalId: z.string().nullable(),
  title: z.string(),
  type: z.string().nullable(),
  currentVersion: z.number().int().nonnegative(),
  status: z.string(),
  updatedAt: isoDate,
})

const artifactDetail = z.object({
  id: uuid,
  chatId: uuid,
  logicalId: z.string().nullable(),
  title: z.string(),
  type: z.string().nullable(),
  currentVersion: z.number().int().nonnegative(),
  status: z.string(),
  createdAt: isoDate,
  updatedAt: isoDate,
  content: z.string().optional(),
})

const artifactVersion = z.object({
  id: uuid,
  artifactId: uuid,
  version: z.number().int().positive(),
  parentVersion: z.number().int().positive().nullable(),
  title: z.string(),
  type: z.string(),
  language: nullableString,
  byteLength: z.number().int().nonnegative(),
  sha256: z.string(),
  createdBy: z.string(),
  createdAt: isoDate,
})

const generationStart = z.object({
  generation,
  userMessage: chatMessage,
  replacesMessageId: uuid.nullable(),
})

const errorResponses = {
  default: jsonSchema(errorResponse),
}

export const httpSchemas = {
  health: {
    response: {
      200: jsonSchema(z.object({
        status: z.enum(['ok', 'degraded', 'unavailable']),
        service: z.string(),
        commit: z.string(),
        authMode: z.enum(['mock', 'upstream']),
        dependencies: z.object({
          postgres: z.enum(['ok', 'unavailable']),
          redis: z.enum(['ok', 'unavailable']),
          objectStorage: z.enum(['ok', 'unavailable', 'disabled']),
        }),
        time: isoDate,
      })),
      503: jsonSchema(z.object({
        status: z.enum(['ok', 'degraded', 'unavailable']),
        service: z.string(),
        commit: z.string(),
        authMode: z.enum(['mock', 'upstream']),
        dependencies: z.object({
          postgres: z.enum(['ok', 'unavailable']),
          redis: z.enum(['ok', 'unavailable']),
          objectStorage: z.enum(['ok', 'unavailable', 'disabled']),
        }),
        time: isoDate,
      })),
    },
  },
  me: {
    response: { 200: jsonSchema(currentUser), ...errorResponses },
  },
  chatIdParams: jsonSchema(z.object({ chatId: uuid })),
  artifactIdParams: jsonSchema(z.object({ artifactId: uuid })),
  artifactVersionParams: jsonSchema(z.object({
    artifactId: uuid,
    version: z.string().regex(/^[1-9]\d*$/),
  })),
  messageIdParams: jsonSchema(z.object({ messageId: uuid })),
  generationIdParams: jsonSchema(z.object({ generationId: uuid })),
  createChat: {
    body: jsonSchema(z.object({
      title: z.string().trim().min(1).max(200),
    })),
    response: { 201: jsonSchema(chatSummary), ...errorResponses },
  },
  renameChat: {
    body: jsonSchema(z.object({
      title: z.string().trim().min(1).max(200),
    })),
    response: { 200: jsonSchema(chatSummary), ...errorResponses },
  },
  vote: {
    body: jsonSchema(z.object({ isUpvoted: z.boolean() })),
    response: {
      200: jsonSchema(z.object({ vote: z.enum(['up', 'down']) })),
      ...errorResponses,
    },
  },
  regenerate: {
    body: jsonSchema(z.object({
      requestId: uuid,
      artifactId: uuid.optional(),
    })),
    response: { 201: jsonSchema(generationStart), ...errorResponses },
  },
  createGeneration: {
    body: jsonSchema(z.object({
      content: z.string().trim().min(1).max(32_000),
      clientMessageId: uuid,
      artifactId: uuid.optional(),
      supersedesGenerationId: uuid.optional(),
    })),
    response: { 201: jsonSchema(generationStart), ...errorResponses },
  },
  messagePageQuery: jsonSchema(z.object({
    beforeSeq: z.string().regex(/^[1-9]\d*$/),
    limit: z.string().regex(/^(?:[1-9]|[1-9]\d|100)$/).optional(),
  })),
  streamQuery: jsonSchema(z.object({
    resumeAt: z.string().regex(/^\d+$/).optional(),
  })),
  chatsResponse: {
    200: jsonSchema(z.object({ chats: z.array(chatSummary) })),
    ...errorResponses,
  },
  chatDetailResponse: {
    200: jsonSchema(chatSummary.extend({
      messages: z.array(chatMessage),
      pageInfo,
      activeGeneration: activeGeneration.nullable(),
    })),
    ...errorResponses,
  },
  messagePageResponse: {
    200: jsonSchema(messagePage),
    ...errorResponses,
  },
  generationResponse: {
    200: jsonSchema(generation),
    202: jsonSchema(generation),
    ...errorResponses,
  },
  artifactListResponse: {
    200: jsonSchema(z.object({ artifacts: z.array(artifactSummary) })),
    ...errorResponses,
  },
  artifactDetailResponse: {
    200: jsonSchema(artifactDetail),
    ...errorResponses,
  },
  artifactVersionsResponse: {
    200: jsonSchema(z.object({ versions: z.array(artifactVersion) })),
    ...errorResponses,
  },
  artifactVersionResponse: {
    200: jsonSchema(artifactVersion.extend({ content: z.string() })),
    ...errorResponses,
  },
  errorResponses,
}
