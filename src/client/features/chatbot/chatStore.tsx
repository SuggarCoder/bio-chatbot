import {
  createContext,
  onMount,
  useContext,
  type ParentComponent,
} from 'solid-js'
import { createStore, produce } from 'solid-js/store'

import {
  createChat,
  deleteChat,
  fetchChat,
  fetchChats,
  fetchCurrentUser,
  renameChat,
  type ChatDetailDto,
  type ChatMessageDto,
  type ChatSummaryDto,
  type CurrentUserDto,
} from './chatApi'

export type ChatMessageRole = 'user' | 'assistant'
export type ChatMessageStatus =
  | 'done'
  | 'streaming'
  | 'cancelled'
  | 'failed'

export type ActiveGeneration = {
  generationId: string
  streamId: string
  status: 'pending' | 'streaming' | 'cancelling'
}

export type ChatMessage = {
  id: string
  clientMessageId?: string
  generationId?: string
  role: ChatMessageRole
  content: string
  status: ChatMessageStatus
  createdAt: number
}

export type ChatConversation = {
  id: string
  title: string
  messages: ChatMessage[]
  draft: string
  activeGeneration?: ActiveGeneration
  createdAt: number
  updatedAt: number
  errorMessage?: string
}

type ChatState = {
  rootDraft: string
  currentUser?: CurrentUserDto
  initialized: boolean
  initializationError?: string
  order: string[]
  conversations: Record<string, ChatConversation>
}

type ChatStoreContextValue = {
  getRootDraft: () => string
  setRootDraft: (value: string) => void
  currentUser: () => CurrentUserDto | undefined
  initialized: () => boolean
  initializationError: () => string | undefined
  orderedConversations: () => ChatConversation[]
  getConversation: (id: string) => ChatConversation | undefined
  createConversation: (titleSeed: string) => Promise<ChatConversation>
  loadConversation: (id: string) => Promise<ChatConversation | undefined>
  renameConversation: (id: string, title: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  updateConversationDraft: (id: string, value: string) => void
  appendUserMessage: (id: string, content: string) => ChatMessage | undefined
  confirmUserMessage: (id: string, message: ChatMessageDto) => void
  startAssistantMessage: (id: string, generationId: string) => void
  setActiveGeneration: (
    id: string,
    generationId: string,
    streamId: string,
  ) => void
  appendAssistantChunk: (
    id: string,
    generationId: string,
    startIndex: number,
    chunk: string,
  ) => void
  finishAssistantMessage: (
    id: string,
    generationId: string,
    message?: ChatMessageDto,
  ) => void
  failAssistantMessage: (
    id: string,
    generationId: string,
    errorMessage: string,
    message?: ChatMessageDto | null,
  ) => void
  failGenerationStart: (id: string, errorMessage: string) => void
  cancelAssistantMessage: (
    id: string,
    generationId: string,
    message?: ChatMessageDto | null,
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
    clientMessageId: role === 'user' ? id : undefined,
    role,
    content,
    status,
    createdAt: Date.now(),
  }
}

function mapMessage(message: ChatMessageDto): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    status:
      message.status === 'cancelled'
        ? 'cancelled'
        : message.status === 'failed'
          ? 'failed'
          : 'done',
    createdAt: new Date(message.createdAt).getTime(),
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
    draft: existing?.draft ?? '',
    activeGeneration: existing?.activeGeneration,
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
    activeGeneration: chat.activeGeneration
      ? {
          generationId: chat.activeGeneration.id,
          streamId: chat.activeGeneration.streamId,
          status: chat.activeGeneration.status,
        }
      : undefined,
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

  const moveConversationToTop = (id: string) => {
    setState('order', (current) => [
      id,
      ...current.filter((item) => item !== id),
    ])
  }

  const initialize = async () => {
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
        }),
      )
    } catch (error) {
      setState('initialized', true)
      setState(
        'initializationError',
        error instanceof Error
          ? error.message
          : '无法加载 Chatbot 数据',
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
    const conversation = mapSummary(chat)

    setState('conversations', chat.id, conversation)
    moveConversationToTop(chat.id)
    return conversation
  }

  const loadConversation = async (id: string) => {
    try {
      const detail = await fetchChat(id)
      const conversation = mapDetail(
        detail,
        state.conversations[id],
      )
      setState('conversations', id, conversation)

      if (!state.order.includes(id)) {
        setState('order', (current) => [id, ...current])
      }

      return conversation
    } catch {
      return undefined
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
          lastMessage.status !== 'streaming'
        ) {
          conversation.messages.push(
            {
              ...buildOptimisticMessage('assistant', '', 'streaming'),
              generationId,
            },
          )
        }

        if (
          conversation.activeGeneration?.generationId === generationId
        ) {
          conversation.activeGeneration.status = 'streaming'
        }
        conversation.errorMessage = undefined
        conversation.updatedAt = Date.now()
      }),
    )
  }

  const setActiveGeneration = (
    id: string,
    generationId: string,
    streamId: string,
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
          status: 'pending',
        }
      }),
    )
  }

  const appendAssistantChunk = (
    id: string,
    generationId: string,
    startIndex: number,
    chunk: string,
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

        if (
          activeMessage?.role === 'assistant' &&
          activeMessage.status === 'streaming'
        ) {
          const overlap = activeMessage.content.length - startIndex

          if (overlap < chunk.length) {
            activeMessage.content += chunk.slice(Math.max(0, overlap))
          }

          conversation.updatedAt = Date.now()
        }
      }),
    )
  }

  const finishAssistantMessage = (
    id: string,
    generationId: string,
    message?: ChatMessageDto,
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

        if (
          activeMessage?.role === 'assistant' &&
          activeMessage.generationId === generationId
        ) {
          activeMessage.status = 'done'

          if (message) {
            activeMessage.id = message.id
            activeMessage.content = message.content
            activeMessage.createdAt = new Date(
              message.createdAt,
            ).getTime()
          }
        }

        conversation.activeGeneration = undefined
        conversation.updatedAt = Date.now()
      }),
    )
    moveConversationToTop(id)
  }

  const failAssistantMessage = (
    id: string,
    generationId: string,
    errorMessage: string,
    message?: ChatMessageDto | null,
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

        if (
          activeMessage?.role === 'assistant' &&
          activeMessage.generationId === generationId
        ) {
          activeMessage.status = 'failed'

          if (message) {
            activeMessage.id = message.id
            activeMessage.content = message.content
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
  }

  const failGenerationStart = (
    id: string,
    errorMessage: string,
  ) => {
    if (!state.conversations[id]) {
      return
    }

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        conversation.messages.push(
          buildOptimisticMessage(
            'assistant',
            errorMessage,
            'failed',
          ),
        )
        conversation.errorMessage = errorMessage
        conversation.updatedAt = Date.now()
      }),
    )
  }

  const cancelAssistantMessage = (
    id: string,
    generationId: string,
    message?: ChatMessageDto | null,
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

        if (
          activeMessage?.role === 'assistant' &&
          activeMessage.generationId === generationId
        ) {
          if (message) {
            activeMessage.id = message.id
            activeMessage.content = message.content
            activeMessage.createdAt = new Date(
              message.createdAt,
            ).getTime()
          }

          if (activeMessage.content.trim()) {
            activeMessage.status = 'cancelled'
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
        orderedConversations,
        getConversation: (id) => state.conversations[id],
        createConversation,
        loadConversation,
        renameConversation,
        deleteConversation,
        updateConversationDraft,
        appendUserMessage,
        confirmUserMessage,
        startAssistantMessage,
        setActiveGeneration,
        appendAssistantChunk,
        finishAssistantMessage,
        failAssistantMessage,
        failGenerationStart,
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
