# 记忆系统上线验证

部署到服务器后按顺序执行。第 1 步是基础设施检查，任何一项不通过就先修，后面的测试没有意义。

下文假设：

| 项 | 值 |
|---|---|
| API 容器 | `ai-chatbot` |
| Worker 容器 | `ai-chatbot-worker` |
| 数据库容器 | `local-postgres`（库 `app_db`，用户 `app_user`） |

如果 `DATABASE_URL` 指向的库名或用户不同，替换下面 `PSQL` 里的值：

```bash
PSQL="docker exec -i local-postgres psql -U app_user -d app_db"
```

## 0. 准备

1. **确认部署成功：** GitHub → Actions → Deploy AI Chatbot，最近一次运行为绿色。
2. **（建议）缩短提取延迟：** 测试期间在部署用的 env 文件里加 `MEMORY_EXTRACTION_DELAY_SECONDS=30`，然后重新部署。否则每次说完话要等约 5 分钟（300 秒，加上最多 15 秒的调度间隔），记忆才会出现。测完删掉这一行。
3. **准备一个测试账号：** 下面的对话内容会写进这个账号的记忆。测完可以在 账户菜单 →“记忆”里“清除全部记忆”。

## 1. 基础设施

### 1.1 健康检查

```bash
curl -sS http://10.88.20.19:8090/ai-chatbot/api/health
```

PostgreSQL、Redis、Worker 都应为 `ok`。

### 1.2 pgvector 扩展和新表

```bash
$PSQL -c "select extname, extversion from pg_extension where extname = 'vector'"
```

```bash
$PSQL -c '\d "MessageChunk"'
```

第一条应返回一行 `vector`。第二条应能看到 `embedding | vector(1024)` 这一列。

### 1.3 向量接口（最关键）

在 API 容器里用应用自己的环境变量发一次请求：

```bash
docker exec ai-chatbot node -e "
const key = process.env.EMBEDDING_API_KEY || process.env.QWEN_API_KEY
fetch(process.env.EMBEDDING_BASE_URL + '/embeddings', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: process.env.EMBEDDING_MODEL, input: ['测试'], dimensions: 1024 }),
}).then(async (r) => { const j = await r.json(); console.log(r.status, j.data?.[0]?.embedding?.length ?? JSON.stringify(j).slice(0, 300)) })
  .catch((e) => console.log('ERROR', String(e.cause ?? e)))
"
```

| 输出 | 含义 | 处理 |
|---|---|---|
| `200 1024` | 正常 | 无需处理 |
| `401` / `403` | 密钥不能调用 embeddings 接口 | 在 env 文件里加 `EMBEDDING_API_KEY=<百炼 API key>` 后重新部署 |
| `400` 并提示 model 或 dimensions 有误 | 模型名或维度不被支持 | 检查 `EMBEDDING_MODEL` |
| `ERROR ... ENOTFOUND` 或超时 | 容器访问不到该域名 | 检查服务器出网，或修改 `EMBEDDING_BASE_URL` |

### 1.4 后台任务没有在报错

```bash
$PSQL -c "select type, status, count(*), max(error) as last_error from \"BackgroundJob\" where \"createdAt\" > now() - interval '1 day' group by type, status order by type, status"
```

```bash
docker logs --since 1h ai-chatbot-worker 2>&1 | grep -iE "memory|embedding|consolidation|summary" | tail -20
```

`chat.index` 和 `user.memory` 应主要是 `completed`。`failed` 或反复 `queued` 时，看 `last_error`。

## 2. 功能测试

每个场景都写了操作、预期结果和用来核对的 SQL。在回复下方展开“执行步骤”，可以看到模型调用了哪个工具：“更新记忆”“删除记忆”“搜索历史对话”“查看最近对话”。

先查出测试账号的 id，后面的 SQL 都会用到：

```bash
$PSQL -c "select id, \"userName\", \"realName\" from \"User\" order by \"updatedAt\" desc limit 5"
```

```bash
U=<测试账号 id>
```

### A. 后台自动提取记忆

1. 新建对话，发送：

   > 我是中科院微生物所的博士后，主要做土壤宏基因组的耐药基因分析。以后回答尽量简短，代码注释用英文。

2. 再追问一句业务问题，例如“耐药基因一般用什么数据库注释？”。
3. 等待提取延迟（第 0 步设为 30 秒的话，约 45 秒）。
4. 查数据库（界面不展示记忆内容）：

```bash
$PSQL -c "select category, source, content, \"lastSeenAt\"::date, \"expiresAt\"::date from \"UserMemory\" where \"userId\" = '$U' order by category"
```

**预期：**
- 有 `identity` 或 `work` 条目（含微生物所、宏基因组/耐药），以及 `preference` 条目（简短、英文注释），两者的 `expiresAt` 都为空。
- 有一条 `episode`（本会话概要），`expiresAt` 约为 60 天后。
- 不应出现“耐药基因用什么数据库注释”这类一次性问题，也不应出现助手给出的建议。

### B. 记忆注入

新建对话，依次问：

1. 你记得关于我的什么？
2. 推荐一个分析流程。

**预期：**
- 第 1 问如实概括 A 里的内容，不出现 `(research_field)` 这类内部标识。
- 第 2 问的回答自然地贴合土壤宏基因组和耐药方向，且比较简短，不说“根据我的记忆”。

### C. 即时记住

在任意对话发送：

> 记住：我负责的项目编号是 P-17。

**预期：**
- 执行步骤里出现“更新记忆”。
- 马上用 A 里的 SQL 查，就能看到这一条，`source` 为 `tool`，不需要等提取延迟。

### D. 即时忘记

发送：

> 忘掉我的项目编号。

**预期：** 执行步骤里出现“删除记忆”，用 A 里的 SQL 查不到这一条。等一个提取周期后，它也不会被后台重新加回来。

### E. 跨会话检索（语义）

1. 新建对话 1，讨论一个具体话题，例如：

   > 这批样本检出了 tetM 和 sul1，丰度分别是 0.8% 和 1.2%，帮我解读一下。

2. 等约 10 秒，让索引任务完成，然后确认索引已建好：

   ```bash
   $PSQL -c "select \"chatId\", seq, left(content, 40), \"embeddingModel\", embedding is not null as embedded from \"MessageChunk\" where \"userId\" = '$U' order by \"createdAt\" desc limit 5"
   ```

   `embedded` 应为 `t`。

3. 新建对话 2，换一种说法问，不重复原词：

   > 我之前问过的那个抗生素抗性基因的结果，丰度是多少来着？

**预期：**
- 执行步骤里出现“搜索历史对话”。
- 回答给出 0.8% / 1.2%，并说明出自哪次对话（标题和日期）。
- 再用英文问一次 “What were the antibiotic resistance genes I asked about before?”，也应能找到。

### F. 按时间列出最近对话

发送：

> 我最近都聊了哪些话题？

**预期：** 执行步骤里出现“查看最近对话”，列出的标题与侧边栏一致，并且不包括当前这个对话。

### G. 无痕对话

1. 首页点“无痕对话”后开始对话，确认标题旁有“无痕”标记。
2. 发送：

   > 我下个月要跳槽去 B 公司，别告诉别人。

3. 在无痕对话里问“你记得关于我的什么？”。
4. 等一个提取周期，然后查数据库：

   ```bash
   $PSQL -c "select id, title from \"Chat\" where \"userId\" = '$U' and incognito"
   ```

   ```bash
   $PSQL -c "select count(*) from \"MessageChunk\" c join \"Chat\" ch on ch.id = c.\"chatId\" where ch.incognito"
   ```

   ```bash
   $PSQL -c "select content from \"UserMemory\" where \"userId\" = '$U' and content like '%B 公司%'"
   ```

**预期：**
- 第 3 步：无痕对话里不知道 A 中记住的信息，执行步骤里也没有任何记忆或检索工具。
- 第 4 步：无痕会话的 `MessageChunk` 数为 0，`UserMemory` 里查不到 B 公司。
- 在普通对话里搜“跳槽”，也搜不到这次无痕对话。

### H. 记忆开关和清除

1. 在 账户菜单 →“记忆”里关闭“使用记忆”，新建对话，问“你记得关于我的什么？”，再问 E 里的问题。**预期：** 不知道你的信息，也不调用任何记忆或检索工具。
2. 刷新页面后重新打开弹窗，开关仍是关闭状态。重新打开开关。
3. 先记下当前条数，再点“清除全部记忆”并确认：

   ```bash
   $PSQL -c "select count(*) from \"UserMemory\" where \"userId\" = '$U'"
   ```

   **预期：** 清除后再查为 0；新建对话问“你记得关于我的什么？”时答不上来。之后做后面的场景前，先重新做一遍 A。

### I. 删除会话

删除 A 里的那个对话，然后查数据库：

```bash
$PSQL -c "select source, content from \"UserMemory\" where \"userId\" = '$U'"
```

**预期：**
- 从该会话整理出的条目（包括它的 `episode` 概要）被删除。
- 该会话在 `MessageChunk` 里没有记录了。

### K. 分层老化

分层规则见 `docs/memory.md` 第 2 节。老化要等几周，这里直接改时间字段来模拟。

1. **近期关注会被识别出来：** 新建对话，发送：

   > 这两周在赶一批肠道菌群样本的数据，月底要交报告。

   等一个提取周期后查数据库：

   ```bash
   $PSQL -c "select key, category, \"reinforcedCount\", \"expiresAt\"::date from \"UserMemory\" where \"userId\" = '$U' and category in ('current', 'work')"
   ```

   **预期：** 出现一条 `current`，`expiresAt` 约为 30 天后。

2. **再次提到会续期：** 把它改成 20 天前见过、10 天后过期（把 `<key>` 换成上一步查到的 key）：

   ```bash
   $PSQL -c "update \"UserMemory\" set \"lastSeenAt\" = now() - interval '20 days', \"expiresAt\" = now() + interval '10 days' where \"userId\" = '$U' and key = '<key>'"
   ```

   然后在另一个新对话里提到它，例如“肠道那批样本的图再改改配色”，等一个提取周期后再查。

   **预期：** `expiresAt` 回到约 30 天后，`reinforcedCount` 加 1。

3. **反复出现会升级为长期：**

   ```bash
   $PSQL -c "update \"UserMemory\" set \"createdAt\" = now() - interval '15 days', \"reinforcedCount\" = 3 where \"userId\" = '$U' and key = '<key>'"
   ```

   再在任意对话里聊一轮，等一个提取周期后查。

   **预期：** 这条变成 `work`，`expiresAt` 为空。

4. **过期会淘汰：** 先把一条 `current` 设为已过期，再在新对话里问“我最近在忙什么？”：

   ```bash
   $PSQL -c "update \"UserMemory\" set \"expiresAt\" = now() - interval '1 minute' where \"userId\" = '$U' and category = 'current'"
   ```

   **预期：** 回答里不再提到它。10 分钟内 Worker 会把它物理删除：

   ```bash
   docker logs --since 15m ai-chatbot-worker 2>&1 | grep "Purged aged-out memories"
   ```

5. **近期对话只注入两周：** 在新对话里问“我们最近聊过什么？”，回答应能提到 A、E 等会话的内容。然后把会话概要设为 15 天前活跃：

   ```bash
   $PSQL -c "update \"UserMemory\" set \"lastSeenAt\" = now() - interval '15 days' where \"userId\" = '$U' and category = 'episode'"
   ```

   再新建对话问同样的问题。

   **预期：** 不再凭记忆直接说出（概要已不注入），但可能会调用“搜索历史对话”或“查看最近对话”去查。

### J. 模型有没有乱调工具

用几轮普通问答（翻译、写代码、解释概念）测一下，然后看工具调用统计：

```bash
$PSQL -c "select \"toolName\", status, count(*) from \"ToolRun\" where \"userId\" = '$U' and \"startedAt\" > now() - interval '1 day' and (\"toolName\" like 'memory.%' or \"toolName\" like 'chat.%') group by 1, 2 order by 1"
```

```bash
$PSQL -c "select \"toolName\", input, error from \"ToolRun\" where \"userId\" = '$U' and \"toolName\" = 'memory.save' order by \"startedAt\" desc limit 10"
```

**预期：**
- `memory.save` 只出现在 C 这类明确要求“记住”的场景。
- 普通问答不应调用 `chat.search`。
- `status = failed` 的记录应为 0，有的话把 `error` 发给开发者。

## 3. 记忆提取质量评测

评测脚本用生产环境的提示词和模型，跑 10 个固定场景，包括：

- 身份、偏好；
- 一次性请求、只是提问、敏感信息、具体结果；
- 更正、遗忘、用户条目保护、指代上文。

运行镜像里没有开发依赖，所以在一个临时 Node 容器里跑。先在任意一个有本仓库代码的目录里（例如 self-hosted runner 的 checkout 目录，或手动 clone 一份）执行：

```bash
cd <仓库目录>
```

```bash
docker run --rm -v "$PWD":/app -w /app -e ONNXRUNTIME_NODE_INSTALL=skip -e QWEN_API_KEY="$(docker exec ai-chatbot printenv QWEN_API_KEY)" -e QWEN_BASE_URL="$(docker exec ai-chatbot printenv QWEN_BASE_URL)" -e BACKGROUND_MODEL="$(docker exec ai-chatbot printenv BACKGROUND_MODEL)" -e EVAL_REPEAT=3 node:22-bookworm-slim sh -c "npm ci --no-audit --no-fund && npm run eval:memory"
```

**预期：** 最后一行通过率 ≥ 80%，退出码为 0。把 `FAIL` 的行发给开发者，用来调整提示词。`EVAL_REPEAT=3` 让每个场景跑 3 次，可以看出结果稳不稳定。

## 4. 检索相似度门槛调优

`CHAT_SEARCH_MIN_SIMILARITY`（默认 0.35）决定只靠语义命中的结果最低要多相似。下面的命令在 API 容器里直接调用检索函数，门槛设为 0，可以看到每条命中的真实相似度：

```bash
docker exec ai-chatbot node --input-type=module -e "
import { readConfig } from './dist/server/config.js'
import { createDatabase, closeDatabase } from './dist/server/db.js'
import { createEmbedder } from './dist/server/embeddings.js'
import { searchUserChats } from './dist/server/chatSearch.js'
const config = readConfig()
const db = createDatabase(config.databaseUrl, 1)
const hits = await searchUserChats(db, createEmbedder(config), { userId: process.argv[1], query: process.argv[2], minSimilarity: 0, limit: 10 })
for (const hit of hits) for (const m of hit.matches) console.log(m.similarity, hit.title, '|', m.excerpt.slice(0, 60))
await closeDatabase(db)
" "$U" "抗生素抗性基因的丰度"
```

用几个“应该命中”和“不应命中”的查询各跑一下：

| 情况 | 调整 |
|---|---|
| 相关结果的相似度明显低于 0.35 | 调低门槛，例如 0.25 |
| 不相关结果的相似度高于 0.35 | 调高门槛，例如 0.45 |

在 env 文件里改 `CHAT_SEARCH_MIN_SIMILARITY`，重新部署后生效。

## 5. 前端检查

在桌面浏览器和手机宽度下各看一次：

- 账户菜单 →“记忆”：弹窗里只有“使用记忆”开关和“清除全部记忆”两项，不展示任何记忆内容；开关切换后刷新页面仍然保持；清除前需要确认，完成后显示“已清除全部记忆”。
- 首页“无痕对话”按钮能切换状态，并显示提示文字。
- 无痕会话的标题旁有“无痕”标记。

## 6. 发给开发者的信息

验证完毕后，把以下内容发回：

1. 第 1.3 步的输出。
2. 第 1.4 步中 `failed` 的任务和 `last_error`（如有）。
3. A–K 中不符合预期的场景编号，以及当时的对话截图或执行步骤。
4. 第 3 步的通过率和 `FAIL` 行。
5. 第 4 步的相似度样例。

测完记得把 `MEMORY_EXTRACTION_DELAY_SECONDS` 从 env 文件里删掉。
