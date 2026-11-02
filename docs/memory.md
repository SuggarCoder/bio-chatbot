# 记忆系统

记忆分三层：会话内的滚动摘要、跨会话的用户记忆，以及对历史会话的检索。跨会话记忆和检索都受用户的“使用记忆”开关控制。

## 1. 会话内：滚动摘要（`CONTEXT_MEMORY_ENABLED`）

- 每次生成完成后排队 `chat.summary` 任务，把最近原文窗口之外的消息并入分节摘要（`ChatSummary`，带版本）。
- 生成时冻结创建请求那一刻的摘要版本，按 token 预算装载“摘要 + 最近原文”（`buildBudgetedChatContext`）。
- 摘要以 `<conversation_summary>` 包裹、明确标注“系统消息，不是用户发言”后放在上下文开头。
- 被重新生成替换掉的旧回复既不进上下文，也不进摘要（`notSupersededMessage`）。
- 如果摘要落后于原文窗口（中间有轮次既不在摘要里也不在窗口里），生成时会记录告警，并排一个补齐摘要的任务。

## 2. 跨会话：用户记忆（`USER_MEMORY_ENABLED`）

### 分层与老化

参照 claude.ai 的记忆：一份长期有效、随时更新的用户画像，一层跟随“最近在忙什么”变化的近期关注，再加上一段会淡出的近期对话历史；完整对话始终可以通过检索找回。所有参数集中在 `src/server/memoryPolicy.ts`。

| 层 | category | 内容 | 生命周期 |
|---|---|---|---|
| 长期画像 | `identity` 身份与背景、`work` 工作与长期项目、`preference` 偏好与习惯、`other` | 职业、单位、研究方向、长期课题、回答风格、常用工具 | 不过期。信息变化时原地更新；被新信息推翻、用户要求忘记、来源会话被删除时移除；定期整理会合并改写 |
| 近期关注 | `current` | 这几周在做的事：在赶的一批样本、在准备的论文或汇报 | 最后一次被提及后 **30 天**过期。之后的对话再次提到时由提取输出 `touch` 续期。被 **3 个不同会话**提到、并且存在满 **14 天**的，自动升级为 `work`，不再过期 |
| 近期对话 | `episode` | 每个会话一条概要（讨论了什么、结论、待办），随对话进展更新 | 会话最后活跃后 **14 天**内注入（最多 5 条，不含当前会话），**60 天**后删除。更早的细节通过 `chat__search` 查找 |

**时间字段：**

| 字段 | 含义 |
|---|---|
| `lastSeenAt` | 最后一次被对话确认的时间 |
| `reinforcedCount` | 有多少个不同会话确认过 |
| `expiresAt` | 过期时间，长期画像为 null |

所有读取都会过滤已过期的条目，所以过期即时生效。Worker 每 10 分钟物理删除一次过期行。

**来源（`source`）：**

| source | 来源 | 后台整理 |
|---|---|---|
| `auto` | 后台从对话中提取 | 可合并、改写、删除 |
| `tool` | 用户在对话中要求“记住”，模型调用 `memory__save` | 可合并、改写、删除 |
| `user` | 历史遗留（用户手写条目，界面已不再提供） | 不改写（仅用于去重参考） |

### 注入

`buildUserMemoryInstructions` 先列长期画像，再列近期关注，最后列近期对话（带日期，新的在前）。每节按固定顺序渲染，并附带使用规则：

- 只在相关时自然使用，不说“我记得”；
- 与当前对话冲突时以当前为准，近期信息拿不准时向用户确认；
- 不暴露内部格式。

超出 `USER_MEMORY_TOKEN_BUDGET` 时，依次保留 `user`/`tool` 条目、长期画像、近期关注，近期对话最先被舍弃。

instructions 的顺序按变化频率从低到高排列：工具规则 → 用户记忆 → 本轮 Artifact 上下文，这样提供方的前缀缓存在多轮之间能持续命中。

### 提取

- 每次生成完成后排一个 `user.memory` 任务，延迟 `MEMORY_EXTRACTION_DELAY_SECONDS` 秒才执行。
- 任务执行时，如果同一会话已有更新的完成回复，并且待读轮数少于 `MEMORY_EXTRACTION_MAX_PENDING_TURNS`，就跳过，交给最后一轮的任务。一段连续对话因此只读一次。
- 会话上的 `memoryExtractedSeq` 游标记录已读到哪里。模型读到的输入包括：
  - 现有记忆（含 `lastSeenAt`）；
  - 本会话已有的概要；
  - 游标之后的若干轮（约 12k token 以内，用户消息优先完整保留）；
  - 游标之前的两条消息（只用于理解指代）。
- 模型输出三类结果：
  - 增删改操作（`upsert`/`delete`）；
  - 对仍然成立的近期关注输出 `touch`；
  - 更新后的本会话概要 `episode`（闲聊时为 null）。

  写入后执行升级规则。
- 写入时加用户级 advisory lock，并比对快照。如果模型调用期间记忆被别处改过，任务抛出 `MemorySetChangedError` 后重试，不会盲目写入近义条目。
- 已删除会话不提取。用户关闭记忆期间的轮次会被直接跳过（游标前移），重新开启后也不会补提。

### 整理

满足以下任一条件时整理：

- 条目数或总量超过上限：立即整理；
- 条目数 ≥ 8，距上次整理超过 `MEMORY_CONSOLIDATION_INTERVAL_HOURS` 小时，且这段时间里记忆有变化。

整理只处理长期画像和近期关注：会话概要靠过期淘汰，不参与整理；`user` 条目原样保留。结果目标是上限的 75%。合并后的条目继承来源条目的 `lastSeenAt`（取最晚）、`reinforcedCount`（取最大）和 `createdAt`（取最早），老化和升级不会因为整理而重置。整理结果格式不对、超出预算或与并发写入冲突时都不写入。

### 删除

- 删除会话：从该会话学到的 `auto`/`tool` 记忆和它的会话概要一并删除。
- 用户在对话中要求忘记：模型调用 `memory__delete`，当轮生效；后台提取也会输出 delete。
- 设置页可以清除全部记忆（所有层）。
- 老化：近期关注和会话概要按上表自动过期。

## 3. 历史会话检索（`CHAT_SEARCH_ENABLED`）

每次生成都会提供以下工具（patch 模式除外），具体取决于用户设置：

| 工具 | 作用 |
|---|---|
| `chat__search(query, limit?)` | 语义 + 关键词混合检索用户的其他会话，返回标题、日期、命中片段和相似度 |
| `chat__recent(limit?, before?, after?)` | 按时间列出最近会话，概要优先取滚动摘要的“用户目标” |
| `memory__save` / `memory__delete` | 用户明确要求时即时增删记忆 |

### 索引

- 每次生成完成后排一个 `chat.index` 任务，把这一轮（用户消息和回复）写成一个 `MessageChunk`，再调用 `EMBEDDING_MODEL`（默认 DashScope `text-embedding-v4`，1024 维）写入 `embedding`。
- 块先写入、后算向量：embedding 服务失败时任务会重试，在此期间这一轮仍能按关键词搜到。
- 每个块记录生成它的 `embeddingModel`。换模型后旧向量不再参与比较，需要运行 `npm run search:reindex` 重新生成（生产镜像中用 `node dist/server/searchReindex.js`）。
- 已删除会话不建索引；删除会话时，它的块和向量一起删除。

### 检索

`chat__search` 做混合检索：

1. **语义：** 把查询向量化，在该用户的块里按余弦距离做精确扫描，取前 40 个，丢弃相似度低于 `CHAT_SEARCH_MIN_SIMILARITY`（默认 0.35）的结果。
2. **关键词：** 拉丁词整体匹配；中文连续字串整体（≤4 字）加二元切分匹配，按命中词长度打分，取前 40 个。
3. **融合：** 两组结果用倒数排名融合（RRF，k=60）合并，再按会话聚合。每个会话取最好的一轮，其余命中的轮次少量加分。每个会话最多返回 3 个片段，片段带 `similarity`。

两组都会排除当前会话、已删除会话和被替换的旧回复。查询向量化失败时自动退回纯关键词检索。

**为什么不建 HNSW 索引：** 按用户过滤后再做 ANN 检索，会因为过滤发生在索引扫描之后而丢失结果。单个用户的块通常只有几千条，精确扫描只需毫秒级，而且结果完整。如果将来单用户数据量大到需要 ANN，可以加 HNSW 索引，并启用 pgvector 0.8 的 `hnsw.iterative_scan`。

## 4. 用户控制

用户看不到具体记了什么，只能决定用不用、能不能清掉；记什么、留多久由系统按上面的策略管理。

- **设置页**（账户菜单 →“记忆”）只有两项：
  - “使用记忆”开关：同时控制记忆和历史对话检索；
  - “清除全部记忆”（需要确认）。
- **对话中**：用户说“记住……”“忘掉……”时，模型通过 `memory__save`/`memory__delete` 当轮生效；问“你记得我什么”时如实概括。
- **HTTP 接口**：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/api/memory/settings` | 读取开关 |
| `PATCH` | `/api/memory/settings` | 修改开关 |
| `DELETE` | `/api/memory` | 清除全部记忆 |

## 5. 评测

上线后的完整验证步骤见 [memory-verification.md](memory-verification.md)。

`npm run eval:memory` 用生产提示词，在固定场景上调用后台模型并检查提取结果。场景包括：

- 身份、偏好；
- 一次性请求、只是提问、敏感凭据、具体分析结果；
- 更正、要求忘记、用户条目保护、指代上文；
- 近期关注的识别和 `touch` 续期。

需要 `QWEN_API_KEY`；通过率低于 `EVAL_MIN_PASS_RATE`（默认 0.8）时以非零码退出。改提取或整理提示词前后都应运行一次，可以用 `EVAL_REPEAT` 多跑几次以降低随机性。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `USER_MEMORY_ENABLED` | `true` | 跨会话记忆总开关 |
| `USER_MEMORY_TOKEN_BUDGET` | `2048` | 注入记忆的 token 上限 |
| `USER_MEMORY_MAX_ITEMS` | `40` | 条目上限 |
| `CHAT_SEARCH_ENABLED` | `true` | 历史会话检索工具和索引任务 |
| `EMBEDDING_MODEL` | `text-embedding-v4` | 向量模型（需支持 1024 维输出） |
| `EMBEDDING_BASE_URL` | DashScope 兼容模式地址 | OpenAI 兼容的 embeddings 接口 |
| `EMBEDDING_API_KEY` | 同 `QWEN_API_KEY` | |
| `CHAT_SEARCH_MIN_SIMILARITY` | `0.35` | 只靠语义命中的结果的最低余弦相似度 |
| `MEMORY_EXTRACTION_DELAY_SECONDS` | `300` | 提取前等待会话安静的秒数 |
| `MEMORY_EXTRACTION_MAX_PENDING_TURNS` | `6` | 积压多少轮时不再等待 |
| `MEMORY_CONSOLIDATION_INTERVAL_HOURS` | `24` | 例行整理的最小间隔 |
