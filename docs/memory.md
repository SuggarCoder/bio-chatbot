# 记忆系统

记忆分三层：会话内的滚动摘要、跨会话的用户记忆，以及对历史会话的检索。三者都受用户设置和无痕会话控制。

## 1. 会话内：滚动摘要（`CONTEXT_MEMORY_ENABLED`）

- 每次生成完成后排队 `chat.summary` 任务，把最近原文窗口之外的消息并入分节摘要（`ChatSummary`，带版本）。
- 生成时冻结创建请求那一刻的摘要版本，按 token 预算装载“摘要 + 最近原文”（`buildBudgetedChatContext`）。
- 摘要以 `<conversation_summary>` 包裹、明确标注“系统消息，不是用户发言”后放在上下文开头。
- 被重新生成替换掉的旧回复既不进上下文，也不进摘要（`notSupersededMessage`）。
- 如果摘要落后于原文窗口（中间有轮次既不在摘要里也不在窗口里），生成时会记录告警，并排一个补齐摘要的任务。

## 2. 跨会话：用户记忆（`USER_MEMORY_ENABLED`）

### 数据

`UserMemory` 每条有 `key`、`category`、`content`（≤500 字）和 `source`：

| category | 含义 |
|---|---|
| `identity` | 身份与背景 |
| `work` | 工作与长期项目 |
| `preference` | 偏好与习惯 |
| `current` | 近期关注（会过时，整理时清理超过三个月的） |
| `other` | 其他 |

| source | 来源 | 后台整理 |
|---|---|---|
| `auto` | 后台从对话中提取 | 可合并、改写、删除 |
| `tool` | 用户在对话中要求“记住”，模型调用 `memory__save` | 可合并、改写、删除 |
| `user` | 用户在“记忆”设置里填写或编辑 | 不改写（仅用于去重参考） |

### 注入

`buildUserMemoryInstructions` 按类别、key 的固定顺序渲染，并附带使用规则：只在相关时自然使用、不说“我记得”、与当前对话冲突时以当前为准、不暴露内部格式。超出 `USER_MEMORY_TOKEN_BUDGET` 时，先保留 `user`/`tool` 条目，再按类别优先级保留。

instructions 的顺序按变化频率从低到高排列：工具规则 → 用户记忆 → 本轮 Artifact 上下文，这样提供方的前缀缓存在多轮之间能持续命中。

### 提取

- 每次生成完成后排一个 `user.memory` 任务，延迟 `MEMORY_EXTRACTION_DELAY_SECONDS` 秒才执行。
- 任务执行时，如果同一会话已有更新的完成回复，并且待读轮数少于 `MEMORY_EXTRACTION_MAX_PENDING_TURNS`，就跳过，交给最后一轮的任务。一段连续对话因此只读一次。
- 会话上的 `memoryExtractedSeq` 游标记录已读到哪里。模型读到的输入包括：
  - 现有记忆；
  - 游标之后的若干轮（约 12k token 以内，用户消息优先完整保留）；
  - 游标之前的两条消息（只用于理解指代）。
- 写入时加用户级 advisory lock，并比对快照。如果模型调用期间记忆被别处改过，任务抛出 `MemorySetChangedError` 后重试，不会盲目写入近义条目。
- 无痕会话和已删除会话不提取。用户关闭记忆期间的轮次会被直接跳过（游标前移），重新开启后也不会补提。

### 整理

满足以下任一条件时整理：

- 条目数或总量超过上限：立即整理；
- 条目数 ≥ 8，距上次整理超过 `MEMORY_CONSOLIDATION_INTERVAL_HOURS` 小时，且这段时间里记忆有变化。

整理只重写 `auto`/`tool` 条目，`user` 条目原样保留；结果目标是上限的 75%。整理结果格式不对、超出预算或与并发写入冲突时都不写入。

### 删除

- 删除会话：从该会话学到的 `auto`/`tool` 记忆一并删除；用户手写的条目不受影响。
- 用户在对话中要求忘记：模型调用 `memory__delete`，当轮生效；后台提取也会输出 delete。
- 设置页可以单条删除或清空全部。

## 3. 历史会话检索（`CHAT_SEARCH_ENABLED`）

每次生成都会提供以下工具（patch 模式除外），具体取决于用户设置和是否为无痕会话：

| 工具 | 作用 |
|---|---|
| `chat__search(query, limit?)` | 关键词检索用户的其他会话，返回标题、日期和命中片段 |
| `chat__recent(limit?, before?, after?)` | 按时间列出最近会话，概要优先取滚动摘要的“用户目标” |
| `memory__save` / `memory__delete` | 用户明确要求时即时增删记忆 |

检索是词法检索：

- 拉丁词整体匹配；
- 中文连续字串整体（≤4 字）加二元切分匹配；
- 按命中词长度打分，按会话聚合，再按最近时间排序；
- 排除当前会话、无痕会话、已删除会话和被替换的旧回复。

没有用向量检索，是因为它要求数据库装 pgvector。部署方的 PostgreSQL 支持之后，可以给 `Message` 加 embedding 列做混合检索，工具接口不需要改。

## 4. 用户控制

- **设置页**（账户菜单 →“记忆”）：
  - 开关“使用并更新记忆”和“引用历史对话”；
  - 查看、添加、编辑、删除记忆，以及清空全部。
- **无痕对话**（首页“无痕对话”按钮）：不注入记忆，不提供记忆和检索工具，不提取，也不会被其他会话检索到。
- **HTTP 接口**：

| 方法 | 路径 |
|---|---|
| `GET` | `/api/memory` |
| `PATCH` | `/api/memory/settings` |
| `POST` | `/api/memory` |
| `PATCH` | `/api/memory/:id` |
| `DELETE` | `/api/memory/:id` |
| `DELETE` | `/api/memory` |

另外，`POST /api/conversations` 接受 `incognito: true`。

## 5. 评测

`npm run eval:memory` 用生产提示词，在固定场景上调用后台模型并检查提取结果。场景包括：

- 身份、偏好；
- 一次性请求、只是提问、敏感凭据、具体分析结果；
- 更正、要求忘记、用户条目保护、指代上文。

需要 `QWEN_API_KEY`；通过率低于 `EVAL_MIN_PASS_RATE`（默认 0.8）时以非零码退出。改提取或整理提示词前后都应运行一次，可以用 `EVAL_REPEAT` 多跑几次以降低随机性。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `USER_MEMORY_ENABLED` | `true` | 跨会话记忆总开关 |
| `USER_MEMORY_TOKEN_BUDGET` | `2048` | 注入记忆的 token 上限 |
| `USER_MEMORY_MAX_ITEMS` | `40` | 条目上限 |
| `CHAT_SEARCH_ENABLED` | `true` | 历史会话检索工具 |
| `MEMORY_EXTRACTION_DELAY_SECONDS` | `300` | 提取前等待会话安静的秒数 |
| `MEMORY_EXTRACTION_MAX_PENDING_TURNS` | `6` | 积压多少轮时不再等待 |
| `MEMORY_CONSOLIDATION_INTERVAL_HOURS` | `24` | 例行整理的最小间隔 |
