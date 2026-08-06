# 生产部署清单

本版本采用 `Fastify API × 1 + Scheduler/Worker × 1`。PostgreSQL 和 Redis 均按总连接数约 10 的环境设计。

## 破坏性数据库基线变更

本次只提供全新数据库基线，不支持从旧表结构迁移数据。上线前必须备份旧数据库，然后创建新的空数据库或空 `public` schema。初始化命令会检测现有 public 表并拒绝覆盖：

```bash
npm run db:init
```

初始化脚本为 `src/server/initDatabase.ts`，实际基线为 `drizzle/0000_multitenant_queue_baseline.sql`。首次初始化后，未来增量变更才使用 `npm run db:migrate`。

## 连接预算

| 进程 | PostgreSQL max | Redis 连接 |
|---|---:|---:|
| API | 4 | 2 |
| Worker | 4 | 2 |
| 迁移/运维预留 | 2 | 6 |

不要在增加实例数量时继续为每个实例配置 `PG_POOL_MAX=4`，必须重新计算数据库总连接预算。

## 关键环境变量

```env
NODE_ENV=production
DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<database>
API_PG_POOL_MAX=4
WORKER_PG_POOL_MAX=4

REDIS_URL=redis://<host>:6379/0
REDIS_KEY_PREFIX=gpas2cb:prod:v3:

GLOBAL_GENERATION_CONCURRENCY=4
PROVIDER_GENERATION_CONCURRENCY=4
MODEL_GENERATION_CONCURRENCY=4
GENERATION_TIMEOUT_MS=180000
GENERATION_LOCK_LEASE_MS=30000
GENERATION_LOCK_RENEW_INTERVAL_MS=10000
GENERATION_CANCEL_POLL_INTERVAL_MS=300
GENERATION_SNAPSHOT_INTERVAL_MS=1000

QWEN_API_KEY=<secret>
QWEN_BASE_URL=<openai-compatible-base-url>
QWEN_MODEL=<model>

GPAS2_AUTH_MODE=upstream
GPAS2_USER_INFO_URL=https://<gpas-host>/api/gpas2/v1/user/info
TRUSTED_PROXY_CIDRS=<direct-proxy-ip-or-cidr>
```

不要配置旧变量 `GENERATION_DISCONNECT_GRACE_SECONDS`。SSE 断开永远不会自动取消后台 Generation。

## 构建和启动

```bash
npm ci
npm test
npm run check
npm run db:check
npm run build

docker compose --env-file /secure/path/bio-chatbot.env build app
docker compose --env-file /secure/path/bio-chatbot.env run --rm app node dist/server/initDatabase.js
docker compose --env-file /secure/path/bio-chatbot.env up -d app worker
```

`db:init` 只能执行一次。API 和 Worker 都只校验 schema，不会在启动时并发执行迁移。

## 反向代理

必须保留 `/ai-chatbot/*` 路径和认证 Cookie，并为 SSE：

- 关闭代理缓冲与压缩聚合；
- 设置长 read timeout；
- 透传 `Last-Event-ID`；
- 不把浏览器断开转化为 Generation Cancel；
- 只信任 `TRUSTED_PROXY_CIDRS` 中直接连接 Fastify 的代理。

应用响应已设置 `X-Accel-Buffering: no`，并每 15 秒发送 SSE heartbeat。

## 上线验收

1. `/ai-chatbot/api/health` 返回 PostgreSQL、Redis、Worker 为 `ok`。
2. 无 GPAS2 Cookie 的受保护请求返回 401；有效 Cookie 返回当前 User。
3. 使用同一个 `Idempotency-Key` 重试发送消息，不产生重复消息或 Generation。
4. 同一会话连续提交多条消息，Assistant 回答按 `seq` 串行完成。
5. 两个不同 User 同时排队时，低权重 User 不会被高权重 User 永久阻塞。
6. 生成中刷新页面，Worker 继续运行，浏览器用 `Last-Event-ID` 恢复。
7. 点击 Stop 后 PostgreSQL 最终为 `cancelled`，部分回答刷新后仍可读取。
8. 杀死未调用 Provider 的 Worker 后任务重新排队；杀死已调用 Provider 的 Worker 后任务变为 `interrupted`，不会自动重复调用。
9. Redis Stream 过期后，completed/cancelled/failed 结果仍由 PostgreSQL 返回。
10. 分享链接只有已认证用户可读取，撤销立即生效，读取产生审计记录。

若启用 Artifact Protocol，还必须按 [object-storage.md](object-storage.md) 完成私有 S3/SeaweedFS 校验。
