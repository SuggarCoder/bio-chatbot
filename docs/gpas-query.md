# GPAS 查询接入方案

本文是 bio-chatbot 接入 GPAS 查询接口的当前方案，取代《[跨样本查询：简化方案](sample-query-simple.md)》。

它要同时满足三个要求：

- **上游工作量小**：不需要 OpenAPI、通用查询语言、数据目录，也不需要改返回格式。
- **能回答跨样本的组合问题**：组合条件可以包含“并且”和“或者”。
- **以后接更多接口时，工具数量不变**。

更早的设计（`sample-query-data-agent.md`、`gpas-semantic-platform.md`、`gpas-openapi-plan.md` 等）保留为长期参考。

---

## 1. 总体设计

```text
用户提问
  ↓
模型从 3 个固定工具中选一个：
  user.profile   当前用户与团队
  gpas.query     所有只读查询，用 api 参数指定接口
  gpas.prepare   所有写操作，只生成确认表单
  ↓
服务端按“接口注册表”中该接口的那一条：校验条件 → 物种名换成编号 → 合并条件组 → 调用上游
  ↓
上游执行（一条 SQL，组内“并且”、组间“或者”），按现有格式返回
  ↓
服务端按注册表解析结果，生成口径说明，选择展示方式
```

四条原则：

1. **工具按类别固定，不按接口增加。** 新接口登记到注册表，不新增工具。
2. **每个上游接口在注册表中登记一条**，内容来自与上游约定的一张“接口约定表”。
3. **查询条件用条件组表示**：组内“并且”，组间“或者”。同一个条件传多个值也是“或者”。
4. **返回格式由上游决定，我们来适配**。双方只约定几条含义上的要求（第 2.1 节）。

---

## 2. 与上游的约定

### 2.1 通用约定（所有查询接口都遵守）

| # | 约定 | 原因 |
|---|---|---|
| 1 | 请求结构：`{ ownTeamId, anyOf: [条件组, …], orderBy, page, pageSize }`。不需要“或者”的接口只用一个条件组，也可以用 GET 平铺参数 | 同一种结构，上游的实现代码可以复用 |
| 2 | **校验 `ownTeamId` 与登录会话的团队一致**，不一致返回 403；按 ID 查询时同样校验对象属于当前团队 | 唯一的安全硬性要求 |
| 3 | 返回沿用 GPAS 现有的 `dataPage` 结构 | 上游不用设计新格式 |
| 4 | `totalData` 是符合条件的**业务对象数**，并且是精确值 | 模型会回答“共 N 个”，按文件行计数会给出错误答案 |
| 5 | 每个业务对象只返回一行，并带有它的 ID | 本地去重会让分页和总数对不上；没有 ID 无法“查看详情” |

“业务对象”指接口所查的东西，例如样本查询中是样本：双端的两个文件只算一个样本。

### 2.2 每个接口一张约定表

上游每提供一个查询接口，双方填一张约定表。这张表就是注册表的来源，不需要 OpenAPI。

| 项目 | 内容 | 谁填 |
|---|---|---|
| 接口 | 地址、方法 | 上游 |
| 用途 | 一句话说明能查什么 | 双方 |
| 条件 | 每个条件一行：条件名、中文名（同义词）、取值、SQL 条件示意 | 本项目起草，上游确认 |
| 上游列名 | 每个条件对应的数据库列 | 上游 |
| 业务对象 | 一行代表什么、`totalData` 数的是什么 | 上游确认 |
| 返回示例 | 一份真实的返回（去掉敏感信息） | 上游 |
| 单位与枚举 | 本项目要显示或计算的字段的单位、取值含义 | 上游，按需回答 |

### 2.3 上游不需要做的

- 不需要写 OpenAPI 或扩展字段，约定表就是文档；
- 不需要实现通用查询语言（任意嵌套、括号、取反）、数据目录、字典接口；
- 不需要改变现有接口的返回格式。

---

## 3. 第一个接口：样本查询 `sample.search`

### 3.1 能回答的问题

| 问题 | 条件组 |
|---|---|
| 所有做了肠道微生物检测的样本 | ① 检测项目 = 肠道 |
| 所有检出金黄色葡萄球菌的样本 | ① 检出物种 = 1280 |
| 所有鉴定到三个以上五星病原的样本 | ① 5 级物种数 ≥ 3 |
| 肠道样本中五星病原 ≥ 3 个的 | ① 检测项目 = 肠道，并且 5 级物种数 ≥ 3 |
| 同时检出金葡和大肠埃希菌的样本 | ① 同时检出 1280 和 562 |
| 肠道样本，或者检出金葡的样本 | ① 检测项目 = 肠道　**或**　② 检出物种 = 1280 |
| 临床样本中，检出金葡或者五星病原 ≥ 3 个的 | ① 临床，并且检出 1280　**或**　② 临床，并且 5 级物种数 ≥ 3 |
| 未检出 xx 的已分析样本 | ① 已完成分析，并且未检出 xx |
| xx 丰度 > 1% 的样本 | ① 检出 xx，丰度下限 1% |
| 2026 年上传的临床样本 | ① 临床，并且上传日期在 2026-01-01 至 2026-12-31 |
| 在上次结果中再筛临床样本 | 本项目在上次的每个条件组中加上“临床”，再查一次 |
| 肠道和呼吸道样本对比 | 本项目查两次，自己比较两个总数 |

“临床样本中，……”这一行是“（A 或 B）并且 C”：把共同条件 C 放进每个组。这一步由本项目的服务端完成（第 4.3 节），模型和上游都不用处理。

**暂不支持**：对整个条件组取反，如“不是（肠道并且五星 ≥ 3）”；带额外限定的计数，如“细菌里的五星病原 ≥ 3 个”。
遇到时，助手如实说明暂不支持。以后需要时往条件表里加条件。

**为什么“或者”要上游做**：同一个样本可能满足多个组，本项目分开查询再合并会重复计数，分页也无法正确合并。
只有在一条 SQL 里用 `OR` 连接，总数和分页才准确。

### 3.2 接口与条件

接口：`POST /sample/search`（名称可由上游决定）。它是只读查询，用 POST 只是因为多个条件组放不进 URL。

```json
{
  "ownTeamId": "<会话团队>",
  "anyOf": [
    { "detectionType": ["GUT_MICROBIOME"], "hazardLevel": 5, "minHazardCount": 3 },
    { "taxIds": ["1280"] }
  ],
  "orderBy": "uploadTime",
  "page": 1,
  "pageSize": 20
}
```

- `anyOf`：1–5 个条件组，每组至少一个条件；满足多个组的样本只算一次、只返回一行。
- `orderBy`：`uploadTime`、`analysisTime`、`hazardCount`（均为降序），默认 `uploadTime`。
- `pageSize` ≤ 100。

条件组中的条件（都可选，同一组内取交集）：

| 条件 | 中文名（同义词） | 取值 | SQL 条件（示意） | 上游列名 | 确认 |
|---|---|---|---|---|---|
| `detectionType` | 检测项目（检测类型、检测套餐） | 见第 3.4 节，数组 | `s.detection_type IN (…)` | | |
| `sampleType` | 样本类型 | `clinic`、`media`、`environment`、`lab`，数组 | `s.sample_type IN (…)` | | |
| `analysisDone` | 已完成分析（已鉴定、有结果） | `true` | `s.analysis_status = 'analysisverified'` | | |
| `sampleName` | 样本名 | 文本 | `s.sample_name LIKE '%…%'` | | |
| `uploadFrom` / `uploadTo` | 上传时间 | `YYYY-MM-DD`，含当天 | `s.upload_time >= … AND s.upload_time < 次日` | | |
| `taxIds` | 检出物种（任一） | NCBI taxId 数组，最多 20 个 | `EXISTS (检出表 d WHERE d.analysis_id = s.analysis_id AND d.tax_id IN (…))` | | |
| `minAbundance` | 丰度下限（%），与 `taxIds` 一起用 | 0–100 | 在上一行的 EXISTS 中加 `AND d.abundance >= …` | | |
| `allTaxIds` | 同时检出（全部） | taxId 数组，最多 5 个 | 每个 taxId 一个 `EXISTS (… d.tax_id = …)`，用 AND 连接 | | |
| `excludeTaxIds` | 未检出物种 | 同 `taxIds` | `NOT EXISTS (… d.tax_id IN (…))` | | |
| `hazardLevel` | 危害等级（星级） | 1–5 | 与下一行一起用 | | |
| `minHazardCount` | 该等级物种数下限 | 正整数 | `该样本 hazard_index = hazardLevel 的物种数 >= …` | | |

### 3.3 返回

**每行的结构与现有的 `file/dual/merge/list` 相同**（`isPair`、`file1`、`file2`，文件上有 `analysisId`、`briefAnalysis` 等），
只在文件上增加 `detectionType`。这样本项目现有的解析代码和多样本表格（样本名、物种组成、检出种数、最高风险、Reads、查看详情）都能直接使用。

与 `merge/list` 不同的只有通用约定的第 4、5 条：`totalData` 按样本计数，每个样本只返回一行。

可选字段（有更好，没有也能显示）：

| 字段 | 含义 | 用途 |
|---|---|---|
| `hazardCounts` | 该样本各危害等级的物种数，如 `{ "5": 3, "4": 6 }` | 表格直接显示“五星 3 个” |
| `matchedTaxa` | 该样本中命中的物种（所有组 `taxIds`、`allTaxIds` 的并集） | 表格显示“命中：金黄色葡萄球菌” |
| `matchedGroups` | 该样本满足的条件组序号（从 0 开始） | 表格标出样本是因哪个条件被选中 |

### 3.4 检测项目代码与物种名查询

检测项目代码（上游填写全部取值；第二行只是示例）：

| 代码 | 中文名 | 常见说法 |
|---|---|---|
| `GUT_MICROBIOME` | 肠道微生物检测 | 肠道、肠道菌群 |
| `RESPIRATORY` | 呼吸道检测（示例） | 呼吸道 |

物种名查询（新增，很小）：`GET /species/search?keyword=金黄色&limit=10`，返回 `[{ taxId, taxCnName, taxEnName }]`。
上游已有物种表（检出明细中有中英文名），按名称模糊查询即可。本项目用它把用户说的物种名换成 taxId。

### 3.5 上游实现

数据准备：

| 需要 | 说明 |
|---|---|
| 样本有“检测项目”字段 | 现在没有的话需要新增，并在上传或项目层面填写。这是问题一的前提 |
| 检出明细表加索引 | 检出明细（样本 × 物种）已经存在，加索引 `(team_id, tax_id)`、`(analysis_id)` |
| 每个样本各危害等级的物种数 | 数据量小时直接 `GROUP BY`；量大时在分析完成时写入汇总表（每个样本一行：h1…h5） |

接口实现就是带动态条件的列表查询：写好一个组的条件，再用循环把几个组用 `OR` 连起来。以 MyBatis 为例：

```xml
<select id="searchSamples" resultType="SampleRow">
  SELECT s.*, h.h1, h.h2, h.h3, h.h4, h.h5
  FROM sample s
  LEFT JOIN sample_hazard_summary h ON h.analysis_id = s.analysis_id
  WHERE s.team_id = #{teamId}                                   <!-- 已与登录会话核对 -->
    AND <foreach collection="anyOf" item="g" open="(" separator=" OR " close=")">
      ( 1 = 1
        <if test="g.detectionType != null and g.detectionType.size() > 0">
          AND s.detection_type IN <foreach collection="g.detectionType" item="t" open="(" separator="," close=")">#{t}</foreach>
        </if>
        <if test="g.sampleType != null and g.sampleType.size() > 0">
          AND s.sample_type IN <foreach collection="g.sampleType" item="t" open="(" separator="," close=")">#{t}</foreach>
        </if>
        <if test="g.analysisDone">
          AND s.analysis_status = 'analysisverified'
        </if>
        <if test="g.taxIds != null and g.taxIds.size() > 0">
          AND EXISTS (SELECT 1 FROM detection d WHERE d.analysis_id = s.analysis_id
                      AND d.tax_id IN <foreach collection="g.taxIds" item="x" open="(" separator="," close=")">#{x}</foreach>
                      <if test="g.minAbundance != null">AND d.abundance &gt;= #{g.minAbundance}</if>)
        </if>
        <if test="g.allTaxIds != null">
          <foreach collection="g.allTaxIds" item="x">
            AND EXISTS (SELECT 1 FROM detection d WHERE d.analysis_id = s.analysis_id AND d.tax_id = #{x})
          </foreach>
        </if>
        <if test="g.excludeTaxIds != null and g.excludeTaxIds.size() > 0">
          AND NOT EXISTS (SELECT 1 FROM detection d WHERE d.analysis_id = s.analysis_id
                          AND d.tax_id IN <foreach collection="g.excludeTaxIds" item="x" open="(" separator="," close=")">#{x}</foreach>)
        </if>
        <if test="g.hazardLevel != null and g.minHazardCount != null">
          AND (CASE #{g.hazardLevel} WHEN 1 THEN h.h1 WHEN 2 THEN h.h2 WHEN 3 THEN h.h3 WHEN 4 THEN h.h4 ELSE h.h5 END) &gt;= #{g.minHazardCount}
        </if>
      )
    </foreach>
  ORDER BY s.upload_time DESC
</select>
```

- 在 Java 代码中先校验：`anyOf` 有 1–5 个组，每组至少一个条件（空组会让 `1 = 1` 匹配全部样本）。
- 所有值用 `#{}` 绑定，不拼接字符串；`orderBy` 只接受约定的取值，在代码里映射成固定列名。
- 总数用现有的分页插件（如 PageHelper）计算。因为是一条 SQL，满足多个组的样本自然只算一次。
- 查出当页样本后，按现有方式组装成 `merge/list` 的行结构；可选字段在内存中补充。

另外，现有的 `GET /file/result/list` 需要补上团队校验：`taskId` 不属于当前团队时返回 403。

---

## 4. 本项目实现

### 4.1 工具

| 工具 | 覆盖 | 说明 |
|---|---|---|
| `user.profile` | 当前用户与团队 | 保持现状 |
| `gpas.query` | 所有只读查询接口 | 用 `api` 参数指定接口，例如 `sample.search` |
| `gpas.prepare` | 所有写操作 | 只生成确认表单，用户确认后才执行（现有 `project.initialize` 的机制）；用 `action` 参数指定操作 |

不管以后接多少接口，工具都是这 3 个，远低于 `AGENT_TOOL_LIMIT = 8`。名称到代码的查找（物种名换成 taxId）在服务端内部完成，不单独占用工具。

### 4.2 接口注册表

每个查询接口登记一条，内容来自它的约定表：

```ts
// src/server/gpas/apis.ts（示意）
export const gpasApis = defineApis({
  'sample.search': {
    label: '跨样本查询',
    use: '按检测项目、物种、危害等级等条件筛选团队的样本',
    examples: ['所有肠道微生物检测的样本', '检出金葡的样本', '三个以上五星病原的样本'],
    request: { method: 'POST', path: 'sample/search', groups: true, conditions: {
      detectionType:  { label: '检测项目', synonyms: ['检测类型', '检测套餐'], type: 'enumList',
                        values: { GUT_MICROBIOME: '肠道微生物检测' } },
      sampleType:     { label: '样本类型', type: 'enumList',
                        values: { clinic: '临床样本', media: '虫媒样本', environment: '环境样本', lab: '实验室样本' } },
      analysisDone:   { label: '已完成分析', type: 'flag' },
      taxNames:       { label: '检出物种（任一）', type: 'taxonList', max: 20, upstream: 'taxIds' },
      allTaxNames:    { label: '同时检出（全部）', type: 'taxonList', max: 5, upstream: 'allTaxIds' },
      excludeTaxNames:{ label: '未检出物种', type: 'taxonList', max: 20, upstream: 'excludeTaxIds' },
      minAbundance:   { label: '丰度下限（%）', type: 'number', min: 0, max: 100, requires: 'taxNames' },
      hazardLevel:    { label: '危害等级', synonyms: ['星级'], type: 'int', min: 1, max: 5, requires: 'minHazardCount' },
      minHazardCount: { label: '该等级物种数下限', type: 'int', min: 1, requires: 'hazardLevel' },
      uploadFrom:     { label: '上传日期起', type: 'date' },
      uploadTo:       { label: '上传日期止', type: 'date' },
    } },
    result: { parse: parseMergeListRows, view: 'sampleTable' },   // 复用现有 file.list 的解析和表格
  },
  'sample.detail': {
    label: '单个样本的检出明细',
    use: '查看某个样本检出了哪些物种、风险等级和可信度',
    examples: ['KY14599 的检测结果', '这个样本的细菌明细'],
    request: { method: 'GET', path: 'file/result/list', conditions: {
      analysisId:  { label: '分析 ID', upstream: 'taskId', type: 'id', required: true },
      speciesType: { label: '大类', type: 'enum', values: { bacteria: '细菌', viral: '病毒', fungi: '真菌' } },
    } },
    result: { parse: parseResultRows, view: 'resultPanel' },      // 复用现有 file.result
  },
  'project.progress': {
    label: '项目样本提交进度',
    use: '四类样本的计划数量、已提交数量和完成率',
    examples: ['我的任务进度', '我们组临床样本还差多少'],
    request: { method: 'POST', path: 'summary/submit/info/{team}', conditions: {} },
    result: { parse: parseSummary, view: 'progressChart' },       // 复用现有 project.progress
  },
})
```

每条只写五样东西：用途和例句、上游地址、条件、解析函数、展示方式。
解析函数和展示组件复用现有代码：现有工具里的 `run`、`toModel`、`toReply` 拆进 `parse` 和 `view`。

### 4.3 `gpas.query` 的参数和处理流程

参数：

```ts
{
  api: string,          // 接口名，必须在注册表中
  all?: 条件组,          // 所有组共同的条件
  anyOf?: 条件组[],      // 备选条件组，1–5 个；不传时只用 all
  orderBy?, page?, pageSize?,
  describe?: true       // 只返回该接口的条件清单，不查询
}
```

模型可以按用户的原话填。例如“临床样本中，检出金葡或者五星病原 ≥ 3 个”：
`all: { sampleType: ['clinic'] }`，`anyOf: [{ taxNames: ['金黄色葡萄球菌'] }, { hazardLevel: 5, minHazardCount: 3 }]`。

服务端处理：

1. **找到接口**：`api` 不在注册表中时，返回接口目录。
2. **校验条件**：按该接口的条件表逐个校验取值和依赖关系（如 `minHazardCount` 必须和 `hazardLevel` 一起传）。
   条件不认识或漏了必填项时，返回该接口的条件清单（中文名和取值），模型据此改正。
3. **物种名换成 taxId**：调用 `/species/search`。唯一匹配就替换；有多个候选时返回候选，由模型请用户选择。
4. **合并共同条件**：把 `all` 合并进每个组，变成上游只需要理解的“组内并且、组间或者”。
   `all` 和某个组限定了同一字段时，按下表合并：

   | 字段 | 合并方式 |
   |---|---|
   | 检测项目、样本类型 | 取交集；交集为空的组直接去掉 |
   | 上传日期 | 起始取较晚的，截止取较早的；范围为空的组直接去掉 |
   | 已完成分析 | 任一方要求即要求 |
   | 同时检出、未检出 | 取并集 |
   | 检出物种（任一） | 一方只有一个物种时移到“同时检出”；两方都有多个物种时无法用一个组表达，返回暂不支持 |
   | 危害等级计数 | 等级相同取较大的下限；等级不同无法表达，返回暂不支持 |

   合并后超过 5 个组时报错，请用户缩小范围。
5. **调用上游**：团队取自会话，条件名按 `upstream` 换成上游名称。
6. **解析与检查**：用该接口的解析函数解析；检查行数不超过 `pageSize`。
7. **口径说明**：用条件的中文名生成，例如“样本类型为临床样本，并且（检出金黄色葡萄球菌，或者危害等级 5 级的物种数 ≥ 3）”。
8. **返回**：给模型的是总数、口径说明和精简结果；给界面的是该接口的展示方式（如样本表格）。翻页由服务端用同一组条件重新请求，不经过模型。

### 4.4 模型怎么知道有哪些接口和条件

- **接口目录**：`gpas.query` 的工具说明里列出全部接口，每个接口一行（名称、用途、一两个例句）。
- **条件说明**：接口不多时，直接写在工具说明里；接口多了以后改为按需提供，即第 4.3 节第 2 步的条件清单，或用 `describe: true` 主动获取。
- **工具参数保持通用**（`api`、`all`、`anyOf`、分页），具体条件由服务端按接口校验，工具定义不会随接口增多而变大。

### 4.5 一次请求的样子

用户问：“临床样本里，检出金葡或者五星病原三个以上的有哪些？”

```text
模型 → gpas.query     { "api": "sample.search",
                        "all": { "sampleType": ["clinic"] },
                        "anyOf": [ { "taxNames": ["金黄色葡萄球菌"] }, { "hazardLevel": 5, "minHazardCount": 3 } ] }
服务端 → GPAS        GET /species/search?keyword=金黄色葡萄球菌        → 唯一匹配 taxId 1280
服务端                校验条件，合并共同条件，生成口径说明
服务端 → GPAS        POST /sample/search
                     { "ownTeamId": "<会话团队>",
                       "anyOf": [ { "sampleType": ["clinic"], "taxIds": ["1280"] },
                                  { "sampleType": ["clinic"], "hazardLevel": 5, "minHazardCount": 3 } ],
                       "page": 1, "pageSize": 20 }
GPAS → 服务端        { code: 200, dataPage: { totalData: 12, dataList: [ merge/list 结构的行 … ] } }
服务端 → 模型        { total: 12, criteria: "样本类型为临床样本，并且（检出金黄色葡萄球菌，或者危害等级 5 级的物种数 ≥ 3）", samples: [...] }
模型 → 用户          “共 12 个样本……”，下方是样本表格
```

---

## 5. 接入新接口的流程

| 步骤 | 谁做 | 内容 |
|---|---|---|
| 1 | 双方 | 填写接口约定表（第 2.2 节） |
| 2 | 上游 | 按通用约定实现接口（第 2.1 节） |
| 3 | 本项目 | 注册表加一条；返回格式是新的就写一个解析函数；展示优先复用已有组件 |
| 4 | 本项目 | 加评测用例：这个接口的常见问法，检查模型能选对 `api`、填对条件 |

**不新增工具**。只有两种例外：写操作走 `gpas.prepare` 的表单；文件上传这类有特殊交互的，继续用专用通道。

以后加条件也一样：约定表加一行，上游加一段 SQL 条件，注册表加一行。

---

## 6. 现有工具的迁移

现在有 6 个工具：`user.profile`、`project.progress`、`project.status`、`project.initialize`、`file.list`、`file.result`。按接口逐个迁移：

1. 样本查询一开始就做成 `gpas.query` 的 `sample.search`，不单独建工具；
2. `file.list`、`file.result`、`project.progress`、`project.status` 逐个改为注册表条目；
3. `project.initialize` 改为 `gpas.prepare` 的一个操作；
4. 全部迁完后，工具从 6 个减到 3 个。

**风险**：模型从“选工具”变成“在一个工具里选 `api`”，难度差不多，但接口目录的写法会直接影响准确率。
每一步迁移前，先为现有问法（`docs/gpas-project-chat.md` 中的各类说法）建立评测基线；迁移后准确率不低于基线再切换。

---

## 7. 实施顺序

1. **对齐约定**（1–2 次会议）：通用约定第 2.1 节；样本查询的约定表（上游列名、确认、真实返回示例）；检测项目的全部代码。
2. **上游**：样本查询接口、物种名查询接口、检测项目字段；`file/result/list` 补团队校验。
3. **本项目**：接口注册表、`gpas.query`（含条件组合并）、`sample.search` 条目、评测用例。
4. **迁移**：按第 6 节把现有工具逐个迁入注册表。
5. **第二期**：样本统计接口 `POST /sample/stats`（请求同样本查询，另加 `groupBy`：`month`、`detectionType`、`sampleType`、`taxId`），
   用于“每月检出 xx 的样本数”“最常见的五星病原”；按需要往条件表里加条件。

---

## 8. 以后的扩展

- **接口非常多**：单个 `gpas.query` 下的接口超过三十个左右时，按领域拆成几个查询工具（如 `gpas.query_sample`、`gpas.query_project`）。工具数量只随领域增长。
- **更复杂的条件**：对整组取反、带额外限定的计数，需要时作为新条件加入条件表，不引入通用查询语言。
