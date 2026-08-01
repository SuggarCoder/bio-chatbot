import { A, useLocation, useNavigate, useParams } from '@solidjs/router'
import {
  createContext,
  createEffect,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
  type Component,
  type ParentComponent,
  type ParentProps,
} from 'solid-js'
import collapseUrl from '../../assets/images/collapse.svg'
import gpasUrl from '../../assets/images/gpas.svg'
import { appRoutes, getAppPathname } from '../../routes'
import {
  cancelGeneration,
  createGeneration,
  deleteMessageVote,
  regenerateMessage,
  setMessageVote,
} from '../../features/chatbot/chatApi'
import { gsap } from 'gsap'
import {
  runChatStream,
  StreamCompletedError,
} from '../../features/chatbot/chatStream'
import {
  thinkingStatusTexts,
  type GenerationActivity,
} from '../../features/chatbot/generationActivity'
import { ChatStoreProvider, useChatStore, type ChatMessage } from '../../features/chatbot/chatStore'
import {
  createAdaptiveStreamSession,
  deleteAdaptiveStreamSession,
  getAdaptiveStreamSession,
} from '../../features/chatbot/adaptiveStream'
import {
  StaticMarkdown,
  StreamingMarkdown,
} from '../../features/chatbot/MarkdownMessage'
import { recordStreamOperation } from '../../features/chatbot/streamMetrics'
import { InputDialog } from '../../shared/ui/InputDialog'
import { ModalDialog } from '../../shared/ui/ModalDialog'
import { PopupMenu, type PopupMenuEntry, type PopupMenuItem } from '../../shared/ui/PopupMenu'
import { Tooltip } from '../../shared/ui/Tooltip'

type LayoutContextValue = {
  isSidebarOpen: () => boolean
  closeSidebar: () => void
}

const LayoutContext = createContext<LayoutContextValue>()
const activeReplyControllers = new Map<string, AbortController>()
const startingReplies = new Set<string>()
const noop = () => undefined

function cancelAssistantReply(generationId: string) {
  const controller = activeReplyControllers.get(generationId)

  if (controller) {
    activeReplyControllers.delete(generationId)
    controller.abort()
  }

  deleteAdaptiveStreamSession(generationId)
}

function cancelAllAssistantReplies() {
  for (const controller of activeReplyControllers.values()) {
    controller.abort()
  }

  for (const generationId of activeReplyControllers.keys()) {
    deleteAdaptiveStreamSession(generationId)
  }

  activeReplyControllers.clear()
}

function waitForDelay(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'))
      return
    }

    const handleAbort = () => {
      window.clearTimeout(timeoutId)
      reject(new DOMException('The operation was aborted', 'AbortError'))
    }
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, duration)

    signal.addEventListener(
      'abort',
      handleAbort,
      { once: true },
    )
  })
}

async function waitForPersistedReply(
  conversationId: string,
  chatStore: ReturnType<typeof useChatStore>,
  signal: AbortSignal,
) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    signal.throwIfAborted()
    const conversation = await chatStore.loadConversation(
      conversationId,
    )
    const latestMessage = conversation?.messages.at(-1)

    if (
      latestMessage?.role === 'assistant' &&
      latestMessage.status === 'done'
    ) {
      return true
    }

    if (conversation && !conversation.activeGeneration) {
      return false
    }

    await waitForDelay(2_000, signal)
  }

  return false
}

function MessageIcon() {
  return <span aria-hidden="true" class="i-lucide-message-square h-4 w-4 shrink-0" />
}

function SendIcon() {
  return <span aria-hidden="true" class="i-lucide-arrow-up h-4 w-4 shrink-0" />
}

function VoiceIcon() {
  return <span aria-hidden="true" class="i-lucide-mic h-4 w-4 shrink-0" />
}

function StopIcon() {
  return (
    <span
      aria-hidden="true"
      class="h-3.5 w-3.5 shrink-0 rounded-[2px] bg-current"
    />
  )
}

function AccountMenuIcon() {
  return <span aria-hidden="true" class="i-lucide-chevrons-up-down h-4 w-4 shrink-0" />
}

function LogoutIcon() {
  return <span aria-hidden="true" class="i-lucide-log-out h-4 w-4 shrink-0" />
}

function SettingsIcon() {
  return <span aria-hidden="true" class="i-lucide-settings-2 h-4 w-4 shrink-0" />
}

function LanguageIcon() {
  return <span aria-hidden="true" class="i-lucide-languages h-4 w-4 shrink-0" />
}

function HelpIcon() {
  return <span aria-hidden="true" class="i-lucide-circle-help h-4 w-4 shrink-0" />
}

function UsageIcon() {
  return <span aria-hidden="true" class="i-lucide-chart-line h-4 w-4 shrink-0" />
}

function AddIcon() {
  return <span aria-hidden="true" class="i-lucide-plus h-4 w-4 shrink-0" />
}

function UploadFileIcon() {
  return <span aria-hidden="true" class="i-lucide-upload h-4 w-4 shrink-0" />
}

function CloudTransferIcon() {
  return <span aria-hidden="true" class="i-lucide-cloud h-4 w-4 shrink-0" />
}

function QuestionMarkIcon() {
  return <span aria-hidden="true" class="i-lucide-circle-help h-4 w-4 shrink-0 text-slate-500" />
}

function MoreIcon() {
  return <span aria-hidden="true" class="i-lucide-ellipsis h-4 w-4 shrink-0" />
}

function RenameIcon() {
  return <span aria-hidden="true" class="i-lucide-pencil-line h-4 w-4 shrink-0" />
}

function DeleteIcon() {
  return <span aria-hidden="true" class="i-lucide-trash-2 h-4 w-4 shrink-0" />
}

function DownArrowIcon() {
  return <span aria-hidden="true" class="i-lucide-chevron-down h-4 w-4 shrink-0" />
}

function ResearcherAvatar() {
  return (
    <div class="grid h-12 w-12 place-items-center rounded-full bg-teal-600 text-sm font-semibold text-light-100">
      GP
    </div>
  )
}

function getSidebarLabel(title: string) {
  return title.length > 18 ? `${title.slice(0, 18)}...` : title
}

function buildConversationActionItems(
  conversationId: string,
  title: string,
  onRename: (conversationId: string, title: string) => void,
  onDelete: (conversationId: string) => void,
): PopupMenuItem[] {
  return [
    {
      label: '重命名',
      icon: <RenameIcon />,
      onSelect: () => onRename(conversationId, title),
    },
    {
      label: '删除',
      icon: <DeleteIcon />,
      tone: 'danger',
      onSelect: () => onDelete(conversationId),
    },
  ]
}

function buildAccountMenuItems(): PopupMenuEntry[] {
  return [
    {
      label: '设置',
      icon: <SettingsIcon />,
      onSelect: noop,
    },
    {
      label: '语言',
      icon: <LanguageIcon />,
      onSelect: noop,
    },
    {
      label: '帮助手册',
      icon: <HelpIcon />,
      onSelect: noop,
    },
    {
      type: 'separator',
    },
    {
      label: 'Tokens 使用量',
      icon: <UsageIcon />,
      onSelect: noop,
    },
  ]
}

function AccountMenu(props: { buttonClass: string }) {
  const chatStore = useChatStore()
  const accountLabel = () =>
    chatStore.currentUser()?.email ||
    chatStore.currentUser()?.userName ||
    'GPAS2 用户'

  return (
    <PopupMenu
      buttonLabel="打开账户菜单"
      buttonClass={props.buttonClass}
      header={
        <div class="min-w-0">
          <p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Account</p>
          <p class="mt-1 truncate text-sm font-semibold text-slate-800">{accountLabel()}</p>
        </div>
      }
      menuWidth={256}
      placement="top-end"
      items={buildAccountMenuItems()}
    >
      <AccountMenuIcon />
    </PopupMenu>
  )
}

async function runAssistantReply(
  conversationId: string,
  prompt: string,
  clientMessageId: string,
  existingGeneration:
    | {
        generationId: string
        streamId: string
      }
    | undefined,
  chatStore: ReturnType<typeof useChatStore>,
) {
  if (
    startingReplies.has(conversationId) ||
    (
      existingGeneration &&
      activeReplyControllers.has(existingGeneration.generationId)
    )
  ) {
    return
  }

  let generationId = existingGeneration?.generationId
  let streamId = existingGeneration?.streamId

  if (!generationId || !streamId) {
    startingReplies.add(conversationId)

    try {
      const previousGenerationId =
        chatStore.getConversation(conversationId)
          ?.activeGeneration?.generationId
      const started = await createGeneration(conversationId, {
        content: prompt,
        clientMessageId,
        supersedesGenerationId: previousGenerationId,
      })

      if (!started.generation.streamId) {
        throw new Error('Generation stream was not created')
      }

      generationId = started.generation.id
      streamId = started.generation.streamId
      chatStore.setActiveGeneration(conversationId, generationId, streamId)
      chatStore.confirmUserMessage(conversationId, started.userMessage)
    } catch (error) {
      chatStore.failGenerationStart(
        conversationId,
        error instanceof Error
          ? error.message
          : 'Generation could not be started',
      )
      return
    } finally {
      startingReplies.delete(conversationId)
    }
  }

  if (activeReplyControllers.has(generationId)) {
    return
  }

  const controller = new AbortController()
  activeReplyControllers.set(generationId, controller)
  const streamSession = getAdaptiveStreamSession(generationId) ??
    createAdaptiveStreamSession(generationId, {
      onTerminal: (terminal, content) => {
        recordStreamOperation(generationId, {
          type: 'store',
          detail: `terminal:${terminal.kind}`,
        })

        if (terminal.kind === 'completed') {
          chatStore.finishAssistantMessage(
            conversationId,
            generationId,
            terminal.message ?? undefined,
            content,
          )
        } else if (terminal.kind === 'cancelled') {
          chatStore.cancelAssistantMessage(
            conversationId,
            generationId,
            terminal.message,
            content,
          )
        } else {
          chatStore.failAssistantMessage(
            conversationId,
            generationId,
            terminal.errorMessage ?? '回复生成失败，请稍后重试。',
            terminal.message,
            content,
          )
        }

        queueMicrotask(() => deleteAdaptiveStreamSession(generationId))
      },
    })
  chatStore.startAssistantMessage(conversationId, generationId)
  recordStreamOperation(generationId, {
    type: 'store',
    detail: 'start',
  })
  let responseMarked = false

  try {
    await runChatStream({
      generationId,
      streamId,
      signal: controller.signal,
      onConnectionState: (connectionState) => {
        chatStore.setStreamConnectionState(
          conversationId,
          generationId,
          connectionState,
          Boolean(streamSession.canonicalText),
        )
        recordStreamOperation(generationId, {
          type: 'store',
          detail: `connection:${connectionState}`,
        })
      },
      onEvent: (event) => {
        if (controller.signal.aborted) {
          return
        }

        if (
          event.generationId !== generationId ||
          chatStore.getConversation(conversationId)
            ?.activeGeneration?.generationId !== generationId
        ) {
          return
        }

        if (event.type === 'generation.start') {
          chatStore.startAssistantMessage(conversationId, generationId)
          chatStore.markGenerationStarted(
            conversationId,
            generationId,
          )
          chatStore.confirmUserMessage(
            conversationId,
            event.userMessage,
          )
          recordStreamOperation(generationId, {
            type: 'store',
            detail: 'generation-start:placeholder',
          })
          recordStreamOperation(generationId, {
            type: 'store',
            detail: 'generation-start:activity',
          })
          recordStreamOperation(generationId, {
            type: 'store',
            detail: 'generation-start:user-confirmation',
          })
        } else if (event.type === 'text.delta') {
          if (!responseMarked) {
            responseMarked = true
            chatStore.markAssistantResponding(conversationId, generationId)
            recordStreamOperation(generationId, {
              type: 'store',
              detail: 'first-delta',
            })
          }
          streamSession.push(event.startIndex, event.delta)
        } else if (event.type === 'tool.start') {
          chatStore.markToolStarted(
            conversationId,
            generationId,
            event.toolName,
          )
          recordStreamOperation(generationId, {
            type: 'store',
            detail: 'tool-start',
          })
        } else if (event.type === 'tool.result') {
          chatStore.markToolFinished(
            conversationId,
            generationId,
          )
          recordStreamOperation(generationId, {
            type: 'store',
            detail: 'tool-result',
          })
        } else if (event.type === 'generation.completed') {
          streamSession.finish(event.assistantMessage.content, {
            kind: 'completed',
            message: event.assistantMessage,
          })
        } else if (event.type === 'generation.cancelled') {
          streamSession.finish(
            event.assistantMessage?.content ?? streamSession.canonicalText,
            {
              kind: 'cancelled',
              message: event.assistantMessage,
            },
          )
        } else if (event.type === 'generation.failed') {
          streamSession.finish(
            event.assistantMessage?.content ?? streamSession.canonicalText,
            {
              kind: 'failed',
              errorMessage: event.message,
              message: event.assistantMessage,
            },
          )
        }
      },
    })
  } catch (error) {
    if (controller.signal.aborted) {
      return
    }

    if (error instanceof StreamCompletedError) {
      deleteAdaptiveStreamSession(generationId)
      await chatStore.loadConversation(conversationId)
      return
    }

    if (
      chatStore.getConversation(conversationId)?.activeGeneration &&
      await waitForPersistedReply(
        conversationId,
        chatStore,
        controller.signal,
      )
    ) {
      deleteAdaptiveStreamSession(generationId)
      return
    }

    const message = error instanceof Error ? error.message : '回复生成失败，请稍后重试。'
    streamSession.finish(streamSession.canonicalText, {
      kind: 'failed',
      errorMessage: message,
    })
  } finally {
    if (activeReplyControllers.get(generationId) === controller) {
      activeReplyControllers.delete(generationId)
    }
  }
}

function SidebarBrand(props: { expanded: boolean; onExpand: () => void; onCollapse: () => void }) {
  return (
    <div
      class={
        props.expanded
          ? 'flex items-center gap-4 px-5 py-5'
          : 'flex items-center justify-center px-3 py-5'
      }
    >
      <div
        class={
          props.expanded
            ? 'grid h-12 w-12 place-items-center'
            : 'grid h-12 w-12 place-items-center cursor-pointer'
        }
        onClick={() => {
          if (!props.expanded) {
            props.onExpand()
          }
        }}
      >
        <img
          src={props.expanded ? gpasUrl : collapseUrl}
          alt="GPAS"
          class={props.expanded ? 'h-8 w-8 shrink-0' : 'h-11 w-11 p-2 rotate-180 rounded-2xl transition duration-200 hover:bg-slate-50'}
        />
      </div>

      <Show when={props.expanded}>
          <div class="flex justify-between items-center w-full">
            <div class="min-w-0 leading-none">
              <p class="font-futura-heavy text-2xl uppercase tracking-widest text-slate-800">GPAS</p>
              <p class="font-futura-heavy text-xs font-semibold uppercase tracking-tight text-slate-500">Data Portal</p>
            </div>
            <img
              src={collapseUrl}
              alt="GPAS"
              class="h-11 w-11 p-2 rounded-2xl transition duration-200 hover:bg-slate-50 cursor-pointer"
              onClick={props.onCollapse}
            />
          </div>
      </Show>
    </div>
  )
}

function CompactSidebarRail(props: { pathname: string; onLogout: () => void }) {
  return (
    <div class="flex min-h-0 flex-1 flex-col items-center px-3 pb-4 pt-4">
      <div class="px-2 py-3">
        <ResearcherAvatar />
      </div>

      <A
        href={appRoutes.home}
        aria-label="新建会话"
        class={
          props.pathname === appRoutes.home
            ? 'mt-6 grid h-11 w-11 place-items-center rounded-2xl text-slate-500 hover:text-teal-700'
            : 'mt-6 grid h-11 w-11 place-items-center rounded-2xl text-slate-500 transition duration-200 hover:bg-slate-50'
        }
      >
        <MessageIcon />
      </A>

      <div class="flex-1" />

      <div class="mt-auto flex flex-col gap-2">
        <AccountMenu buttonClass="grid h-11 w-11 place-items-center rounded-2xl text-slate-500 transition duration-200 hover:text-teal-700" />
        <button
          type="button"
          aria-label="退出登录"
          onClick={props.onLogout}
          class="grid h-11 w-11 place-items-center rounded-2xl text-slate-500 transition duration-200 hover:text-teal-700"
        >
          <LogoutIcon />
        </button>
      </div>
    </div>
  )
}

function ExpandedSidebarPanel(props: {
  pathname: string
  onConversationSelect: () => void
  onLogout: () => void
}) {
  const chatStore = useChatStore()
  const navigate = useNavigate()
  const [renameConversationId, setRenameConversationId] = createSignal<string | null>(null)
  const [renameValue, setRenameValue] = createSignal('')
  const [deleteConversationId, setDeleteConversationId] = createSignal<string | null>(null)
  const displayName = () =>
    chatStore.currentUser()?.realName ||
    chatStore.currentUser()?.name ||
    chatStore.currentUser()?.userName ||
    'GPAS2 用户'
  const jobTitle = () =>
    chatStore.currentUser()?.jobTitle || '研究人员'

  const closeRenameDialog = () => {
    setRenameConversationId(null)
    setRenameValue('')
  }
  const closeDeleteDialog = () => setDeleteConversationId(null)
  const openRenameDialog = (conversationId: string, title: string) => {
    setRenameConversationId(conversationId)
    setRenameValue(title)
  }
  const openDeleteDialog = (conversationId: string) => setDeleteConversationId(conversationId)
  const submitRename = () => {
    const conversationId = renameConversationId()
    const title = renameValue().trim()

    if (!conversationId || title.length === 0) {
      return
    }

    void chatStore.renameConversation(conversationId, title)
    closeRenameDialog()
  }
  const confirmDeleteConversation = () => {
    const conversationId = deleteConversationId()

    if (!conversationId) {
      return
    }

    const generationId =
      chatStore.getConversation(conversationId)
        ?.activeGeneration?.generationId

    if (generationId) {
      cancelAssistantReply(generationId)
    }
    navigate(appRoutes.home, { replace: true })
    void chatStore.deleteConversation(conversationId)
    closeDeleteDialog()
    props.onConversationSelect()
  }

  return (
    <>
      <div class="px-4 pt-5">
        <div class="rounded-2xl bg-white px-4 py-4">
          <div class="flex items-center gap-3">
            <ResearcherAvatar />
            <div>
              <div class="flex items-end justify-between gap-2 w-full">
                <span class="max-w-36 truncate text-xl font-semibold leading-none text-slate-700">{displayName()}</span>
                <span class="text-xs font-semibold text-slate-500">{jobTitle()}</span>
              </div>
              <div class="mt-2 flex items-center justify-between gap-2">
                <span class="text-sm font-semibold leading-none text-emerald-600">良好</span>
                <Tooltip content="这是当前您汇交进度状态">
                    <QuestionMarkIcon />
                </Tooltip>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-6">
        <div class="flex items-center justify-between px-2">
          <p class="text-sm font-semibold uppercase tracking-wide text-slate-400">最近会话</p>
        </div>

        <div class="gpas-scrollbar mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
          <div class="space-y-2 pb-6">
            <A
              href={appRoutes.home}
              onClick={props.onConversationSelect}
              class={
                props.pathname === appRoutes.home
                  ? 'flex w-full items-center justify-between rounded-2xl bg-teal-600 px-4 py-3 text-left text-white'
                  : 'flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left text-slate-600 transition duration-200 hover:border-slate-300'
              }
            >
              <div class="min-w-0">
                <p class="truncate text-sm font-semibold">新建会话</p>
              </div>
              <span
                class={
                  props.pathname === appRoutes.home
                    ? 'grid h-9 w-9 place-items-center rounded-xl bg-white/20 text-white'
                    : 'grid h-9 w-9 place-items-center rounded-xl bg-slate-100 text-slate-400'
                }
              >
                <MessageIcon />
              </span>
            </A>

            <div class="pt-3">
              <Show
                when={chatStore.orderedConversations().length > 0}
                fallback={
                  <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm leading-6 text-slate-400">
                    发送第一条消息后，这里会显示你的会话列表。
                  </div>
                }
              >
                <For each={chatStore.orderedConversations()}>
                  {(conversation) => {
                    const href = appRoutes.session(conversation.id)
                    const isActive = () => props.pathname === href

                    return (
                      <div
                        class={
                          isActive()
                            ? 'relative flex w-full items-center justify-between rounded-2xl bg-teal-600 px-4 py-3 text-white'
                            : 'relative flex w-full items-center justify-between rounded-2xl border border-transparent px-4 py-3 text-slate-600 transition duration-200 hover:border-slate-200 hover:bg-white/70'
                        }
                      >
                        <A
                          href={href}
                          onClick={props.onConversationSelect}
                          class="min-w-0 flex-1 text-left"
                        >
                          <div class="min-w-0">
                            <p class="truncate text-sm font-semibold">{getSidebarLabel(conversation.title)}</p>
                          </div>
                        </A>

                        <PopupMenu
                          buttonLabel="打开会话操作菜单"
                          buttonClass={
                            isActive()
                              ? 'grid h-9 w-9 place-items-center rounded-xl bg-transparent text-white transition duration-200 hover:bg-white/20'
                              : 'grid h-9 w-9 place-items-center rounded-xl bg-transparent text-slate-500 transition duration-200 hover:bg-slate-200'
                          }
                          items={buildConversationActionItems(
                            conversation.id,
                            conversation.title,
                            openRenameDialog,
                            openDeleteDialog,
                          )}
                        >
                            <MoreIcon />
                        </PopupMenu>
                      </div>
                    )
                  }}
                </For>
              </Show>
            </div>
          </div>
        </div>
      </div>

      <InputDialog
        open={Boolean(renameConversationId())}
        title="重命名会话"
        description="请输入新的会话名称。"
        value={renameValue()}
        placeholder="输入会话名称"
        confirmLabel="保存"
        onValueChange={setRenameValue}
        onClose={closeRenameDialog}
        onConfirm={submitRename}
      />

      <Show when={deleteConversationId()}>
        <ModalDialog
          title="确认删除该会话？"
          description={`删除后将无法恢复。${
            chatStore.getConversation(deleteConversationId() ?? '')?.title
              ? ` 会话名称：${chatStore.getConversation(deleteConversationId() ?? '')?.title}`
              : ''
          }`}
          onClose={closeDeleteDialog}
        >
          <div class="flex justify-end gap-3">
            <button
              type="button"
              class="inline-flex h-11 items-center rounded-full px-5 text-sm font-semibold text-slate-300 transition duration-200 hover:text-slate-400"
              onClick={closeDeleteDialog}
            >
              取消
            </button>
            <button
              type="button"
              class="inline-flex h-11 items-center rounded-full bg-[#6f2b2b] px-5 text-sm font-semibold text-white transition duration-200 hover:bg-[#5f2222]"
              onClick={confirmDeleteConversation}
            >
              确认删除
            </button>
          </div>
        </ModalDialog>
      </Show>

      <div class="mt-auto border-t border-slate-200 px-4 py-4">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm font-semibold text-slate-400">嘉兴南湖实验室</p>
          </div>
          <div class="flex items-center gap-2">
            <AccountMenu buttonClass="grid h-9 w-9 place-items-center rounded-xl text-slate-500 transition duration-200 hover:bg-slate-50 hover:text-teal-700" />
            <button
              type="button"
              aria-label="退出登录"
              onClick={props.onLogout}
              class="grid h-9 w-9 place-items-center rounded-xl text-slate-500 transition duration-200 hover:bg-slate-50 hover:text-teal-700"
            >
              <LogoutIcon />
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

function ChatComposer(props: {
  value: string
  onInput: (value: string) => void
  onSubmit: () => void
  onStop?: () => void
  centered?: boolean
  disabled?: boolean
  generating?: boolean
  stopping?: boolean
  placeholder?: string
}) {
  const [selectedFiles, setSelectedFiles] = createSignal<File[]>([])
  const [fileError, setFileError] = createSignal('')
  const [isVoiceHolding, setIsVoiceHolding] = createSignal(false)
  const [voiceHint, setVoiceHint] = createSignal('')
  let fileInputRef: HTMLInputElement | undefined
  const hasTypedContent = () => props.value.trim().length > 0

  const openFilePicker = () => fileInputRef?.click()
  const appendFiles = (files: File[]) => {
    setSelectedFiles((current) => {
      const next = [...current]

      for (const file of files) {
        const exists = next.some(
          (currentFile) =>
            currentFile.name === file.name &&
            currentFile.size === file.size &&
            currentFile.lastModified === file.lastModified,
        )

        if (!exists) {
          next.push(file)
        }
      }

      return next
    })
  }

  const handleFileChange = (event: Event & { currentTarget: HTMLInputElement }) => {
    const files = Array.from(event.currentTarget.files ?? [])

    if (files.length === 0) {
      return
    }

    const validFiles = files.filter((file) => file.name.toLowerCase().endsWith('.fasq'))
    const hasInvalidFile = validFiles.length !== files.length

    if (validFiles.length > 0) {
      appendFiles(validFiles)
    }

    setFileError(hasInvalidFile ? '仅支持上传 .fasq 文件' : '')
    event.currentTarget.value = ''
  }

  const handleComposerInput = (value: string) => {
    props.onInput(value)

    if (value.trim().length > 0) {
      setVoiceHint('')
    }
  }

  const startVoiceHold = () => {
    if (props.disabled || hasTypedContent()) {
      return
    }

    setVoiceHint('')
    setIsVoiceHolding(true)
  }

  const stopVoiceHold = (showHint: boolean) => {
    if (!isVoiceHolding()) {
      return
    }

    setIsVoiceHolding(false)

    if (showHint) {
      setVoiceHint('语音输入即将上线')
    }
  }

  const handleSubmit = () => {
    if (props.disabled || !hasTypedContent()) {
      return
    }

    props.onSubmit()
    setSelectedFiles([])
    setFileError('')
  }

  createEffect(() => {
    if (hasTypedContent()) {
      setVoiceHint('')
      setIsVoiceHolding(false)
    }
  })

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div class={props.centered ? 'w-full max-w-3xl' : 'mt-auto pt-3'}>
      <div class="rounded-3xl bg-white p-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".fasq"
          multiple
          hidden
          onChange={handleFileChange}
        />

        <textarea
          rows={props.centered ? 3 : 2}
          value={props.value}
          placeholder={props.placeholder ?? '输入你的问题，回车发送'}
          class="min-h-12 w-full resize-none border-none bg-transparent px-3 py-2 text-base leading-7 text-slate-700 outline-none placeholder:text-slate-400"
          onInput={(event) => handleComposerInput(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />

        <Show when={selectedFiles().length > 0}>
          <div class="mt-1 flex flex-wrap gap-2 px-3 pb-1">
            <For each={selectedFiles()}>
              {(file) => (
                <span class="inline-flex max-w-full items-center rounded-full bg-teal-50 px-3 py-1 text-xs font-medium text-teal-700 ring-1 ring-teal-100">
                  <span class="truncate">{file.name}</span>
                </span>
              )}
            </For>
          </div>
        </Show>

        <Show when={fileError()}>
          <p class="mt-2 px-3 text-xs font-medium text-rose-500">{fileError()}</p>
        </Show>

        <Show when={voiceHint()}>
          <p class="mt-2 px-3 text-xs font-medium text-sky-700">{voiceHint()}</p>
        </Show>

        <div class="mt-3 flex items-center justify-between gap-3 px-2 pt-3">
          <PopupMenu
            buttonLabel="打开附件菜单"
            buttonClass="grid h-11 w-11 place-items-center rounded-full text-slate-500 transition duration-200 hover:border-slate-300 hover:bg-slate-50 hover:text-teal-700"
            menuWidth={208}
            placement="top-end"
            items={[
              {
                label: '上传文件',
                icon: <UploadFileIcon />,
                onSelect: openFilePicker,
              },
              {
                label: '云端传输',
                icon: <CloudTransferIcon />,
                onSelect: noop,
              },
            ]}
          >
            <AddIcon />
          </PopupMenu>
          <Show when={props.generating}>
            <button
              type="button"
              disabled={props.stopping}
              aria-label={props.stopping ? '正在停止生成' : '停止生成'}
              onClick={() => props.onStop?.()}
              class={
                props.stopping
                  ? 'voice-action-button grid h-11 w-11 place-items-center rounded-full border border-slate-200 bg-slate-100 text-slate-400'
                  : 'voice-action-button grid h-11 w-11 place-items-center rounded-full border border-slate-200 bg-white text-slate-700 transition duration-200 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900'
              }
            >
              <StopIcon />
            </button>
          </Show>
          <Show when={!props.generating}>
            <Show
            when={hasTypedContent()}
            fallback={
              <button
                type="button"
                disabled={props.disabled}
                aria-label={isVoiceHolding() ? '录音中' : '按住语音输入'}
                data-voice-active={isVoiceHolding() ? 'true' : 'false'}
                class={
                  props.disabled
                    ? 'voice-action-button grid h-11 w-11 place-items-center rounded-full border border-slate-200 bg-white text-slate-300'
                  : isVoiceHolding()
                    ? 'voice-action-button grid h-11 w-11 place-items-center rounded-full bg-rose-600 text-white shadow-sm'
                      : 'voice-action-button grid h-11 w-11 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 transition duration-200 hover:text-teal-700'
                }
                onPointerDown={startVoiceHold}
                onPointerUp={() => stopVoiceHold(true)}
                onPointerLeave={() => stopVoiceHold(false)}
                onPointerCancel={() => stopVoiceHold(false)}
              >
                <span aria-hidden="true" class="voice-icon-glyph">
                  <VoiceIcon />
                </span>
                <span aria-hidden="true" class="voice-wave-group voice-wave-center">
                  <span class="voice-wave-bar voice-wave-delay-0" />
                  <span class="voice-wave-bar voice-wave-delay-1" />
                  <span class="voice-wave-bar voice-wave-delay-2" />
                  <span class="voice-wave-bar voice-wave-delay-1" />
                  <span class="voice-wave-bar voice-wave-delay-0" />
                </span>
              </button>
            }
          >
            <button
              type="button"
              disabled={props.disabled}
              onClick={handleSubmit}
              class={
                props.disabled
                  ? 'grid h-11 w-11 place-items-center rounded-full border border-slate-200 bg-slate-100 text-slate-400'
                  : 'grid h-11 w-11 place-items-center rounded-full bg-teal-700 text-white transition duration-200 hover:bg-teal-800'
              }
            >
              <SendIcon />
            </button>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  )
}

function GenerationStatusIndicator(props: {
  activity: GenerationActivity
}) {
  const reducedMotionQuery = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  )
  const [prefersReducedMotion, setPrefersReducedMotion] =
    createSignal(reducedMotionQuery.matches)
  const [thinkingTextIndex, setThinkingTextIndex] = createSignal(0)
  const handleReducedMotionChange = (event: MediaQueryListEvent) => {
    setPrefersReducedMotion(event.matches)
  }

  reducedMotionQuery.addEventListener(
    'change',
    handleReducedMotionChange,
  )
  onCleanup(() => {
    reducedMotionQuery.removeEventListener(
      'change',
      handleReducedMotionChange,
    )
  })

  createEffect(() => {
    const phase = props.activity.phase
    const reducedMotion = prefersReducedMotion()
    setThinkingTextIndex(0)

    if (phase !== 'thinking' || reducedMotion) {
      return
    }

    const intervalId = window.setInterval(() => {
      setThinkingTextIndex(
        (current) => (current + 1) % thinkingStatusTexts.length,
      )
    }, 1_800)

    onCleanup(() => window.clearInterval(intervalId))
  })

  const visibleText = () => {
    if (props.activity.phase === 'queued') {
      return '正在准备回答'
    }

    if (props.activity.phase === 'thinking') {
      return thinkingStatusTexts[thinkingTextIndex()]
    }

    if (props.activity.phase === 'tool') {
      return props.activity.toolLabel ?? '正在调用工具'
    }

    return '连接中断，正在恢复'
  }
  const accessibleText = () => {
    if (props.activity.phase === 'thinking') {
      return '正在思考'
    }

    return visibleText()
  }

  return (
    <span
      class="generation-status-indicator absolute right-3 top-2"
      data-phase={props.activity.phase}
      role="status"
      aria-live="polite"
    >
      <Show
        when={props.activity.phase === 'tool'}
        fallback={
          <Show
            when={props.activity.phase === 'reconnecting'}
            fallback={
              <span
                class="generation-status-dots"
                aria-hidden="true"
              >
                <span />
                <span />
                <span />
              </span>
            }
          >
            <span
              aria-hidden="true"
              class="i-lucide-refresh-cw generation-status-spin h-3 w-3 shrink-0"
            />
          </Show>
        }
      >
        <span
          aria-hidden="true"
          class="i-lucide-wrench h-3 w-3 shrink-0"
        />
      </Show>

      <For each={[visibleText()]}>
        {(text) => (
          <span
            aria-hidden="true"
            class="generation-status-text"
          >
            {text}
          </span>
        )}
      </For>
      <span class="sr-only">{accessibleText()}</span>
    </span>
  )
}

type MessageExecutionStep = ChatMessage['executionSteps'][number]

function ReasoningAccordion(props: { message: ChatMessage }) {
  const [open, setOpen] = createSignal(false)
  let panelRef: HTMLDivElement | undefined
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const steps = (): MessageExecutionStep[] => {
    const activity = props.message.activity

    if (!activity) {
      return props.message.executionSteps.length > 0
        ? props.message.executionSteps
        : [
            { id: 'received', label: '已接收问题', status: 'completed' },
            {
              id: 'response',
              label: props.message.status === 'done' ? '生成回答' : '生成回答已中断',
              status: props.message.status === 'done' ? 'completed' : 'interrupted',
            },
          ]
    }

    const completed = (id: string, label: string): MessageExecutionStep => ({
      id,
      label,
      status: 'completed',
    })
    const active = (id: string, label: string): MessageExecutionStep => ({
      id,
      label,
      status: 'active',
    })

    if (activity.phase === 'queued') {
      return [active('received', '正在接收问题')]
    }

    if (activity.phase === 'thinking') {
      return [
        completed('received', '已接收问题'),
        active('analysis', '正在分析并组织回答'),
      ]
    }

    if (activity.phase === 'tool') {
      return [
        completed('received', '已接收问题'),
        completed('analysis', '已完成初步分析'),
        active('tool', activity.toolLabel ?? '正在调用工具'),
      ]
    }

    if (activity.phase === 'reconnecting') {
      return [
        completed('received', '已接收问题'),
        active('reconnecting', '正在恢复连接'),
      ]
    }

    return [
      completed('received', '已接收问题'),
      completed('analysis', '已完成分析'),
      active('response', '正在生成回答'),
    ]
  }
  const summary = () => {
    const activeStep = steps().find((step) => step.status === 'active')

    if (activeStep) {
      return activeStep.label
    }

    if (props.message.status === 'failed') {
      return '处理过程已中断'
    }

    if (props.message.status === 'cancelled') {
      return '已停止生成'
    }

    return `已完成 · ${steps().length} 个步骤`
  }
  const toggle = () => {
    const next = !open()
    setOpen(next)

    if (!panelRef) {
      return
    }

    gsap.killTweensOf(panelRef)
    if (reducedMotion.matches) {
      gsap.set(panelRef, { height: next ? 'auto' : 0 })
      return
    }

    gsap.to(panelRef, {
      height: next ? 'auto' : 0,
      duration: 0.25,
      ease: 'power2.inOut',
    })
  }

  onMount(() => panelRef && gsap.set(panelRef, { height: 0 }))
  onCleanup(() => panelRef && gsap.killTweensOf(panelRef))

  return (
    <section class="mb-1 ml-2 max-w-full overflow-hidden text-slate-400">
      <button
        type="button"
        class="inline-flex max-w-full items-center gap-2 px-1 py-1 text-left text-sm text-slate-400 transition hover:text-slate-500"
        aria-expanded={open()}
        onClick={toggle}
      >
        <span class="flex min-w-0 items-center gap-2">
          <span class="truncate">{summary()}</span>
        </span>
        <span class={`i-lucide-chevron-right h-3.5 w-3.5 shrink-0 transition-transform duration-250 ${open() ? 'rotate-90' : ''}`} aria-hidden="true" />
      </button>
      <div ref={panelRef} class="overflow-hidden">
        <ol class="space-y-1.5 px-1 pb-2 pt-1">
          <For each={steps()}>
            {(step) => (
              <li class="flex items-start gap-2 text-sm leading-5 text-slate-400">
                <span
                  aria-hidden="true"
                  class={
                    step.status === 'completed'
                      ? 'i-lucide-circle-check-big mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400'
                      : step.status === 'interrupted'
                        ? 'i-lucide-circle-x mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400'
                        : 'i-lucide-loader-circle generation-status-spin mt-0.5 h-3.5 w-3.5 shrink-0 text-teal-500'
                  }
                />
                <span>{step.label}</span>
              </li>
            )}
          </For>
        </ol>
      </div>
    </section>
  )
}

function MessageActionToolbar(props: {
  message: ChatMessage
  canRegenerate: boolean
  onVote: (vote: 'up' | 'down' | null) => Promise<void>
  onRegenerate: () => Promise<void>
}) {
  const [notice, setNotice] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  let noticeTimer: number | undefined
  const showNotice = (value: string) => {
    setNotice(value)
    if (noticeTimer !== undefined) window.clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(() => setNotice(''), 1_500)
  }
  const copy = async () => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(props.message.content)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = props.message.content
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.append(textarea)
        textarea.select()
        const copied = document.execCommand('copy')
        textarea.remove()
        if (!copied) throw new Error('Copy command failed')
      }
      showNotice('已复制')
    } catch {
      showNotice('复制失败')
    }
  }
  const vote = async (value: 'up' | 'down') => {
    if (busy() || props.message.status !== 'done') return
    setBusy(true)
    try {
      await props.onVote(props.message.vote === value ? null : value)
    } catch {
      showNotice('评价未保存')
    } finally {
      setBusy(false)
    }
  }
  const regenerate = async () => {
    if (busy() || !props.canRegenerate) return
    setBusy(true)
    try {
      await props.onRegenerate()
    } catch {
      showNotice('重新生成失败')
      setBusy(false)
    }
  }
  const buttonClass = 'grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition duration-150 hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-35'
  onCleanup(() => noticeTimer !== undefined && window.clearTimeout(noticeTimer))

  return (
    <div class="mt-2 flex min-h-8 items-center gap-1" role="toolbar" aria-label="消息操作">
      <button type="button" class={buttonClass} aria-label="复制回答" onClick={() => void copy()}><span class="i-lucide-copy h-4 w-4" /></button>
      <button type="button" class={`${buttonClass} ${props.message.vote === 'up' ? 'bg-teal-50 text-teal-700' : ''}`} aria-label="点赞" aria-pressed={props.message.vote === 'up'} disabled={busy() || props.message.status !== 'done'} onClick={() => void vote('up')}><span class="i-lucide-thumbs-up h-4 w-4" /></button>
      <button type="button" class={`${buttonClass} ${props.message.vote === 'down' ? 'bg-teal-50 text-teal-700' : ''}`} aria-label="点踩" aria-pressed={props.message.vote === 'down'} disabled={busy() || props.message.status !== 'done'} onClick={() => void vote('down')}><span class="i-lucide-thumbs-down h-4 w-4" /></button>
      <button type="button" class={buttonClass} aria-label="重新生成" disabled={busy() || !props.canRegenerate} onClick={() => void regenerate()}><span class={`i-lucide-refresh-cw h-4 w-4 ${busy() ? 'generation-status-spin' : ''}`} /></button>
      <span class="ml-1 text-xs text-slate-500" role="status" aria-live="polite">{notice()}</span>
    </div>
  )
}

function ChatMessageBubble(props: {
  message: ChatMessage
  latestAssistant: boolean
  generationActive: boolean
  onVisibleProgress: (generationId: string) => void
  onVote: (vote: 'up' | 'down' | null) => Promise<void>
  onRegenerate: () => Promise<void>
}) {
  const isUser = () => props.message.role === 'user'
  const [visualComplete, setVisualComplete] = createSignal(
    props.message.status !== 'streaming',
  )
  return (
    <div class={isUser() ? 'flex justify-end' : 'flex items-start justify-start gap-3'}>
      <Show when={!isUser()}>
        <div class="mt-1 grid h-10 w-10 shrink-0 place-items-center rounded-2xl">
          <img src={gpasUrl} alt="GPAS" class="h-5 w-5 object-contain" />
        </div>
      </Show>
      <div class="min-w-0 max-w-3xl">
        <Show when={!isUser()}>
          <ReasoningAccordion message={props.message} />
        </Show>

        <div
          class={
            isUser()
              ? 'relative rounded-3xl bg-slate-100 px-4 py-2 text-slate-400'
              : 'relative rounded-3xl bg-white px-4 py-2 text-slate-700'
          }
        >

        <Show
          when={
            props.message.status === 'failed' ||
            props.message.status === 'cancelled'
          }
        >
          <span
            role="status"
            aria-live="polite"
            class={`mb-2 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide ${
              props.message.status === 'failed'
                ? 'bg-rose-50 text-rose-500'
                : 'bg-amber-50 text-amber-700'
            }`}
          >
            {props.message.status === 'failed'
              ? '生成失败'
              : '已停止生成'}
          </span>
        </Show>

        <div class="message-content text-base leading-7">
          <Show
            when={!isUser()}
            fallback={<p class="whitespace-pre-wrap">{props.message.content}</p>}
          >
            <Show
              when={
                props.message.status === 'streaming' &&
                props.message.generationId
              }
              keyed
              fallback={<StaticMarkdown text={props.message.content} />}
            >
              {(generationId) => (
                <StreamingMarkdown
                  generationId={generationId}
                  onVisibleProgress={() => props.onVisibleProgress(generationId)}
                  onComplete={() => setVisualComplete(true)}
                />
              )}
            </Show>
          </Show>
        </div>
        <Show when={!isUser() && props.message.content.length > 0 && props.message.status !== 'streaming' && visualComplete()}>
          <MessageActionToolbar
            message={props.message}
            canRegenerate={props.latestAssistant && !props.generationActive}
            onVote={props.onVote}
            onRegenerate={props.onRegenerate}
          />
        </Show>
        </div>
      </div>
    </div>
  )
}

function ChatPanelFrame(props: ParentProps<{ title: string; hideHeader?: boolean; headerAction?: JSX.Element }>) {
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col bg-slate-50">
      <Show when={!props.hideHeader}>
      <header class="flex items-center justify-start gap-3 px-4 py-4 text-slate-600 sm:px-8 sm:py-5">
        <div class="min-w-0">
          <p class="truncate text-lg font-semibold text-slate-800">{props.title}</p>
        </div>
        <Show when={props.headerAction}>
          <div class="shrink-0">{props.headerAction}</div>
        </Show>
      </header>
      </Show>

      <div class="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col px-5 pb-4 pt-6 sm:px-8 lg:px-12">{props.children}</div>
    </div>
  )
}

function EmptyConversationState() {
  const navigate = useNavigate()
  const chatStore = useChatStore()

  const startConversation = async () => {
    const content = chatStore.getRootDraft().trim()

    if (content.length === 0) {
      return
    }

    try {
      const conversation =
        await chatStore.createConversation(content)
      const message = chatStore.appendUserMessage(
        conversation.id,
        content,
      )
      chatStore.setRootDraft('')
      navigate(appRoutes.session(conversation.id))

      if (message?.clientMessageId) {
        void runAssistantReply(
          conversation.id,
          message.content,
          message.clientMessageId,
          undefined,
          chatStore,
        )
      }
    } catch {
      // The store initialization/error UI remains available for retry.
    }
  }

  return (
    <ChatPanelFrame title="开始新会话" hideHeader>
      <div class="grid min-h-0 flex-1 place-items-center">
        <div class="flex w-full max-w-3xl flex-col items-center gap-8 text-center">
          <div class="grid h-16 w-16 place-items-center">
            <img src={gpasUrl} alt="GPAS" class="h-9 w-9 object-contain" />
          </div>
          <div class="space-y-3">
            <h2 class="font-futura-heavy text-3xl font-semibold tracking-tight text-slate-900">Where should we begin?</h2>
          </div>

          <ChatComposer
            centered
            value={chatStore.getRootDraft()}
            onInput={chatStore.setRootDraft}
            onSubmit={() => void startConversation()}
            placeholder="输入你的第一条消息，例如：请总结这份样本分析的关键风险"
          />
        </div>
      </div>
    </ChatPanelFrame>
  )
}

function MissingConversationState() {
  return (
    <ChatPanelFrame title="会话不存在">
      <div class="grid min-h-0 flex-1 place-items-center">
        <div class="w-full max-w-xl rounded-3xl border border-slate-200 bg-white px-8 py-10 text-center">
          <div class="mx-auto grid h-14 w-14 place-items-center rounded-full bg-slate-100 text-slate-500">
            <MessageIcon />
          </div>
          <h2 class="mt-6 text-2xl font-semibold text-slate-900">没有找到对应会话</h2>
          <p class="mt-3 text-base leading-7 text-slate-500">
            这个会话 ID 当前不在前端状态中。你可以回到根页重新开始一个会话。
          </p>
          <div class="mt-7">
            <A
              href={appRoutes.home}
              class="inline-flex h-11 items-center rounded-full bg-teal-700 px-5 text-sm font-semibold text-white transition duration-200 hover:bg-teal-800"
            >
              返回空会话页
            </A>
          </div>
        </div>
      </div>
    </ChatPanelFrame>
  )
}

function SessionConversationView(props: { conversationId: string }) {
  const chatStore = useChatStore()
  const navigate = useNavigate()
  const [renameConversationId, setRenameConversationId] = createSignal<string | null>(null)
  const [renameValue, setRenameValue] = createSignal('')
  const [deleteConversationId, setDeleteConversationId] = createSignal<string | null>(null)
  const [isMessageListScrolling, setIsMessageListScrolling] = createSignal(false)
  const [isConversationLoading, setIsConversationLoading] = createSignal(true)
  const [isStoppingGeneration, setIsStoppingGeneration] = createSignal(false)
  const conversation = () => chatStore.getConversation(props.conversationId)
  let scrollFadeTimer: number | undefined
  let pointerScrollEndTimer: number | undefined
  let messageListRef: HTMLDivElement | undefined
  let shouldStickToBottom = true
  let isPointerScrollInteraction = false
  let wheelAnimationFrame: number | undefined
  let followScrollFrame: number | undefined
  let wheelScrollTarget = 0
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  const closeRenameDialog = () => {
    setRenameConversationId(null)
    setRenameValue('')
  }
  const closeDeleteDialog = () => setDeleteConversationId(null)
  const openRenameDialog = (conversationId: string, title: string) => {
    setRenameConversationId(conversationId)
    setRenameValue(title)
  }
  const openDeleteDialog = (conversationId: string) => setDeleteConversationId(conversationId)
  const submitRename = () => {
    const conversationId = renameConversationId()
    const title = renameValue().trim()

    if (!conversationId || title.length === 0) {
      return
    }

    void chatStore.renameConversation(conversationId, title)
    closeRenameDialog()
  }
  const confirmDeleteConversation = () => {
    const conversationId = deleteConversationId()

    if (!conversationId) {
      return
    }

    const generationId =
      chatStore.getConversation(conversationId)
        ?.activeGeneration?.generationId

    if (generationId) {
      cancelAssistantReply(generationId)
    }
    navigate(appRoutes.home, { replace: true })
    void chatStore.deleteConversation(conversationId)
    closeDeleteDialog()
  }

  onMount(() => {
    const existing = chatStore.getConversation(props.conversationId)
    const hasOptimisticMessage =
      existing?.messages.some((message) =>
        Boolean(message.clientMessageId),
      ) ?? false

    if (
      hasOptimisticMessage &&
      (
        existing?.activeGeneration ||
        startingReplies.has(props.conversationId)
      )
    ) {
      setIsConversationLoading(false)
      return
    }

    void chatStore
      .loadConversation(props.conversationId)
      .finally(() => setIsConversationLoading(false))
  })

  const showMessageListScrollbar = () => {
    setIsMessageListScrolling(true)

    if (scrollFadeTimer !== undefined) {
      window.clearTimeout(scrollFadeTimer)
    }

    scrollFadeTimer = window.setTimeout(() => {
      setIsMessageListScrolling(false)
      scrollFadeTimer = undefined
    }, 480)
  }
  const cancelWheelAnimation = () => {
    if (wheelAnimationFrame !== undefined) {
      window.cancelAnimationFrame(wheelAnimationFrame)
      wheelAnimationFrame = undefined
    }

    if (messageListRef) {
      wheelScrollTarget = messageListRef.scrollTop
    }
  }
  const updateShouldStickToBottom = () => {
    if (!messageListRef) {
      return
    }

    const remainingScroll =
      messageListRef.scrollHeight -
      messageListRef.scrollTop -
      messageListRef.clientHeight

    shouldStickToBottom = remainingScroll < 96
  }
  const finishPointerScrollInteraction = () => {
    if (pointerScrollEndTimer !== undefined) {
      window.clearTimeout(pointerScrollEndTimer)
    }

    pointerScrollEndTimer = window.setTimeout(() => {
      updateShouldStickToBottom()
      isPointerScrollInteraction = false
      pointerScrollEndTimer = undefined
    }, 160)
  }
  const animateWheelScroll = () => {
    if (!messageListRef) {
      wheelAnimationFrame = undefined
      return
    }

    const remainingDistance = wheelScrollTarget - messageListRef.scrollTop

    if (Math.abs(remainingDistance) < 0.5) {
      messageListRef.scrollTop = wheelScrollTarget
      wheelAnimationFrame = undefined
      return
    }

    messageListRef.scrollTop += remainingDistance * 0.2
    wheelAnimationFrame = window.requestAnimationFrame(animateWheelScroll)
  }
  const handleMessageListWheel = (event: WheelEvent) => {
    showMessageListScrollbar()

    if (!messageListRef || prefersReducedMotion.matches || event.ctrlKey) {
      return
    }

    const deltaScale =
      event.deltaMode === 1
        ? 20
        : event.deltaMode === 2
          ? messageListRef.clientHeight
          : 1
    const delta = event.deltaY * deltaScale

    if (delta === 0) {
      return
    }

    event.preventDefault()

    if (wheelAnimationFrame === undefined) {
      wheelScrollTarget = messageListRef.scrollTop
    }

    const maxScrollTop = Math.max(
      messageListRef.scrollHeight - messageListRef.clientHeight,
      0,
    )

    wheelScrollTarget = Math.min(
      Math.max(wheelScrollTarget + delta, 0),
      maxScrollTop,
    )
    shouldStickToBottom = maxScrollTop - wheelScrollTarget < 96

    if (wheelAnimationFrame === undefined) {
      wheelAnimationFrame = window.requestAnimationFrame(animateWheelScroll)
    }
  }
  const handleMessageListScroll = () => {
    if (isPointerScrollInteraction) {
      updateShouldStickToBottom()
      finishPointerScrollInteraction()
    }
  }
  const followVisibleOutput = (generationId: string) => {
    if (!messageListRef || !shouldStickToBottom || followScrollFrame !== undefined) {
      return
    }

    followScrollFrame = window.requestAnimationFrame(() => {
      followScrollFrame = undefined
      if (!messageListRef || !shouldStickToBottom) return
      const start = performance.now()
      cancelWheelAnimation()
      messageListRef.scrollTop = messageListRef.scrollHeight
      wheelScrollTarget = messageListRef.scrollTop
      recordStreamOperation(generationId, {
        type: 'scroll',
        duration: performance.now() - start,
      })
    })
  }

  createEffect(() => {
    const activeConversation = conversation()

    if (
      !activeConversation ||
      !activeConversation.activeGeneration ||
      activeReplyControllers.has(
        activeConversation.activeGeneration.generationId,
      )
    ) {
      return
    }

    const latestUserMessage = [...activeConversation.messages].reverse().find((message) => message.role === 'user')

    if (!latestUserMessage) {
      return
    }

    void runAssistantReply(
      activeConversation.id,
      latestUserMessage.content,
      latestUserMessage.clientMessageId || crypto.randomUUID(),
      activeConversation.activeGeneration,
      chatStore,
    )
  })

  createEffect(() => {
    const activeConversation = conversation()
    const messageCount = activeConversation?.messages.length ?? 0
    const generationId = activeConversation?.activeGeneration?.generationId

    if (!activeConversation || messageCount === 0 || !shouldStickToBottom) {
      return
    }

    followVisibleOutput(generationId ?? 'conversation')
  })

  onCleanup(() => {
    cancelWheelAnimation()

    if (followScrollFrame !== undefined) {
      window.cancelAnimationFrame(followScrollFrame)
    }

    if (pointerScrollEndTimer !== undefined) {
      window.clearTimeout(pointerScrollEndTimer)
    }

    if (scrollFadeTimer !== undefined) {
      window.clearTimeout(scrollFadeTimer)
    }
  })

  const sendFollowUp = () => {
    const content = conversation()?.draft.trim() ?? ''

    if (content.length === 0) {
      return
    }

    const message = chatStore.appendUserMessage(
      props.conversationId,
      content,
    )

    if (message?.clientMessageId) {
      shouldStickToBottom = true
      void runAssistantReply(
        props.conversationId,
        message.content,
        message.clientMessageId,
        undefined,
        chatStore,
      )
    }
  }

  const stopGeneration = async () => {
    const activeConversation = conversation()
    const generationId =
      activeConversation?.activeGeneration?.generationId

    if (!generationId || isStoppingGeneration()) {
      return
    }

    setIsStoppingGeneration(true)
    const streamSession = getAdaptiveStreamSession(generationId)
    const controller = activeReplyControllers.get(generationId)
    activeReplyControllers.delete(generationId)
    controller?.abort()

    if (streamSession) {
      streamSession.finish(streamSession.canonicalText, {
        kind: 'cancelled',
      })
    } else {
      chatStore.cancelAssistantMessage(
        props.conversationId,
        generationId,
      )
    }

    try {
      await cancelGeneration(generationId)
    } catch {
      // Keep the locally received canonical text if cancellation persistence fails.
    } finally {
      setIsStoppingGeneration(false)
    }
  }

  const visibleMessages = () => {
    const active = conversation()?.activeGeneration
    const messages = conversation()?.messages ?? []

    return active?.replacesMessageId
      ? messages.filter(
          (message) => message.id !== active.replacesMessageId,
        )
      : messages
  }
  const latestAssistantId = () => {
    const messages = visibleMessages()

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant') {
        return messages[index].id
      }
    }

    return undefined
  }
  const updateVote = async (
    message: ChatMessage,
    vote: 'up' | 'down' | null,
  ) => {
    const previous = message.vote
    chatStore.setMessageVoteState(props.conversationId, message.id, vote)

    try {
      if (vote === null) {
        await deleteMessageVote(message.id)
      } else {
        await setMessageVote(message.id, vote === 'up')
      }
    } catch (error) {
      chatStore.setMessageVoteState(props.conversationId, message.id, previous)
      throw error
    }
  }
  const regenerate = async (message: ChatMessage) => {
    if (conversation()?.activeGeneration || latestAssistantId() !== message.id) {
      return
    }

    const started = await regenerateMessage(message.id, crypto.randomUUID())

    if (!started.generation.streamId) {
      throw new Error('Generation stream was not created')
    }

    chatStore.setActiveGeneration(
      props.conversationId,
      started.generation.id,
      started.generation.streamId,
      started.replacesMessageId ?? message.id,
    )
    void runAssistantReply(
      props.conversationId,
      '',
      crypto.randomUUID(),
      {
        generationId: started.generation.id,
        streamId: started.generation.streamId,
      },
      chatStore,
    )
  }

  return (
    <Show
      when={conversation()}
      fallback={
        <Show
          when={!isConversationLoading()}
          fallback={
            <ChatPanelFrame title="正在加载会话">
              <div class="grid min-h-0 flex-1 place-items-center text-sm text-slate-400">
                正在从服务器恢复会话…
              </div>
            </ChatPanelFrame>
          }
        >
          <MissingConversationState />
        </Show>
      }
    >
      {(activeConversation) => (
        <>
          <ChatPanelFrame
            title={activeConversation().title}
            headerAction={
              <PopupMenu
                buttonLabel="打开当前会话操作菜单"
                buttonClass="grid h-9 w-9 place-items-center text-slate-500 transition duration-200"
                items={buildConversationActionItems(
                  activeConversation().id,
                  activeConversation().title,
                  openRenameDialog,
                  openDeleteDialog,
                )}
              >
                <DownArrowIcon />
              </PopupMenu>
            }
          >
            <div class="flex min-h-0 flex-1 flex-col">
              <div
                ref={messageListRef}
                class={`gpas-scrollbar scrollbar-fade flex min-h-0 flex-1 flex-col overflow-y-auto pr-2 ${isMessageListScrolling() ? 'scrollbar-visible' : ''}`}
                onScroll={handleMessageListScroll}
                onWheel={handleMessageListWheel}
                onPointerDown={() => {
                  isPointerScrollInteraction = true
                  cancelWheelAnimation()
                  showMessageListScrollbar()
                }}
                onPointerUp={finishPointerScrollInteraction}
                onPointerCancel={finishPointerScrollInteraction}
              >
                <div class="flex flex-col gap-4">
                  <For each={visibleMessages()}>
                    {(message) => (
                      <ChatMessageBubble
                        message={message}
                        latestAssistant={message.id === latestAssistantId()}
                        generationActive={Boolean(activeConversation().activeGeneration)}
                        onVisibleProgress={followVisibleOutput}
                        onVote={(vote) => updateVote(message, vote)}
                        onRegenerate={() => regenerate(message)}
                      />
                    )}
                  </For>
                </div>
              </div>

              <ChatComposer
                value={activeConversation().draft}
                onInput={(value) => chatStore.updateConversationDraft(props.conversationId, value)}
                onSubmit={sendFollowUp}
                onStop={() => void stopGeneration()}
                disabled={
                  Boolean(activeConversation().activeGeneration)
                }
                generating={
                  Boolean(activeConversation().activeGeneration)
                }
                stopping={isStoppingGeneration()}
                placeholder="继续提问，或补充更多上下文"
              />
            </div>
          </ChatPanelFrame>

          <InputDialog
            open={Boolean(renameConversationId())}
            title="重命名会话"
            description="请输入新的会话名称。"
            value={renameValue()}
            placeholder="输入会话名称"
            confirmLabel="保存"
            onValueChange={setRenameValue}
            onClose={closeRenameDialog}
            onConfirm={submitRename}
          />

          <Show when={deleteConversationId()}>
            <ModalDialog
              title="确认删除该会话？"
              description={`删除后将无法恢复。${
                chatStore.getConversation(deleteConversationId() ?? '')?.title
                  ? ` 会话名称：${chatStore.getConversation(deleteConversationId() ?? '')?.title}`
                  : ''
              }`}
              onClose={closeDeleteDialog}
            >
              <div class="flex justify-end gap-3">
                <button
                  type="button"
                  class="inline-flex h-11 items-center rounded-full px-5 text-sm font-semibold text-slate-300 transition duration-200 hover:text-slate-400"
                  onClick={closeDeleteDialog}
                >
                  取消
                </button>
                <button
                  type="button"
                  class="inline-flex h-11 items-center rounded-full bg-[#6f2b2b] px-5 text-sm font-semibold text-white transition duration-200 hover:bg-[#5f2222]"
                  onClick={confirmDeleteConversation}
                >
                  确认删除
                </button>
              </div>
            </ModalDialog>
          </Show>
        </>
      )}
    </Show>
  )
}

function ChatbotChrome(props: ParentProps) {
  const chatStore = useChatStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [isSidebarOpen, setIsSidebarOpen] = createSignal(false)
  const [isDesktop, setIsDesktop] = createSignal(
    typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)').matches : false,
  )

  const openSidebar = () => setIsSidebarOpen(true)
  const closeSidebar = () => setIsSidebarOpen(false)
  const closeSidebarOnMobile = () => {
    if (!isDesktop()) {
      closeSidebar()
    }
  }
  const handleLogout = () => {
    closeSidebar()
    navigate(appRoutes.home)
  }

  const sidebarClass = () => {
    const base =
      'flex shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-slate-100 transition-all duration-300 ease-out'

    if (isDesktop()) {
      return `${base} relative z-10 h-full ${isSidebarOpen() ? 'w-80' : 'w-24'}`
    }

    return `${base} absolute inset-y-0 left-0 z-30 ${isSidebarOpen() ? 'w-72 shadow-lg sm:w-80' : 'w-20 shadow-md'}`
  }

  onMount(() => {
    const desktopQuery = window.matchMedia('(min-width: 1024px)')
    const handleViewportChange = (event?: MediaQueryListEvent) => {
      setIsDesktop(event?.matches ?? desktopQuery.matches)
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeSidebar()
      }
    }

    handleViewportChange()
    desktopQuery.addEventListener('change', handleViewportChange)
    window.addEventListener('keydown', handleEscape)

    onCleanup(() => {
      desktopQuery.removeEventListener('change', handleViewportChange)
      window.removeEventListener('keydown', handleEscape)
    })
  })

  return (
    <LayoutContext.Provider value={{ isSidebarOpen, closeSidebar }}>
      <section class="flex h-screen w-screen overflow-hidden bg-slate-50 text-slate-900">
        <div class="relative flex h-full w-full overflow-hidden bg-slate-50">
          <aside class={sidebarClass()}>
            <SidebarBrand
              expanded={isSidebarOpen()}
              onExpand={openSidebar}
              onCollapse={closeSidebar}
            />
            <Show
              when={isSidebarOpen()}
              fallback={<CompactSidebarRail pathname={getAppPathname(location.pathname)} onLogout={handleLogout} />}
            >
              <ExpandedSidebarPanel
                pathname={getAppPathname(location.pathname)}
                onConversationSelect={closeSidebarOnMobile}
                onLogout={handleLogout}
              />
            </Show>
          </aside>

          <Show when={!isDesktop() && isSidebarOpen()}>
            <button
              type="button"
              aria-label="关闭侧边菜单"
              onClick={closeSidebar}
              class="absolute inset-y-0 left-72 right-0 z-20 bg-slate-950/40 sm:left-80"
            />
          </Show>

          <div class="flex min-w-0 flex-1 flex-col overflow-hidden bg-slate-50 pl-20 lg:pl-0">
            {props.children}
          </div>

          <Show when={chatStore.initializationError()}>
            {(message) => (
              <div class="absolute inset-0 z-50 grid place-items-center bg-slate-950/20 px-6 backdrop-blur-sm">
                <div
                  role="alert"
                  class="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-xl"
                >
                  <div class="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-amber-50 text-amber-600">
                    <span
                      aria-hidden="true"
                      class="i-lucide-triangle-alert h-5 w-5"
                    />
                  </div>
                  <h2 class="text-base font-semibold text-slate-900">
                    无法加载 Chatbot
                  </h2>
                  <p class="mt-2 text-sm leading-6 text-slate-500">
                    {message()}
                  </p>
                  <Show
                    when={chatStore.initializationErrorStatus() !== 403}
                  >
                    <button
                      type="button"
                      class="mt-5 inline-flex h-10 items-center justify-center rounded-full bg-teal-700 px-5 text-sm font-semibold text-white transition hover:bg-teal-800"
                      onClick={() =>
                        void chatStore.retryInitialization()
                      }
                    >
                      重试
                    </button>
                  </Show>
                </div>
              </div>
            )}
          </Show>
        </div>
      </section>
    </LayoutContext.Provider>
  )
}

export const ChatbotPage: ParentComponent = (props) => {
  onCleanup(cancelAllAssistantReplies)

  return (
    <ChatStoreProvider>
      <ChatbotChrome>{props.children}</ChatbotChrome>
    </ChatStoreProvider>
  )
}

export const ChatbotEmptyState: Component = () => {
  return <EmptyConversationState />
}

export const ChatSessionPage: Component = () => {
  const params = useParams()

  return <SessionConversationView conversationId={params.id ?? ''} />
}
