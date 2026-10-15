# GPAS 查询接入方案

本文是 bio-chatbot 接入 GPAS 查询接口的当前方案，取代《[跨样本查询：简化方案](sample-query-simple.md)》。

它要同时满足四个要求：

- **上游工作量小**：不需要 OpenAPI、通用查询语言、数据目录，也不需要改返回格式。
- **查询足够灵活**：任意嵌套的“并且 / 或者 / 非”都能表达，包括带限定的计数（如“细菌里的五星病原 ≥ 3 个”）。
- **结果准确**：总数和分页由上游的一条 SQL 给出，不在本地拼接。
- **以后接更多接口时，工具数量不变**。

更早的设计（`sample-query-data-agent.md`、`gpas-semantic-platform.md`、`gpas-openapi-plan.md` 等）保留为长期参考。

---

## 1. 总体设计

```text
用户提问
  ↓
模型从 3 个固定工具中选一个：
  user.profile   当前用户与团队
  gpas.query     所有只读查询，用 api 参数指定接口；条件可以任意嵌套“并且 / 或者 / 非”
  gpas.prepare   所有写操作，只生成确认表单
  ↓
服务端按“接口注册表”中该接口的那一条：
  校验条件 → 物种名换成编号 → 把嵌套条件编译成上游的固定两层结构
  ↓
上游执行（一条 SQL），按现有格式返回
  ↓
服务端按注册表解析结果，生成口径说明，选择展示方式
```

五条原则：

1. **工具按类别固定，不按接口增加。** 新接口登记到注册表，不新增工具。
2. **每个上游接口在注册表中登记一条**，内容来自与上游约定的一张“接口约定表”。
3. **条件分两层**：样本自身的条件，和“检出条件”（对该样本检出物种的存在、计数要求）。两层各自独立，可以自由组合（第 2 节）。
4. **灵活性在本项目，上游只做固定结构**：模型写任意嵌套的条件，本项目服务端把它编译成上游的固定两层结构（第 2.3 节）。
5. **返回格式由上游决定，我们来适配**。双方只约定几条含义上的要求（第 3.1 节）。

---

## 2. 条件模型：为什么能覆盖任意组合

### 2.1 旧设计的两个问题

旧设计中，“未检出”“同时检出”“五星 ≥ 3 个”等都是**按问题预先拼好的固定条件**，导致两类问题表达不了：

| 表达不了的问题 | 原因 |
|---|---|
| “细菌里的五星病原 ≥ 3 个” | `minHazardCount` 把“计数”和“按危害等级筛选”写死在一起，计数的范围只能是“该等级的全部物种”，无法再加“细菌”“丰度”等限定。<br>根本原因是**没有把两层数据分开**：样本（一个样本一行）和检出记录（样本 × 物种，一个样本多行）。所有与物种有关的条件，本质上都是“该样本的检出记录中，满足某些条件的有几条”。旧设计把其中几种组合各写成一个条件，而不是提供一个通用的写法。 |
| “不是（肠道并且五星 ≥ 3）” | 条件组只有一层“组间或者、组内并且”，而且**大部分条件没有对应的否定形式**。按逻辑规则（德摩根定律），“非（A 并且 B）”等于“非 A 或者 非 B”，需要每个条件都能取反；旧设计只有“未检出物种”这一个否定条件。 |

### 2.2 新设计：两层条件

**样本条件**：样本自身的字段，如检测项目、样本类型、是否已分析、上传时间。

**检出条件**：一个统一的结构，表示“该样本的检出记录中，满足筛选的物种数量在某个范围内”：

```json
{ "taxIds": ["…"], "hazardLevels": [5], "microbialTypes": ["bacteria"], "minAbundance": 1, "min": 3, "max": null }
```

- 前四项是对检出记录的筛选，都可选，同时出现时取交集；
- `min`、`max` 是数量范围，默认 `min = 1`、`max` 不限。

这一个结构就能表达所有与物种有关的条件：

| 问题 | 检出条件 |
|---|---|
| 检出金葡 | `{ taxIds: [1280] }`（默认至少 1 个） |
| 未检出金葡 | `{ taxIds: [1280], max: 0 }` |
| 同时检出金葡和大肠埃希菌 | 两个检出条件：`{ taxIds: [1280] }` 和 `{ taxIds: [562] }` |
| 检出金葡、大肠埃希菌中至少一个 | `{ taxIds: [1280, 562] }` |
| 五星病原 ≥ 3 个 | `{ hazardLevels: [5], min: 3 }` |
| **细菌里的五星病原 ≥ 3 个** | `{ hazardLevels: [5], microbialTypes: ['bacteria'], min: 3 }` |
| 四星及以上的病原 ≥ 2 个 | `{ hazardLevels: [4, 5], min: 2 }` |
| 五星病原不超过 2 个 | `{ hazardLevels: [5], max: 2 }` |
| 金葡丰度 > 1% | `{ taxIds: [1280], minAbundance: 1 }` |
| 没有检出任何五星病原 | `{ hazardLevels: [5], max: 0 }` |

以后要加新的筛选维度（如唯一匹配 reads 数、覆盖度），只需在检出条件中加一个字段，所有计数类问题自动可用。

### 2.3 新设计：任意嵌套的“并且 / 或者 / 非”

- **模型这边**：`gpas.query` 接受任意嵌套的条件树（`and`、`or`、`not`），模型按用户原话写即可。
- **上游这边**：只实现固定的两层结构：

  ```text
  结果 = 组1 或 组2 或 …
  每个组 = 样本条件（并且） 并且 检出条件（并且） 并且 非（排除组1 或 排除组2 或 …）
  排除组 = 样本条件（并且） 并且 检出条件（并且）      ← 排除组里不能再有排除组
  ```

- **本项目服务端**负责把条件树编译成这个两层结构（第 5.3 节）。按布尔代数，任何“并且 / 或者 / 非”的组合都能化成“若干组的或，每组是若干条件和若干否定条件的并且”，
  否定条件放进该组的排除组。所以这个两层结构**能表达任意组合**，上游却始终只需要实现一种写法。

例子：

| 问题 | 编译成 |
|---|---|
| 不是（肠道并且五星 ≥ 3） | 组1 = 全部样本，排除组 = { 肠道，五星 ≥ 3 } |
| 临床样本中，检出金葡或者细菌五星 ≥ 3，但不包括肠道样本 | 组1 = { 临床，检出金葡 }，排除 { 肠道 }<br>组2 = { 临床，细菌五星 ≥ 3 }，排除 { 肠道 } |
| （肠道或者呼吸道）并且（检出金葡或者五星 ≥ 3） | 4 个组：肠道 + 金葡、肠道 + 五星、呼吸道 + 金葡、呼吸道 + 五星（同一字段的多个取值也可以合并成一组，见第 5.3 节） |

**为什么不直接让上游支持任意嵌套**：那就是之前被拒绝的通用查询语言。固定两层结构的 SQL 写法只有一种，上游写一次就能用于所有查询；
嵌套展开的复杂度由本项目承担，并且有组数上限保护（第 3.2 节）。

### 2.4 仍然表达不了的

- **检出记录之间的比较**，如“金葡丰度高于大肠埃希菌的样本”；
- **计数以外的汇总**，如“细菌总丰度超过 50% 的样本”（需要时可以在检出条件中加 `minTotalAbundance`）；
- **跨样本的关系**，如“同一患者 30 天内两次检出”。这需要新的业务对象（患者），属于新接口。

---

## 3. 与上游的约定

### 3.1 通用约定（所有查询接口都遵守）

| # | 约定 | 原因 |
|---|---|---|
| 1 | 请求结构：`{ ownTeamId, anyOf: [条件组, …], orderBy, page, pageSize }`，条件组的结构见第 4.2 节。不需要条件的接口可以用 GET 平铺参数 | 同一种结构，上游的实现代码可以复用 |
| 2 | **校验 `ownTeamId` 与登录会话的团队一致**，不一致返回 403；按 ID 查询时同样校验对象属于当前团队 | 唯一的安全硬性要求 |
| 3 | 返回沿用 GPAS 现有的 `dataPage` 结构 | 上游不用设计新格式 |
| 4 | `totalData` 是符合条件的**业务对象数**，并且是精确值 | 模型会回答“共 N 个”，按文件行计数会给出错误答案 |
| 5 | 每个业务对象只返回一行，并带有它的 ID | 本地去重会让分页和总数对不上；没有 ID 无法“查看详情” |

“业务对象”指接口所查的东西，例如样本查询中是样本：双端的两个文件只算一个样本。

### 3.2 限额

| 项目 | 上限 |
|---|---|
| 条件组 `anyOf` | 20 个 |
| 每组的排除组 `except` | 5 个 |
| 每组（或排除组）的检出条件 | 5 个 |
| 每个检出条件的 `taxIds` | 20 个 |
| `pageSize` | 100 |

本项目编译后超过上限时，不发请求，请用户缩小范围。

### 3.3 每个接口一张约定表

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

### 3.4 上游不需要做的

- 不需要写 OpenAPI 或扩展字段，约定表就是文档；
- 不需要实现任意嵌套的条件，只实现固定的两层结构；
- 不需要数据目录、字典接口，也不需要改变现有接口的返回格式。

---

## 4. 第一个接口：样本查询 `sample.search`

### 4.1 能回答的问题

| 问题 | 条件 |
|---|---|
| 所有做了肠道微生物检测的样本 | 样本：检测项目 = 肠道 |
| 所有检出金黄色葡萄球菌的样本 | 检出：`{ taxIds: [1280] }` |
| 所有鉴定到三个以上五星病原的样本 | 检出：`{ hazardLevels: [5], min: 3 }` |
| 细菌里的五星病原 ≥ 3 个 | 检出：`{ hazardLevels: [5], microbialTypes: [bacteria], min: 3 }` |
| 同时检出金葡和大肠埃希菌 | 检出：`{ taxIds: [1280] }` 并且 `{ taxIds: [562] }` |
| 检出金葡但未检出大肠埃希菌 | 检出：`{ taxIds: [1280] }` 并且 `{ taxIds: [562], max: 0 }` |
| 肠道样本，或者检出金葡的样本 | 组1 肠道；组2 检出金葡 |
| 不是（肠道并且五星 ≥ 3）的样本 | 全部样本，排除 { 肠道，五星 ≥ 3 } |
| 临床样本中，检出金葡或者细菌五星 ≥ 3，但不包括肠道样本 | 见第 2.3 节的编译结果 |
| 2026 年上传的临床样本 | 样本：临床，上传日期 2026-01-01 至 2026-12-31 |
| 在上次结果中再筛临床样本 | 本项目把上次的条件树和“临床”用“并且”连接，再查一次 |
| 肠道和呼吸道样本对比 | 本项目查两次，自己比较两个总数 |

### 4.2 接口与条件

接口：`POST /sample/search`（名称可由上游决定）。它是只读查询，用 POST 是因为条件组放不进 URL。

```json
{
  "ownTeamId": "<会话团队>",
  "anyOf": [
    {
      "sampleType": ["clinic"],
      "detections": [ { "hazardLevels": [5], "microbialTypes": ["bacteria"], "min": 3 } ],
      "except": [ { "detectionType": ["GUT_MICROBIOME"] } ]
    },
    {
      "sampleType": ["clinic"],
      "detections": [ { "taxIds": ["1280"] } ],
      "except": [ { "detectionType": ["GUT_MICROBIOME"] } ]
    }
  ],
  "orderBy": "uploadTime",
  "page": 1,
  "pageSize": 20
}
```

- 样本满足任意一个组即入选；满足多个组的样本只算一次、只返回一行。
- 一个组内：样本条件、所有检出条件同时满足，并且不满足任何一个排除组。
- 一个组可以没有样本条件和检出条件，只有排除组，表示“全部样本中排除……”；但不能完全为空。
- 排除组的结构与组相同，只是不能再包含 `except`。
- `orderBy`：`uploadTime`、`analysisTime`（均为降序），默认 `uploadTime`。

**样本条件**（都可选，同一组内取交集）：

| 条件 | 中文名（同义词） | 取值 | SQL 条件（示意） | 上游列名 | 确认 |
|---|---|---|---|---|---|
| `detectionType` | 检测项目（检测类型、检测套餐） | 见第 4.4 节，数组 | `s.detection_type IN (…)` | | |
| `sampleType` | 样本类型 | `clinic`、`media`、`environment`、`lab`，数组 | `s.sample_type IN (…)` | | |
| `analysisDone` | 已完成分析（已鉴定、有结果） | `true` | `s.analysis_status = 'analysisverified'` | | |
| `sampleName` | 样本名 | 文本 | `s.sample_name LIKE '%…%'` | | |
| `uploadFrom` / `uploadTo` | 上传时间 | `YYYY-MM-DD`，含当天 | `s.upload_time >= … AND s.upload_time < 次日` | | |

**检出条件** `detections`（数组，每一项都要满足）：

| 字段 | 中文名 | 取值 | SQL 条件（示意） | 上游列名 | 确认 |
|---|---|---|---|---|---|
| `taxIds` | 物种 | taxId 数组，最多 20 个 | `d.tax_id IN (…)` | | |
| `hazardLevels` | 危害等级 | 1–5 的数组 | `d.hazard_index IN (…)` | | |
| `microbialTypes` | 大类 | `bacteria`、`viral`、`fungi` 等 | `d.microbial_type IN (…)` | | |
| `minAbundance` | 丰度下限（%） | 0–100 | `d.abundance >= …` | | |
| `min` / `max` | 满足以上筛选的物种数范围 | 整数，默认 `min = 1`、`max` 不限 | `(SELECT COUNT(DISTINCT d.tax_id) FROM 检出表 d WHERE d.analysis_id = s.analysis_id AND 以上筛选) BETWEEN min AND max` | | |

检出条件只对已完成分析的样本有意义：未分析的样本没有检出记录，计数为 0。所以“未检出 xx”（`max: 0`）
或排除组中的检出条件（“不是检出 xx”）会把未分析的样本也算进来。
本项目在编译时，凡是组本身或它的排除组中出现检出条件，都给该组加上 `analysisDone: true`，并在口径说明中写明。

### 4.3 返回

**每行的结构与现有的 `file/dual/merge/list` 相同**（`isPair`、`file1`、`file2`，文件上有 `analysisId`、`briefAnalysis` 等），
只在文件上增加 `detectionType`。这样本项目现有的解析代码和多样本表格都能直接使用。

与 `merge/list` 不同的只有通用约定的第 4、5 条：`totalData` 按样本计数，每个样本只返回一行。

可选字段（有更好，没有也能显示）：

| 字段 | 含义 | 用途 |
|---|---|---|
| `hazardCounts` | 该样本各危害等级的物种数，如 `{ "5": 3, "4": 6 }` | 表格直接显示“五星 3 个” |
| `matchedTaxa` | 该样本中命中 `taxIds` 的物种 | 表格显示“命中：金黄色葡萄球菌” |
| `matchedGroups` | 该样本满足的条件组序号（从 0 开始） | 表格标出样本是因哪个条件被选中 |

### 4.4 检测项目代码与物种名查询

检测项目代码（上游填写全部取值；第二行只是示例）：

| 代码 | 中文名 | 常见说法 |
|---|---|---|
| `GUT_MICROBIOME` | 肠道微生物检测 | 肠道、肠道菌群 |
| `RESPIRATORY` | 呼吸道检测（示例） | 呼吸道 |

物种名查询（新增，很小）：`GET /species/search?keyword=金黄色&limit=10`，返回 `[{ taxId, taxCnName, taxEnName }]`。
上游已有物种表（检出明细中有中英文名），按名称模糊查询即可。

### 4.5 上游实现

数据准备：

| 需要 | 说明 |
|---|---|
| 样本有“检测项目”字段 | 现在没有的话需要新增，并在上传或项目层面填写 |
| 检出明细表加索引 | 检出明细（样本 × 物种）已经存在，加索引 `(analysis_id, hazard_index)`、`(analysis_id, tax_id)`、`(team_id, tax_id)` |
| 检出明细有大类字段 | 每条检出记录要能知道它属于细菌、病毒还是真菌（`file/result/list` 的 `speciesType` 已经有） |

接口实现：把“一个组的条件”写成一个 SQL 片段，组和排除组都用它。以 MyBatis（3.4.2 及以上）为例：

```xml
<!-- 一个组（或排除组）的条件；${g} 是组变量名 -->
<sql id="groupConds">
  1 = 1
  <if test="${g}.detectionType != null and ${g}.detectionType.size() > 0">
    AND s.detection_type IN <foreach collection="${g}.detectionType" item="t" open="(" separator="," close=")">#{t}</foreach>
  </if>
  <if test="${g}.sampleType != null and ${g}.sampleType.size() > 0">
    AND s.sample_type IN <foreach collection="${g}.sampleType" item="t" open="(" separator="," close=")">#{t}</foreach>
  </if>
  <if test="${g}.analysisDone">
    AND s.analysis_status = 'analysisverified'
  </if>
  <if test="${g}.detections != null">
    <foreach collection="${g}.detections" item="dt">
      AND (SELECT COUNT(DISTINCT d.tax_id) FROM detection d
           WHERE d.analysis_id = s.analysis_id
           <if test="dt.taxIds != null and dt.taxIds.size() > 0">
             AND d.tax_id IN <foreach collection="dt.taxIds" item="x" open="(" separator="," close=")">#{x}</foreach>
           </if>
           <if test="dt.hazardLevels != null and dt.hazardLevels.size() > 0">
             AND d.hazard_index IN <foreach collection="dt.hazardLevels" item="x" open="(" separator="," close=")">#{x}</foreach>
           </if>
           <if test="dt.microbialTypes != null and dt.microbialTypes.size() > 0">
             AND d.microbial_type IN <foreach collection="dt.microbialTypes" item="x" open="(" separator="," close=")">#{x}</foreach>
           </if>
           <if test="dt.minAbundance != null">AND d.abundance &gt;= #{dt.minAbundance}</if>
          ) BETWEEN #{dt.min} AND #{dt.max}
    </foreach>
  </if>
</sql>

<select id="searchSamples" resultType="SampleRow">
  SELECT s.* FROM sample s
  WHERE s.team_id = #{teamId}                                   <!-- 已与登录会话核对 -->
    AND <foreach collection="anyOf" item="g" open="(" separator=" OR " close=")">
      ( <include refid="groupConds"><property name="g" value="g"/></include>
        <if test="g.except != null and g.except.size() > 0">
          AND NOT <foreach collection="g.except" item="e" open="(" separator=" OR " close=")">
            ( <include refid="groupConds"><property name="g" value="e"/></include> )
          </foreach>
        </if>
      )
    </foreach>
  ORDER BY s.upload_time DESC
</select>
```

- 在 Java 代码中先校验并补默认值：组数、排除组数、检出条件数不超过第 3.2 节的上限；每组至少有一个条件或排除组；
  检出条件缺 `min` 时补 1，缺 `max` 时补一个足够大的数。
- 所有值用 `#{}` 绑定，不拼接字符串；`orderBy` 只接受约定的取值，在代码里映射成固定列名。
- 总数用现有的分页插件（如 PageHelper）计算。因为是一条 SQL，满足多个组的样本只算一次。
- 查出当页样本后，按现有方式组装成 `merge/list` 的行结构；可选字段在内存中补充。

另外，现有的 `GET /file/result/list` 需要补上团队校验：`taskId` 不属于当前团队时返回 403。

---

## 5. 本项目实现

### 5.1 工具

| 工具 | 覆盖 | 说明 |
|---|---|---|
| `user.profile` | 当前用户与团队 | 保持现状 |
| `gpas.query` | 所有只读查询接口 | 用 `api` 参数指定接口，例如 `sample.search` |
| `gpas.prepare` | 所有写操作 | 只生成确认表单，用户确认后才执行（现有 `project.initialize` 的机制）；用 `action` 参数指定操作 |

不管以后接多少接口，工具都是这 3 个，远低于 `AGENT_TOOL_LIMIT = 8`。物种名换成 taxId 在服务端内部完成，不单独占用工具。

### 5.2 接口注册表

每个查询接口登记一条，内容来自它的约定表：

```ts
// src/server/gpas/apis.ts（示意）
export const gpasApis = defineApis({
  'sample.search': {
    label: '跨样本查询',
    use: '按检测项目、物种、危害等级等条件筛选团队的样本',
    examples: ['所有肠道微生物检测的样本', '检出金葡的样本', '细菌里五星病原三个以上的样本'],
    request: { method: 'POST', path: 'sample/search', tree: true,
      sampleConditions: {
        detectionType: { label: '检测项目', synonyms: ['检测类型', '检测套餐'], type: 'enumList',
                         values: { GUT_MICROBIOME: '肠道微生物检测' } },
        sampleType:    { label: '样本类型', type: 'enumList',
                         values: { clinic: '临床样本', media: '虫媒样本', environment: '环境样本', lab: '实验室样本' } },
        analysisDone:  { label: '已完成分析', type: 'flag' },
        sampleName:    { label: '样本名', type: 'text' },
        uploadFrom:    { label: '上传日期起', type: 'date' },
        uploadTo:      { label: '上传日期止', type: 'date' },
      },
      detectionFilters: {
        taxNames:       { label: '物种', type: 'taxonList', max: 20, upstream: 'taxIds' },
        hazardLevels:   { label: '危害等级', synonyms: ['星级'], type: 'intList', min: 1, max: 5 },
        microbialTypes: { label: '大类', type: 'enumList', values: { bacteria: '细菌', viral: '病毒', fungi: '真菌' } },
        minAbundance:   { label: '丰度下限（%）', type: 'number', min: 0, max: 100 },
      },
    },
    result: { parse: parseMergeListRows, view: 'sampleTable' },   // 复用现有 file.list 的解析和表格
  },
  'sample.detail': {
    label: '单个样本的检出明细',
    use: '查看某个样本检出了哪些物种、风险等级和可信度',
    examples: ['KY14599 的检测结果', '这个样本的细菌明细'],
    request: { method: 'GET', path: 'file/result/list', params: {
      analysisId:  { label: '分析 ID', upstream: 'taskId', type: 'id', required: true },
      speciesType: { label: '大类', type: 'enum', values: { bacteria: '细菌', viral: '病毒', fungi: '真菌' } },
    } },
    result: { parse: parseResultRows, view: 'resultPanel' },      // 复用现有 file.result
  },
  'project.progress': {
    label: '项目样本提交进度',
    use: '四类样本的计划数量、已提交数量和完成率',
    examples: ['我的任务进度', '我们组临床样本还差多少'],
    request: { method: 'POST', path: 'summary/submit/info/{team}', params: {} },
    result: { parse: parseSummary, view: 'progressChart' },       // 复用现有 project.progress
  },
})
```

每条只写五样东西：用途和例句、上游地址、条件、解析函数、展示方式。
解析函数和展示组件复用现有代码：现有工具里的 `run`、`toModel`、`toReply` 拆进 `parse` 和 `view`。

### 5.3 `gpas.query` 的参数和处理流程

参数：

```ts
{
  api: string,                 // 接口名，必须在注册表中
  where?: 条件树,               // 支持条件的接口使用
  params?: 参数,                // 平铺参数的接口使用（如 sample.detail 的 analysisId）
  orderBy?, page?, pageSize?,
  describe?: true              // 只返回该接口的条件清单，不查询
}

条件树 = { and: 条件树[] } | { or: 条件树[] } | { not: 条件树 }
       | { sample: 样本条件 }           // 如 { sample: { detectionType: ['GUT_MICROBIOME'] } }
       | { detected: 检出条件 }         // 如 { detected: { hazardLevels: [5], microbialTypes: ['bacteria'], min: 3 } }
```

模型按用户原话写。例如“临床样本中，检出金葡或者细菌五星 ≥ 3，但不包括肠道样本”：

```json
{ "and": [
  { "sample": { "sampleType": ["clinic"] } },
  { "or": [
    { "detected": { "taxNames": ["金黄色葡萄球菌"] } },
    { "detected": { "hazardLevels": [5], "microbialTypes": ["bacteria"], "min": 3 } } ] },
  { "not": { "sample": { "detectionType": ["GUT_MICROBIOME"] } } } ] }
```

服务端处理：

1. **找到接口**：`api` 不在注册表中时，返回接口目录。
2. **校验条件**：按该接口的条件表校验字段和取值。不认识的字段或缺少必填项时，返回该接口的条件清单（中文名和取值），模型据此改正。
3. **物种名换成 taxId**：调用 `/species/search`。唯一匹配就替换；有多个候选时返回候选，由模型请用户选择。
4. **编译成两层结构**（纯函数，可单测）：
   1. 把 `not` 往下推到单个条件上（德摩根定律）。两种情况不再往下推：对只由样本条件和检出条件组成的“并且”整体取反时，
      直接作为一个排除组（如“不是（肠道并且五星 ≥ 3）”）；一个检出条件取反后能直接改写的，就直接改写
      （如“至少 1 个”的反面是“至多 0 个”）；
   2. 展开成“若干组的或，每组是若干条件和若干否定条件的并且”；
   3. 每组中，肯定的样本条件合并（同一字段取交集，日期取重叠部分），检出条件逐个保留；否定的条件放进该组的排除组；
   4. 合并后不可能成立的组去掉，如检测项目交集为空；
   5. 只有一个样本条件取值不同、其它条件完全相同的组合并成一组，如“肠道 + 金葡”和“呼吸道 + 金葡”合成“肠道或呼吸道 + 金葡”，以减少组数；
   6. 组本身或其排除组中有检出条件时，给该组加上“已完成分析”（第 4.2 节）；
   7. 超过第 3.2 节的上限时，不发请求，请用户缩小范围。
5. **调用上游**：团队取自会话，条件名按 `upstream` 换成上游名称。
6. **解析与检查**：用该接口的解析函数解析，检查行数不超过 `pageSize`。
7. **口径说明**：按条件树（不是编译后的结构）用中文名生成，保留用户的原意。例如：
   “样本类型为临床样本，并且（检出金黄色葡萄球菌，或者细菌中危害等级 5 级的物种数 ≥ 3），并且检测项目不是肠道微生物检测”。
8. **返回**：给模型的是总数、口径说明、精简结果和本次的条件树（用于“在结果中再筛”）；给界面的是该接口的展示方式（如样本表格）。
   翻页由服务端用同一组条件重新请求，不经过模型。

### 5.4 模型怎么知道有哪些接口和条件

- **接口目录**：`gpas.query` 的工具说明里列出全部接口，每个接口一行（名称、用途、一两个例句）。
- **条件说明**：接口不多时，直接写在工具说明里；接口多了以后改为按需提供，即第 5.3 节第 2 步的条件清单，或用 `describe: true` 主动获取。
- **工具参数保持通用**（`api`、`where`、`params`、分页），具体条件由服务端按接口校验，工具定义不会随接口增多而变大。

### 5.5 一次请求的样子

用户问：“临床样本里，检出金葡或者细菌五星病原三个以上的，肠道样本不要。”

```text
模型 → gpas.query     { "api": "sample.search", "where": 第 5.3 节的条件树 }
服务端 → GPAS        GET /species/search?keyword=金黄色葡萄球菌        → 唯一匹配 taxId 1280
服务端                校验条件，编译成两层结构，生成口径说明
服务端 → GPAS        POST /sample/search   第 4.2 节示例中的请求体（两个组，各带“排除肠道”）
GPAS → 服务端        { code: 200, dataPage: { totalData: 9, dataList: [ merge/list 结构的行 … ] } }
服务端 → 模型        { total: 9, criteria: "样本类型为临床样本，并且（……），并且检测项目不是肠道微生物检测", samples: [...] }
模型 → 用户          “共 9 个样本……”，下方是样本表格
```

---

## 6. 接入新接口的流程

| 步骤 | 谁做 | 内容 |
|---|---|---|
| 1 | 双方 | 填写接口约定表（第 3.3 节） |
| 2 | 上游 | 按通用约定实现接口（第 3.1 节）；需要条件的接口沿用两层结构，条件片段的写法与第 4.5 节相同 |
| 3 | 本项目 | 注册表加一条；返回格式是新的就写一个解析函数；展示优先复用已有组件。条件编译器对所有接口通用，不用改 |
| 4 | 本项目 | 加评测用例：这个接口的常见问法，检查模型能选对 `api`、写对条件 |

**不新增工具**。只有两种例外：写操作走 `gpas.prepare` 的表单；文件上传这类有特殊交互的，继续用专用通道。

以后加条件也一样：约定表加一行，上游在条件片段里加一个 `<if>`，注册表加一行。

---

## 7. 现有工具的迁移

现在有 6 个工具：`user.profile`、`project.progress`、`project.status`、`project.initialize`、`file.list`、`file.result`。按接口逐个迁移：

1. 样本查询一开始就做成 `gpas.query` 的 `sample.search`，不单独建工具；
2. `file.list`、`file.result`、`project.progress`、`project.status` 逐个改为注册表条目；
3. `project.initialize` 改为 `gpas.prepare` 的一个操作；
4. 全部迁完后，工具从 6 个减到 3 个。

**风险**：

- 模型从“选工具”变成“在一个工具里选 `api`”，接口目录的写法会直接影响准确率；
- 条件树比平铺参数难写一些。

所以每一步迁移前，先为现有问法（`docs/gpas-project-chat.md` 中的各类说法）和组合问法建立评测基线，迁移后准确率不低于基线再切换。
条件编译器是纯函数，用大量组合用例做单元测试，包括“编译前后对同一批模拟样本的筛选结果一致”。

---

## 8. 实施顺序

1. **对齐约定**（1–2 次会议）：通用约定（第 3.1、3.2 节）；样本查询的约定表（上游列名、确认、真实返回示例）；检测项目的全部代码。
2. **上游**：样本查询接口（两层结构）、物种名查询接口、检测项目字段；`file/result/list` 补团队校验。
3. **本项目**：接口注册表、`gpas.query`（含条件编译器）、`sample.search` 条目、评测用例。
4. **迁移**：按第 7 节把现有工具逐个迁入注册表。
5. **第二期**：样本统计接口 `POST /sample/stats`（请求同样本查询，另加 `groupBy`：`month`、`detectionType`、`sampleType`、`taxId`），
   用于“每月检出 xx 的样本数”“最常见的五星病原”。

---

## 9. 以后的扩展

- **接口非常多**：单个 `gpas.query` 下的接口超过三十个左右时，按领域拆成几个查询工具（如 `gpas.query_sample`、`gpas.query_project`）。工具数量只随领域增长。
- **新的检出筛选维度**：在检出条件中加字段（如 `minReads`、`minCoverage`），所有计数类问题自动可用。
- **第 2.4 节中表达不了的问题**：按需增加条件（如 `minTotalAbundance`），或作为新接口接入，不引入通用查询语言。
