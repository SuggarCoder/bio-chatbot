import {
  createContext,
  onMount,
  useContext,
  type ParentComponent,
} from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import { artifactStore } from '../artifacts/artifactStore'

import {
  ChatApiError,
  createChat,
  deleteChat,
  fetchChat,
  fetchChatMessages,
  fetchChats,
  fetchCurrentUser,
  renameChat,
  type ChatDetailDto,
  type ChatMessageDto,
  type ChatSummaryDto,
  type CurrentUserDto,
} from './chatApi'
import {
  createGenerationActivity,
  reduceGenerationActivity,
  type GenerationActivity,
  type GenerationActivityAction,
} from './generationActivity'

export type ChatMessageRole = 'user' | 'assistant'
export type ChatMessageStatus =
  | 'done'
  | 'streaming'
  | 'cancelled'
  | 'failed'

export type GenerationStartRetry = {
  content: string
  clientMessageId: string
}

export type ActiveGeneration = {
  generationId: string
  streamId: string
  status: 'created' | 'queued' | 'scheduled' | 'running' | 'cancelling'
  replacesMessageId?: string
}

export type ChatMessage = {
  id: string
  persisted: boolean
  generationStartRetry?: GenerationStartRetry
  clientMessageId?: string
  generationId?: string
  activity?: GenerationActivity
  role: ChatMessageRole
  content: string
  parts: ChatMessageDto['parts']
  status: ChatMessageStatus
  createdAt: number
  vote: 'up' | 'down' | null
  executionSteps: ChatMessageDto['executionSteps']
}

export type ChatConversation = {
  id: string
  title: string
  messages: ChatMessage[]
  detailStatus: 'summary' | 'loading' | 'loaded' | 'error'
  detailError?: string
  draft: string
  activeGeneration?: ActiveGeneration
  hasMoreMessages: boolean
  beforeMessageSeq?: number
  loadingOlderMessages: boolean
  olderMessagesError?: string
  createdAt: number
  updatedAt: number
  errorMessage?: string
}

type ChatState = {
  rootDraft: string
  currentUser?: CurrentUserDto
  initialized: boolean
  initializationError?: string
  initializationErrorStatus?: number
  order: string[]
  conversations: Record<string, ChatConversation>
}

type ChatStoreContextValue = {
  getRootDraft: () => string
  setRootDraft: (value: string) => void
  currentUser: () => CurrentUserDto | undefined
  initialized: () => boolean
  initializationError: () => string | undefined
  initializationErrorStatus: () => number | undefined
  retryInitialization: () => Promise<void>
  orderedConversations: () => ChatConversation[]
  getConversation: (id: string) => ChatConversation | undefined
  createConversation: (titleSeed: string) => Promise<ChatConversation>
  loadConversation: (
    id: string,
    options?: { force?: boolean },
  ) => Promise<ChatConversation | undefined>
  loadOlderMessages: (id: string) => Promise<void>
  renameConversation: (id: string, title: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  updateConversationDraft: (id: string, value: string) => void
  appendUserMessage: (id: string, content: string) => ChatMessage | undefined
  confirmUserMessage: (id: string, message: ChatMessageDto) => void
  startAssistantMessage: (id: string, generationId: string) => void
  markAssistantResponding: (id: string, generationId: string) => void
  markGenerationStarted: (id: string, generationId: string) => void
  markToolStarted: (
    id: string,
    generationId: string,
    toolName: string,
  ) => void
  markToolFinished: (id: string, generationId: string) => void
  setStreamConnectionState: (
    id: string,
    generationId: string,
    state: 'connected' | 'reconnecting',
    hasReceivedText?: boolean,
  ) => void
  setActiveGeneration: (
    id: string,
    generationId: string,
    streamId: string,
    replacesMessageId?: string,
  ) => void
  setMessageVoteState: (
    conversationId: string,
    messageId: string,
    vote: 'up' | 'down' | null,
  ) => void
  finishAssistantMessage: (
    id: string,
    generationId: string,
    message?: ChatMessageDto,
    content?: string,
  ) => void
  failAssistantMessage: (
    id: string,
    generationId: string,
    errorMessage: string,
    message?: ChatMessageDto | null,
    content?: string,
  ) => void
  failGenerationStart: (
    id: string,
    errorMessage: string,
    retry: GenerationStartRetry,
  ) => void
  prepareGenerationStartRetry: (
    id: string,
    failedMessageId: string,
  ) => GenerationStartRetry | undefined
  cancelAssistantMessage: (
    id: string,
    generationId: string,
    message?: ChatMessageDto | null,
    content?: string,
  ) => void
}

const ChatStoreContext = createContext<ChatStoreContextValue>()

export function buildConversationTitle(content: string) {
  const normalized = content.trim().replace(/\s+/g, ' ')
  return normalized.length > 24
    ? `${normalized.slice(0, 24)}...`
    : normalized || '新会话'
}

function buildOptimisticMessage(
  role: ChatMessageRole,
  content: string,
  status: ChatMessageStatus,
): ChatMessage {
  const id = crypto.randomUUID()

  return {
    id,
    persisted: false,
    clientMessageId: role === 'user' ? id : undefined,
    role,
    content,
    parts: content
      ? [{ type: 'text', order: 0, text: content }]
      : [],
    status,
    createdAt: Date.now(),
    vote: null,
    executionSteps: [],
  }
}

function mapMessage(message: ChatMessageDto): ChatMessage {
  return {
    id: message.id,
    persisted: true,
    role: message.role,
    content: message.content,
    parts: message.parts,
    status:
      message.status === 'cancelled'
        ? 'cancelled'
        : message.status === 'failed'
          ? 'failed'
          : 'done',
    createdAt: new Date(message.createdAt).getTime(),
    vote: message.vote,
    executionSteps: message.executionSteps,
  }
}

function mapSummary(
  chat: ChatSummaryDto,
  existing?: ChatConversation,
): ChatConversation {
  return {
    id: chat.id,
    title: chat.title,
    messages: existing?.messages ?? [],
    detailStatus: existing?.detailStatus ?? 'summary',
    detailError: existing?.detailError,
    draft: existing?.draft ?? '',
    activeGeneration: existing?.activeGeneration,
    hasMoreMessages: existing?.hasMoreMessages ?? false,
    beforeMessageSeq: existing?.beforeMessageSeq,
    loadingOlderMessages: existing?.loadingOlderMessages ?? false,
    olderMessagesError: existing?.olderMessagesError,
    createdAt: new Date(chat.createdAt).getTime(),
    updatedAt: new Date(chat.updatedAt).getTime(),
    errorMessage: existing?.errorMessage,
  }
}

function mapDetail(
  chat: ChatDetailDto,
  existing?: ChatConversation,
): ChatConversation {
  return {
    ...mapSummary(chat, existing),
    messages: chat.messages.map(mapMessage),
    detailStatus: 'loaded',
    detailError: undefined,
    activeGeneration: chat.activeGeneration
      ? {
          generationId: chat.activeGeneration.id,
          streamId: chat.activeGeneration.streamId,
          status: chat.activeGeneration.status,
          replacesMessageId:
            chat.activeGeneration.replacesMessageId ?? undefined,
        }
      : undefined,
    hasMoreMessages: chat.pageInfo.hasMore,
    beforeMessageSeq: chat.pageInfo.beforeSeq ?? undefined,
    loadingOlderMessages: false,
    olderMessagesError: undefined,
    errorMessage: undefined,
  }
}

export const ChatStoreProvider: ParentComponent = (props) => {
  const [state, setState] = createStore<ChatState>({
    rootDraft: '',
    initialized: false,
    order: [],
    conversations: {},
  })
  const pendingConversationLoads = new Map<
    string,
    Promise<ChatConversation | undefined>
  >()

  const moveConversationToTop = (id: string) => {
    setState('order', (current) => [
      id,
      ...current.filter((item) => item !== id),
    ])
  }

  const initialize = async () => {
    setState('initializationError', undefined)
    setState('initializationErrorStatus', undefined)

    try {
      const [user, chats] = await Promise.all([
        fetchCurrentUser(),
        fetchChats(),
      ])

      setState(
        produce((draft: ChatState) => {
          draft.currentUser = user
          draft.order = chats.map((chat) => chat.id)

          for (const chat of chats) {
            draft.conversations[chat.id] = mapSummary(
              chat,
              draft.conversations[chat.id],
            )
          }

          draft.initialized = true
          draft.initializationError = undefined
          draft.initializationErrorStatus = undefined
        }),
      )
    } catch (error) {
      setState('initialized', true)
      setState(
        'initializationError',
        error instanceof ChatApiError && error.status === 403
          ? '当前 GPAS2 账号状态异常，暂时无法使用 Chatbot。'
          : error instanceof ChatApiError && error.status === 502
            ? '身份服务暂时不可用，请稍后重试。'
            : error instanceof Error
              ? error.message
              : '无法加载 Chatbot 数据',
      )
      setState(
        'initializationErrorStatus',
        error instanceof ChatApiError ? error.status : undefined,
      )
    }
  }

  onMount(() => {
    void initialize()
  })

  const orderedConversations = () =>
    state.order
      .map((id) => state.conversations[id])
      .filter(
        (conversation): conversation is ChatConversation =>
          Boolean(conversation),
      )

  const createConversation = async (titleSeed: string) => {
    const chat = await createChat(buildConversationTitle(titleSeed))
    const conversation: ChatConversation = {
      ...mapSummary(chat),
      detailStatus: 'loaded',
    }

    setState('conversations', chat.id, conversation)
    moveConversationToTop(chat.id)
    return conversation
  }

  const loadConversation = (
    id: string,
    options?: { force?: boolean },
  ): Promise<ChatConversation | undefined> => {
    const existing = state.conversations[id]
    if (existing?.detailStatus === 'loaded' && !options?.force) {
      return Promise.resolve(existing)
    }
    const pending = pendingConversationLoads.get(id)
    if (pending) return pending
    if (existing) {
      setState('conversations', id, {
        detailStatus: 'loading',
        detailError: undefined,
      })
    }
    const request = fetchChat(id).then((detail) => {
      const conversation = mapDetail(
        detail,
        state.conversations[id],
      )
      setState('conversations', id, conversation)

      if (!state.order.includes(id)) {
        setState('order', (current) => [id, ...current])
      }

      return conversation
    }).catch((error: unknown) => {
      if (state.conversations[id]) {
        setState('conversations', id, {
          detailStatus: 'error',
          detailError: error instanceof Error
            ? error.message
            : 'Conversation could not be loaded',
        })
      }
      return undefined
    }).finally(() => {
      if (pendingConversationLoads.get(id) === request) {
        pendingConversationLoads.delete(id)
      }
    })
    pendingConversationLoads.set(id, request)
    return request
  }

  const loadOlderMessages = async (id: string): Promise<void> => {
    const conversation = state.conversations[id]
    if (
      !conversation ||
      !conversation.hasMoreMessages ||
      !conversation.beforeMessageSeq ||
      conversation.loadingOlderMessages
    ) {
      return
    }

    const beforeSeq = conversation.beforeMessageSeq
    setState('conversations', id, {
      loadingOlderMessages: true,
      olderMessagesError: undefined,
    })

    try {
      const page = await fetchChatMessages(id, beforeSeq)
      const olderMessages = page.messages.map(mapMessage)
      setState(
        'conversations',
        id,
        produce((current: ChatConversation) => {
          const existingIds = new Set(current.messages.map((message) => message.id))
          current.messages = [
            ...olderMessages.filter((message) => !existingIds.has(message.id)),
            ...current.messages,
          ]
          current.hasMoreMessages = page.pageInfo.hasMore
          current.beforeMessageSeq = page.pageInfo.beforeSeq ?? undefined
          current.loadingOlderMessages = false
        }),
      )
    } catch (error) {
      setState('conversations', id, {
        loadingOlderMessages: false,
        olderMessagesError: error instanceof Error
          ? error.message
          : 'Earlier messages could not be loaded',
      })
    }
  }

  const renameConversation = async (id: string, title: string) => {
    const normalized = title.trim()

    if (!state.conversations[id] || !normalized) {
      return
    }

    const chat = await renameChat(id, normalized)
    setState('conversations', id, 'title', chat.title)
    setState(
      'conversations',
      id,
      'updatedAt',
      new Date(chat.updatedAt).getTime(),
    )
  }

  const deleteConversation = async (id: string) => {
    if (!state.conversations[id]) {
      return
    }

    await deleteChat(id)
    setState(
      produce((draft: ChatState) => {
        delete draft.conversations[id]
        draft.order = draft.order.filter((item) => item !== id)
      }),
    )
  }

  const updateConversationDraft = (id: string, value: string) => {
    if (state.conversations[id]) {
      setState('conversations', id, 'draft', value)
    }
  }

  const applyGenerationActivity = (
    id: string,
    action: GenerationActivityAction,
  ) => {
    if (!state.conversations[id]) {
      return
    }

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        if (
          conversation.activeGeneration?.generationId !==
          action.generationId
        ) {
          return
        }

        const activeMessage = conversation.messages.at(-1)

        if (
          activeMessage?.role !== 'assistant' ||
          activeMessage.generationId !== action.generationId ||
          activeMessage.status !== 'streaming'
        ) {
          return
        }

        activeMessage.activity = reduceGenerationActivity(
          activeMessage.activity,
          action,
        )
      }),
    )
  }

  const appendUserMessage = (id: string, content: string) => {
    const normalized = content.trim()

    if (!state.conversations[id] || !normalized) {
      return
    }

    const message = buildOptimisticMessage(
      'user',
      normalized,
      'done',
    )

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        conversation.messages.push(message)
        conversation.draft = ''
        conversation.errorMessage = undefined
        conversation.updatedAt = Date.now()
      }),
    )
    moveConversationToTop(id)
    return message
  }

  const confirmUserMessage = (
    id: string,
    message: ChatMessageDto,
  ) => {
    if (!state.conversations[id]) {
      return
    }

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        const optimistic = [...conversation.messages]
          .reverse()
          .find(
            (item) =>
              item.role === 'user' &&
              Boolean(item.clientMessageId),
          )

        if (optimistic) {
          optimistic.id = message.id
          optimistic.persisted = true
          optimistic.clientMessageId = undefined
          optimistic.content = message.content
          optimistic.createdAt = new Date(message.createdAt).getTime()
        }
      }),
    )
  }

  const startAssistantMessage = (id: string, generationId: string) => {
    if (!state.conversations[id]) {
      return
    }

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        const lastMessage = conversation.messages.at(-1)

        if (
          !lastMessage ||
          lastMessage.role !== 'assistant' ||
          lastMessage.status !== 'streaming' ||
          lastMessage.generationId !== generationId
        ) {
          conversation.messages.push(
            {
              ...buildOptimisticMessage('assistant', '', 'streaming'),
              generationId,
              activity: createGenerationActivity(generationId),
            },
          )
        } else if (!lastMessage.activity) {
          lastMessage.activity = createGenerationActivity(generationId)
        }

        conversation.errorMessage = undefined
        conversation.updatedAt = Date.now()
      }),
    )
  }

  const markGenerationStarted = (
    id: string,
    generationId: string,
  ) => {
    if (
      state.conversations[id]?.activeGeneration?.generationId ===
      generationId
    ) {
      setState(
        'conversations',
        id,
        'activeGeneration',
        'status',
        'running',
      )
    }
    applyGenerationActivity(id, {
      type: 'generation-start',
      generationId,
    })
  }

  const markAssistantResponding = (
    id: string,
    generationId: string,
  ) => {
    applyGenerationActivity(id, {
      type: 'text-delta',
      generationId,
    })
  }

  const markToolStarted = (
    id: string,
    generationId: string,
    toolName: string,
  ) => {
    applyGenerationActivity(id, {
      type: 'tool-start',
      generationId,
      toolName,
    })
  }

  const markToolFinished = (
    id: string,
    generationId: string,
  ) => {
    applyGenerationActivity(id, {
      type: 'tool-result',
      generationId,
    })
  }

  const setStreamConnectionState = (
    id: string,
    generationId: string,
    connectionState: 'connected' | 'reconnecting',
    hasReceivedText = false,
  ) => {
    const activeMessage =
      state.conversations[id]?.messages.at(-1)

    applyGenerationActivity(
      id,
      connectionState === 'reconnecting'
        ? {
            type: 'reconnecting',
            generationId,
          }
        : {
            type: 'connected',
            generationId,
            hasContent:
              hasReceivedText || Boolean(activeMessage?.content.trim()),
          },
    )
  }

  const setActiveGeneration = (
    id: string,
    generationId: string,
    streamId: string,
    replacesMessageId?: string,
  ) => {
    if (!state.conversations[id]) {
      return
    }

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        conversation.activeGeneration = {
          generationId,
          streamId,
          status: 'created',
          replacesMessageId,
        }
      }),
    )
  }

  const setMessageVoteState = (
    conversationId: string,
    messageId: string,
    vote: 'up' | 'down' | null,
  ) => {
    const index = state.conversations[conversationId]?.messages.findIndex(
      (message) => message.id === messageId,
    ) ?? -1

    if (index >= 0) {
      setState('conversations', conversationId, 'messages', index, 'vote', vote)
    }
  }

  const finishAssistantMessage = (
    id: string,
    generationId: string,
    message?: ChatMessageDto,
    content = '',
  ) => {
    if (!state.conversations[id]) {
      return
    }

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        if (
          conversation.activeGeneration?.generationId !== generationId
        ) {
          return
        }

        const activeMessage = conversation.messages.at(-1)
        const replacesMessageId =
          conversation.activeGeneration?.replacesMessageId

        if (
          activeMessage?.role === 'assistant' &&
          activeMessage.generationId === generationId
        ) {
          activeMessage.status = 'done'
          activeMessage.activity = undefined

          if (message) {
            activeMessage.id = message.id
            activeMessage.persisted = true
            activeMessage.content = message.content
            activeMessage.parts = message.parts
            activeMessage.createdAt = new Date(
              message.createdAt,
            ).getTime()
            activeMessage.vote = message.vote
            activeMessage.executionSteps = message.executionSteps
          } else {
            activeMessage.content = content
          }

          if (replacesMessageId) {
            conversation.messages = conversation.messages.filter(
              (item) => item.id !== replacesMessageId,
            )
          }
        }

        conversation.activeGeneration = undefined
        conversation.updatedAt = Date.now()
      }),
    )
    moveConversationToTop(id)
    artifactStore.releaseGeneration(generationId)
  }

  const failAssistantMessage = (
    id: string,
    generationId: string,
    errorMessage: string,
    message?: ChatMessageDto | null,
    content = '',
  ) => {
    if (!state.conversations[id]) {
      return
    }

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        if (
          conversation.activeGeneration?.generationId !== generationId
        ) {
          return
        }

        const activeMessage = conversation.messages.at(-1)
        const replacesMessageId =
          conversation.activeGeneration?.replacesMessageId

        if (replacesMessageId) {
          if (activeMessage?.generationId === generationId) {
            conversation.messages.pop()
          }
        } else if (
          activeMessage?.role === 'assistant' &&
          activeMessage.generationId === generationId
        ) {
          activeMessage.status = 'failed'
          activeMessage.activity = undefined

          if (message) {
            activeMessage.id = message.id
            activeMessage.persisted = true
            activeMessage.content = message.content
            activeMessage.parts = message.parts
          } else if (content) {
            activeMessage.content = content
          } else if (!activeMessage.content.trim()) {
            activeMessage.content = errorMessage
          }
        } else {
          conversation.messages.push({
            ...buildOptimisticMessage(
              'assistant',
              errorMessage,
              'failed',
            ),
            generationId,
          })
        }

        conversation.activeGeneration = undefined
        conversation.errorMessage = errorMessage
        conversation.updatedAt = Date.now()
      }),
    )
    artifactStore.releaseGeneration(generationId)
  }

  const failGenerationStart = (
    id: string,
    errorMessage: string,
    retry: GenerationStartRetry,
  ) => {
    if (!state.conversations[id]) {
      return
    }

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        conversation.messages.push({
          ...buildOptimisticMessage(
            'assistant',
            errorMessage,
            'failed',
          ),
          generationStartRetry: retry,
        })
        conversation.errorMessage = errorMessage
        conversation.updatedAt = Date.now()
      }),
    )
  }

  const prepareGenerationStartRetry = (
    id: string,
    failedMessageId: string,
  ) => {
    let retryRequest: GenerationStartRetry | undefined

    if (!state.conversations[id]) {
      return retryRequest
    }

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        const failedIndex = conversation.messages.findIndex(
          (message) => message.id === failedMessageId,
        )
        const failedMessage = conversation.messages[failedIndex]

        if (
          failedIndex < 0 ||
          failedMessage.role !== 'assistant' ||
          failedMessage.status !== 'failed' ||
          failedMessage.persisted ||
          !failedMessage.generationStartRetry
        ) {
          return
        }

        retryRequest = { ...failedMessage.generationStartRetry }
        conversation.messages.splice(failedIndex, 1)
        conversation.errorMessage = undefined
        conversation.updatedAt = Date.now()
      }),
    )

    return retryRequest
  }

  const cancelAssistantMessage = (
    id: string,
    generationId: string,
    message?: ChatMessageDto | null,
    content = '',
  ) => {
    if (!state.conversations[id]) {
      return
    }

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        if (
          conversation.activeGeneration?.generationId !== generationId
        ) {
          return
        }

        const activeMessage = conversation.messages.at(-1)
        const replacesMessageId =
          conversation.activeGeneration?.replacesMessageId

        if (replacesMessageId) {
          if (activeMessage?.generationId === generationId) {
            conversation.messages.pop()
          }
        } else if (
          activeMessage?.role === 'assistant' &&
          activeMessage.generationId === generationId
        ) {
          if (message) {
            activeMessage.id = message.id
            activeMessage.persisted = true
            activeMessage.content = message.content
            activeMessage.parts = message.parts
            activeMessage.createdAt = new Date(
              message.createdAt,
            ).getTime()
          } else if (content) {
            activeMessage.content = content
          }

          if (activeMessage.content.trim()) {
            activeMessage.status = 'cancelled'
            activeMessage.activity = undefined
          } else {
            conversation.messages.pop()
          }
        }

        conversation.activeGeneration = undefined
        conversation.errorMessage = undefined
        conversation.updatedAt = Date.now()
      }),
    )
  }

  return (
    <ChatStoreContext.Provider
      value={{
        getRootDraft: () => state.rootDraft,
        setRootDraft: (value) => setState('rootDraft', value),
        currentUser: () => state.currentUser,
        initialized: () => state.initialized,
        initializationError: () => state.initializationError,
        initializationErrorStatus: () => state.initializationErrorStatus,
        retryInitialization: initialize,
        orderedConversations,
        getConversation: (id) => state.conversations[id],
        createConversation,
        loadConversation,
        loadOlderMessages,
        renameConversation,
        deleteConversation,
        updateConversationDraft,
        appendUserMessage,
        confirmUserMessage,
        startAssistantMessage,
        markAssistantResponding,
        markGenerationStarted,
        markToolStarted,
        markToolFinished,
        setStreamConnectionState,
        setActiveGeneration,
        setMessageVoteState,
        finishAssistantMessage,
        failAssistantMessage,
        failGenerationStart,
        prepareGenerationStartRetry,
        cancelAssistantMessage,
      }}
    >
      {props.children}
    </ChatStoreContext.Provider>
  )
}

export function useChatStore() {
  const context = useContext(ChatStoreContext)

  if (!context) {
    throw new Error(
      'useChatStore must be used within a ChatStoreProvider',
    )
  }

  return context
}
