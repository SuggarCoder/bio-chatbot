import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  initMetrics,
  registerCollectedGauge,
  registerPoolMetrics,
  registry,
  startMetricsServer,
} from './metrics.js'
// Importing these registers the metrics they define.
import './cache.js'
import './gpas/client.js'
import './generation.js'

/** Metric names in alert rules and the dashboard must exist, or they silently never fire. */
function referencedMetricNames(): Set<string> {
  const sources = [
    readFileSync('deploy/monitoring/alerts.yml', 'utf8'),
    readFileSync('deploy/monitoring/grafana/dashboards/chatbot-overview.json', 'utf8'),
  ].join('\n')
  const names = new Set<string>()
  for (const match of sources.matchAll(/\bchatbot_[a-z0-9_]+/g)) {
    names.add(match[0].replace(/_(bucket|count|sum)$/, ''))
  }
  return names
}

test('backup metrics referenced by alerts are written by the backup job', () => {
  const script = readFileSync('deploy/backup/backup.sh', 'utf8')
  const backupNames = [...referencedMetricNames()].filter((name) => name.startsWith('chatbot_backup_'))
  assert.ok(backupNames.length >= 3)
  assert.deepEqual(backupNames.filter((name) => !script.includes(`${name} $(`)), [])
})

test('every metric referenced by alerts and the dashboard is exported', async () => {
  initMetrics('api')
  registerPoolMetrics({ totalCount: 1, idleCount: 1, waitingCount: 0 }, { max: 4 })
  registerCollectedGauge('chatbot_sse_subscribers', 'test', () => 0)
  const exported = new Set((await registry.getMetricsAsJSON()).map((metric) => metric.name))
  // chatbot_backup_* come from the backup job via node-exporter's textfile collector.
  const missing = [...referencedMetricNames()].filter((name) => !name.startsWith('chatbot_backup_') && !exported.has(name))
  assert.deepEqual(missing, [])
})

test('the metrics server serves /metrics and /healthz', async () => {
  let healthy = true
  const server = await startMetricsServer(19_000 + Math.floor(Math.random() * 1_000), async () => ({ ok: healthy }))
  assert.ok(server)
  const port = (server.address() as { port: number }).port
  try {
    const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics`)
    assert.equal(metricsResponse.status, 200)
    assert.match(await metricsResponse.text(), /chatbot_generations_active/)
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200)
    healthy = false
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 503)
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404)
  } finally {
    server.close()
  }
})
