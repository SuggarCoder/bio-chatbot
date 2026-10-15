# 跨样本查询：简化方案

GPAS 上游评估后认为之前的方案工作量过大（OpenAPI 扩展字段、通用查询语言、数据目录和字典接口）。
本方案只保留回答问题必需的部分，上游按熟悉的方式做**一个列表接口加几个筛选参数**。

与之前方案的差别：

| | 之前 | 现在 |
|---|---|---|
| 注册表 | 上游发布 OpenAPI 和数据目录，本项目在其上加语义层 | 双方事先约定一张**参数表**（第 2 节），签字后各自实现 |
| 查询 | 通用查询语言（条件树、子查询、分组），上游翻译成 SQL | 平铺的 URL 参数，多个参数之间都是“并且”；每个参数在上游对应一段固定的 SQL 条件 |
| 上游新接口 | 数据目录、字典、通用查询、四个替代接口 | 样本查询，加一个物种名查询；样本统计放在第二期 |
| 返回格式 | 统一新结构 | 沿用 GPAS 现有的 `dataPage` 结构 |
| 文档 | OpenAPI 3.1 | 本文第 2、3 节的两张表 |

之前的设计文档（`sample-query-data-agent.md`、`gpas-semantic-platform.md`、`gpas-openapi-plan.md`）保留为长期参考，当前以本文为准。

---

## 1. 能回答哪些问题

| 问题 | 用到的参数 |
|---|---|
| 所有做了肠道微生物检测的样本 | `detectionType=GUT_MICROBIOME` |
| 所有检出金黄色葡萄球菌的样本 | `taxIds=1280` |
| 所有鉴定到三个以上五星病原的样本 | `hazardLevel=5&minHazardCount=3` |
| 肠道样本中检出五星病原 ≥ 3 个的 | 上面两组参数同时传（参数之间是“并且”） |
| 未检出 xx 的已分析样本 | `analysisDone=true&excludeTaxIds=…` |
| xx 丰度 > 1% 的样本 | `taxIds=…&minAbundance=1` |
| 2026 年上传的临床样本 | `sampleType=clinic&uploadFrom=2026-01-01&uploadTo=2026-12-31` |
| 在上次结果中再筛临床样本 | 本项目在上次的参数上加 `sampleType=clinic` 再查一次 |
| 肠道和呼吸道样本对比 | 本项目分两次查询，自己对比两个总数 |
| 每月检出 xx 的样本数 | 第二期的样本统计接口（第 4 节） |

同一个参数传多个值是“或者”（如 `detectionType=肠道,呼吸道`），不同参数之间是“并且”。

**不支持**（需要时再加参数）：不同参数之间的“或者”（如“肠道样本或检出 xx 的样本”）、
“细菌里的五星病原 ≥ 3 个”这类带额外限定的计数。遇到时，助手如实说明暂不支持。

---

## 2. 约定表一：样本查询参数（注册表）

这张表就是注册表。双方确认后，上游按“SQL 条件”一列实现，本项目按“中文名、同义词”一列让模型使用。
“上游列名”和“确认”两列由上游填写。

接口：`GET /sample/search`（名称可由上游决定）。参数都是可选的，同时传多个时取交集（AND）。

| 参数 | 中文名（同义词） | 取值 | SQL 条件（示意） | 上游列名 | 确认 |
|---|---|---|---|---|---|
| `detectionType` | 检测项目（检测类型、检测套餐） | 见约定表三，可传多个，逗号分隔 | `s.detection_type IN (…)` | | |
| `sampleType` | 样本类型 | `clinic`、`media`、`environment`、`lab`，可传多个 | `s.sample_type IN (…)` | | |
| `analysisDone` | 已完成分析（已鉴定、有结果） | `true` | `s.analysis_status = 'analysisverified'` | | |
| `sampleName` | 样本名 | 文本 | `s.sample_name LIKE '%…%'` | | |
| `uploadFrom` / `uploadTo` | 上传时间 | `YYYY-MM-DD`，含当天 | `s.upload_time >= … AND s.upload_time < 次日` | | |
| `taxIds` | 检出物种（任一） | NCBI taxId，逗号分隔，最多 20 个 | `EXISTS (检出表 d WHERE d.analysis_id = s.analysis_id AND d.tax_id IN (…))` | | |
| `minAbundance` | 丰度下限（%），与 `taxIds` 一起用 | 0–100 的数字 | 在上一行的 EXISTS 中加 `AND d.abundance >= …` | | |
| `excludeTaxIds` | 未检出物种 | 同 `taxIds` | `NOT EXISTS (… d.tax_id IN (…))` | | |
| `hazardLevel` | 危害等级（星级） | 1–5 | 与下一行一起用 | | |
| `minHazardCount` | 该等级物种数下限 | 正整数 | `该样本 hazard_index = hazardLevel 的物种数 >= …` | | |
| `orderBy` | 排序 | `uploadTime`、`analysisTime`、`hazardCount`（降序） | `ORDER BY …` | | |
| `page` / `pageSize` | 分页 | `pageSize` ≤ 100 | `LIMIT / OFFSET` | | |

**团队**：沿用现有接口的做法，可以继续传 `ownTeamId`，但上游**必须校验它与登录会话的团队一致**，不一致返回 403。这是唯一的安全硬性要求。

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
        "matchedTaxa": [{ "taxId": "1280", "taxCnName": "金黄色葡萄球菌", "hazardIndex": 4, "abundance": 0.82 }]
      }
    ]
  }
}
```

| 字段 | 含义 | 要求 | 确认 |
|---|---|---|---|
| `totalData` | 符合条件的**样本数** | 精确值；双端两个文件只算一个样本 | |
| `analysisId` | 分析任务 ID，即详情接口的 `taskId` | 每个样本一行，不再按 R1/R2 返回两行 | |
| `sampleName` | 样本名 | | |
| `sampleType`、`detectionType`、`analysisStatus` | 同约定表一 | | |
| `uploadTime`、`analysisTime` | 时间 | 写明时区 | |
| `hazardCounts` | 各危害等级的物种数 | 未分析的样本可为空 | |
| `matchedTaxa` | 传了 `taxIds` 时，该样本中命中的物种 | 没传 `taxIds` 时可省略 | |
| `abundance` | 丰度 | 写明单位（% 还是 0–1） | |

---

## 4. 约定表三：枚举与其它接口

**检测项目代码**（上游填写全部取值）：

| 代码 | 中文名 | 常见说法 |
|---|---|---|
| `GUT_MICROBIOME` | 肠道微生物检测 | 肠道、肠道菌群 |
| …… | | |

**物种名查询**（新增，很小）：`GET /species/search?keyword=金黄色&limit=10`，
返回 `[{ taxId, taxCnName, taxEnName }]`。上游已有物种表（检出明细里有中英文名），按名称模糊查即可。
本项目用它把用户说的“金葡”“大肠杆菌”换成 taxId；多个候选时请用户选择。

**样本统计**（第二期）：`GET /sample/stats?groupBy=month|detectionType|sampleType|taxId`，筛选参数与约定表一相同，
返回 `[{ key, label, count }]`，用于“每月检出 xx 的样本数”“最常见的五星病原”。

---

## 5. 上游怎么适配

### 5.1 数据准备

| 需要 | 说明 |
|---|---|
| 样本有“检测项目”字段 | 如果现在没有，需要新增并在上传或项目层面填写。这是问题一的前提 |
| 检出明细表有索引 | 检出明细（样本 × 物种）已经存在（`file/result/list` 就在查它），加索引 `(team_id, tax_id)`、`(analysis_id)` |
| 每个样本各危害等级的物种数 | 数据量小时可以直接 `GROUP BY` 计算；量大时在分析完成时写入一张汇总表（每个样本一行：h1…h5） |

### 5.2 接口实现

就是一个带动态条件的列表查询。以 MyBatis 为例（其它框架同理）：

```xml
<select id="searchSamples" resultType="SampleRow">
  SELECT s.analysis_id, s.sample_name, s.sample_type, s.detection_type, s.analysis_status,
         s.upload_time, s.analysis_time, h.h1, h.h2, h.h3, h.h4, h.h5
  FROM sample s
  LEFT JOIN sample_hazard_summary h ON h.analysis_id = s.analysis_id
  WHERE s.team_id = #{teamId}                         <!-- 来自登录会话 -->
  <if test="detectionTypes != null">
    AND s.detection_type IN <foreach collection="detectionTypes" item="t" open="(" separator="," close=")">#{t}</foreach>
  </if>
  <if test="analysisDone">
    AND s.analysis_status = 'analysisverified'
  </if>
  <if test="taxIds != null">
    AND EXISTS (SELECT 1 FROM detection d WHERE d.analysis_id = s.analysis_id
                AND d.tax_id IN <foreach collection="taxIds" item="x" open="(" separator="," close=")">#{x}</foreach>
                <if test="minAbundance != null">AND d.abundance &gt;= #{minAbundance}</if>)
  </if>
  <if test="excludeTaxIds != null">
    AND NOT EXISTS (SELECT 1 FROM detection d WHERE d.analysis_id = s.analysis_id
                    AND d.tax_id IN <foreach collection="excludeTaxIds" item="x" open="(" separator="," close=")">#{x}</foreach>)
  </if>
  <if test="hazardLevel != null and minHazardCount != null">
    AND (CASE #{hazardLevel} WHEN 1 THEN h.h1 WHEN 2 THEN h.h2 WHEN 3 THEN h.h3 WHEN 4 THEN h.h4 ELSE h.h5 END) &gt;= #{minHazardCount}
  </if>
  ORDER BY s.upload_time DESC
</select>
```

- 所有值都用 `#{}` 绑定，不拼接字符串。
- `orderBy` 只接受约定表里的取值，在代码里映射成固定的列名，不直接拼接用户输入。
- 总数可以用现有的分页插件（如 PageHelper）自动计算。
- `matchedTaxa` 在查出当页样本后，再按 `analysisId IN (…) AND tax_id IN (…)` 查一次检出明细。

### 5.3 上游不需要做的

- 不需要写 OpenAPI 或任何扩展字段；约定表就是文档。
- 不需要实现通用查询语言、数据目录、字典接口、统一返回结构。
- 不需要改动现有接口（`file/result/list` 的团队校验除外，见约定表一的安全要求）。

---

## 6. 本项目怎么做

### 6.1 注册表文件

约定表一和表三在本项目中写成一个文件，工具说明、参数校验、口径说明都从它生成：

```ts
// src/server/semantic/sampleSearch.ts（示意）
export const sampleSearchParams = defineParams({
  detectionType: { label: '检测项目', synonyms: ['检测类型', '检测套餐'], type: 'enumList',
                   values: { GUT_MICROBIOME: '肠道微生物检测' } },
  sampleType:    { label: '样本类型', type: 'enumList',
                   values: { clinic: '临床样本', media: '虫媒样本', environment: '环境样本', lab: '实验室样本' } },
  analysisDone:  { label: '已完成分析', type: 'flag' },
  taxNames:      { label: '检出物种（任一）', type: 'taxonList', max: 20, upstream: 'taxIds' },
  excludeTaxNames: { label: '未检出物种', type: 'taxonList', max: 20, upstream: 'excludeTaxIds' },
  minAbundance:  { label: '丰度下限（%）', type: 'number', min: 0, max: 100, requires: 'taxNames' },
  hazardLevel:   { label: '危害等级', synonyms: ['星级'], type: 'int', min: 1, max: 5, requires: 'minHazardCount' },
  minHazardCount:{ label: '该等级物种数下限', type: 'int', min: 1, requires: 'hazardLevel' },
  uploadFrom:    { label: '上传日期起', type: 'date' },
  uploadTo:      { label: '上传日期止', type: 'date' },
})
```

### 6.2 一个工具：`sample.search`

- 参数就是上面的平铺字段。模型直接填，不用学查询语言。
- **物种名由服务端换成 taxId**：模型传 `taxNames: ["金黄色葡萄球菌"]`，服务端调用 `/species/search`；
  唯一匹配就换成 taxId，否则把候选返回给模型，由模型请用户选择。
- 服务端校验取值和依赖关系（如 `minHazardCount` 必须和 `hazardLevel` 一起传），生成口径说明，
  例如“检测项目为肠道微生物检测、危害等级 5 级的物种数 ≥ 3”。
- 结果以多样本表格展示（复用现有表格）；翻页由服务端用同一组参数重新请求，不经过模型。
- 加上这个工具共 7 个，不超过 `AGENT_TOOL_LIMIT = 8`。

### 6.3 一次请求的样子

用户问：“帮我找出鉴定到三个以上五星病原的肠道样本”

```text
模型 → sample.search  { "detectionType": ["GUT_MICROBIOME"], "hazardLevel": 5, "minHazardCount": 3 }
服务端校验，生成口径说明
服务端 → GPAS        GET /sample/search?ownTeamId=<会话团队>&detectionType=GUT_MICROBIOME&hazardLevel=5&minHazardCount=3&page=1&pageSize=20
GPAS → 服务端        { code: 200, dataPage: { totalData: 37, dataList: [...] } }
服务端 → 模型        { total: 37, criteria: "检测项目为肠道微生物检测、危害等级 5 级的物种数 ≥ 3", samples: [前 20 个] }
模型 → 用户          “共 37 个样本……”，下方是样本表格
```

---

## 7. 实施顺序

1. **对齐约定表**（1–2 次会议）：上游填写“上游列名”和“确认”两列、检测项目的全部代码、返回字段的单位和时区。
2. **上游**：样本查询接口、物种名查询接口；检测项目字段；`file/result/list` 补团队校验。
3. **本项目**：注册表文件、`sample.search` 工具、表格展示、评测用例（三个初始问题及其常见说法）。
4. **第二期**：样本统计接口；按需要往约定表一加参数。
