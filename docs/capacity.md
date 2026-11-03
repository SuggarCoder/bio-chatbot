# 容量模型（单机，目标约 100 人同时在线）

本文给出每种资源的上限、实测数据，以及何时需要扩容。数据保留见 [data-retention.md](data-retention.md)，运维操作见 [operations.md](operations.md)。

## 1. 资源模型

| 资源 | 上限 | 由谁限制 | 饱和时的表现 |
|---|---|---|---|
| 同时进行的生成 | 96（全局） | Redis 全局租约（`*_GENERATION_CONCURRENCY`） | 超出的生成按用户加权轮转排队，单用户最多 3 路 |
| 上游模型并发 | 100 | `UPSTREAM_CONCURRENCY`（生成 96 + 后台 2×2） | 不会在共享许可上等待 |
| 单次生成的字节量 | 8 MiB | `GENERATION_MAX_BYTES` | 按长度上限结束，已生成文本保留 |
| PostgreSQL 连接 | 2×12 + 2×12 = 48 | `API/WORKER_PG_POOL_MAX` | 等待连接；持续饱和超过 1 s 时，API 对新请求返回 503 |
| API 事件循环 | p99 不超过 500 ms | 负载保护（连续 2 s 超限才触发） | 新请求返回 503，并带 `Retry-After: 2`，前端会退避重试 |
| 每进程会话检索 | 同时 4 个，单次 1.5 s | `SearchSlots` 和 `statement_timeout` | 检索返回"繁忙"，对话照常进行 |
| GPAS 调用 | 并发 32，排队 64，熔断器 | `GpasGuard` | 快速失败，15 s 后熔断器半开试探 |
| 消息页、分享页 | 2 MiB 且不超过 50/100 条 | `MESSAGE_PAGE_MAX_BYTES` | 分页加载 |
| Redis 内存 | 1 GB（`noeviction`） | redis.conf | 写入失败时返回 503，告警阈值 70% |
| 进程堆 | 1536 MiB | `NODE_HEAP_MB`，容器内存上限 2–3 GB | 堆用到 80% 时告警 |

## 2. 实测（本地，假模型，真实 PostgreSQL、Redis、API、worker 和 SSE）

测试命令：

```bash
LOAD_SCENARIOS=target LOAD_CHATS_PER_USER=3 LOAD_POLL_MS=2000 LOAD_RAMP_MS=1000 \
LOAD_GENERATION_MS=15000 LOAD_API_PG_POOL=12 LOAD_WORKER_PG_POOL=12 \
node --import tsx tests/chat-load.mjs --run
```

测试场景：100 个用户 × 每人 3 个会话，共 300 个请求，在 1 秒内全部提交。每个回复耗时 15 秒，测试使用单个 API 进程和单个 worker。

| 指标 | 结果 |
|---|---|
| 成功率 | 300/300 成功，无丢失、无串号（跨团队调用 0 次），上游 429 为 0 |
| 并发 | 生成峰值 96，单用户峰值 3 |
| 受理（202）时间 | p50 627 ms，p95 1.04 s |
| 首 token 时间 | p50 20.0 s，p95 36.4 s，最大 48.9 s。超过 96 路的部分在排队，排队时间约为（前面排队的条数 ÷ 96）× 15 s |
| 全部完成用时 | 63.6 s |
| SSE 连接峰值 | 204 |
| API 连接池等待峰值 | 92。突发排队不到 1 秒，未触发负载保护 |
| 与旧配置对比 | 旧配置连接池为 20/16、没有增量合并：首 token p50 27.1 s、p95 48.3 s，总用时 66.9 s |

负载保护曾经的问题：第一版负载保护在同样的突发下错误地拒绝了 124 个请求。改为"持续饱和才拒绝"后为 300/300，上表即为改后数据。

其他已验收的边界（均有自动化测试守护）：

| 项目 | 结果 | 守护测试 |
|---|---|---|
| 流式增量合并 | 300 个模型增量合并成不到 75 条 Redis 记录，回放后文本完全一致 | generation.integration |
| 消息页 | 20 条约 400 KB 的消息分页返回，每页不超过 2.2 MiB；单条超大消息单独成页 | budgets.integration |
| 分享页 | 250 条消息分 3 页返回，顺序正确、不重不漏 | budgets.integration |
| 读页内存 | 连续读 200 页，堆增长不超过 8 MiB | budgets.integration |
| 检索并发 | 第 3、4 个并发检索在等待 50 ms 后被拒绝，空出名额后恢复 | budgets.integration |
| 负载保护 | 短暂排队不触发；排队持续 1 s 以上才触发，排队消失后立即恢复 | loadShed、app |
| 故障注入 | Redis 冻结、Redis 清空重启、PostgreSQL 断连、生成中途 Redis 冻结、SIGTERM 排空、第二个 worker 接管：15/15 通过 | `npm run test:faults` |
| 数据保留 | 过期行分批删除，用量汇总不重复计数，30 天前删除的会话被级联清除 | stability.integration |

## 3. 何时扩容

| 信号（Grafana 或告警） | 含义 | 动作 |
|---|---|---|
| `chatbot_generation_queued` 持续大于 50，且首 token p95 超过 30 s | 上游并发是瓶颈 | 提高上游配额，并同步调整三项 `*_GENERATION_CONCURRENCY` 和 `UPSTREAM_CONCURRENCY` |
| ApiLoadShedding 持续触发，且原因是 `db_pool` | 数据库慢或连接池不足 | 先查慢查询；再把 `API_PG_POOL_MAX` 调到 16–20，并核算连接预算 |
| ApiLoadShedding 触发，且原因是 `event_loop` | API 的 CPU 不够 | 增加第三个 API 实例（compose 中复制 app-2，并在 nginx upstream 中加入） |
| 单用户检索分块超过约 5 万 | 精确扫描变慢 | 为 MessageChunk.embedding 建 HNSW 索引 |
| 单表超过约 5000 万行，或保留任务清不完 | 表太大 | 按 data-retention.md 第 3 节分区 |
| 用户超过约 300 人同时在线 | 超出单机设计 | PostgreSQL 独立部署并配主从，Redis 独立部署，API 和 worker 横向扩容（代码无需改动：状态都在 PostgreSQL 和 Redis 中） |
