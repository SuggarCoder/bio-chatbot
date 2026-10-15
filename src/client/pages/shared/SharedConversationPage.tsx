import { A, useParams } from '@solidjs/router'
import { createResource, For, Show } from 'solid-js'

import { fetchSharedConversation } from '../../features/chatbot/chatApi'
import { appRoutes } from '../../routes'

export function SharedConversationPage() {
  const params = useParams<{ shareSlug: string }>()
  const [conversation] = createResource(
    () => params.shareSlug,
    fetchSharedConversation,
  )

  return (
    <main class="h-full overflow-y-auto bg-slate-50 px-4 py-8 text-slate-900 sm:px-8">
      <div class="mx-auto max-w-3xl">
        <A
          href={appRoutes.home}
          class="mb-6 inline-flex items-center gap-2 text-sm text-slate-600 hover:text-slate-950"
        >
          <span class="i-lucide-arrow-left" aria-hidden="true" />
          返回 Chatbot
        </A>

        <Show
          when={conversation()}
          fallback={
            <section class="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
              <Show
                when={conversation.error}
                fallback={<p class="text-slate-600">正在加载分享会话…</p>}
              >
                <h1 class="text-xl font-semibold">无法读取分享会话</h1>
                <p class="mt-2 text-sm text-slate-600">
                  分享可能已撤销，或当前账号没有访问权限。
                </p>
              </Show>
            </section>
          }
        >
          {(shared) => (
            <>
              <header class="mb-6">
                <div class="text-xs font-medium uppercase tracking-wider text-slate-500">
                  已认证只读分享 · {shared().shareMode === 'snapshot' ? '快照' : '实时'}
                </div>
                <h1 class="mt-2 text-2xl font-semibold">{shared().title}</h1>
              </header>

              <section class="space-y-4">
                <For each={shared().messages}>
                  {(message) => (
                    <article
                      class={message.role === 'user'
                        ? 'ml-auto max-w-[85%] rounded-2xl bg-slate-900 px-5 py-4 text-white'
                        : 'mr-auto max-w-[92%] rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm'}
                    >
                      <div class="mb-2 text-xs font-medium opacity-65">
                        {message.role === 'user' ? '用户' : 'Assistant'}
                      </div>
                      <div class="whitespace-pre-wrap break-words text-sm leading-7">
                        {message.content}
                      </div>
                    </article>
                  )}
                </For>
              </section>
            </>
          )}
        </Show>
      </div>
    </main>
  )
}
