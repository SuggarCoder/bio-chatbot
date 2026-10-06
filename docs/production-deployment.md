# 生产部署清单

本版本默认采用 `Fastify API × 1 + Scheduler/Worker × 1`，连接池保持保守预算，可按真实数据库容量独立调整；模型并发数不等于数据库连接数。

## 破坏性数据库基线变更

本次只提供全新数据库基线，不支持从旧表结构迁移数据。上线前必须备份旧数据库，然后创建新的空数据库或空 `public` schema。初始化命令会检测现有 public 表并拒绝覆盖：

```bash
npm run db:init
```

初始化脚本为 `src/server/initDatabase.ts`，实际基线为 `drizzle/0000_multitenant_queue_baseline.sql`。首次初始化后，未来增量变更才使用 `npm run db:migrate`。

## 连接预算

| 进程 | PostgreSQL max | Redis 连接 |
|---|---:|---:|
| API | 20 | 2 |
| Worker | 16 | 2 |
| 迁移/运维预留 | 4 | 6 |

合计约 40，PostgreSQL `max_connections` 至少 50（默认 100 足够）。增加实例时必须重新计算数据库总连接预算。

## 容量设计（100 用户 × 每人 3 路 chat，上游 LLM 100 并发，8 核 16G）

峰值需求 300 路生成，上游只有 100 并发，因此**超出部分排队，不是全部同时执行**。上游 100 个许可静态切分：

| 类别 | 限额 | 闸门 |
|---|---:|---|
| 生成（智能体运行，每个运行同一时刻 1 个模型调用） | 96 | `GLOBAL/PROVIDER/MODEL_GENERATION_CONCURRENCY`（Redis 全局租约） |
| 后台（摘要/记忆） | 2 | `BACKGROUND_CONCURRENCY`（每 Worker 进程） |
| 余量 | 2 | — |

- 生成租约与后台闸门都在共享上游许可之前生效，只要 `生成 + 后台×Worker数 ≤ UPSTREAM_CONCURRENCY`，任何调用都不会在共享许可上等待或 60 秒超时；违反时启动日志会告警。API ingress 不调用模型。增加 Worker 实例时要按实例数重算。
- 每用户并发来自 `"User"."generationConcurrencyLimit"`，默认 3（迁移 `0005` 把仍为旧默认 1 的用户改为 3）。同一会话仍严格串行；用户第 4 路起排队（`maxQueuedGenerations` 默认 5）。
- 排队按用户加权轮转，单用户占满 3 路不会饿死其他用户。全局满载时 Worker 停止扫描，等有生成结束再调度。
- 身份解析按会话 Cookie 哈希在 Redis 缓存 `AUTH_CACHE_TTL_SECONDS`（默认 30 秒），避免每次轮询/SSE 都请求 GPAS 并 UPSERT `User`。代价：GPAS 侧注销后最多 30 秒内仍可访问；持久 ingress 执行前仍会用保存的 Cookie 重新校验身份。
- 本地合成压测（智能体模式，每条 1 次工具调用 + 1 次作答，mock LLM 15 秒/条、真实 PG/Redis/API/Worker/SSE、2 秒轮询、300 条在 1 秒内提交）：300/300 正确且仅含本人团队数据，GPAS 跨团队请求 0，生成峰值 96、单用户峰值 3、ingress 模型调用 0、无 429；首 token P50 27.1 秒 / P95 48.3 秒，全部完成 66.9 秒。排队时间约 `(排在前面的条数 / 96) × 平均运行时长`；运行时长随工具轮数增加。智能体设计见 [agent.md](agent.md)。

## 关键环境变量

```env
NODE_ENV=production
DATABASE_URL=postgresql://<user>:<password>@<host>:5432/<database>
API_PG_POOL_MAX=20
WORKER_PG_POOL_MAX=16

REDIS_URL=redis://<host>:6379/0
REDIS_KEY_PREFIX=gpas2cb:prod:v3:

GLOBAL_GENERATION_CONCURRENCY=96
PROVIDER_GENERATION_CONCURRENCY=96
MODEL_GENERATION_CONCURRENCY=96
GENERATION_TIMEOUT_MS=180000
GENERATION_LOCK_LEASE_MS=30000
GENERATION_LOCK_RENEW_INTERVAL_MS=10000
GENERATION_CANCEL_POLL_INTERVAL_MS=5000
GENERATION_SNAPSHOT_INTERVAL_MS=1000

QWEN_API_KEY=<secret>
QWEN_BASE_URL=<openai-compatible-base-url>
QWEN_MODEL=<model>
QWEN_TOKENIZER_PATH=/app/models/qwen-tokenizer
QWEN_CONTEXT_WINDOW_TOKENS=1000000
QWEN_MAX_INPUT_TOKENS=991808
QWEN_MAX_OUTPUT_TOKENS=40960

CHAT_HISTORY_TOKEN_BUDGET=131072
CHAT_SUMMARY_TOKEN_BUDGET=8192
SUMMARY_TRIGGER_TOKENS=16384
INSTRUCTIONS_TOKEN_BUDGET=32768
CONTEXT_MEMORY_ENABLED=false
USER_MEMORY_ENABLED=false

BACKGROUND_MODEL=qwen3.6-flash
BACKGROUND_MAX_OUTPUT_TOKENS=4096
BACKGROUND_CONCURRENCY=2
BACKGROUND_TIMEOUT_MS=120000

ARTIFACT_CONTEXT_V2_ENABLED=false
ARTIFACT_PATCH_ENABLED=false
EMBEDDING_MODEL_PATH=/app/models/bge-small-zh-v1.5

S3_ENDPOINT=http://host.docker.internal:8333
S3_ALLOW_INSECURE_HTTP=true

GPAS2_AUTH_MODE=upstream
GPAS2_USER_INFO_URL=https://<gpas-host>/api/gpas2/v1/user/info
```

不要配置旧变量 `GENERATION_DISCONNECT_GRACE_SECONDS`。SSE 断开永远不会自动取消后台 Generation。

## 构建和启动

生产机必须预先准备 `/home/lu/models`。该目录不属于 Git 工作区，不能使用符号链接，并由 Compose 只读挂载到 API 和 Worker 的 `/app/models`。目录至少包含：

```text
/home/lu/models/
├── qwen-tokenizer/
│   ├── tokenizer.json
│   └── tokenizer_config.json
└── bge-small-zh-v1.5/
    ├── config.json
    └── onnx/model_int8.onnx
```

当前 BGE INT8 ONNX 文件的 SHA-256 为 `b9837c19ce154ff0726d398ee77abbc03a7faf0476c6f93016c84e531be7ebb5`。部署工作流会在构建前校验模型文件、该摘要以及 tokenizer 的 `chat_template`。

生产镜像使用 Debian slim，以兼容 `onnxruntime-node` 发布的 Linux 原生库。Docker 构建设置 `ONNXRUNTIME_NODE_INSTALL=skip`，只使用 npm 包内自带的 CPU runtime，不下载 CUDA/TensorRT provider；构建阶段会实际加载一次该模块以提前发现原生库不兼容。

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

### 分层上下文上线顺序

1. 先执行 `npm run db:migrate`，确认 PostgreSQL 已启用 `vector` 扩展。
2. 在宿主机 `/home/lu/models` 放入与线上 Qwen 模型完全匹配的 tokenizer（至少包含 `tokenizer.json`、`tokenizer_config.json` 和 `chat_template`），并确认 BGE INT8 ONNX 文件存在且校验和正确。
3. 同时部署 API 与 Worker，先保持四个新功能开关为 `false`。
4. 依次开启 `CONTEXT_MEMORY_ENABLED`、`USER_MEMORY_ENABLED`、`ARTIFACT_CONTEXT_V2_ENABLED`，最后开启 `ARTIFACT_PATCH_ENABLED`。
5. 每一步都检查 `/ai-chatbot/api/health`：`embeddings` 和 `worker` 必须为 `ok`；普通聊天也强制做 token 预算检查，`tokenizer` 必须为 `ok`。BGE 现在还用于 API 的业务语义识别，因此即使所有上下文开关关闭，模型也必须可用。运行时只从宿主机只读挂载读取模型，禁止联网回退。

## 反向代理

必须保留 `/ai-chatbot/*` 路径和认证 Cookie，并为 SSE：

- 关闭代理缓冲与压缩聚合；
- 设置长 read timeout；
- 透传 `Last-Event-ID`；
- 不把浏览器断开转化为 Generation Cancel。

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


## 100 人同时在线：并发安全修订

本次目标是 **100 个已认证用户在线，突发提交可排队**，不是 100 路 LLM 同时生成或指定首字延迟 SLA。

### 必须执行的升级步骤

1. 备份数据库，执行 `npm run db:migrate`，新增 `0003_concurrency_safety` / `BusinessOperation`；不要重新执行 `db:init`。
2. API 和 Worker 都必须准备匹配模型的本地 Qwen tokenizer。普通聊天即使关闭记忆功能，也会加载 tokenizer 并裁剪旧上下文；最新用户消息本身超限会明确失败，不会被静默丢弃。
3. 更新 API 与 Worker。Compose 为这两个容器设置了每个 3 × 10 MiB 的日志上限；这不代替数据库、Redis、镜像缓存的容量管理。

### 当前边界

- 消息入口不调用模型。本地 embedding（仅在工具数超过 `AGENT_TOOL_LIMIT` 时加载）并发 2、等待上限 128，ONNX intra-op 线程 2 / inter-op 线程 1。
- 业务 HTTP 执行并发 8、等待上限 128。等待者不持有数据库连接。队列满返回 429。
- 消息入口先提交 `IngressRequest` 再返回 HTTP 202；工具选择、表单确认和创建生成由 API 内的持久任务处理器执行（默认 24 路）。内存队列仅作为执行资源限流，不再是用户请求唯一的保存位置。API 重启后恢复排队请求，租约过期后恢复执行中请求。
- Generation 的全局 / Provider / Model 并发默认 96；`UPSTREAM_CONCURRENCY`（默认 100）是所有生成和后台模型请求共享的 Redis 上限。另可配置共享 RPM 和保守 TPM 预留。
- 数据库池默认 API 20 + Worker 16（Compose）。短事务设置 statement timeout 5 秒、lock timeout 2 秒；是否扩大连接池必须结合真实 SQL 延迟与数据库总连接预算评估。
- Redis 离线快速失败，底层命令队列上限 2048，命令响应等待 2 秒。已发送命令超时并不表示未执行，所以队列/状态操作仍必须幂等。流事件最多积压 256 个，终态写流最多额外等待 2.5 秒，数据库最终内容是兜底。
- 每个活跃 Generation 的 SSE 数据库终态检查按约 5 秒节流，同一进程内多个标签页合并检查；正常依赖条件下通常下一轮轮询即可收尾。无需为每条 SSE 创建数据库或 Redis 专属连接。

### 业务创建的未知结果处理

`BusinessOperation` 使用短事务登记、事务外调用 GPAS、先保存返回结果、再短事务落消息：

- `running`：业务调用进行中；同一请求可等待/重试，同一会话禁止并发生成。
- `result_ready`：已保存上游结果。使用原请求标识重试可补齐消息，不再次调用 GPAS。
- `uncertain`：创建可能已在 GPAS 成功，但本地没有可靠结果。相同团队的新创建被拒绝，不能自动重放副作用。
- 进程崩溃留下的超时 `running` 写操作同样按未知结果处理，不因租约到期就再次创建。

管理员必须先在 GPAS 核对实际项目状态；必要时从新会话查询，以避开旧会话未完成的预留。只有确认旧调用已停止且结果明确后，才可通过受控运维流程把对应记录补为带结果的 `result_ready`（随后重试原请求），或确认未执行后标为 `failed`。不要盲目删除未知操作或重试创建。上游若提供正式幂等键，应进一步贯通该键，不能把本地事务误当成跨服务事务。

### 可重复的本地验证

```bash
npm test
npm run check
npm run db:check
npm run build

# 可选：只安装到忽略目录，不加入生产依赖；不连接生产数据库
npm install --prefix node_modules/.review-db --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.3.16
npm run test:concurrency-sql
```

SQL 测试使用 PostgreSQL/WASM + pgvector 执行真实迁移和查询，验证业务幂等、事务外 HTTP、未知结果保护、崩溃后结果恢复及 FIFO。HTTP 测试使用 100 个不同身份，分别同时提交 100 条普通聊天和 100 条业务查询，要求全部 202 且最终处理成功；模型、认证、GPAS 与 Redis 使用测试替身。这不是真实网络/磁盘/连接池性能压测。

另有 `src/server/concurrency.integration.test.ts`，配置专用 `TEST_DATABASE_URL` 后可运行真实 PostgreSQL 连接池测试。应预先迁移测试库，并用 `node --import tsx --test --test-concurrency=1 src/server/concurrency.integration.test.ts` 运行；禁止指向生产数据库。

### 生产容量验收仍需完成

在目标 8 核 16G 环境做 100 用户混合工作负载的持续测试，记录入口成功率、排队时间、首字时间、SQL/连接等待、事件循环延迟、RSS、Redis 内存与实际模型 RPM/TPM/429。分别覆盖慢 GPAS、Redis 中断、Worker 重启、SSE 重连、多标签页和长上下文。

40G 本地盘必须监控数据库/WAL、Redis 持久化、Docker 镜像与构建缓存。100T NFS 不等于无限 IOPS，也不会自动承接这些本地数据。持久历史数据仍需按业务保留政策归档；不能在不了解业务要求时自动删除。

结论：修订消除了本次审查的七项直接缺陷，并通过本地 100 用户接纳路径验证；是否达到生产延迟/吞吐目标，必须以真实依赖和磁盘布局的压测为准。


## 持久入口与扩容配置（2026-10）

### 上线顺序与密钥

1. 备份数据库，执行 `npm run db:migrate`，包含 `0003_concurrency_safety` 和 `0004_durable_ingress`；**已有本项目基线的数据库不要重建**。
2. 生成一次 `REQUEST_ENCRYPTION_KEY` 并放入部署环境文件，所有 API 实例保持相同，重启不得重新生成：
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
3. 先部署迁移，再同步部署 API/Worker/前端（发送消息接口返回 202 请求凭据）。
4. 密钥独立于数据库备份保管。Cookie 使用 AES-256-GCM 加密，绑定用户和请求 ID，任务终结时清除密文；恢复执行前重新验证登录身份和团队。登录失效会令任务失败，绝不绕过认证。轮换前排空待处理请求，不能直接替换仍有待处理请求使用的密钥。

### 接纳与恢复语义

- 仅在数据库提交成功后返回 202。此前网络断开不能宣称已接纳；前端对临时错误用**同一 Idempotency-Key**重试。相同 key 不同正文/会话返回 409。
- 已生成 Generation、已完成业务回复可重放。进行中的任务每 20 秒续租，90 秒未续租可被其他处理器接管；旧处理器不能覆盖新处理器结果。
- 每用户最多 10 个待处理入口请求，每会话同时 1 个。已创建的 Generation 仍按原来的持久队列/FIFO 调度。
- 临时错误最多执行 8 次并退避，排队请求超过 24 小时失败；无效登录、未知业务副作用等不盲目重试。它是至少一次任务调度 + 幂等提交，不是外部 GPAS 副作用的 exactly-once 保证。
- `GET /ai-chatbot/api/requests/:id` 只允许所属用户查看状态；重载会话通过 `/conversations/:chatId/requests` 找回待处理任务。浏览器等待最长 30 分钟，超时不取消后台任务。
- 请求记录保留用于去重，增加数据库容量占用；需纳入历史归档策略。不要直接删除幂等记录再重放旧 key。数据库持久化/WAL 和备份可靠性仍是前提。

### 并发与数据库连接分开配置

默认值按上面的容量设计（上游 100 并发）设定；上游配额不同时按比例调整：

```env
API_PG_POOL_MAX=20
WORKER_PG_POOL_MAX=16
AUTH_CACHE_TTL_SECONDS=30
INGRESS_CONCURRENCY=24
UPSTREAM_CONCURRENCY=100
UPSTREAM_REQUESTS_PER_MINUTE=0
UPSTREAM_TOKENS_PER_MINUTE=0
GENERATION_CANCEL_POLL_INTERVAL_MS=5000
```

- `PG_POOL_MAX` 已解除固定 4 限制，单进程接受 1–64。必须保证 `API实例数×API池 + Worker实例数×Worker池 + 运维预留 + 其他应用连接` 不超过数据库实际预算。若数据库仍只有 10 个连接，不要照抄 8+8。
- 取消优先 Redis Pub/Sub；Worker 默认每 5 秒对全部本地活动任务做一次批量数据库查询，正常流式增量不再每路每 300ms 查询。关键副作用/提交边界仍单独检查数据库。Redis 失效时取消可延迟约一个轮询周期加 SQL 时间。
- 所有模型调用共享并发/RPM/TPM 门控，流式调用占用许可直到流结束。不同进程必须连接同一 Redis 并使用相同 prefix 和限额；共享同一上游账号的其他应用也必须计入预算，否则此项目无法替它们限流。Redis 不可用时不绕过限制。
- RPM/TPM 为 0 表示该项不限制，不表示上游无限额。TPM 是滚动 60 秒的**请求 JSON UTF-8 字节数 + 输出 token 上限 + 1024**保守预留，不是精确计费；可能明显低于实际可用吞吐，且上游窗口规则未必相同，应留余量。单请求预留超过限额会被拒绝，不应只增加并发解决。
- 三项 `*_GENERATION_CONCURRENCY` 必须一起调整，只调一项无效；生成 + 后台之和不得超过 `UPSTREAM_CONCURRENCY`。
- 服务器上已有的 `.env` 若显式写了旧值（如 `GLOBAL_GENERATION_CONCURRENCY=4`、`UPSTREAM_CONCURRENCY=8`），会覆盖 Compose 新默认值，上线前要删除或改掉。
- 复现容量压测：`LOAD_SCENARIOS=target LOAD_CHATS_PER_USER=3 LOAD_POLL_MS=2000 LOAD_RAMP_MS=1000 LOAD_GENERATION_MS=15000 LOAD_API_PG_POOL=20 LOAD_WORKER_PG_POOL=16 node --import tsx tests/chat-load.mjs --run`（只创建并删除自己的临时库和 Redis 前缀）。

### 分级验证

```bash
npm run test:concurrency-stages
# 可选：专用测试 Redis，运行真实 Lua 预算用例（不要指向生产）
TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
```

本地 stages 使用 16/32/64/100 个独立用户，分别接纳聊天及业务请求，并检查重启前落盘、过期租约接管、旧持有者隔离与凭证清除。使用 PGlite 和假上游，不会访问生产；前提是按前文安装本地 PGlite 测试依赖。

生产验收必须由可访问目标主机的人员执行同样的 16→32→64→100 阶梯，并覆盖持续生成而非仅排队接纳。观察 RSS/事件循环延迟、数据库连接等待和慢查询、NFS 延迟、模型 RPM/TPM/429、排队与首字 P95、任务恢复和取消延迟；任一阶段恶化停止升级。8 核/16G/40G/100T 的容量描述本身不能证明性能 SLA。
