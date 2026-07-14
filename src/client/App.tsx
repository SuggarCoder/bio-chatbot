import { createResource } from 'solid-js'
import type { ParentProps } from 'solid-js'
import { Navigate, Route, Router } from '@solidjs/router'

type Health = {
  status: 'ok'
  service: string
  commit: string
  time: string
}

import {
  ChatSessionPage,
  ChatbotEmptyState,
  ChatbotPage,
} from './pages/chatbot/ChatbotPage'
import { routerBase } from './routes'


function ChatbotRoute(props: ParentProps) {
  return <ChatbotPage>{props.children}</ChatbotPage>
}

function RootLayout(props: ParentProps) {
  return (
    <div class="relative h-screen w-full overflow-hidden bg-white">{props.children}</div>
  )
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
    <Router base={routerBase} root={RootLayout}>
      <Route path="/" component={ChatbotRoute}>
        <Route path="/" component={ChatbotEmptyState} />
        <Route path="/:id" component={ChatSessionPage} />
      </Route>
      <Route path="*fallback" component={() => <Navigate href="/" />} />
    </Router>
  )
}
