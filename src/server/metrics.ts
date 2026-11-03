import { createServer, type Server } from 'node:http'

import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client'

/**
 * Prometheus metrics for the API and the worker. Both serve them on a
 * separate internal port (METRICS_PORT), never through the public API.
 */
export const registry = new Registry()

let initialized = false

export function initMetrics(role: 'api' | 'worker'): void {
  if (initialized) return
  initialized = true
  registry.setDefaultLabels({ role })
  // Heap, GC, event-loop lag, handles, CPU: the process-level health signals.
  collectDefaultMetrics({ register: registry, prefix: 'chatbot_' })
}

const durationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]

export const metrics = {
  httpRequestDuration: new Histogram({
    name: 'chatbot_http_request_duration_seconds',
    help: 'API request duration by route and status class.',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: durationBuckets,
    registers: [registry],
  }),
  loadShed: new Counter({
    name: 'chatbot_http_load_shed_total',
    help: 'Requests rejected with 503 because the process was overloaded.',
    labelNames: ['reason'] as const,
    registers: [registry],
  }),
  redisCommandDuration: new Histogram({
    name: 'chatbot_redis_command_duration_seconds',
    help: 'Redis command latency as seen by the application.',
    labelNames: ['command'] as const,
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
    registers: [registry],
  }),
  redisCommandErrors: new Counter({
    name: 'chatbot_redis_command_errors_total',
    help: 'Redis commands that failed or timed out.',
    labelNames: ['command'] as const,
    registers: [registry],
  }),
  dbPoolErrors: new Counter({
    name: 'chatbot_db_pool_errors_total',
    help: 'Errors on idle pooled PostgreSQL connections (e.g. the server closed them).',
    registers: [registry],
  }),
  generationsStarted: new Counter({
    name: 'chatbot_generations_started_total',
    help: 'Generations the worker started running.',
    registers: [registry],
  }),
  generationsFinished: new Counter({
    name: 'chatbot_generations_finished_total',
    help: 'Generations finalized, by final status and error code.',
    labelNames: ['status', 'error_code'] as const,
    registers: [registry],
  }),
  generationsActive: new Gauge({
    name: 'chatbot_generations_active',
    help: 'Generations running in this worker.',
    registers: [registry],
  }),
  generationDuration: new Histogram({
    name: 'chatbot_generation_duration_seconds',
    help: 'Wall time of a generation run.',
    buckets: [1, 2, 5, 10, 20, 30, 60, 90, 120, 180, 300],
    registers: [registry],
  }),
  generationFirstToken: new Histogram({
    name: 'chatbot_generation_first_token_seconds',
    help: 'Time from start to the first output token.',
    buckets: [0.25, 0.5, 1, 2, 3, 5, 8, 13, 20, 30],
    registers: [registry],
  }),
  generationBytes: new Histogram({
    name: 'chatbot_generation_bytes',
    help: 'Bytes one generation took in (input, output, tool results, Artifact base).',
    buckets: [64e3, 256e3, 512e3, 1e6, 2e6, 4e6, 8e6, 16e6],
    registers: [registry],
  }),
  queuedGenerations: new Gauge({
    name: 'chatbot_generations_queued',
    help: 'Generations waiting to run (PostgreSQL view, refreshed by worker reconcile).',
    registers: [registry],
  }),
  modelPermitWait: new Histogram({
    name: 'chatbot_model_permit_wait_seconds',
    help: 'Time spent waiting for a shared upstream model permit.',
    buckets: [0.001, 0.01, 0.1, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [registry],
  }),
  toolCalls: new Counter({
    name: 'chatbot_tool_calls_total',
    help: 'Model tool calls by tool and outcome.',
    labelNames: ['tool', 'outcome'] as const,
    registers: [registry],
  }),
  backgroundJobs: new Counter({
    name: 'chatbot_background_jobs_total',
    help: 'Background jobs by type and outcome.',
    labelNames: ['type', 'outcome'] as const,
    registers: [registry],
  }),
  backgroundJobDuration: new Histogram({
    name: 'chatbot_background_job_duration_seconds',
    help: 'Background job duration by type.',
    labelNames: ['type'] as const,
    buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
    registers: [registry],
  }),
  gpasRequests: new Histogram({
    name: 'chatbot_gpas_request_duration_seconds',
    help: 'GPAS upstream calls by outcome.',
    labelNames: ['outcome'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [registry],
  }),
  workerLoopErrors: new Counter({
    name: 'chatbot_worker_loop_errors_total',
    help: 'Worker scheduling-loop steps that failed and were retried.',
    labelNames: ['step'] as const,
    registers: [registry],
  }),
  workerLoopLastSuccess: new Gauge({
    name: 'chatbot_worker_loop_last_success_timestamp_seconds',
    help: 'When the worker scheduling loop last completed a full iteration.',
    registers: [registry],
  }),
  retentionDeleted: new Counter({
    name: 'chatbot_retention_deleted_rows_total',
    help: 'Rows removed by the data retention job, by table.',
    labelNames: ['table'] as const,
    registers: [registry],
  }),
}

/** Gauges computed on scrape from live objects (pools, hubs). */
export function registerCollectedGauge(
  name: string,
  help: string,
  read: () => number,
): void {
  if (registry.getSingleMetric(name)) registry.removeSingleMetric(name)
  new Gauge({
    name,
    help,
    registers: [registry],
    collect() {
      this.set(read())
    },
  })
}

export function registerPoolMetrics(pool: { totalCount: number; idleCount: number; waitingCount: number }, options: { max: number }): void {
  registerCollectedGauge('chatbot_db_pool_connections', 'Open PostgreSQL pool connections.', () => pool.totalCount)
  registerCollectedGauge('chatbot_db_pool_idle', 'Idle PostgreSQL pool connections.', () => pool.idleCount)
  registerCollectedGauge('chatbot_db_pool_waiting', 'Queries waiting for a PostgreSQL pool connection.', () => pool.waitingCount)
  registerCollectedGauge('chatbot_db_pool_max', 'PostgreSQL pool size.', () => options.max)
}

export type HealthCheck = () => Promise<{ ok: boolean; detail?: Record<string, unknown> }>

/**
 * Internal HTTP server: GET /metrics for Prometheus, GET /healthz for the
 * container healthcheck (liveness). Port 0 disables it.
 */
export async function startMetricsServer(port: number, health?: HealthCheck): Promise<Server | null> {
  if (!port) return null
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/metrics') {
        response.writeHead(200, { 'content-type': registry.contentType })
        response.end(await registry.metrics())
        return
      }
      if (request.url === '/healthz') {
        const result = health ? await health() : { ok: true }
        response.writeHead(result.ok ? 200 : 503, { 'content-type': 'application/json' })
        response.end(JSON.stringify(result))
        return
      }
      response.writeHead(404).end()
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500)
      response.end(error instanceof Error ? error.message : 'metrics error')
    })
  })
  server.keepAliveTimeout = 5_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => resolve())
  })
  return server
}
