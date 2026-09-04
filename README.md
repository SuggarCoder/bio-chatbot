# bio-chatbot

基于 SolidJS、Fastify、PostgreSQL、Redis Streams 和 OpenAI Compatible API 的多用户 Chatbot。

## 架构约束

- `User` 同时是身份主体和租户边界，不存在独立 Tenant 表，也不接受客户端传入的 userId。
- PostgreSQL 保存会话、消息、Generation、最终/部分回答、用量、错误、Outbox 和审计记录，是最终事实来源。
- Redis 仅保存按用户队列、公平调度状态、并发租约、取消信号、临时快照和可过期的流事件。
- API 与 Worker 分进程运行。同一会话一次只运行一个 Generation。
- SSE 断开只结束订阅；只有取消接口才会停止后台 Generation。
- 流式 Delta 不写 PostgreSQL。Generation 结束时一次性更新 Assistant 占位消息。

## 本地开发

需要 Node.js 22、PostgreSQL 15+ 和 Redis。复制 `.env.example` 为 `.env` 并填写连接信息和 `QWEN_API_KEY`。

本次数据库是全新基线，不提供旧结构数据迁移。首次使用必须指定一个空的 `public` schema：

```bash
npm ci
npm run db:init
npm run dev
```

`npm run dev` 同时启动 Vite、Fastify API 和独立 Worker。也可以分别运行：

```bash
npm run dev:web
npm run dev:api
npm run dev:worker
```

- Web：`http://127.0.0.1:5173/ai-chatbot/`
- API：`http://127.0.0.1:8090/ai-chatbot/api`
- 健康检查：`GET /ai-chatbot/api/health`

健康检查只有在 PostgreSQL、Redis 和 Worker 心跳均正常时才返回成功；启用对象存储后也会校验对象存储。

## 核心 API

```text
GET    /api/conversations
POST   /api/conversations
GET    /api/conversations/:conversationId
POST   /api/conversations/:conversationId/messages
GET    /api/generations/:generationId
GET    /api/generations/:generationId/stream
POST   /api/generations/:generationId/cancel
POST   /api/conversations/:conversationId/share
DELETE /api/conversations/:conversationId/share
GET    /api/shared/conversations/:shareSlug
```

发送消息和重新生成必须提供 UUID 格式的 `Idempotency-Key`。SSE 恢复使用标准 `Last-Event-ID`，其值是 Redis Stream ID，例如 `1785930000000-0`。

## 数据库与运行进程

- `src/server/db/schema.ts`：Drizzle 数据模型。
- `drizzle/0000_multitenant_queue_baseline.sql`：空库初始化基线。
- `src/server/initDatabase.ts`：拒绝非空 public schema 的初始化入口。
- `src/server/index.ts`：API/SSE 进程。
- `src/server/worker.ts`：Outbox Dispatcher、公平调度、租约恢复和 LLM Worker。

初始化后新增的向前迁移使用 `npm run db:migrate`。修改 schema 后运行 `npm run db:generate` 和 `npm run db:check`。

默认 PostgreSQL 连接预算为 API 4、Worker 4、迁移/运维预留 2。Redis 使用进程级普通连接和进程级 Subscriber，不会为每个 SSE 客户端创建 Redis Client。

## 身份与共享

生产环境身份仍来自 GPAS2 Cookie 和 `/user/info`。`externalUserId` 映射到 PostgreSQL `User.id`；现有用户字段和登录方式保持不变。调度等级、权重、并发和最大排队数保存在同一 User 记录中。

普通会话接口只允许所有者访问。跨用户读取必须由所有者显式创建 `authenticated` 分享链接；分享读取仍要求已认证，并写入审计日志。附件不继承会话分享权限。

## 验证

```bash
npm test
npm run check
npm run db:check
npm run build
```

部署、连接预算和故障验收见 [生产部署清单](docs/production-deployment.md)，取消与恢复语义见 [Generation lifecycle](docs/generation-cancellation.md)，Redis Key 规范见 [Redis design](redis.md)。

## 分层会话与 Artifact 上下文

新上下文管线由独立开关渐进启用：

- `CONTEXT_MEMORY_ENABLED`：按 token 预算装载最近原文，并注入创建请求时冻结的滚动摘要版本。
- `USER_MEMORY_ENABLED`：异步提取稳定的跨会话事实；总注入量不超过 2 KiB。
- `ARTIFACT_CONTEXT_V2_ENABLED`：小 Artifact 附全文，大 Artifact 附结构大纲和相关区块；区块向量使用本地 BGE 模型和 pgvector。
- `ARTIFACT_PATCH_ENABLED`：大于等于 32 KiB 的 Artifact 只接受唯一匹配的 SEARCH/REPLACE 补丁，应用后执行语法校验；失败会带校验错误自动重试一次。

这些开关默认关闭。启用前先执行 `npm run db:migrate` 并部署 Worker。模型文件不进入 Git 仓库或 Docker 镜像；生产机必须提前准备 `/home/lu/models`，Compose 会将其只读挂载到容器的 `/app/models`。其中 Qwen tokenizer 位于 `/home/lu/models/qwen-tokenizer`，必须与线上模型完全匹配且包含 `chat_template`；BGE INT8 模型位于 `/home/lu/models/bge-small-zh-v1.5/onnx/model_int8.onnx`。服务只读取本地挂载，不会在运行时联网下载模型。

Artifact 历史版本不会被覆盖。`POST /api/artifacts/:artifactId/versions/:version/restore` 使用 UUID 格式的 `Idempotency-Key`，把旧快照复制为新的当前版本。
