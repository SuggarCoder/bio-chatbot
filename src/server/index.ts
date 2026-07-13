import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_BASE = '/ai-chatbot/'
const API_BASE = '/ai-chatbot/api'

const HOST = process.env.HOST ?? '0.0.0.0'
const PORT = Number(process.env.PORT ?? 8090)

/*
 * 本地开发：
 * SERVE_CLIENT=false
 * 前端由 Vite 5173 提供。
 *
 * 生产环境：
 * 默认 true
 * Fastify 托管 dist/client。
 */
const SERVE_CLIENT =
  process.env.SERVE_CLIENT !== 'false'

const currentFile =
  fileURLToPath(import.meta.url)

const currentDirectory =
  path.dirname(currentFile)

/*
 * 编译后服务器文件：
 * dist/server/index.js
 *
 * 前端文件：
 * dist/client/
 */
const clientDirectory =
  path.resolve(currentDirectory, '../client')

const app = Fastify({
  logger: true,

  /*
   * Fastify 位于 Nginx 反向代理后方。
   */
  trustProxy: true,
})

/*
 * 健康检查接口。
 */
app.get(`${API_BASE}/health`, async () => {
  return {
    status: 'ok',
    service: 'ai-chatbot',
    commit: process.env.APP_COMMIT ?? 'local',
    time: new Date().toISOString(),
  }
})

if (SERVE_CLIENT) {
  await app.register(fastifyStatic, {
    root: clientDirectory,
    prefix: APP_BASE,

    /*
     * Vite 生成的 assets 文件带 hash，
     * 可以长时间缓存。
     */
    maxAge: '30d',
    immutable: true,

    /*
     * index.html 不能长时间缓存，
     * 否则部署后可能仍引用旧资源。
     */
    setHeaders(reply, filePath) {
      if (filePath.endsWith('index.html')) {
        reply.header(
          'Cache-Control',
          'no-cache, no-store, must-revalidate',
        )
      }
    },
  })

  /*
   * 没有尾部 / 时跳转到标准路径。
   */
  app.get(
    '/ai-chatbot',
    async (_request, reply) => {
      return reply.redirect(APP_BASE)
    },
  )

  /*
   * SPA fallback。
   *
   * 后续加入前端路由后：
   * /ai-chatbot/conversations/123
   * 仍然返回 index.html。
   */
  app.setNotFoundHandler(
    async (request, reply) => {
      const acceptsHtml =
        request.headers.accept?.includes(
          'text/html',
        ) ?? false

      const isClientRoute =
        request.method === 'GET' &&
        request.url.startsWith(APP_BASE)

      const isApiRoute =
        request.url.startsWith(
          `${API_BASE}/`,
        )

      if (
        isClientRoute &&
        !isApiRoute &&
        acceptsHtml
      ) {
        return reply
          .type('text/html; charset=utf-8')
          .sendFile('index.html', {
            maxAge: 0,
            immutable: false,
          })
      }

      return reply.code(404).send({
        error: 'Not Found',
        path: request.url,
      })
    },
  )
}

async function shutdown(
  signal: string,
): Promise<void> {
  app.log.info(
    { signal },
    'Shutting down',
  )

  await app.close()
  process.exit(0)
}

process.on('SIGINT', () => {
  void shutdown('SIGINT')
})

process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})

try {
  await app.listen({
    host: HOST,
    port: PORT,
  })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}