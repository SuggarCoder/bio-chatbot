# 跨样本查询：简化方案

> **已被取代**：本文已整合进《[GPAS 查询接入方案](gpas-query.md)》，以新文档为准。本文仅保留修改记录。

GPAS 上游评估后认为之前的方案工作量过大（OpenAPI 扩展字段、通用查询语言、数据目录和字典接口）。
本方案只保留回答问题必需的部分，上游按熟悉的方式做**一个列表接口加一组固定的筛选条件**。

与之前方案的差别：

| | 之前 | 现在 |
|---|---|---|
| 注册表 | 上游发布 OpenAPI 和数据目录，本项目在其上加语义层 | 双方事先约定一张**条件表**（第 2 节），签字后各自实现 |
| 查询 | 通用查询语言（任意嵌套的条件树、子查询、分组），上游翻译成 SQL | **条件组**：组内各条件是“并且”，组与组之间是“或者”；每个条件在上游对应一段固定的 SQL |
| 上游新接口 | 数据目录、字典、通用查询、四个替代接口 | 样本查询，加一个物种名查询；样本统计放在第二期 |
| 返回格式 | 统一新结构 | 沿用 GPAS 现有的 `dataPage` 结构 |
| 文档 | OpenAPI 3.1 | 本文第 2、3、4 节的三张表 |

之前的设计文档（`sample-query-data-agent.md`、`gpas-semantic-platform.md`、`gpas-openapi-plan.md`）保留为长期参考，当前以本文为准。

---

## 1. 能回答哪些问题

查询由一个或几个**条件组**组成：

- 一个条件组内的各条件同时满足（“并且”）；
- 样本满足任意一个条件组即可（“或者”）；
- 同一个条件传多个值也是“或者”，如检测项目传“肠道、呼吸道”。

| 问题 | 条件组 |
|---|---|
| 所有做了肠道微生物检测的样本 | ① 检测项目 = 肠道 |
| 所有检出金黄色葡萄球菌的样本 | ① 检出物种 = 1280 |
| 同时检出金葡和大肠埃希菌的样本 | ① 同时检出 1280 和 562 |
| 所有鉴定到三个以上五星病原的样本 | ① 危害等级 5 的物种数 ≥ 3 |
| 肠道样本中五星病原 ≥ 3 个的 | ① 检测项目 = 肠道，并且 5 级物种数 ≥ 3 |
| **肠道样本，或者检出金葡的样本** | ① 检测项目 = 肠道　**或**　② 检出物种 = 1280 |
| **五星病原 ≥ 3 个，或者检出沙门菌** | ① 5 级物种数 ≥ 3　**或**　② 检出物种 = 沙门菌 |
| **临床样本中，检出金葡或者五星病原 ≥ 3 个的** | ① 临床，并且检出 1280　**或**　② 临床，并且 5 级物种数 ≥ 3 |
| 未检出 xx 的已分析样本 | ① 已完成分析，并且未检出 xx |
| xx 丰度 > 1% 的样本 | ① 检出 xx，丰度下限 1% |
| 2026 年上传的临床样本 | ① 临床，并且上传日期在 2026-01-01 到 2026-12-31 |
| 在上次结果中再筛临床样本 | 本项目在上次的每个条件组里都加上“临床”，再查一次 |
| 肠道和呼吸道样本对比 | 本项目查两次（各一个条件组），自己对比两个总数 |
| 每月检出 xx 的样本数 | 第二期的样本统计接口（第 4 节） |

倒数第五行（“临床样本中，……”）是“（A 或 B）并且 C”的写法：把共同条件 C 放进每个组。
这一步由本项目的服务端完成（第 6.2 节），模型和上游都不用处理。

**仍不支持**（需要时再加条件）：

- 对整个条件组取反，如“不是（肠道并且五星 ≥ 3）”的样本；
- “细菌里的五星病原 ≥ 3 个”这类带额外限定的计数。

遇到时，助手如实说明暂不支持。

**为什么“或者”要由上游做，而不是本项目查几次再合并**：同一个样本可能满足多个组，分开查询会重复计数，
分页也无法正确合并。只有在一条 SQL 里用 `OR` 连接，总数和分页才准确。

---

## 2. 约定表一：查询条件（注册表）

这张表就是注册表。双方确认后，上游按“SQL 条件”一列实现，本项目按“中文名、同义词”一列让模型使用。
“上游列名”和“确认”两列由上游填写。

### 2.1 接口与请求结构

接口：`POST /sample/search`（名称可由上游决定）。它是只读查询；用 POST 只是因为多个条件组放不进 URL。

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

| 字段 | 含义 | 要求 |
|---|---|---|
| `ownTeamId` | 团队 | 沿用现有接口的传法；上游**必须校验它与登录会话的团队一致**，不一致返回 403。这是唯一的安全硬性要求 |
| `anyOf` | 条件组列表，组之间是“或者” | 1–5 个组；每个组至少包含一个条件；只有一个组时就是普通的“并且”查询 |
| `orderBy` | 排序 | `uploadTime`、`analysisTime`、`hazardCount`（均为降序），默认 `uploadTime` |
| `page` / `pageSize` | 分页 | `pageSize` ≤ 100 |

满足多个组的样本只算一次，只返回一行。

### 2.2 条件组中的条件

一个条件组里的字段都是可选的，同时出现时取交集（AND）。

| 条件 | 中文名（同义词） | 取值 | SQL 条件（示意） | 上游列名 | 确认 |
|---|---|---|---|---|---|
| `detectionType` | 检测项目（检测类型、检测套餐） | 见约定表三，数组 | `s.detection_type IN (…)` | | |
| `sampleType` | 样本类型 | `clinic`、`media`、`environment`、`lab`，数组 | `s.sample_type IN (…)` | | |
| `analysisDone` | 已完成分析（已鉴定、有结果） | `true` | `s.analysis_status = 'analysisverified'` | | |
| `sampleName` | 样本名 | 文本 | `s.sample_name LIKE '%…%'` | | |
| `uploadFrom` / `uploadTo` | 上传时间 | `YYYY-MM-DD`，含当天 | `s.upload_time >= … AND s.upload_time < 次日` | | |
| `taxIds` | 检出物种（任一） | NCBI taxId 数组，最多 20 个 | `EXISTS (检出表 d WHERE d.analysis_id = s.analysis_id AND d.tax_id IN (…))` | | |
| `minAbundance` | 丰度下限（%），与 `taxIds` 一起用 | 0–100 的数字 | 在上一行的 EXISTS 中加 `AND d.abundance >= …` | | |
| `allTaxIds` | 同时检出（全部） | NCBI taxId 数组，最多 5 个 | 每个 taxId 一个 `EXISTS (… d.tax_id = …)`，用 AND 连接 | | |
| `excludeTaxIds` | 未检出物种 | 同 `taxIds` | `NOT EXISTS (… d.tax_id IN (…))` | | |
| `hazardLevel` | 危害等级（星级） | 1–5 | 与下一行一起用 | | |
| `minHazardCount` | 该等级物种数下限 | 正整数 | `该样本 hazard_index = hazardLevel 的物种数 >= …` | | |

**以后加问题**：在这张表里加一行，上游加一段 SQL 条件，本项目在注册表文件里加一行。三方都只改一处。

---

## 3. 约定表二：返回字段

沿用 GPAS 现有的返回结构：

```json
{
  "code": 200,
  "message": "success",
  "dataPage": {
    "totalData": 37,
    "dataList": [
      {
        "analysisId": "30001",
        "sampleName": "DEMO-001",
        "sampleType": "clinic",
        "detectionType": "GUT_MICROBIOME",
        "analysisStatus": "analysisverified",
        "uploadTime": "2026-09-01 10:00:00",
        "analysisTime": "2026-09-02 08:30:00",
        "hazardCounts": { "1": 120, "2": 60, "3": 25, "4": 6, "5": 3 },
        "matchedGroups": [0],
        "matchedTaxa": [{ "taxId": "1280", "taxCnName": "金黄色葡萄球菌", "hazardIndex": 4, "abundance": 0.82 }]
      }
    ]
  }
}
```

| 字段 | 含义 | 要求 | 确认 |
|---|---|---|---|
| `totalData` | 符合条件的**样本数** | 精确值；双端两个文件只算一个样本；满足多个组的样本只算一次 | |
| `analysisId` | 分析任务 ID，即详情接口的 `taskId` | 每个样本一行，不再按 R1/R2 返回两行 | |
| `sampleName` | 样本名 | | |
| `sampleType`、`detectionType`、`analysisStatus` | 同约定表一 | | |
| `uploadTime`、`analysisTime` | 时间 | 写明时区 | |
| `hazardCounts` | 各危害等级的物种数 | 未分析的样本可为空 | |
| `matchedGroups` | 该样本满足的条件组序号（从 0 开始） | 可选；有了它，界面能标出每个样本是因为哪个条件被选中 | |
| `matchedTaxa` | 该样本中命中的物种（取所有组 `taxIds`、`allTaxIds` 的并集） | 没有任何组传物种条件时可省略 | |
| `abundance` | 丰度 | 写明单位（% 还是 0–1） | |

---

## 4. 约定表三：枚举与其它接口

**检测项目代码**（上游填写全部取值；下表第二行只是示例）：

| 代码 | 中文名 | 常见说法 |
|---|---|---|
| `GUT_MICROBIOME` | 肠道微生物检测 | 肠道、肠道菌群 |
| `RESPIRATORY` | 呼吸道检测（示例） | 呼吸道 |
| …… | | |

**物种名查询**（新增，很小）：`GET /species/search?keyword=金黄色&limit=10`，
返回 `[{ taxId, taxCnName, taxEnName }]`。上游已有物种表（检出明细里有中英文名），按名称模糊查即可。
本项目用它把用户说的“金葡”“大肠杆菌”换成 taxId；多个候选时请用户选择。

**样本统计**（第二期）：`POST /sample/stats`，请求体与样本查询相同，另加
`groupBy`（`month`、`detectionType`、`sampleType`、`taxId` 之一），返回 `[{ key, label, count }]`，
用于“每月检出 xx 的样本数”“最常见的五星病原”。

---

## 5. 上游怎么适配

### 5.1 数据准备

| 需要 | 说明 |
|---|---|
| 样本有“检测项目”字段 | 如果现在没有，需要新增并在上传或项目层面填写。这是问题一的前提 |
| 检出明细表有索引 | 检出明细（样本 × 物种）已经存在（`file/result/list` 就在查它），加索引 `(team_id, tax_id)`、`(analysis_id)` |
| 每个样本各危害等级的物种数 | 数据量小时可以直接 `GROUP BY` 计算；量大时在分析完成时写入一张汇总表（每个样本一行：h1…h5） |

### 5.2 接口实现

就是一个带动态条件的列表查询：把一个组的条件写好，再用循环把几个组用 `OR` 连起来。以 MyBatis 为例（其它框架同理）：

```xml
<select id="searchSamples" resultType="SampleRow">
  SELECT s.analysis_id, s.sample_name, s.sample_type, s.detection_type, s.analysis_status,
         s.upload_time, s.analysis_time, h.h1, h.h2, h.h3, h.h4, h.h5
  FROM sample s
  LEFT JOIN sample_hazard_summary h ON h.analysis_id = s.analysis_id
  WHERE s.team_id = #{teamId}                                   <!-- 来自登录会话 -->
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

- 组内条件和之前单组的写法完全一样，只是外面多了一层 `foreach`，用 `OR` 连接。
- 在 Java 代码里先校验：`anyOf` 有 1–5 个组，每组至少一个条件（避免空组让 `1 = 1` 匹配全部样本）。
- 所有值都用 `#{}` 绑定，不拼接字符串。`orderBy` 只接受约定的取值，在代码里映射成固定的列名。
- 总数可以用现有的分页插件（如 PageHelper）自动计算；因为是一条 SQL，满足多个组的样本自然只算一次。
- `matchedTaxa`：查出当页样本后，再按 `analysisId IN (…) AND tax_id IN (所有组 taxIds 和 allTaxIds 的并集)` 查一次检出明细。
- `matchedGroups`（可选）：对当页样本在内存中逐组判断，或者在 SELECT 中为每个组生成一个 `CASE WHEN … THEN 1` 列。

### 5.3 上游不需要做的

- 不需要写 OpenAPI 或任何扩展字段；约定表就是文档。
- 不需要实现通用查询语言（任意嵌套、括号、取反）、数据目录、字典接口、统一返回结构。
- 不需要改动现有接口（`file/result/list` 的团队校验除外，见第 2.1 节的安全要求）。

---

## 6. 本项目怎么做

### 6.1 注册表文件

约定表一和表三在本项目中写成一个文件，工具说明、参数校验、口径说明都从它生成：

```ts
// src/server/semantic/sampleSearch.ts（示意）
export const sampleSearchConditions = defineConditions({
  detectionType: { label: '检测项目', synonyms: ['检测类型', '检测套餐'], type: 'enumList',
                   values: { GUT_MICROBIOME: '肠道微生物检测' } },
  sampleType:    { label: '样本类型', type: 'enumList',
                   values: { clinic: '临床样本', media: '虫媒样本', environment: '环境样本', lab: '实验室样本' } },
  analysisDone:  { label: '已完成分析', type: 'flag' },
  taxNames:      { label: '检出物种（任一）', type: 'taxonList', max: 20, upstream: 'taxIds' },
  allTaxNames:   { label: '同时检出（全部）', type: 'taxonList', max: 5, upstream: 'allTaxIds' },
  excludeTaxNames: { label: '未检出物种', type: 'taxonList', max: 20, upstream: 'excludeTaxIds' },
  minAbundance:  { label: '丰度下限（%）', type: 'number', min: 0, max: 100, requires: 'taxNames' },
  hazardLevel:   { label: '危害等级', synonyms: ['星级'], type: 'int', min: 1, max: 5, requires: 'minHazardCount' },
  minHazardCount:{ label: '该等级物种数下限', type: 'int', min: 1, requires: 'hazardLevel' },
  uploadFrom:    { label: '上传日期起', type: 'date' },
  uploadTo:      { label: '上传日期止', type: 'date' },
})
```

### 6.2 查询工具：`gpas.query`

样本查询不单独做成一个工具，而是作为通用查询工具 `gpas.query` 的一个接口（`api: 'sample.search'`），
原因见第 8 节。工具参数：

```ts
{
  api: 'sample.search',  // 接口名，来自接口注册表（第 8.3 节）
  all?:   条件组,      // 所有组共同的条件（可选）
  anyOf?: 条件组[],    // 备选条件组，1–5 个（可选；不传时只用 all）
  orderBy?, page?, pageSize?
}
```

- **模型可以直接按用户的说法填**：“临床样本中，检出金葡或者五星病原 ≥ 3 个”填成
  `all: { sampleType: ['clinic'] }`、`anyOf: [{ taxNames: ['金黄色葡萄球菌'] }, { hazardLevel: 5, minHazardCount: 3 }]`。
- **服务端把 `all` 合并进每个组**再发给上游，变成上游只需要理解的“组内并且、组间或者”。
  `all` 和某个组限定了同一个字段时，按下面的规则合并：

  | 字段 | 合并方式 |
  |---|---|
  | 检测项目、样本类型 | 取交集；交集为空的组直接去掉 |
  | 上传日期 | 起始取较晚的，截止取较早的；范围为空的组直接去掉 |
  | 已完成分析 | 任一方要求即要求 |
  | 同时检出（`allTaxNames`）、未检出 | 取并集 |
  | 检出物种（任一） | 一方只有一个物种时，把它移到“同时检出”；两方都有多个物种时无法用一个组表达，返回暂不支持 |
  | 危害等级计数 | 等级相同取较大的下限；等级不同无法表达，返回暂不支持 |

  合并后超过 5 个组时报错，请用户缩小范围。
- **物种名由服务端换成 taxId**：模型传 `taxNames`，服务端调用 `/species/search`；
  唯一匹配就换成 taxId，否则把候选返回给模型，由模型请用户选择。
- 服务端校验取值和依赖关系（如 `minHazardCount` 必须和 `hazardLevel` 一起传），生成口径说明，
  例如“样本类型为临床样本，并且（检出金黄色葡萄球菌，或者危害等级 5 级的物种数 ≥ 3）”。
- 结果以多样本表格展示（复用现有表格）；有 `matchedGroups` 时在表格里标出命中的条件。
  翻页由服务端用同一组条件重新请求，不经过模型。
- 工具数量见第 8 节：新接口都登记到 `gpas.query` 下，不再新增工具。

### 6.3 一次请求的样子

用户问：“临床样本里，检出金葡或者五星病原三个以上的有哪些？”

```text
模型 → gpas.query     { "api": "sample.search", "all": { "sampleType": ["clinic"] },
                        "anyOf": [ { "taxNames": ["金黄色葡萄球菌"] }, { "hazardLevel": 5, "minHazardCount": 3 } ] }
服务端 → GPAS        GET /species/search?keyword=金黄色葡萄球菌   → 唯一匹配 taxId 1280
服务端校验、合并共同条件、生成口径说明
服务端 → GPAS        POST /sample/search
                     { "ownTeamId": "<会话团队>",
                       "anyOf": [ { "sampleType": ["clinic"], "taxIds": ["1280"] },
                                  { "sampleType": ["clinic"], "hazardLevel": 5, "minHazardCount": 3 } ],
                       "page": 1, "pageSize": 20 }
GPAS → 服务端        { code: 200, dataPage: { totalData: 12, dataList: [...] } }
服务端 → 模型        { total: 12, criteria: "样本类型为临床样本，并且（检出金黄色葡萄球菌，或者危害等级 5 级的物种数 ≥ 3）", samples: [...] }
模型 → 用户          “共 12 个样本……”，下方是样本表格
```

---

## 7. 实施顺序

1. **对齐约定表**（1–2 次会议）：上游填写“上游列名”和“确认”两列、检测项目的全部代码、返回字段的单位和时区。
2. **上游**：样本查询接口（含条件组）、物种名查询接口；检测项目字段；`file/result/list` 补团队校验。
3. **本项目**：注册表文件、`gpas.query` 工具及其中的 `sample.search` 接口（含共同条件合并）、表格展示、评测用例（初始问题、“或者”类问题及其常见说法）。
4. **第二期**：样本统计接口；按需要往约定表一加条件。

---

## 8. 接入更多接口：工具数量不随接口增长

### 8.1 问题

现在每个 GPAS 接口对应一个工具：已有 6 个，加上样本查询就是 7 个。`AGENT_TOOL_LIMIT` 默认是 8，工具数超过它时服务启动失败。
照这样每接一个接口加一个工具，很快会超限。

上限本身可以调大（`docs/agent.md` 提到 qwen3.6-flash 能处理几十个工具），但工具越多，每次请求的提示越长，
模型选错工具的概率也越高。所以更好的做法是让工具数量固定，不随接口数量增长。

### 8.2 做法：按“接口类别”设工具，而不是按接口

| 工具 | 覆盖 | 说明 |
|---|---|---|
| `user.profile` | 当前用户与团队 | 保留现状 |
| `gpas.query` | **所有只读查询接口** | 用 `api` 参数指定查哪个接口；条件、翻页、口径说明、展示的处理方式都一样 |
| `gpas.prepare` | **所有写操作** | 只生成确认表单，用户确认后才执行（现有 `project.initialize` 的机制）；用 `action` 参数指定哪个操作 |

不管以后接多少接口，工具都是这 3 个。名称到代码的查找（如物种名换成 taxId）在服务端内部完成，不需要单独的工具。

### 8.3 接口注册表

每个查询接口在注册表里登记一条，内容来自与上游约定的那张条件表：

```ts
// src/server/semantic/gpasApis.ts（示意）
export const gpasApis = defineApis({
  'sample.search': {
    label: '跨样本查询',
    use: '按检测项目、物种、危害等级等条件筛选团队的样本',
    examples: ['所有肠道微生物检测的样本', '检出金葡的样本', '三个以上五星病原的样本'],
    request: { method: 'POST', path: 'sample/search', conditions: sampleSearchConditions, groups: true },
    result: { parse: parseSampleRows, view: 'sampleTable' },
  },
  'sample.detail': {
    label: '单个样本的检出明细',
    use: '查看某个样本检出了哪些物种、风险等级和可信度',
    examples: ['KY14599 的检测结果', '这个样本的细菌明细'],
    request: { method: 'GET', path: 'file/result/list',
               conditions: { analysisId: { label: '分析 ID', upstream: 'taskId', required: true },
                             speciesType: { label: '大类', type: 'enumList', values: { bacteria: '细菌', viral: '病毒', fungi: '真菌' } } } },
    result: { parse: parseResultRows, view: 'resultPanel' },
  },
  'project.progress': {
    label: '项目样本提交进度',
    use: '四类样本的计划数量、已提交数量和完成率',
    examples: ['我的任务进度', '我们组临床样本还差多少'],
    request: { method: 'POST', path: 'summary/submit/info/{team}', conditions: {} },
    result: { parse: parseSummary, view: 'progressChart' },
  },
})
```

每条登记只写五样东西：

- 给模型看的用途和例句；
- 上游地址和方法；
- 条件表；
- 解析函数；
- 展示方式。

解析函数和展示组件都复用现有代码：现有工具里的 `run`、`toModel`、`toReply` 拆进 `parse` 和 `view`，不用重写。

### 8.4 模型怎么知道有哪些接口和条件

- **接口目录**：`gpas.query` 的工具说明里列出全部接口，每个接口一行（名称、用途、一两个例句）。
  20 个接口也只有一两千字，比 20 个独立工具的说明短得多。
- **条件说明**：接口不多时，直接写在工具说明里。接口多了以后改为按需提供：
  模型传了不认识的条件或漏了必填条件时，服务端返回该接口的条件清单（中文名和取值），模型据此改正后再调用一次；
  模型也可以传 `describe: true` 直接取某个接口的条件清单。
- **参数校验**：工具的参数结构保持通用（`api`、`all`、`anyOf`、分页），具体条件由服务端按注册表逐个接口校验。
  这样工具定义不会随接口增多而膨胀。

### 8.5 新接口接入流程

| 步骤 | 谁做 | 内容 |
|---|---|---|
| 1 | 双方 | 约定条件表（格式同第 2.2 节）和一份真实的返回示例 |
| 2 | 上游 | 实现接口。请求沿用 `{ ownTeamId, anyOf, page, pageSize }`；不需要“或者”的接口只用一个组，也可以用 GET 平铺参数。返回沿用 `dataPage` 结构 |
| 3 | 本项目 | 在接口注册表里加一条。返回格式是新的就写一个解析函数；展示优先复用已有组件 |
| 4 | 本项目 | 加评测用例：这个接口的常见问法，检查模型能选对 `api`、填对条件 |

**不新增工具**。只有两种情况例外：写操作走 `gpas.prepare` 的表单；文件上传这类有特殊交互的继续用专用通道。

### 8.6 现有工具怎么迁移

按接口逐个迁移，每迁一个先用评测确认效果不变：

1. 样本查询一开始就做成 `gpas.query` 的 `sample.search`，不单独建工具；
2. `file.list`、`file.result`、`project.progress`、`project.status` 逐个改为注册表条目；
3. `project.initialize` 改为 `gpas.prepare` 的一个操作；
4. 全部迁完后，工具从 7 个减到 3 个。

**风险**：模型从“选工具”变成“在一个工具里选 `api`”，难度差不多，但接口目录的写法会直接影响准确率。
所以每一步迁移前都要先有评测基线，迁移后准确率不低于基线再切换。

### 8.7 接口非常多以后

单个工具里的接口超过三十个左右时，可以按领域拆成几个查询工具，例如 `gpas.query_sample`、`gpas.query_project`。
工具数量仍然只随领域增长，不随接口增长。

