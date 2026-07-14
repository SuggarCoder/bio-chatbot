import { createContext, useContext, type ParentComponent } from 'solid-js'
import { createStore, produce } from 'solid-js/store'

export type ChatMessageRole = 'user' | 'assistant'
export type ChatMessageStatus = 'done' | 'streaming' | 'error'
export type ChatStreamState = 'idle' | 'streaming' | 'error'

export type ChatMessage = {
  id: string
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
  pendingReply: boolean
  streamState: ChatStreamState
  createdAt: number
  updatedAt: number
  errorMessage?: string
}

type ChatState = {
  rootDraft: string
  order: string[]
  conversations: Record<string, ChatConversation>
}

type ChatStoreContextValue = {
  getRootDraft: () => string
  setRootDraft: (value: string) => void
  orderedConversations: () => ChatConversation[]
  getConversation: (id: string) => ChatConversation | undefined
  renameConversation: (id: string, title: string) => void
  deleteConversation: (id: string) => void
  updateConversationDraft: (id: string, value: string) => void
  appendUserMessage: (id: string, content: string) => void
  startAssistantMessage: (id: string) => void
  appendAssistantChunk: (id: string, chunk: string) => void
  finishAssistantMessage: (id: string) => void
  failAssistantMessage: (id: string, errorMessage: string) => void
}

const ChatStoreContext = createContext<ChatStoreContextValue>()

function buildConversationTitle(content: string) {
  const normalized = content.trim().replace(/\s+/g, ' ')
  return normalized.length > 24 ? `${normalized.slice(0, 24)}...` : normalized || '新会话'
}

function buildMessage(role: ChatMessageRole, content: string, status: ChatMessageStatus): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    status,
    createdAt: Date.now(),
  }
}

export const ChatStoreProvider: ParentComponent = (props) => {
  const [state, setState] = createStore<ChatState>({
    rootDraft: '',
    order: [],
    conversations: {},
  })

  const ensureConversation = (id: string, titleSeed: string) => {
    if (state.conversations[id]) {
      return
    }

    const now = Date.now()

    setState(
      produce((draft: ChatState) => {
        draft.conversations[id] = {
          id,
          title: buildConversationTitle(titleSeed),
          messages: [],
          draft: '',
          pendingReply: false,
          streamState: 'idle',
          createdAt: now,
          updatedAt: now,
        }
        draft.order = [id, ...draft.order.filter((item) => item !== id)]
      }),
    )
  }

  const moveConversationToTop = (id: string) => {
    setState('order', (current) => [id, ...current.filter((item) => item !== id)])
  }

  const orderedConversations = () =>
    state.order
      .map((id) => state.conversations[id])
      .filter((conversation): conversation is ChatConversation => Boolean(conversation))

  const getRootDraft = () => state.rootDraft
  const setRootDraft = (value: string) => setState('rootDraft', value)
  const getConversation = (id: string) => state.conversations[id]
  const renameConversation = (id: string, title: string) => {
    const normalized = title.trim()

    if (!state.conversations[id] || normalized.length === 0) {
      return
    }

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        conversation.title = normalized
        conversation.updatedAt = Date.now()
      }),
    )
  }

  const deleteConversation = (id: string) => {
    if (!state.conversations[id]) {
      return
    }

    setState(
      produce((draft: ChatState) => {
        delete draft.conversations[id]
        draft.order = draft.order.filter((item) => item !== id)
      }),
    )
  }

  const updateConversationDraft = (id: string, value: string) => {
    if (!state.conversations[id]) {
      return
    }

    setState('conversations', id, 'draft', value)
  }

  const appendUserMessage = (id: string, content: string) => {
    const normalized = content.trim()

    if (normalized.length === 0) {
      return
    }

    ensureConversation(id, normalized)

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        conversation.messages.push(buildMessage('user', normalized, 'done'))
        conversation.draft = ''
        conversation.pendingReply = true
        conversation.streamState = 'idle'
        conversation.errorMessage = undefined

        if (conversation.messages.filter((message) => message.role === 'user').length === 1) {
          conversation.title = buildConversationTitle(normalized)
        }

        conversation.updatedAt = Date.now()
      }),
    )

    moveConversationToTop(id)
  }

  const startAssistantMessage = (id: string) => {
    if (!state.conversations[id]) {
      return
    }

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        conversation.messages.push(buildMessage('assistant', '', 'streaming'))
        conversation.pendingReply = false
        conversation.streamState = 'streaming'
        conversation.errorMessage = undefined
        conversation.updatedAt = Date.now()
      }),
    )
  }

  const appendAssistantChunk = (id: string, chunk: string) => {
    if (!state.conversations[id]) {
      return
    }

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        const activeMessage = conversation.messages[conversation.messages.length - 1]

        if (!activeMessage || activeMessage.role !== 'assistant') {
          return
        }

        activeMessage.content += chunk
        conversation.updatedAt = Date.now()
      }),
    )
  }

  const finishAssistantMessage = (id: string) => {
    if (!state.conversations[id]) {
      return
    }

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        const activeMessage = conversation.messages[conversation.messages.length - 1]

        if (activeMessage && activeMessage.role === 'assistant') {
          activeMessage.status = 'done'
        }

        conversation.streamState = 'idle'
        conversation.updatedAt = Date.now()
      }),
    )
  }

  const failAssistantMessage = (id: string, errorMessage: string) => {
    if (!state.conversations[id]) {
      return
    }

    setState(
      'conversations',
      id,
      produce((conversation: ChatConversation) => {
        const activeMessage = conversation.messages[conversation.messages.length - 1]

        if (activeMessage && activeMessage.role === 'assistant') {
          activeMessage.status = 'error'

          if (activeMessage.content.trim().length === 0) {
            activeMessage.content = errorMessage
          }
        }

        conversation.streamState = 'error'
        conversation.errorMessage = errorMessage
        conversation.updatedAt = Date.now()
      }),
    )
  }

  return (
    <ChatStoreContext.Provider
      value={{
        getRootDraft,
        setRootDraft,
        orderedConversations,
        getConversation,
        renameConversation,
        deleteConversation,
        updateConversationDraft,
        appendUserMessage,
        startAssistantMessage,
        appendAssistantChunk,
        finishAssistantMessage,
        failAssistantMessage,
      }}
    >
      {props.children}
    </ChatStoreContext.Provider>
  )
}

export function useChatStore() {
  const context = useContext(ChatStoreContext)

  if (!context) {
    throw new Error('useChatStore must be used within a ChatStoreProvider')
  }

  return context
}
