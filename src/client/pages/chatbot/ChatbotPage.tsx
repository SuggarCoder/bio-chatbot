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
import { streamAssistantReply } from '../../features/chatbot/chatStream'
import { ChatStoreProvider, useChatStore, type ChatMessage } from '../../features/chatbot/chatStore'
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
const accountEmail = 'alexa@gpas.ai'
const noop = () => undefined

function cancelAssistantReply(conversationId: string) {
  activeReplyControllers.get(conversationId)?.abort()
}

function cancelAllAssistantReplies() {
  for (const controller of activeReplyControllers.values()) {
    controller.abort()
  }

  activeReplyControllers.clear()
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
  return (
    <PopupMenu
      buttonLabel="打开账户菜单"
      buttonClass={props.buttonClass}
      header={
        <div class="min-w-0">
          <p class="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Account</p>
          <p class="mt-1 truncate text-sm font-semibold text-slate-800">{accountEmail}</p>
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
  chatStore: ReturnType<typeof useChatStore>,
) {
  if (activeReplyControllers.has(conversationId)) {
    return
  }

  const controller = new AbortController()
  activeReplyControllers.set(conversationId, controller)
  chatStore.startAssistantMessage(conversationId)

  try {
    for await (const chunk of streamAssistantReply(prompt, controller.signal)) {
      chatStore.appendAssistantChunk(conversationId, chunk)
    }

    chatStore.finishAssistantMessage(conversationId)
  } catch (error) {
    if (controller.signal.aborted) {
      return
    }

    const message = error instanceof Error ? error.message : '回复生成失败，请稍后重试。'
    chatStore.failAssistantMessage(conversationId, message)
  } finally {
    if (activeReplyControllers.get(conversationId) === controller) {
      activeReplyControllers.delete(conversationId)
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

    chatStore.renameConversation(conversationId, title)
    closeRenameDialog()
  }
  const confirmDeleteConversation = () => {
    const conversationId = deleteConversationId()

    if (!conversationId) {
      return
    }

    cancelAssistantReply(conversationId)
    navigate(appRoutes.home, { replace: true })
    chatStore.deleteConversation(conversationId)
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
                <span class="text-xl font-semibold leading-none text-slate-700">Alexa</span>
                <span class="text-xs font-semibold text-slate-500">研究员</span>
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
  centered?: boolean
  disabled?: boolean
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
        </div>
      </div>
    </div>
  )
}

function ChatMessageBubble(props: { message: ChatMessage }) {
  const isUser = () => props.message.role === 'user'
  const showPlaceholder = () =>
    props.message.role === 'assistant' &&
    props.message.status === 'streaming' &&
    props.message.content.trim().length === 0

  return (
    <div class={isUser() ? 'flex justify-end' : 'flex items-start justify-start gap-3'}>
      <Show when={!isUser()}>
        <div class="mt-1 grid h-10 w-10 shrink-0 place-items-center rounded-2xl">
          <img src={gpasUrl} alt="GPAS" class="h-5 w-5 object-contain" />
        </div>
      </Show>
      <div
        class={
          isUser()
            ? 'relative max-w-3xl rounded-3xl bg-slate-100 px-4 py-2 text-slate-400'
            : 'relative max-w-3xl rounded-3xl bg-white px-4 py-2 text-slate-700'
        }
      >
        <Show when={!isUser()}>
          <span
            role="status"
            aria-live="polite"
            class={`absolute right-3 top-2 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-opacity duration-200 ${
              props.message.status === 'streaming'
                ? 'bg-teal-50 text-teal-700 opacity-100'
                : props.message.status === 'error'
                  ? 'bg-rose-50 text-rose-500 opacity-100'
                  : 'pointer-events-none opacity-0'
            }`}
          >
            {props.message.status === 'error'
              ? 'Error'
              : props.message.status === 'streaming'
                ? 'Streaming'
                : ''}
          </span>
        </Show>

        <p
          class={`message-content whitespace-pre-wrap text-base leading-7 ${isUser() ? '' : 'pr-24'}`}
        >
          {showPlaceholder() ? '正在生成回复...' : props.message.content}
        </p>
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

  const startConversation = () => {
    const content = chatStore.getRootDraft().trim()

    if (content.length === 0) {
      return
    }

    const conversationId = crypto.randomUUID()
    chatStore.appendUserMessage(conversationId, content)
    chatStore.setRootDraft('')
    navigate(appRoutes.session(conversationId))
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
            onSubmit={startConversation}
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
  const conversation = () => chatStore.getConversation(props.conversationId)
  let scrollFadeTimer: number | undefined
  let pointerScrollEndTimer: number | undefined
  let messageListRef: HTMLDivElement | undefined
  let shouldStickToBottom = true
  let isPointerScrollInteraction = false
  let wheelAnimationFrame: number | undefined
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

    chatStore.renameConversation(conversationId, title)
    closeRenameDialog()
  }
  const confirmDeleteConversation = () => {
    const conversationId = deleteConversationId()

    if (!conversationId) {
      return
    }

    cancelAssistantReply(conversationId)
    navigate(appRoutes.home, { replace: true })
    chatStore.deleteConversation(conversationId)
    closeDeleteDialog()
  }

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

  createEffect(() => {
    const activeConversation = conversation()

    if (!activeConversation || !activeConversation.pendingReply) {
      return
    }

    const latestUserMessage = [...activeConversation.messages].reverse().find((message) => message.role === 'user')

    if (!latestUserMessage) {
      return
    }

    void runAssistantReply(activeConversation.id, latestUserMessage.content, chatStore)
  })

  createEffect(() => {
    const activeConversation = conversation()
    const latestMessage = activeConversation?.messages.at(-1)
    latestMessage?.content.length

    if (!activeConversation || !latestMessage || !shouldStickToBottom) {
      return
    }

    const frameId = window.requestAnimationFrame(() => {
      if (!messageListRef || !shouldStickToBottom) {
        return
      }

      cancelWheelAnimation()
      messageListRef.scrollTop = messageListRef.scrollHeight
      wheelScrollTarget = messageListRef.scrollTop
    })

    onCleanup(() => window.cancelAnimationFrame(frameId))
  })

  onCleanup(() => {
    cancelWheelAnimation()

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

    chatStore.appendUserMessage(props.conversationId, content)
  }

  return (
    <Show when={conversation()} fallback={<MissingConversationState />}>
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
                  <For each={activeConversation().messages}>
                    {(message) => <ChatMessageBubble message={message} />}
                  </For>
                </div>
              </div>

              <ChatComposer
                value={activeConversation().draft}
                onInput={(value) => chatStore.updateConversationDraft(props.conversationId, value)}
                onSubmit={sendFollowUp}
                disabled={activeConversation().streamState === 'streaming'}
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
