# 跨样本数据查询：可扩展的数据智能体方案

本文设计一套能持续扩展的跨样本查询能力。最初的三个需求：

- 请帮我找出所有做了肠道微生物检测的样本
- 请帮我列出所有检出 xx 病原的样本
- 请帮我找出所有鉴定到三个以上五星病原的样本

它们只是第一批用例。设计目标是**一类问题**都能回答，例如“每月检出 xx 的样本数”“同时检出 A 和 B 的样本”
“肠道和呼吸道样本的五星病原检出率对比”“在这些样本里再筛出临床样本”。
新增问题时，不新增工具、不改智能体循环、不改提示词主干。

方案从当前架构出发：Worker 内的单智能体循环、`defineGpasTool` 工具规格、只读 GPAS、身份只来自服务端。
参照的是 Anthropic 2026 年 6 月发布的内部数据分析智能体架构
（[How Anthropic enables self-service data analytics with Claude](https://claude.com/blog/how-anthropic-enables-self-service-data-analytics-with-claude)）。
本文还说明为什么不对结构化数据做向量化，并列出上游 GPAS API 需要做的修改。

---

## 1. 问题范围：从三个问题到一类问题

### 1.1 问题形状

把可能被问到的问题按“形状”分类，而不是按措辞。三个初始问题分别是形状 A、B、C：

| 形状 | 含义 | 例子 |
|---|---|---|
| **A 属性过滤** | 按样本自身字段筛选 | **所有肠道微生物检测的样本**；2026 年上传的临床样本；分析未完成的样本 |
| **B 子实体存在 / 不存在** | 样本下是否有满足条件的检出物种 | **有 xx 病原的样本**；未检出 xx 的样本；同时检出 A 和 B；检出任一肠道致病菌 |
| **C 子实体聚合后过滤** | 先在样本内计数或求和，再按结果筛选 | **三个以上五星病原的样本**；检出种数 > 100 的样本；病毒检出 ≥ 5 种 |
| **D 度量阈值** | 按数值字段比较 | xx 丰度 > 1% 的样本；Reads < 100 万的样本 |
| **E 分组统计** | 按维度分组计数或汇总 | 各检测项目的样本数；每月检出 xx 的样本数；最常见的五星病原 Top 10 |
| **F 排名** | 按度量排序取前 N | xx 丰度最高的 10 个样本；最近 20 个分析完成的样本 |
| **G 对比** | 两组以上按同一口径比较 | 肠道 vs 呼吸道样本的五星病原检出率；本月与上月对比 |
| **H 结果上继续操作** | 在上一次结果集上加条件、分组或排序 | “这些样本里哪些是临床样本”；“按月份分一下” |
| I 单样本明细 | 一个样本的完整结果 | 已有 `file.result`，保持不变 |

不在范围内的：

- **写操作**：仍走现有的确认表单机制。
- **知识与解读**（“xx 病原有什么危害”“这个结果说明什么”）：属于非结构化知识，见第 4 节最后一部分。

### 1.2 统一的数据视角

A 到 H 都可以表达为**同一个实体图上的结构化查询**：

```text
team ─1:n─ sample（分析任务）─1:n─ detection（样本 × 物种的一条检出）─n:1─ taxon（物种，含分类谱系、危害等级）
                │
                ├─ 维度：检测项目、样本类型、上传/分析时间、分析状态、Reads……
                └─ 以后可接：project、batch、采样地点、宿主、耐药基因、毒力因子、质控指标……
```

所以扩展性的关键是两件事，而不是逐个问题去适配：

1. 一份**描述这张实体图的语义层**：有哪些实体、字段、关系和业务口径。
2. 一种**能表达 A 到 H 的查询表示**（下文称“查询 IR”）。

---

## 2. 现状为什么答不了

1. **缺少维度。** `file.list`（`GET file/dual/merge/list`）只能按 `fileName`、`status`、`qcStatus`、`analysisStatus` 过滤。
   `sampleType` 只有临床、虫媒、环境、实验室四类，没有“检测项目”字段。
2. **brief 是展示摘要，不能用来过滤。** `briefAnalysis` 每个类别只带 `topInfos`（目前 3 条）和 `maxHazandIndex`。
   用它判断“是否检出”，会漏掉低丰度病原，用户也察觉不到；用它也数不出每个危害等级有几种。
3. **明细只能逐个样本查询。** `file.result` 每次只查一个 `taskId`、一页。
   一次回答最多调用 `AGENT_MAX_TOOL_CALLS = 4` 次工具，单个结果超过 8 KB 还会被截断。
4. **已经在用扫描凑合。** `analyzedOnly` 最多翻 10 页、500 行后在服务端过滤，结果带 `scan.complete`。
   这种做法扩展不到病原、危害等级和统计。
5. **每类问题都要单独写代码。** 现在每种查询都要写一个新工具或新参数（`analyzedOnly` 就是这样加的）。
   照这个方式继续，工具数会超过 `AGENT_TOOL_LIMIT = 8`，就得启用 BGE 路由，而路由选错工具又会成为新的失败来源。
6. **数数的变成了模型。** 把数据塞给模型筛选和计数，违反“业务数据只能来自工具结果”的规则。

---

## 3. Anthropic 数据智能体架构要点

据原文，Anthropic 内部约 95% 的业务分析问题由 Claude 自动回答，总体准确率约 95%。
文章把准确率定性为**上下文和验证的问题，而不是写代码的问题**，核心难点是
“把用户的问题映射到数据模型中具体且最新的实体”。文章列出三种失败模式：

| 失败模式 | 在本场景的样子 |
|---|---|
| 概念 ↔ 实体歧义 | “肠道”是检测项目还是样本部位？“五星”是 `hazardIndex = 5` 还是 ≥ 4？“xx 病原”指种还是属？ |
| 数据陈旧 | 刚完成分析的样本没被统计；上游改了枚举值或字段名 |
| 检索失败 | 病原只在 brief 的 top 3 之外，于是被判为“未检出” |

文章的分层，以及在本项目中的对应：

| Anthropic 组件 | 本项目对应 |
|---|---|
| **语义层**：人工维护的指标与维度定义，智能体必须先查；新增指标只加定义，不加代码路径 | 声明式语义层注册表（§5.2），这是扩展性的核心 |
| 血缘图、历史 SQL 语料：语义层不覆盖时的后备 | 不需要。语义层不覆盖时如实说明“暂不支持”，不让模型自己拼查询 |
| **业务上下文**：知识图谱、文档、决策记录 | 上游字典（检测项目、物种分类、危害等级）加本地别名表 |
| **Skills**：按需读取的 markdown，每个领域一个 knowledge 加一个 runbook。原文称没有 skill 时准确率不超过 21%，有 skill 后在 95% 以上 | `src/server/skills/<domain>/`。字段目录部分由注册表生成，口径说明和流程人工撰写（§5.7） |
| **查询工具**：智能体编写语义查询 spec，由系统编译成 SQL | `data.query`：模型只填查询 IR，服务端确定性地编译（§5.3、§5.5） |
| **验证**：对抗式审查子智能体、每条回答附来源脚注 | 不引入子智能体（违反 `docs/agent.md` 的并发预算）。改为确定性校验、口径复述和来源脚注（§5.8） |
| **评测**：离线问答对、消融实验、线上遥测、收集用户纠错。原文称上线一个月准确率从约 95% 漂移到约 65% | 按“形状 × 字段”组织的评测矩阵，加上游契约测试（§5.9） |

原文中与扩展性直接相关的几条原则：

- **定义由人维护**：用 LLM 自动生成指标定义会让准确率变差。注册表里的业务口径由人评审，Claude 只起草文档。
- **skill 与数据模型在同一个 PR 里修改**：上游加了字段，注册表、skill 和评测在同一次改动里更新。
- **瓶颈在结构，不在检索**：原文唯一的检索实验（让智能体 grep 上千个 SQL 文件）准确率变化不到 1 个百分点。

---

## 4. 为什么结构化数据不适合向量化

一个看起来顺手的做法是：把每个样本的检测结果拼成文本，用 BGE 做 embedding 存进 pgvector，再按相似度检索。
这条路对 A 到 H 都行不通：

1. **“所有”和 top-k 冲突。** 向量检索返回最相似的 k 条，近似索引本身也不保证完全召回。用户要的是不多不少的完整集合。
2. **精确谓词在向量空间里没有意义。** `hazardIndex = 5` 和 `= 4` 的 embedding 几乎一样。
   “三个以上”（C）、“丰度 > 1%”（D）、“未检出”（B 的否定）、“同时检出 A 和 B”（B 的合取），相似度都表达不了。
3. **统计、排名、对比根本不是检索问题。** E、F、G 需要分组、排序和聚合，向量库只能返回文档片段。
4. **相近的物种名会互相混淆。** 大肠埃希菌、大肠埃希菌噬菌体、志贺菌在文本上很接近，病原性完全不同。物种的身份是 `taxId`。
5. **答案不稳定，无法审计。** 换模型或调阈值，同一个问题会得到不同的样本集合，也解释不了为什么某个样本被选中。
6. **数据陈旧，越过隔离边界。** 做向量化需要把业务结果复制到本地。这破坏了“业务数据只在 GPAS”的边界，
   还要重新处理团队隔离、权限回收，以及分析重跑后的索引失效。
7. **越扩展越糟。** 每加一个字段或问题形状，就要重新设计拼接文本、重建索引，而且照样无法保证正确。
   结构化查询加一个字段只需要一条声明。

**向量检索在这里的正确位置：**

- **词表映射**：把“金葡”“MRSA”“肠道菌群检测”召回为受控词表中的候选（物种 `taxId`、检测项目代码），
  再由精确的字典查询确认，或者请用户选择。向量化的对象是词表，不是数据。
  这与现在 `SemanticIntentRouter` 的定位一致：BGE 只用来缩小范围，不做判断。
- **非结构化知识**：病原知识库、SOP、报告解读规范这类文档，适合向量检索（RAG），可以作为以后的一个独立能力。
  它回答“是什么、为什么”，结构化查询回答“有哪些、有多少”，两者不混用。

---

## 5. 可扩展架构

### 5.1 设计原则

1. **工具集固定。** 不管以后支持多少种问题，跨样本查询只用两个工具：`data.catalog` 和 `data.query`。
   现有 6 个工具加这 2 个共 8 个，正好等于 `AGENT_TOOL_LIMIT`，不需要启用 BGE 路由。
2. **定义只写一处。** 实体、字段、关系、业务口径都写在语义层注册表里。下面这些都从注册表派生：
   - 工具参数的校验
   - 查询编译时的检查
   - 口径复述的中文措辞
   - 结果列的类型和展示方式
   - skill 中的字段目录
   - 评测用例模板
3. **按需加载上下文。** 字段越来越多时，不把整份目录塞进提示词。模型用 `data.catalog` 只查当前需要的部分。
4. **模型不碰身份，也不写查询语言。** IR 里没有团队字段，只能引用注册表里的字段和运算符。团队由编译器从会话中注入。
5. **形状可以逐步支持。** 上游通过元数据声明支持哪些运算符；不支持的形状返回明确的“暂不支持”，不做近似查询。

### 5.2 语义层注册表（声明式，人工评审）

```ts
// src/server/semantic/registry.ts（示意）
export const sampleModel = defineSemanticModel({
  version: 1,
  entities: {
    sample: {
      label: '样本', key: 'analysisId', upstream: 'sample',
      // 双端两个文件算一个样本，与 mergeDuplicateRows 的语义一致
      fields: {
        detectionType: { label: '检测项目', type: 'enum', dict: 'detection-types', ops: ['in', 'not_in'] },
        sampleType:    { label: '样本类型', type: 'enum', dict: 'sample-types', ops: ['in', 'not_in'] },
        analysisDone:  { label: '分析已完成', type: 'boolean', ops: ['eq'] },
        uploadTime:    { label: '上传时间', type: 'time', ops: ['between', 'gte', 'lte'], grains: ['day', 'month', 'year'] },
        totalReads:    { label: 'Reads', type: 'number', unit: 'reads', ops: ['gte', 'lte', 'between'] },
      },
      measures: {
        sampleCount: { label: '样本数', agg: 'count' },
        // 派生度量：分子、分母都写死，模型不自己做除法
        fiveStarSampleRate: { label: '五星病原检出率', ratio: {
          numerator: { measure: 'sampleCount', where: { has: 'detection', where: { segment: 'fiveStarPathogen' } } },
          denominator: { measure: 'sampleCount' },
        } },
      },
    },
    detection: {
      label: '检出物种', parent: 'sample', upstream: 'detection',
      // 只有分析已完成的样本才有可信的检出记录
      implies: { sample: { analysisDone: true } },
      fields: {
        taxon:       { label: '物种', type: 'ref', dict: 'species', ops: ['in', 'not_in', 'under'] }, // under：属/科及其下级
        hazardLevel: { label: '危害等级', type: 'ordinal', range: [1, 5], ops: ['eq', 'gte', 'lte'] },
        abundance:   { label: '相对丰度', type: 'number', unit: '%', ops: ['gte', 'lte'] },
        category:    { label: '大类', type: 'enum', dict: 'microbial-types', ops: ['in'] },
      },
      measures: {
        detectionCount: { label: '检出数', agg: 'count' },
        taxonCount:     { label: '物种数', agg: 'count_distinct', field: 'taxon' },
      },
    },
  },
  // 命名口径：业务说法 → 固定定义，人工评审后才能修改
  segments: {
    fiveStarPathogen: { label: '五星病原', entity: 'detection', where: { field: 'hazardLevel', op: 'eq', value: 5 } },
    identified:       { label: '已鉴定样本', entity: 'sample', where: { field: 'analysisDone', op: 'eq', value: true } },
  },
})
```

- 注册表在启动时校验：字段必须存在于上游元数据（§6.1），运算符必须是上游声明支持的，字典必须存在。
- “三个以上”按“以上含本数”解析为 ≥ 3，写在 runbook 里，并通过口径复述展示给用户。
- 需要业务方确认的口径：
  - 检测项目在上游的实际字段。
  - `hazardIndex` 的取值范围：代码里截断到 0–9，文档写的是 1–5 级。
  - “检出”要不要设丰度或可信度下限。
  - 用户说属名时，是否默认展开到下级物种。

### 5.3 查询 IR

一种小而封闭的 JSON 结构，覆盖 A 到 H，用 zod 定义、由注册表校验：

```ts
type Predicate =
  | { field: string, op: Op, value: unknown }                                  // A、D
  | { segment: string }                                                        // 命名口径
  | { and: Predicate[] } | { or: Predicate[] } | { not: Predicate }            // 组合与否定
  | { has: ChildEntity, where?: Predicate }                                    // B：存在
  | { count: ChildEntity, where?: Predicate, distinct?: string, cmp: Cmp }     // C：聚合后过滤

type Query = {
  entity: 'sample' | 'detection' | 'taxon'
  where?: Predicate
  groupBy?: Array<{ field: string, grain?: TimeGrain }>                        // E
  measures?: string[]                                                          // E、G
  compare?: Array<{ label: string, where: Predicate }>                         // G：每组同口径
  orderBy?: Array<{ by: string, dir: 'asc' | 'desc' }>                         // F
  limit?: number, page?: number, pageSize?: number
}
```

示例。三个初始问题和几个后续问题都用同一种结构表达：

```jsonc
// A 所有肠道微生物检测的样本
{ "entity": "sample", "where": { "field": "detectionType", "op": "in", "value": ["GUT_MICROBIOME"] } }

// B 所有检出金黄色葡萄球菌的样本
{ "entity": "sample", "where": { "has": "detection", "where": { "field": "taxon", "op": "in", "value": ["1280"] } } }

// C 所有鉴定到三个以上五星病原的样本
{ "entity": "sample", "where": { "count": "detection", "where": { "segment": "fiveStarPathogen" },
                                  "distinct": "taxon", "cmp": { "op": "gte", "value": 3 } } }

// B 同时检出 A 和 B，且未检出 C
{ "entity": "sample", "where": { "and": [
  { "has": "detection", "where": { "field": "taxon", "op": "in", "value": ["A"] } },
  { "has": "detection", "where": { "field": "taxon", "op": "in", "value": ["B"] } },
  { "not": { "has": "detection", "where": { "field": "taxon", "op": "in", "value": ["C"] } } } ] } }

// E 每月检出 xx 的样本数
{ "entity": "sample", "where": { "has": "detection", "where": { "field": "taxon", "op": "in", "value": ["xx"] } },
  "groupBy": [{ "field": "uploadTime", "grain": "month" }], "measures": ["sampleCount"] }

// E/F 最常见的五星病原 Top 10（按检出样本数）
{ "entity": "detection", "where": { "segment": "fiveStarPathogen" },
  "groupBy": [{ "field": "taxon" }], "measures": ["sampleCount"], "orderBy": [{ "by": "sampleCount", "dir": "desc" }], "limit": 10 }

// G 肠道 vs 呼吸道样本的五星病原检出率（比例由注册表中的派生度量定义，见下文）
{ "entity": "sample", "measures": ["sampleCount", "fiveStarSampleRate"],
  "compare": [
    { "label": "肠道", "where": { "field": "detectionType", "op": "in", "value": ["GUT_MICROBIOME"] } },
    { "label": "呼吸道", "where": { "field": "detectionType", "op": "in", "value": ["RESPIRATORY"] } } ] }
```

**H（在结果上继续操作）**：`data.query` 的结果会带回规范化后的 IR。用户说“这些样本里再筛临床样本”时，
模型在原 IR 的 `where` 上用 `and` 加一个条件，再查一次。上一轮的条件保存在本轮工具结果中，随会话上下文延续，
服务端不需要保存查询状态。

**检出率**这类比例指标在注册表里定义为派生度量（见 §5.2 的 `fiveStarSampleRate`），分子和分母都是固定的。
模型只引用度量名，不自己做除法，以避免“分母是什么”的歧义。

### 5.4 两个固定工具

| 工具 | 作用 | 说明 |
|---|---|---|
| `data.catalog` | 查语义层：某个实体有哪些字段、运算符、度量、命名口径；或在某个字典里查值（检测项目、物种名到 `taxId`、属下物种） | 词表可以用 BGE 召回候选，最终以字典精确匹配为准。多个候选时返回候选列表，由模型请用户选择，不自行猜测 |
| `data.query` | 执行查询 IR，返回精确的 `total`、行或分组、`asOf`、口径复述、规范化后的 IR | 参数先用 zod 校验结构，再按注册表校验字段、运算符和值域，然后编译 |

典型调用次数：常见问题 1 到 2 次（catalog 查词，然后 query），在结果上继续操作 1 次。都在 4 次的上限之内。

`file.list` 中 `analyzedOnly` 这类为单个问题加的参数，以后可以改成 `data.query` 的预设，减少重复的入口。
`file.result` 仍负责单样本明细（形状 I）。

### 5.5 编译与执行流程

```text
IR ─▶ ① 结构校验（zod）
   ─▶ ② 语义校验（注册表：字段、运算符、值域、字典代码是否存在）
   ─▶ ③ 规范化（展开命名口径；应用 implies，例如有检出条件时自动加上 analysisDone；补默认分页）
   ─▶ ④ 成本检查（谓词深度 ≤ 4、IN 列表 ≤ 50、分组基数、compare 组数 ≤ 5）
   ─▶ ⑤ 编译为上游请求（团队由会话注入）
   ─▶ ⑥ 执行，并做一致性断言
   ─▶ ⑦ 整形：按注册表生成列类型；按 IR 生成中文口径复述
```

- 编译器和口径复述都是纯函数，完全可单测。新增字段时，这两部分不需要改代码。
- 校验失败时返回可解释的错误码，例如 `unknown_field`、`unsupported_op`、`ambiguous_value`、`too_expensive`、
  `upstream_unsupported`。模型据此向用户澄清，或说明暂不支持。

### 5.6 通用展示

新增一种通用的 `query` 消息 part，内容是 `{ columns, rows | groups, total, asOf, criteria, ir }`。
前端根据结果的形状选择展示方式，不需要为每类问题写专门的界面：

| 结果形状 | 展示 |
|---|---|
| 样本列表 | 复用现有多样本表格（`FileAnalysisCards`），追加命中条件相关的列（如匹配到的病原、五星数），每行可“查看详情” |
| 按类别分组 | 横向条形图加表格 |
| 按时间分组 | 折线图（复用 `ProjectProgressCard` 的图表做法） |
| compare | 分组条形图，加口径和分母说明 |

翻页由服务端路由用同一份 IR 执行，数据不进入模型上下文，与现有 `gpas/file/results` 的做法相同。

### 5.7 Skills

- `src/server/skills/sample-query/knowledge.md`：
  - 字段目录由注册表生成（`npm run semantic:docs`），保证与代码一致。
  - 人工补充常见误读，例如 brief 的 top 3 不能用来判断“是否检出”，种数占比不是丰度占比。
- `src/server/skills/sample-query/runbook.md`：按形状写流程和示例 IR，以及何时澄清（歧义词、属与种、时间范围不明）。
  另外写明：结果为空时不放宽条件；回复只引用 `total` 和口径复述。
- 只在本次工具集包含 `data.query` 时注入。以后新的领域（项目进度、质控等）各自一对 skill，互不干扰。

### 5.8 验证（确定性，不用子智能体）

- **口径复述**：由编译器根据规范化后的 IR 生成，例如“已完成分析的样本中，危害等级 5 级的物种数 ≥ 3”。
  模型必须原样给出，用户可以立刻发现理解上的偏差。
- **来源脚注**：“数据来源 GPAS · 截至 {asOf} · 共 {total} 个样本 · 结果完整”。
- **一致性断言**：`total` 等于上游返回的总数；分组之和与总数一致（不适用时跳过）；抽查当页行是否满足条件。
  断言失败时工具报错，不把结果交给模型。
- **结果为空不等于不存在**：结果为 0 时，复述口径并提示可能的原因，不自动放宽条件重查。

### 5.9 评测与防漂移

- **评测矩阵**：形状（A 到 H）× 字段 × 措辞（同义、口语、缩写），每条用例包含问题、期望的 IR 和期望的口径复述。
  注册表新增字段时，脚本自动生成该字段的模板用例，再由人补充真实措辞。
- **确定性部分**（校验、编译、复述、断言）由 `npm test` 运行。
- **模型部分**（问题 → IR）用 mock GPAS 定期运行并记录准确率。新增形状或领域时，评测准确率 ≥ 90% 才开放。
- **上游契约测试**：拉取上游元数据（§6.1）与注册表比对。字段改名、枚举变化、运算符被撤销时，CI 直接失败。
- **收集用户纠错**：用户的纠正（例如“我说的是属”）记入别名表和评测集。

---

## 6. 上游 GPAS API 修改建议

原则：**过滤、关联、聚合放在数据所在的地方完成；接口是通用的，能力用元数据声明。**
如果按问题逐个加接口，N 种问题就要 N 个接口；通用接口只需要一个，新增问题由加字段和加运算符来支持。

### 6.1 P0：元数据接口 `GET query/metadata`

上游公布可查询的实体、字段、类型、单位、运算符、字典和版本，作为两边对齐的契约：

```jsonc
{
  "version": "2026-10-01",
  "entities": {
    "sample": {
      "key": "analysisId",
      "fields": {
        "detectionType": { "type": "enum", "dict": "detection-types", "ops": ["in", "not_in"] },
        "uploadTime":    { "type": "time", "ops": ["between", "gte", "lte"], "grains": ["day", "month", "year"] }
      },
      "relations": { "detection": { "cardinality": "1:n" } }
    },
    "detection": {
      "fields": {
        "taxon":       { "type": "ref", "dict": "species", "ops": ["in", "not_in", "under"] },
        "hazardLevel": { "type": "ordinal", "range": [1, 5], "ops": ["eq", "gte", "lte"] },
        "abundance":   { "type": "number", "unit": "percent", "ops": ["gte", "lte"] }
      }
    }
  },
  "capabilities": { "predicates": ["has", "count", "and", "or", "not"], "groupBy": true, "compare": false }
}
```

本地注册表只引用这里存在的字段，命名口径和中文措辞仍由本地人工维护。
上游声明不支持的能力（如上例中的 `compare: false`），本地直接返回“暂不支持”。

### 6.2 P0：通用查询接口 `POST query/execute`

- **请求体**：§5.3 的 IR（已经规范化并注入了团队）。团队只从会话中取，请求中出现团队字段时返回 400。
- **响应**：

  ```jsonc
  {
    "code": 200,
    "asOf": "2026-10-11T09:30:00+08:00",
    "columns": [{ "name": "sampleName", "type": "text" }, { "name": "h5Count", "type": "integer" }],
    "dataPage": { "totalData": 37, "page": 1, "pageSize": 50, "dataList": [ … ] },
    "groups": null
  }
  ```

- **不接受 SQL 或任意表达式**，只接受元数据声明的字段和运算符。
- **限额**：谓词深度、IN 列表长度、分组基数、超时时间。超限返回明确的错误码（`too_expensive`、`unsupported_op`），
  不静默截断。
- `totalData` 必须是精确值；分页有上限（`pageSize` ≤ 100）。
- 上游可以**分期实现**：第一期只支持 sample 和 detection 两个实体，以及 `has`、`count`、`and`、`not`
  （覆盖 A、B、C、D）；第二期支持 `groupBy`、度量、`orderBy`（E、F）；第三期支持 `compare` 和更多实体。
  每一期通过元数据声明，本地不需要发版就能识别。

### 6.3 P0：通用字典接口 `GET dict/{name}?keyword=&limit=`

| 字典 | 每项内容 | 用途 |
|---|---|---|
| `detection-types` | `code, name, aliases[]` | “肠道”指哪个检测项目 |
| `species` | `taxId, taxCname, taxEname, synonyms[], rank, parentTaxId, lineage[], hazardIndex` | 俗名、缩写到 `taxId`；按属或科展开（`under`） |
| `hazard-levels` | `level, name, description` | 固定“五星”的含义和取值范围 |
| `microbial-types`、`sample-types` | `code, name` | 大类和样本类型 |

以后新增字典（地区、宿主、耐药基因等）沿用同一个接口，本地不需要新代码。

样本需要**增加检测项目字段**：上传时由用户填写或由项目继承，作为受控枚举保存。
目前四类 `sampleType` 表达不了“肠道微生物检测”。

### 6.4 上游数据模型建议

```sql
-- 维度：样本（分析任务）与物种
CREATE TABLE sample (analysis_id text PRIMARY KEY, team_id bigint, detection_type text, sample_type text,
                     analysis_status text, upload_time timestamptz, analysis_time timestamptz, total_reads bigint);
CREATE TABLE taxon  (tax_id text PRIMARY KEY, cname text, ename text, rank text, parent_tax_id text,
                     lineage text[], hazard_index smallint);

-- 事实：样本 × 物种的检出记录（完整结果，不是 brief 的 top 3）
CREATE TABLE detection (team_id bigint, analysis_id text, tax_id text, hazard_index smallint,
                        abundance numeric, only_matching int, category text,
                        PRIMARY KEY (analysis_id, tax_id));
CREATE INDEX ON detection (team_id, tax_id);         -- 物种 → 样本（形状 B）
CREATE INDEX ON detection (team_id, hazard_index);   -- 按危害等级（形状 C）
CREATE INDEX ON sample (team_id, detection_type, upload_time);

-- 热点聚合的预计算：分析完成或重跑时更新（形状 C、E）
CREATE TABLE sample_detection_summary (analysis_id text PRIMARY KEY, team_id bigint,
                                       h1 int, h2 int, h3 int, h4 int, h5 int, taxon_count int);
```

以后接耐药基因、毒力因子、质控指标时，各加一张事实表，并在元数据中声明与 `sample` 的关系。
查询接口和本地工具都不需要改。

### 6.5 P0：修正现有接口的契约

- `file/dual/merge/list`：每个样本只返回一行，`totalData` 按样本计数；`analysisStatus` 支持服务端过滤。
- 团队范围**只从会话中取**：现在 `merge/list` 由调用方传 `ownTeamId`，`file/result/list` 是否校验 `taskId`
  属于当前团队仍待确认（`docs/gpas-project-chat.md` 验收清单第 16 项）。新接口必须在服务端校验，跨团队请求返回 403。
- 统一字段名和单位：`taxid`/`taxId` 只保留一种；写明 `abundance`、`coverage` 的单位和 `hazardIndex` 的取值范围；
  时间统一用带时区的 ISO 8601。

### 6.6 版本与演进

- 元数据带 `version`。新增字段和运算符是兼容变更；改名或删除要先标记 `deprecated`，至少保留一个版本周期。
- 枚举代码一旦发布不再改名。
- p95 延迟 < 1 s（本应用的 GPAS 请求超时是 10 s）；返回 `asOf`，用于来源脚注和判断数据是否陈旧。

---

## 7. 新增一类问题时怎么做

按改动大小分级。越往下越少见，大多数新问题落在前两级：

| 级别 | 情况 | 例子 | 需要做的 |
|---|---|---|---|
| L0 新说法 | 已有形状和字段能表达 | “帮我捞一下有沙门的样本”“丰度超过 1% 的金葡样本” | 加评测用例；必要时在别名表里加俗名 |
| L1 新字段或度量 | 已有实体上多了一个字段 | 按采样省份筛选或统计；按测序平台筛选 | 上游在元数据和查询接口中加字段（有字典的加字典）→ 本地注册表加一条声明 → 自动生成的评测模板补上措辞 |
| L2 新业务口径 | 一个说法对应固定定义 | “高危样本” = 五星病原 ≥ 1 或四星 ≥ 3 | 注册表 `segments` 加一条，经业务方评审 |
| L3 新实体或关系 | 实体图里多了一种对象 | “检出 mecA 耐药基因的样本”“按项目或批次统计” | 上游加事实表或维度，并在元数据中声明关系 → 本地注册表加实体 → 补 skill 和评测 |
| L4 新查询形状 | IR 表达不了 | “同一患者 30 天内复检均阳性”这类时间窗口关联 | 扩展 IR 和编译器，上游实现对应运算符并在 `capabilities` 中声明，补评测。需要评审 |

每一级都**不新增工具、不改智能体循环**。L0 到 L2 不改 TypeScript 逻辑，只改声明和数据。

---

## 8. 本仓库改动清单

| 文件 | 内容 |
|---|---|
| `src/server/semantic/registry.ts` | 注册表定义与 `defineSemanticModel`（启动时校验） |
| `src/server/semantic/ir.ts` | 查询 IR 的 zod 定义、语义校验、规范化、成本检查 |
| `src/server/semantic/compile.ts`、`criteria.ts` | 编译为上游请求、生成口径复述（纯函数） |
| `src/server/semantic/metadata.ts` | 拉取并缓存上游元数据，与注册表做一致性比对 |
| `src/server/gpas/tools/data.catalog.ts`、`data.query.ts` | 两个固定工具，加入 `tools/index.ts` |
| `src/server/skills/sample-query/*.md` | knowledge（字段目录由脚本生成）和 runbook |
| `src/server/agent/tools.ts` | 按工具集注入 skill；instructions 增加“回复只引用 total 和口径复述” |
| `src/server/gpasContracts.ts` | `query` part 的 schema |
| `src/client/features/gpasQuery/` | 通用结果渲染：样本表格复用 `FileAnalysisCards`，分组和对比用图表 |
| `src/server/app.ts` | 查询结果翻页路由 |
| `tests/evals/sample-query/`、`src/server/semantic/*.test.ts` | 评测矩阵、编译器单测、上游契约测试（mock GPAS） |

---

## 9. 实施顺序

1. **对齐口径**：业务方、上游和本项目一起确认 §5.2 中待确认的各项，以及第一批要支持的形状（建议 A、B、C、D）。
2. **上游第一期**：元数据接口、`query/execute`（sample 和 detection；`has`/`count`/`and`/`not`）、字典接口、
   检测项目字段、现有接口契约修正。
3. **本项目第一期**：注册表、IR 与编译器（先写单测）→ `data.catalog`、`data.query` → skill → 通用结果展示 → 评测矩阵。
   上线门槛是评测准确率 ≥ 90%。
4. **第二期**：`groupBy`、度量、排名（E、F），图表展示。
5. **第三期**：对比（G）和新实体（项目、批次、耐药基因等），按第 7 节的 L3 流程逐个接入。

**过渡方案**（上游第一期上线前）：可以在 `data.query` 内部为形状 B、C 做有上限的服务端扇出：
先扫描出已完成分析的样本，再逐个请求 `file/result/list` 的全部页，在服务端过滤和计数。
上限设为 ≤ 50 个样本、≤ 200 次请求、并发 4，超出上限返回 `complete: false`，回复中必须说明。
工具接口和 IR 与正式版完全一致，上游接口就绪后只需要替换编译目标。
形状 A 中的“检测项目”需要等上游加字段；E 到 G 不做过渡。
