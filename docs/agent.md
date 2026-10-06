# 智能体与 GPAS 工具

所有普通聊天消息都是一次智能体运行：模型在 Worker 的生成租约内，按需调用已注册的 GPAS 工具，再基于工具结果作答。没有单独的 LLM 语义规划步骤。

## 流程

```text
POST /conversations/:chatId/messages  → IngressRequest（持久，返回 202）
  API ingress：校验身份与会话 → 选出本次可用工具 → 加密保存本次 Cookie → 创建 Generation
  Worker（生成租约内，每个运行同一时刻最多 1 个模型调用）：
    第 n 轮：Qwen Responses（tools=本次工具）→ function_call?
      是 → 服务端校验参数 → 用本人 Cookie 执行工具 → ToolRun 审计 → function_call_output → 下一轮
      否 → 流式回答，结束
    工具次数达到 AGENT_MAX_TOOL_CALLS 后，下一轮 tool_choice=none，强制基于已有结果作答
  结束：清除加密 Cookie；确认类工具的表单作为 gpas part 附在回答后
表单确认（projectInput）→ 业务提交（幂等，模型永远不能触发）
```

## 用户隔离

- **身份只来自服务端**：工具上下文（profile、Cookie）由服务端注入。`defineGpasTool` 拒绝 `teamId`、`projectCode`、`userId`、`cookie` 等身份参数；团队等身份参数只能从 `ctx.profile` 取。
- **会话校验**：Worker 用本次请求的 Cookie 重新获取 GPAS 资料，必须与 Generation 所属用户、团队一致，否则工具返回错误。
- **凭据**：Cookie 以 AES-256-GCM（`REQUEST_ENCRYPTION_KEY`）加密存于 `Generation.credential`，AAD 绑定 `userId:generationId`，Generation 终结时清空，永不进入模型提示词、日志或 Redis。
- **工具白名单**：只提供 ingress 选出的工具；模型调用清单外的名称会被拒绝。参数用工具的 zod schema 校验。
- **写操作**：`prepare_confirmation` 工具只返回表单，真正创建只走用户点击确认后的幂等业务路径。
- **审计**：每次工具调用写 `ToolRun`（用户、生成、工具、校验后的参数、结果字节数、错误），不保存结果数据。

## 新增一个 GPAS 接口

1. 在 `src/server/gpas/tools/` 新建规格文件，用 `defineGpasTool` 声明 `input`（zod 业务参数）、`run`（用 `ctx.client.read` 调 GPAS，身份从 `ctx.profile` 取）、`toModel`（给模型的精简结果）、`toReply`（给用户的完整回复 / 表单）。
2. 加入 `src/server/gpas/tools/index.ts`。
3. 写一个用 mock GPAS 的契约测试（参考 `src/server/agentTools.test.ts`、`gpasTools.test.ts`）。

循环、队列、隔离规则都不需要改。不支持的操作在 `capabilities/gpas.ts` 里登记为 `unsupported` 策略，模型会按策略说明拒绝。

## 配置

| 变量 | 默认 | 说明 |
|---|---:|---|
| `AGENT_MAX_TOOL_CALLS` | 4 | 每次回答最多工具调用数；模型调用 ≤ 该值 + 1 |
| `AGENT_TOOL_LIMIT` | 8 | 每次运行提供的工具上限。工具总数不超过它时全部提供，且**不加载本地 BGE 模型**（健康检查 `embeddings: not_required`）；超过时用 BGE 召回最相关的工具 |

给模型的单个工具结果上限 8 KB，超出截断并注明；完整数据由前端展示。

## 容量

- 每个运行同一时刻最多一个模型调用，所以 1 个生成槽 = 1 个上游许可：`GLOBAL_GENERATION_CONCURRENCY(96) + BACKGROUND_CONCURRENCY(2) ≤ UPSTREAM_CONCURRENCY(100)`。不要在循环中引入并行模型调用或子智能体，否则需重算预算。
- 每次回答 K 轮模型调用时，单个生成槽占用时间约 ×K；吞吐取决于上游并发和轮数，不取决于 8 核 16G（运行期主要在等待网络 I/O）。
- 合成压测（100 用户 × 3 会话，每条一次工具调用）：`LOAD_SCENARIOS=target LOAD_CHATS_PER_USER=3 LOAD_POLL_MS=2000 LOAD_RAMP_MS=1000 LOAD_GENERATION_MS=15000 LOAD_API_PG_POOL=20 LOAD_WORKER_PG_POOL=16 node --import tsx tests/chat-load.mjs --run`。

## 验证

- `npm test`：工具规格、身份字段拒绝、白名单、参数校验、身份不匹配、表单不触发创建、结果截断、凭据 AAD 绑定。
- `npm run test:concurrency-sql`：100 用户提交，ingress 不调用任何模型。
- `tests/chat-load.mjs`：真实 PG/Redis/API/Worker/SSE + 模拟 Qwen 与 GPAS，断言每个回答只含本人团队数据、GPAS 无跨团队请求、每次工具调用有审计、凭据已清除。
