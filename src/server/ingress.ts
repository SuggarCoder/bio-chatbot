import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Database } from './db.js'
import { chats, ingressRequests, users } from './db/schema.js'
import { AuthenticationError } from './auth.js'
import type { AppConfig } from './config.js'
import type { GpasUploadBatch, projectInputSchema } from './gpasContracts.js'
import type { z } from 'zod'

export type IngressPayload = { content: string; artifactId?: string; supersedesGenerationId?: string; projectInput?: z.infer<typeof projectInputSchema>; uploads?: GpasUploadBatch }
export type IngressRow = typeof ingressRequests.$inferSelect
export type IngressContext = { check(): Promise<void> }
export function sealCredential(cookie: string, key: string, aad: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv)
  cipher.setAAD(Buffer.from(aad))
  const encrypted = Buffer.concat([cipher.update(cookie, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')
}
export function openCredential(value: string, key: string, aad: string): string {
  const bytes = Buffer.from(value, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), bytes.subarray(0, 12))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
}
export function ingressTicket(row: IngressRow) {
  return { id: row.id, chatId: row.chatId, requestId: row.requestId, status: row.status, result: row.result, error: row.error }
}
export class DurableIngress {
  private timer?: ReturnType<typeof setInterval>
  private active = new Set<Promise<void>>()
  private ticking = false
  private stopped = false
  constructor(private config: AppConfig, private db: Database,
    private execute: (row: IngressRow, cookie: string, context: IngressContext) => Promise<Record<string, unknown>>,
    private report: (error: unknown) => void = () => {}) {}

  async submit(input: { userId: string; chatId: string; requestId: string; payload: IngressPayload; cookie: string; externalUserId: string; teamId: string }) {
    // Fields are constructed in stable order by the route, never arbitrary client JSON.
    const payloadHash = createHash('sha256').update(JSON.stringify(input.payload)).digest('hex')
    return this.db.transaction(async tx => {
      // Serialize per-user quota and idempotency checks, not external work.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for('update')
      const [chat] = await tx.select({ id: chats.id }).from(chats).where(and(eq(chats.id, input.chatId), eq(chats.userId, input.userId), sql`${chats.deletedAt} is null`)).for('update')
      if (!chat) throw new AuthenticationError('会话不存在。', 404, 'chat_not_found')
      const [prior] = await tx.select().from(ingressRequests).where(and(eq(ingressRequests.userId, input.userId), eq(ingressRequests.requestId, input.requestId)))
      if (prior) {
        if (prior.chatId !== input.chatId || prior.payloadHash !== payloadHash) throw new AuthenticationError('同一请求标识不能用于不同内容。', 409, 'request_conflict')
        return ingressTicket(prior)
      }
      const pending = await tx.select({ chatId: ingressRequests.chatId }).from(ingressRequests).where(and(eq(ingressRequests.userId, input.userId), inArray(ingressRequests.status, ['queued', 'running'])))
      if (pending.some(row => row.chatId === input.chatId)) throw new AuthenticationError('本会话仍有请求排队。', 409, 'request_pending')
      if (pending.length >= 10) throw new AuthenticationError('待处理请求过多。', 429, 'request_queue_full')
      const [row] = await tx.insert(ingressRequests).values({ userId: input.userId, chatId: input.chatId, requestId: input.requestId, payload: input.payload, payloadHash,
        externalUserId: input.externalUserId, teamId: input.teamId,
        credential: sealCredential(input.cookie, this.config.requestEncryptionKey, `${input.userId}:${input.requestId}`),
      }).returning()
      return ingressTicket(row)
    })
  }
  async get(userId: string, id: string) {
    const [row] = await this.db.select().from(ingressRequests).where(and(eq(ingressRequests.userId, userId), eq(ingressRequests.id, id)))
    return row ? ingressTicket(row) : null
  }
  async pending(userId: string, chatId: string) {
    const rows = await this.db.select().from(ingressRequests).where(and(eq(ingressRequests.userId, userId), eq(ingressRequests.chatId, chatId), inArray(ingressRequests.status, ['queued', 'running'])))
    return rows.map(ingressTicket)
  }
  start() {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => { void this.tick().catch(this.report) }, 500)
    this.timer.unref()
    void this.tick().catch(this.report)
  }
  async stop() {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = undefined
    // Wait for an in-flight claim to enter the active set before draining.
    while (this.ticking) await new Promise(resolve => setTimeout(resolve, 10))
    // Do not mark unfinished requests failed: their leases will be reclaimed.
    await Promise.allSettled([...this.active])
  }
  async tick() {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      while (!this.stopped && this.active.size < (this.config.ingressConcurrency ?? 8)) {
        const token = randomUUID()
        const claimed = await this.db.execute(sql`
          update "IngressRequest" set status='running', token=${token}::uuid,
            "leaseUntil"=now()+interval '90 seconds', attempts=attempts+1, "updatedAt"=now()
          where id=(select id from "IngressRequest"
            where (status='queued' and "availableAt"<=now()) or (status='running' and "leaseUntil"<now())
            order by "availableAt", "createdAt", id for update skip locked limit 1)
          returning id`)
        if (!claimed.rows.length) break
        const [row] = await this.db.select().from(ingressRequests).where(eq(ingressRequests.id, String(claimed.rows[0].id)))
        const task = this.run(row).catch(this.report).finally(() => this.active.delete(task))
        this.active.add(task)
      }
    } finally { this.ticking = false }
  }
  private async run(row: IngressRow) {
    const owned = and(eq(ingressRequests.id, row.id), eq(ingressRequests.token, row.token!), eq(ingressRequests.status, 'running'), sql`${ingressRequests.leaseUntil}>now()`)
    const check = async () => {
      const rows = await this.db.update(ingressRequests).set({ leaseUntil: sql`now()+interval '90 seconds'` }).where(owned).returning({ id: ingressRequests.id })
      if (!rows.length) throw new Error('Ingress lease lost')
    }
    // The whole operation has a finite lease; renew independently of slow network work.
    let renewing = false
    const timer = setInterval(() => {
      if (renewing) return
      renewing = true
      void check().catch(this.report).finally(() => { renewing = false })
    }, 20_000)
    timer.unref()
    try {
      if (Date.now() - row.createdAt.getTime() > 24 * 60 * 60 * 1000 || row.attempts > 8) throw new AuthenticationError('请求已过期，请重新提交。', 410, 'request_expired')
      const cookie = openCredential(row.credential!, this.config.requestEncryptionKey, `${row.userId}:${row.requestId}`)
      const result = await this.execute(row, cookie, { check })
      await this.db.update(ingressRequests).set({ status: 'succeeded', result, credential: null, leaseUntil: null, updatedAt: new Date() }).where(owned)
    } catch (error) {
      const status = typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500
      const transient = (status >= 500 || status === 429) && row.attempts < 8
      const detail = error instanceof AuthenticationError ? { code: error.code, message: error.message } : { code: 'request_failed', message: '请求暂时无法完成，请重试。' }
      await this.db.update(ingressRequests).set({ status: transient ? 'queued' : 'failed',
        error: transient ? null : detail, credential: transient ? row.credential : null, leaseUntil: null,
        availableAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** row.attempts)), updatedAt: new Date(),
      }).where(owned)
      // Never log credentials, payloads, provider responses, or full thrown errors here.
    } finally { clearInterval(timer) }
  }
}
