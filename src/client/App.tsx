import { createResource } from 'solid-js'

type Health = {
  status: 'ok'
  service: string
  commit: string
  time: string
}

async function fetchHealth(): Promise<Health> {
  /*
   * import.meta.env.BASE_URL 在生产环境中为：
   * /ai-chatbot/
   *
   * 因此最终请求：
   * /ai-chatbot/api/health
   */
  const response = await fetch(
    `${import.meta.env.BASE_URL}api/health`,
    {
      credentials: 'include',
    },
  )

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return response.json() as Promise<Health>
}

export default function App() {
  const [health, { refetch }] = createResource(fetchHealth)

  return (
    <main class="min-h-screen bg-slate-50 p-6 text-slate-950 sm:p-10">
      <section class="panel mx-auto max-w-3xl overflow-hidden">
        <header class="border-b border-slate-200 px-6 py-5 sm:px-8">
          <div class="mb-4 inline-flex rounded-full bg-indigo-50 px-3 py-1 text-xs font-700 text-brand">
            SolidJS · Fastify · UnoCSS
          </div>

          <h1 class="m-0 text-4xl font-800 tracking-tight sm:text-5xl">
            AI Chatbot
          </h1>

          <p class="mt-3 text-base leading-7 text-slate-500">
            应用基础框架已运行在

            <code class="mx-1 rounded bg-slate-100 px-1.5 py-0.5 text-sm text-slate-800">
              /ai-chatbot/
            </code>

            路径下。
          </p>
        </header>

        <div class="grid gap-5 px-6 py-6 sm:grid-cols-2 sm:px-8">
          <div class="rounded-4 bg-slate-950 p-5 text-white">
            <div class="text-sm text-slate-400">
              API 状态
            </div>

            <div class="mt-2 text-2xl font-700">
              {health.loading && '检查中…'}
              {health.error && '连接失败'}
              {health()?.status === 'ok' && '运行正常'}
            </div>
          </div>

          <div class="rounded-4 border border-slate-200 p-5">
            <div class="text-sm text-slate-500">
              当前部署提交
            </div>

            <div class="mt-2 break-all font-mono text-sm text-slate-800">
              {health()?.commit ?? '—'}
            </div>
          </div>
        </div>

        <footer class="flex items-center justify-between gap-4 border-t border-slate-200 px-6 py-5 sm:px-8">
          <span class="min-w-0 break-all text-sm text-slate-500">
            {health.error
              ? String(health.error)
              : health()?.time ?? ''}
          </span>

          <button
            class="btn-primary shrink-0"
            type="button"
            disabled={health.loading}
            onClick={() => void refetch()}
          >
            重新检查
          </button>
        </footer>
      </section>
    </main>
  )
}