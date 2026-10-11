# 跨样本检索：数据智能体方案

本文给出一套方案，回答下面这类“跨样本集合查询”：

- 请帮我找出所有做了肠道微生物检测的样本
- 请帮我列出所有检出 xx 病原的样本
- 请帮我找出所有鉴定到三个以上五星病原的样本

方案从当前架构出发（Worker 内的单智能体循环、`defineGpasTool` 工具规格、只读 GPAS、身份只来自服务端），
参照 Anthropic 2026 年 6 月发布的内部数据分析智能体架构
（[How Anthropic enables self-service data analytics with Claude](https://claude.com/blog/how-anthropic-enables-self-service-data-analytics-with-claude)），
说明为什么不对结构化数据做向量化，并列出上游 GPAS API 需要做的修改。

---

## 1. 这类问题是什么，现在为什么答不了

三个问题本质上都是**在团队全部样本上做精确过滤，部分还要聚合计数**，类似一条 SQL：

| 问题 | 本质 | 等价查询 |
|---|---|---|
| 肠道微生物检测的样本 | 按样本属性过滤 | `WHERE detection_type = 'GUT'` |
| 有 xx 病原的样本 | 物种 → 样本的反向查找 | `WHERE EXISTS (species WHERE tax_id IN (...))` |
| 三个以上五星病原 | 每个样本内聚合，再按聚合值过滤 | `GROUP BY sample HAVING count(hazard = 5) >= 3` |

现有工具在结构上回答不了这些问题，换提示词也没用：

1. **缺少维度。** `file.list`（`GET file/dual/merge/list`）只能按 `fileName`、`status`、`qcStatus`、`analysisStatus` 过滤。
   `sampleType` 只有临床、虫媒、环境、实验室四类（`gpasContracts.ts` 的 `sampleKeys`），
   没有“检测项目”或“样本来源/部位”字段，“肠道微生物检测”在现有数据里找不到对应字段。
2. **brief 是展示摘要，不能用来过滤。** `briefAnalysis` 每个类别只带 `topInfos`（目前 3 条）和 `maxHazandIndex`。
   - “有 xx 病原”：低丰度病原不会出现在 top 3 里，用 brief 判断会**漏掉样本**，而且用户察觉不到。
   - “≥3 个五星”：brief 只给出每类的最高危害等级，数不出每个等级各有几种。
3. **明细接口只能逐个样本查询。** `file.result`（`GET file/result/list`）每次只查一个 `taskId`、一页。
   N 个样本要调用 N × 页数次，而一次回答最多调用 `AGENT_MAX_TOOL_CALLS = 4` 次工具，单个结果超过 8 KB 还会被截断。
4. **已经在用客户端扫描凑合。** `analyzedOnly` 最多翻 10 页、500 行，在服务端合并后再过滤，结果带 `scan.complete`。
   这说明过滤本该在上游完成，现在的做法只是变通，不能再扩展到病原和危害等级。
5. **数数的变成了模型。** 即使把所有数据塞给模型，计数和筛选也会由模型完成。
   这违反现有规则“业务数据只能来自工具结果，不要编造或推测数字”。

结论：缺的不是更聪明的检索，而是**一个以样本为单位、可精确过滤和聚合的上游查询接口，再加一层固定的业务定义**。

---

## 2. Anthropic 数据智能体架构要点

据原文，Anthropic 内部约 95% 的业务分析问题由 Claude 自动回答，总体准确率约 95%。
文章把准确率定性为**上下文和验证的问题，而不是写代码的问题**，核心难点是
“把用户的问题映射到数据模型中具体且最新的实体”。文章列出三种失败模式：

| 失败模式 | 原文含义 | 在本场景的样子 |
|---|---|---|
| 概念 ↔ 实体歧义 | 多个看似合理的字段，智能体选错 | “肠道”是检测项目、样本部位还是项目名？“五星”是 `hazardIndex = 5` 还是 ≥ 4？“xx 病原”指种还是属？ |
| 数据陈旧 | 源、定义或 schema 变化后，答案悄悄出错 | 刚完成分析的样本没被统计；上游改了枚举值 |
| 检索失败 | 信息明明存在，智能体没找到 | 病原只在 brief 的 top 3 之外，于是被判为“未检出” |

文章的分层，以及在本项目中的对应：

| Anthropic 组件 | 作用 | 本项目对应 |
|---|---|---|
| **语义层**（人工维护的指标与维度定义，智能体必须先查） | 让同一个问题始终得到同一个数 | `src/server/semantic/sampleModel.ts`：样本维度、谓词、度量的固定定义（见 §4.1） |
| 血缘 / 转换图、历史 SQL 语料 | 语义层不覆盖时的后备 | 不需要。我们只有一个上游，后备就是“如实说明不支持” |
| **业务上下文**（知识图谱：文档、决策记录） | 消除歧义、提出更好的澄清问题 | 上游字典接口（检测项目、物种分类、危害等级）加本地别名表 |
| **Skills**（按需读取的 markdown；每个领域一个 knowledge skill 和一个 runbook skill） | 原文称：没有 skill 时评测准确率不超过 21%，有 skill 后稳定在 95% 以上 | `src/server/skills/sample-query/`：一份字段与口径说明，一份查询流程和澄清规则 |
| **查询工具**：先加载语义层，把 spec 编译成 SQL；裸 SQL 只作后备 | 智能体不直接写查询 | `sample.query` 工具：模型只填结构化 spec，服务端确定性地编译成上游请求 |
| **验证**：对抗式 SQL 审查子智能体、每条回答附来源脚注、数据质量检查 | 原文称对抗审查带来约 +6% 准确率，代价是 Token +32%、延迟 +72% | 不引入子智能体（违反 `docs/agent.md` 的并发预算：一个生成槽对应一个上游许可）。改为确定性校验，加上“查询口径复述”和来源脚注（§4.4） |
| **评测**：离线问答对、消融实验、线上遥测、收集用户纠错 | 原文称上线一个月准确率从约 95% 漂移到约 65%，此后把维护当作工程工作 | `tests/evals/sample-query/`：固定的问题 → spec 评测集，CI 运行确定性部分（§4.5） |

原文还给出几条直接可用的原则：

- **定义由人维护**：用 LLM 自动生成指标定义会让准确率变差；Claude 可以起草文档，定义由人负责。
- **skill 与数据模型在同一个 PR 里修改**：上游字段变了，语义层、skill 和评测一起改。
- **原文没有使用向量检索。** 唯一一次检索实验是让智能体 grep 上千个 SQL 文件，准确率变化不到 1 个百分点，
  约 80% 答错的问题其实答案就在语料里。原文结论是瓶颈在结构，而不在能否访问到数据。

---

## 3. 为什么结构化数据不适合向量化

一个看起来顺手的做法是：把每个样本的检测结果拼成文本，用 BGE 做 embedding 存进 pgvector，
再拿“有金黄色葡萄球菌的样本”做相似度检索。这条路行不通，原因如下：

1. **“所有”和 top-k 冲突。** 向量检索返回最相似的 k 条，近似索引（HNSW、IVF）本身也不保证完全召回。
   用户问的是“所有”，答案必须**不多不少**。检索总会截断，又没有可靠的阈值来区分“相关”和“不相关”。
2. **精确谓词在向量空间里没有意义。** `hazardIndex = 5` 和 `= 4` 只差一个字符，embedding 几乎一样，临床意义却完全不同。
   “三个以上”是聚合条件，“没有检出 xx”是否定条件，相似度都表达不了。
3. **相近的物种名会互相混淆。** 大肠埃希菌、大肠埃希菌噬菌体、志贺菌在文本上很接近，
   同属不同种的名称也很相似，但病原性完全不同。物种的身份是 `taxId`，不是名称字面上的相似度。
4. **答案不稳定，无法审计。** 换模型、调阈值、增减数据都会让同一个问题得到不同的样本集合，
   也说不出为什么某个样本被选中或被排除。精确查询可以复述口径（“危害等级 5 级的物种数 ≥ 3”），并且可以复现。
5. **数据陈旧，越过隔离边界。** 做向量化需要把业务结果复制到本地。这破坏了现有边界：
   业务数据只在 GPAS，本地 PostgreSQL 只保存会话。复制之后还要重新解决团队隔离、权限回收，
   以及分析刚完成或重跑后的索引失效。现在的 `ToolRun` 审计只记录参数和字节数，也是为了不留存业务数据。
6. **计数仍然要模型来做。** 检索出来的片段最后要由模型数一遍、筛一遍，第 1 节的问题依然存在。

**向量检索在这里的正确位置：把用户的自由说法映射到受控词表中的候选。** 向量化的对象是词表，不是数据。

- 例如“金葡”“MRSA”“新冠”“肠道菌群检测”，先召回物种 `taxId` 或检测项目代码的**候选**。
- 再由精确的字典查询确认，或者让用户在几个候选中选一个。
- 最终的查询完全是确定性的。

这与现在 `SemanticIntentRouter` 的定位一致：BGE 只用来缩小工具范围，不推断权限、否定或操作
（见 `src/server/gpasIntent.ts` 的注释）。

---

## 4. 目标架构

```text
用户问题
  │  ingress：选工具（不变；新增 2 个工具后共 8 个，仍不超过 AGENT_TOOL_LIMIT，不需要 BGE 路由）
  ▼
Worker 智能体循环（不变：一次最多一个模型调用，最多 4 次工具调用）
  │  instructions += skills/sample-query（knowledge + runbook，只在提供了 sample.query 时注入）
  │
  ├─ ① vocab.resolve      概念 → 实体
  │     "肠道微生物" → detectionType=GUT_MICROBIOME
  │     "金葡"       → taxId=1280（金黄色葡萄球菌）
  │     "五星"       → hazardLevel=5（语义层的固定定义，不调用接口）
  │     来源：上游字典接口 + 本地人工别名表；可选用 BGE 召回词表候选
  │     有歧义时 → 返回候选，模型向用户澄清，不自行猜测
  │
  ├─ ② sample.query       结构化 spec（zod 校验）
  │     → 编译器（纯函数，可单测）→ 上游 POST sample/search
  │     ← total（精确值）、当页样本、asOf、口径复述
  │
  └─ 回复：模型只引用 total 和口径；多样本表格作为 part 展示（复用 FileAnalysisCards 的表格）
          回复末尾附来源脚注：数据来源、截至时间、是否完整
```

一次回答通常需要 2 次工具调用（resolve 和 query），翻页再加 1 次，在 4 次的上限之内。

### 4.1 语义层：样本模型（人工维护）

在代码中固定业务口径，评审方式与 schema 相同。模型不能改写这些定义，只能引用。

| 业务说法 | 实体 / 定义 | 默认口径 | 需要业务方确认 |
|---|---|---|---|
| 样本 | 一个分析任务（`analysisId`），双端两个文件算一个样本 | 与 `mergeDuplicateRows` 的语义一致 | 上游以 `analysisId` 为主键返回，不再需要本地去重 |
| 已鉴定 / 有结果 | `analysisStatus = analysisverified` | 未完成分析的样本不参与病原类条件 | — |
| 检测项目（如肠道微生物检测） | `detectionType`：受控枚举代码 | 精确匹配代码，不匹配名称 | **上游目前没有这个字段**，见 §5 |
| 检出 xx 病原 | 样本完整结果中存在 `taxId ∈ resolve(xx)` 的行 | 默认按种级精确匹配；用户说属名时展开到该属下所有种 | 是否设可信度或丰度下限（例如唯一匹配 reads ≥ N） |
| N 星病原 | 结果行 `hazardIndex = N` | 五星指 `hazardIndex = 5` | `hazardIndex` 的实际取值范围（代码目前截断到 0–9，文档写 1–5 级） |
| 三个以上 | 计数 ≥ 3 | 按中文“以上含本数”处理，并在回复中写明“≥ 3” | — |

### 4.2 Skill：`src/server/skills/sample-query/`

按照原文的“一个 knowledge 加一个 runbook”结构，写成 markdown 并纳入版本库：

- `knowledge.md`：每个字段的含义、单位（`abundance` 为百分数、`coverage` 为比例）、枚举值和常见误读。
  例如：brief 的 top 3 不能用来判断“是否检出”；种数占比不是丰度占比。
- `runbook.md`：查询流程。先 resolve 再 query；有歧义时澄清；结果为空时说明口径，不改用近似条件；
  不完整时如实说明；回复只引用 `total`，不自行计数。

`AgentToolSet.instructions()` 只在本次运行的工具集中包含 `sample.query` 时拼入这些内容，
不会占用其它对话的上下文。

### 4.3 工具规格

```ts
// src/server/gpas/tools/sample.query.ts（示意）
const hazardLevel = z.number().int().min(1).max(5)
export const sampleQueryInput = z.object({
  detectionTypes: z.array(dictCode).max(10).optional(),     // 来自 vocab.resolve
  sampleTypes: z.array(z.enum(sampleKeys)).optional(),
  analysisDone: z.boolean().optional(),
  uploadedFrom: isoDate.optional(),
  uploadedTo: isoDate.optional(),
  pathogens: z.object({
    taxIds: z.array(taxId).min(1).max(50),                  // 来自 vocab.resolve，模型不能自填名称
    match: z.enum(['any', 'all']).default('any'),
    minHazard: hazardLevel.optional(),
  }).optional(),
  hazardCount: z.object({ level: hazardLevel, atLeast: z.number().int().min(1).max(100) }).optional(),
  page: z.number().int().min(1).max(1000).optional(),
  pageSize: z.number().int().min(1).max(50).optional(),
})
```

- 字段名都不会触发 `identityFieldPattern`。团队由服务端从 `ctx.profile` 和 Cookie 决定，与现有工具一致。
- `taxIds` 和 `detectionTypes` 只接受字典代码。即使模型绕过 `vocab.resolve` 直接填写，上游也会按字典校验，非法代码返回错误。
- `toModel` 返回：`total`、`complete`、`asOf`、`criteria`（服务端生成的口径中文复述）、
  最多 20 个精简样本（`sampleName`、`taskId`、匹配到的病原及其等级、各危害等级的物种数）。
  这样可以控制在 8 KB 以内。
- `toReply`：多样本表格作为 part 展示；翻页走类似 `GET /api/gpas/file/results` 的服务端路由，数据不进入模型上下文。

三个示例问题对应的 spec：

```jsonc
// 所有肠道微生物检测的样本
{ "detectionTypes": ["GUT_MICROBIOME"] }
// 所有有金黄色葡萄球菌的样本
{ "analysisDone": true, "pathogens": { "taxIds": ["1280"], "match": "any" } }
// 所有鉴定到三个以上五星病原的样本
{ "analysisDone": true, "hazardCount": { "level": 5, "atLeast": 3 } }
```

### 4.4 验证：用确定性检查代替子智能体

- **口径复述**：`criteria` 由编译器根据 spec 生成，例如“已完成分析；危害等级 5 级的物种数 ≥ 3”。
  模型必须在回复中原样给出，用户一眼就能看出口径对不对，比如“三个以上”到底是 ≥ 3 还是 > 3。
- **来源脚注**：回复末尾固定附上“数据来源 GPAS 样本检索 · 截至 {asOf} · 共 {total} 个样本{，结果完整/未完整}”。
  这对应原文要求的每条回答都附来源脚注，包括来源层级、新鲜度和负责人。
- **一致性断言**：`total` 必须等于上游返回的 `totalData`；当页行数不超过 `pageSize`；
  每一行都满足 spec，服务端会抽查匹配到的病原等级。断言失败时工具报错，不交给模型。
- **结果为空不等于不存在**：结果为 0 时，回复要说明口径和可能的原因
  （样本未完成分析、物种名映射到了另一个 `taxId`），不能自动放宽条件重新查询。

### 4.5 评测与防漂移

- `tests/evals/sample-query/cases.jsonl`：每条包含问题、期望的 spec 和期望的口径复述，
  覆盖三类问题的同义说法、歧义（需要澄清）、否定、组合条件和超出范围（应当拒绝）的情况。
- 确定性部分（编译器、口径复述、断言）由 `npm test` 运行。模型部分（问题 → spec）用 mock GPAS 定期运行，
  并记录准确率。上游字段或别名表一改，这些评测就会提示漂移。
- 用户的纠错（比如“不对，我说的是属”）记入别名表和评测集，对应原文的主动收集纠错。

### 4.6 过渡方案（上游接口上线前）

不建议用 brief 做病原判断（理由见第 1 节第 2 点）。如果业务方需要一个临时版本，可以在 `sample.query` 内部
用有上限的服务端扇出：先用 `analyzedOnly` 扫描出已完成分析的样本，再对每个样本并发请求
`file/result/list` 的全部页，在服务端过滤和计数。上限设为 ≤ 50 个样本、≤ 200 次请求、并发 4。
超出上限时返回 `complete: false`，回复中必须说明。“肠道微生物检测”在这个阶段答不了，因为没有对应字段。
扇出不经过模型，不占用工具调用次数，但给上游带来的负载与样本数成正比，所以只能是过渡方案。

### 4.7 本仓库改动清单

| 文件 | 内容 |
|---|---|
| `src/server/semantic/sampleModel.ts` | §4.1 的定义、口径复述生成、spec → 上游请求的编译器 |
| `src/server/skills/sample-query/*.md` | §4.2 的 knowledge 和 runbook |
| `src/server/gpas/tools/vocab.resolve.ts`、`sample.query.ts` | 两个新工具，加入 `tools/index.ts` |
| `src/server/agent/tools.ts` | 按工具集注入 skill；instructions 增加“回复只引用 total 和 criteria” |
| `src/client/features/gpasUpload/FileAnalysisCards.tsx` | 复用多样本表格，增加“匹配病原”列和来源脚注 |
| `src/server/app.ts` | 检索结果翻页路由（与 `gpas/file/results` 相同的做法） |
| `tests/evals/sample-query/`、`src/server/sampleQuery.test.ts` | 评测集和契约测试（mock GPAS） |

---

## 5. 上游 GPAS API 修改建议

原则：**过滤、关联和聚合放在数据所在的地方完成**。本应用只负责把自然语言转成结构化条件，并展示结果。

### P0：新增样本检索接口 `POST sample/search`

以分析任务（样本）为单位，由服务端过滤、分页并给出精确总数。

```jsonc
// 请求（团队由会话 Cookie 决定，不接受 ownTeamId 参数）
{
  "detectionTypes": ["GUT_MICROBIOME"],
  "sampleTypes": ["clinic"],
  "analysisStatus": ["analysisverified"],
  "uploadTime": { "from": "2026-01-01T00:00:00+08:00", "to": null },
  "species": { "taxIds": ["1280"], "match": "any", "minHazardIndex": null },
  "hazardCount": { "hazardIndex": 5, "gte": 3 },
  "page": 1, "pageSize": 50,
  "orderBy": "-analysisTime"
}
// 响应
{
  "code": 200,
  "asOf": "2026-10-11T09:30:00+08:00",          // 数据快照时间，用于来源脚注
  "dataPage": {
    "totalData": 37,                              // 精确总数，不是估算
    "dataList": [{
      "analysisId": "…", "groupId": "…", "sampleName": "KY14599-1-T233R",
      "files": [{ "fileId": "…", "fileName": "…", "endType": "R1" }],
      "sampleType": "clinic", "detectionType": "GUT_MICROBIOME",
      "analysisStatus": "analysisverified", "analysisTime": "…", "uploadTime": "…",
      "totalSpecies": 214,
      "hazardHistogram": { "1": 120, "2": 60, "3": 25, "4": 6, "5": 3 },
      "matchedSpecies": [                         // 只列满足 species / hazardCount 条件的物种
        { "taxId": "1280", "taxCname": "金黄色葡萄球菌", "hazardIndex": 4, "abundance": 0.82 }
      ]
    }]
  }
}
```

上游参考实现：用一张样本 × 物种的明细表加样本级汇总，下面是 PostgreSQL 示意。

```sql
-- 样本 × 物种明细（从现有分析结果落表）
CREATE TABLE analysis_species (
  team_id bigint, analysis_id text, tax_id text, hazard_index smallint,
  abundance numeric, only_matching int, PRIMARY KEY (analysis_id, tax_id)
);
CREATE INDEX ON analysis_species (team_id, tax_id);            -- 物种 → 样本
CREATE INDEX ON analysis_species (team_id, hazard_index);

-- 样本级危害等级计数，分析完成或重跑时更新
CREATE TABLE analysis_hazard_summary (
  team_id bigint, analysis_id text PRIMARY KEY,
  h1 int, h2 int, h3 int, h4 int, h5 int, total_species int
);
CREATE INDEX ON analysis_hazard_summary (team_id, h5);

-- 问题 3：三个以上五星病原
SELECT a.* FROM analysis a JOIN analysis_hazard_summary s USING (analysis_id)
WHERE a.team_id = $team AND a.analysis_status = 'analysisverified' AND s.h5 >= 3
ORDER BY a.analysis_time DESC LIMIT 50 OFFSET 0;

-- 问题 2：检出指定病原
SELECT a.* FROM analysis a
WHERE a.team_id = $team AND EXISTS (
  SELECT 1 FROM analysis_species x
  WHERE x.analysis_id = a.analysis_id AND x.team_id = $team AND x.tax_id = ANY($taxIds));
```

### P0：字典接口，用于概念到实体的映射

| 接口 | 返回 | 用途 |
|---|---|---|
| `GET dict/detection-types` | `[{ code, name, aliases[] }]`，如 `GUT_MICROBIOME / 肠道微生物检测` | 解决“肠道”指什么 |
| `GET dict/species?keyword=&limit=` | `[{ taxId, taxCname, taxEname, synonyms[], rank, parentTaxId, hazardIndex }]` | 物种名、俗名、缩写到 `taxId`；按属展开 |
| `GET dict/hazard-levels` | `[{ level, name, description }]` | 固定“五星”的含义和取值范围 |

样本还需要**带上检测项目（或样本部位）字段**：上传时由用户填写或由项目继承，作为受控枚举保存。
目前四类 `sampleType` 无法表达“肠道微生物检测”。

### P0：修正现有接口的契约

- `file/dual/merge/list`：每个样本只返回一行（不再按 R1/R2、R2/R1 各返回一行），`totalData` 按样本计数；
  `analysisStatus` 支持服务端过滤。这样 `analyzedOnly` 就不需要翻页扫描了（对应 `docs/gpas-project-chat.md` 验收清单第 13 项）。
- 团队范围**只从会话中取**：现在 `merge/list` 由调用方传 `ownTeamId`，`file/result/list` 是否校验 `taskId`
  属于当前团队仍待确认（验收清单第 16 项）。新接口必须在服务端校验，跨团队请求返回 403。
- 字段命名和单位统一：`taxid`/`taxId` 只保留一种；写明 `abundance` 是百分数、`coverage` 是比例还是百分比、
  `hazardIndex` 的取值范围；时间统一用带时区的 ISO 8601。

### P1：摘要与统计

- `briefAnalysis` 增加样本级的 `hazardHistogram` 和每个类别的完整检出种数。`topInfos` 继续只用于展示，
  文档中注明不能用于“是否检出”的判断。
- `POST sample/stats`：请求条件与 `sample/search` 相同，按 `detectionType`、`sampleType`、月份或物种分组计数，
  用于回答“有多少个”“按月分布”这类问题，不需要拉取明细。

### P1：非功能要求

- `pageSize` ≤ 100；`totalData` 必须是精确值；p95 延迟 < 1 s（本应用的 GPAS 请求超时是 10 s）。
- 返回 `asOf` 或数据版本号，用于来源脚注和判断数据是否陈旧。
- 枚举代码一旦发布不再改名；新增或废弃代码要提前通知，本应用同步修改语义层、skill 和评测（同一个 PR）。

---

## 6. 实施顺序

1. **对齐口径**（业务方、上游、本项目）：确认 §4.1 表格中“需要业务方确认”的各项，形成语义层初稿。
2. **上游 P0**：`sample/search`、字典接口、检测项目字段、`merge/list` 契约修正。
3. **本项目**：语义层与编译器（先写单测）→ 两个工具 → skill → 表格与来源脚注 → 评测集。
4. **上线门槛**：参照原文按领域设置上线门槛的做法，评测集上问题 → spec 的准确率 ≥ 90% 再开放，之后持续跟踪漂移。

如果上游排期较晚，可以先做 §4.6 的过渡方案，覆盖问题 2 和问题 3，并明确标注结果可能不完整。
问题 1 需要等上游增加检测项目字段。
