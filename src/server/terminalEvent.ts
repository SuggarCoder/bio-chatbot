import { getGeneration, getGenerationAssistantMessage, type Database } from './db.js'
import type { StreamEvent } from './domain.js'

export async function readTerminalEvent(database: Database, userId: string, generationId: string): Promise<StreamEvent | null> {
  const generation = await getGeneration(database, userId, generationId)
  if (!generation || !['completed', 'cancelled', 'failed', 'interrupted', 'timed_out'].includes(generation.status)) return null
  const assistantMessage = await getGenerationAssistantMessage(database, userId, generationId)
  return {
    type: 'message.finish', generationId, streamId: generation.streamId ?? '',
    messageId: assistantMessage?.id ?? generationId, eventId: 0,
    finishReason: generation.status === 'completed' ? 'stop' : generation.status === 'cancelled' ? 'cancelled' : 'error',
    assistantMessage,
    ...(['completed', 'cancelled'].includes(generation.status) ? {} : {
      error: { code: generation.errorCode ?? `generation_${generation.status}`, message: generation.errorMessage ?? 'Generation did not complete' },
    }),
  }
}
