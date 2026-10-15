# GPAS OpenAPI 规划（给 GPAS 团队）

本文写给 GPAS 后端团队，假设读者没有维护过 OpenAPI 文档。我们根据 bio-chatbot 实际调用的接口和收到的数据，
已经起草好了说明书。你们要做的主要是**核对、补全、发布、按计划改进**，不需要从零开始写。

背景和原理见《[语义注册表与 OpenAPI 入门](semantic-registry-guide.md)》。

---

## 0. 一页纸摘要

| 阶段 | 你们要做的 | 产出 | 建议时间 |
|---|---|---|---|
| 1. 核对现状 | 回答草稿中的 46 个问题，改正写错的字段 | 准确的现状说明书 | 1–2 周 |
| 2. 发布与维护 | 把说明书放进 GPAS 代码仓库，发布到固定地址，接入 CI 检查 | 每次发版自动更新的说明书 | 1 周 |
| 3. 实现目标接口 | 按目标草稿分期实现新接口（数据目录、字典、通用查询……） | 新接口和新版说明书 | 按排期 |

**有一个问题请优先回答，因为它涉及数据安全**：`GET /file/result/list` 是否校验 `taskId` 属于当前登录团队（问题 22）。
如果没有校验，知道别的团队 `taskId` 的人就能读到他们的结果，应当在现有接口上立即修复。

---

## 1. 我们提供的文件

| 文件 | 内容 |
|---|---|
| [`gpas-openapi/gpas-current.openapi.yaml`](gpas-openapi/gpas-current.openapi.yaml) | **现状说明书**：10 个现有接口现在的样子，包括不规范的地方。待确认的问题写在 `x-gpas-confirm` 里 |
| [`gpas-openapi/gpas-target.openapi.yaml`](gpas-openapi/gpas-target.openapi.yaml) | **目标说明书**：建议新增的接口（数据目录、字典、通用查询）和替代旧接口的新版本 |
| [`gpas-openapi/redocly.yaml`](gpas-openapi/redocly.yaml) | 格式检查工具的配置 |

两份说明书都已通过 Redocly 的格式检查（OpenAPI 3.1）。示例中的人名、账号、ID、状态取值和数值都是虚构的。

**怎么查看**：YAML 文件可以直接用文本编辑器打开。想看排版好的页面，可以在本地运行：

```bash
npx @redocly/cli@1.34.0 preview-docs docs/gpas-openapi/gpas-current.openapi.yaml
```

然后用浏览器打开它提示的本地地址。请不要把文件上传到公网的在线编辑器，里面是内部接口信息。

---

## 2. 阶段 1：核对现状说明书

### 2.1 怎么核对

1. 逐个接口阅读 `gpas-current.openapi.yaml`，对照你们的代码和数据库。
2. 回答下面清单中的问题。可以直接改 YAML，也可以在本表后面填答案发给我们，由我们改。
3. 发现字段名、类型、是否必填写错了，直接改正。
4. 问题回答完后，删除对应的 `x-gpas-confirm` 条目。`x-gpas-issue` 是已知问题，留到阶段 3 处理。

### 2.2 待确认问题清单

| # | 接口 | 问题 |
|---:|---|---|
| 1 | `GET /user/info` | `status` 的全部取值与含义（当前按 0 = 正常处理，其它值视为不可用） |
| 2 | `GET /user/info` | `role`、`natureId`、`sex` 的取值与含义 |
| 3 | `GET /user/info` | 一个用户是否可能属于多个团队？`ownteamId` 是否就是当前生效的团队？ |
| 4 | `GET /project/exist/{ownteamId}` | 路径中的 ownteamId 与登录用户的团队不一致时，接口是否拒绝（403）？ |
| 5 | `GET /project/exist/{ownteamId}` | `info.userName` 被 GPAS Web 用作默认项目名称，它的真实含义是什么？与 `info.projectName` 有何区别？ |
| 6 | `GET /project/exist/{ownteamId}` | 项目已存在（`data = true`）时是否仍返回 `info`？ |
| 7 | `POST /summary/submit/info/{ownteamId}` | `projectPlanInfo` 什么时候是对象、什么时候是数组？多项目团队是否总是数组？ |
| 8 | `POST /summary/submit/info/{ownteamId}` | `realSubmitInfo` 同一年月是否可能出现多行（当前按年月累加）？缺少的样本类型是否表示 0？ |
| 9 | `POST /summary/submit/info/{ownteamId}` | `month` 是否为 1–12？年月按什么时区和日期口径（上传时间、审核时间）统计？ |
| 10 | `POST /summary/submit/info/{ownteamId}` | clinic、media、environment、lab 是否为全部样本类型？以后会不会增加？ |
| 11 | `POST /project/create` | 同一团队重复提交时返回什么？服务端是否保证一个团队只有一个项目？ |
| 12 | `POST /project/create` | 成功时 `data` 返回什么（项目 ID？） |
| 13 | `POST /project/create` | `projectCode` 是否必须与 `/project/exist` 返回的一致？`ownTeamId` 与登录团队不一致时是否拒绝？ |
| 14 | `POST /project/create` | 字段长度限制、电话格式要求、计划数量上限 |
| 15 | `GET /file/dual/merge/list` | `fileName` 是精确匹配还是模糊匹配？能否用样本名（文件名前缀）查到双端两个文件？ |
| 16 | `GET /file/dual/merge/list` | 同一对双端文件按 R1/R2、R2/R1 各返回一行，这是预期行为吗？`totalData` 按行数还是按样本数计？ |
| 17 | `GET /file/dual/merge/list` | `status`、`qcStatus`、`analysisStatus`、`metaStatus` 的全部取值与中文含义；查询参数能否按这些值过滤？ |
| 18 | `GET /file/dual/merge/list` | `orderBy` 的可选值与默认值 |
| 19 | `GET /file/dual/merge/list` | `size` 的单位是否为字节？`uploadTime` 的格式和时区？ |
| 20 | `GET /file/dual/merge/list` | `analysisId` 是否就是 `/file/result/list` 的 `taskId`？未分析时是否为空？ |
| 21 | `GET /file/dual/merge/list` | `pageSize` 的上限 |
| 22 | `GET /file/result/list` | **是否校验 taskId 属于当前登录团队？**（安全问题，见第 0 节） |
| 23 | `GET /file/result/list` | `speciesType` 的取值是否与 briefAnalysis 的 `microbialType` 一致？ |
| 24 | `GET /file/result/list` | `coverage` 是百分比字符串（如 12.5%）还是 0–1 的小数？ |
| 25 | `GET /file/result/list` | `abundance` 是百分数吗？是样本内丰度还是类别内丰度？ |
| 26 | `GET /file/result/list` | `unifPvalue` 是原始 P 值还是 −log10 之后的值？ |
| 27 | `GET /file/result/list` | `hazardIndex` 的取值范围（文档写 1–5 级，数据中出现过 0） |
| 28 | `GET /file/result/list` | `selfAlignRatio`、`onlyMatching`、`ani95SpeciesNums` 的含义与单位 |
| 29 | `GET /file/result/list` | `colonization` 与 `colonizationE` 的取值 |
| 30 | `POST /file/task` | `sampleType` 是否接受 clinic、media、environment、lab？ |
| 31 | `POST /file/task` | `fileMN` 的用途与校验规则（当前为文件前 3072 字节的 base64） |
| 32 | `POST /file/task` | 哪些业务 code 表示可以重试？ |
| 33 | `POST /file/task` | 同一文件重复创建任务会怎样？ |
| 34 | `POST /file/dual/task` | `fileList[].name` 是否原样返回请求中的文件名？顺序是否与请求一致？ |
| 35 | `POST /file/dual/task` | `endType` 的取值 |
| 36 | `POST /file/upload/{uploadId}` | 同一分片 `no` 重复上传是否安全（覆盖而不是追加）？ |
| 37 | `POST /file/upload/{uploadId}` | 失败后能否在同一任务中补传缺失分片？任务多久过期？ |
| 38 | `POST /file/upload/{uploadId}` | 分片编号从 0 还是 1 开始（当前客户端从 0 开始）？ |
| 39 | `POST /file/upload/{uploadId}` | 分片大小上限（当前 5 MB） |
| 40 | `POST /file/dual/upload/{fileId}` | 与单端分片接口相同的问题 |
| 41 | 所有接口 | 完整的业务错误码表，并注明哪些可以重试 |
| 42 | briefAnalysis | 每个类别的 `topInfos` 最多几条（当前观察到 3 条）？按什么排序？ |
| 43 | briefAnalysis | `abundance` 是类别内相对丰度吗？ |
| 44 | briefAnalysis | `dataVolume` 的单位（当前按字节理解） |
| 45 | 所有接口 | 会话 Cookie 的实际名称与有效期 |
| 46 | 分页接口 | `pageSize` 的默认值与上限 |

---

## 3. 阶段 2：发布与维护

### 3.1 放在哪里、怎么发布

1. 把 `gpas-current.openapi.yaml` 复制到 GPAS 代码仓库，例如 `docs/openapi/gpas.openapi.yaml`。从此以 GPAS 仓库中的这份为准。
2. 部署时把它发布到固定地址，例如 `/api/gpas2/v1/openapi.yaml`（需要登录即可访问，不必公开到公网）。
3. 每次发版更新 `info.version`，并在仓库里维护一份简短的变更记录。

### 3.2 怎么保证说明书和代码一致

有两种做法，建议**先用做法 A**，团队熟悉之后再考虑做法 B。

**做法 A：手写维护 + 自动检查（推荐起步）**

- 改接口的同一个合并请求里同时改 YAML。代码评审时检查这一点。
- CI 中加两项检查：
  1. 格式检查：`npx @redocly/cli@1.34.0 lint --config redocly.yaml gpas.openapi.yaml`
  2. 契约测试：在测试环境调用真实接口，检查返回是否符合说明书。
     可以使用 Schemathesis 这类与语言无关的工具，例如 `schemathesis run gpas.openapi.yaml --url <测试环境地址> -H "Cookie: <测试账号会话>"`，
     也可以在你们现有的接口测试里，用 JSON Schema 校验库检查返回体。
- 需要一个**测试团队账号和固定的测试数据**，契约测试和我们的评测都会用到。

**做法 B：从代码自动生成**

大多数后端框架都能从代码注解生成 OpenAPI，好处是不容易忘记更新。以 Java Spring Boot 为例（如果 GPAS 用的是别的框架，原理相同）：

1. 加入依赖 `springdoc-openapi`，启动后访问 `/v3/api-docs` 或 `/v3/api-docs.yaml` 即可看到自动生成的说明书。
2. 用注解补充自动生成不了的信息：

```java
@Operation(operationId = "listAnalysisResults", summary = "单个样本的物种检出明细",
    extensions = @Extension(properties = {
        @ExtensionProperty(name = "x-gpas-kind", value = "data"),
        @ExtensionProperty(name = "x-gpas-scope", value = "team") }))
@GetMapping("/file/result/list")
public Envelope<ResultPage> list(@RequestParam String taskId, @RequestParam(required = false) String speciesType) { … }

public class AnalysisResultRow {
    @Schema(description = "相对丰度，百分数 0–100", minimum = "0", maximum = "100",
            extensions = @Extension(properties = @ExtensionProperty(name = "x-gpas-unit", value = "percent")))
    private Double abundance;
}
```

扩展字段注解的具体写法以你们使用的 springdoc 和 swagger-annotations 版本的文档为准。
其它框架的对应工具：Python FastAPI 自带；Node.js NestJS 用 `@nestjs/swagger`；Go 可以用 swaggo。

切换到做法 B 后，把生成结果与阶段 1 核对好的 YAML 比较，确保内容一致，再以生成结果为准。

### 3.3 改接口时的约定

- **新增字段**：兼容变更，随时可以加，在说明书里同步加上。
- **改名、删除字段或修改含义**：先在说明书中给旧字段标记 `deprecated: true`，并通知 bio-chatbot 团队；至少保留一个版本周期再删除。
- **枚举新增取值**：同步更新对应的字典（目标版本中的 `/dict/{name}`）。

---

## 4. 扩展字段（x-gpas-*）说明

OpenAPI 允许用 `x-` 开头的字段写标准里没有的信息。我们约定以下字段，两份说明书都在使用：

| 字段 | 写在 | 含义 | 取值 |
|---|---|---|---|
| `x-gpas-kind` | 接口 | 接口类别 | `identity` 身份、`data` 数据读取、`action` 写操作、`transfer` 文件传输、`meta` 目录与字典 |
| `x-gpas-scope` | 接口 | 数据范围 | `user` 本人、`team` 本团队、`public` 不区分团队 |
| `x-gpas-team-source` | 接口 | 团队 ID 从哪里来 | 现状有 `path`、`query`、`body`；目标版本全部为 `session`（从会话取）；`none` 表示接口不带团队参数 |
| `x-gpas-effect` | 写接口 | 写操作类型 | `create`、`update`、`delete`、`trigger` |
| `x-gpas-idempotency` | 写接口 | 幂等方式 | `header`（请求头 Idempotency-Key）、`none` |
| `x-gpas-preconditions` | 写接口 | 前置条件 | 例如 `project.notExists` |
| `x-gpas-safe` | 用 POST 的读接口 | 说明这是只读操作 | `true` |
| `x-gpas-entity` | 接口或 schema | 对应数据目录中的哪个实体 | 例如 `sample`、`detection` |
| `x-gpas-unit` | 字段 | 单位 | 例如 `percent`、`ratio`、`byte`、`reads` |
| `x-gpas-dict` | 字段或参数 | 取值来自哪个字典 | 例如 `analysis-status`、`species` |
| `x-gpas-sensitivity` | 字段 | 敏感级别 | `personal`（个人信息）；不写表示普通数据 |
| `x-gpas-state-machine` | 状态字段 | 状态之间的转换 | 例如 `{ uploaded: [qc], qc: [analysing, qcFailed] }` |
| `x-gpas-replaces` | 目标接口 | 它替代的旧接口 | 例如 `GET /file/result/list` |
| `x-gpas-error-codes` | Envelope | 业务错误码表 | 每项包含 code、message、retryable、description |
| `x-gpas-confirm` | 任意位置 | 待确认的问题（仅现状草稿使用，核对后删除） | 问题列表 |
| `x-gpas-issue` | 任意位置 | 已知问题，在目标版本中修正 | 问题列表 |

---

## 5. 阶段 3：实现目标接口

### 5.1 现状 → 目标对照

| 现状接口 | 主要问题 | 目标接口 | 改了什么 |
|---|---|---|---|
| `GET /user/info` | 返回了 lastIP、lastUA 等不需要的个人信息 | 保持路径不变 | 不再返回登录痕迹字段 |
| `GET /project/exist/{ownteamId}` | 团队 ID 在路径中；`info` 不在 `data` 里 | `GET /project/existence` | 团队取自会话；返回 `{ data: { exists, seed } }` |
| `POST /summary/submit/info/{ownteamId}` | 读操作用 POST；结构有时是对象有时是数组；不在 `data` 里 | `GET /project/summary` | 改为 GET；`plans` 总是数组；`monthly` 由服务端按年月合并，缺少的类型为 0 |
| `POST /project/create` | 没有幂等键；`planContent` 是 JSON 字符串；团队在请求体中 | `POST /project` | 请求头 `Idempotency-Key`；`plan` 为对象；团队取自会话；已存在返回 40901 |
| `GET /file/dual/merge/list` | 团队在查询参数中；双端返回两行；brief 是字符串 JSON | 由 `POST /query/execute`（实体 sample）覆盖 | 每个样本一行；条件过滤和精确总数由服务端完成 |
| `GET /file/result/list` | `taskId` 与 `analysisId` 不同名；`taxid` 与 `taxId` 不同名；数值格式不确定 | `GET /analysis/{analysisId}/detections` | 统一命名；数值用数字类型并写明单位；校验团队 |
| （无） | — | `GET /meta/catalog` | 数据目录：可查询的实体、字段、运算符、关系、能力 |
| （无） | — | `GET /dict/{name}` | 统一的字典接口：检测项目、物种、危害等级、各类状态 |
| （无） | — | `POST /query/execute` | 通用只读查询，用于跨样本筛选和统计 |
| 上传相关 4 个接口 | 行为没有文档 | 保持不变 | 只需在说明书中补全阶段 1 的问题答案 |

新接口与旧接口**并存**，bio-chatbot 逐个切换。全部切换后，旧接口在说明书中标记 `deprecated`，再按约定下线。

### 5.2 分期

| 期 | 内容 | 能支持的用户问题 |
|---|---|---|
| P0 | `/meta/catalog`、`/dict/{name}`、`/query/execute`（实体 sample 和 detection；条件 `and`、`not`、`has`、`count`）；样本增加检测项目字段 `detectionType`；`/file/result/list` 补团队校验 | “所有肠道微生物检测的样本”“所有检出 xx 的样本”“三个以上五星病原的样本” |
| P1 | `/project/existence`、`/project/summary`、`POST /project`、`/analysis/{analysisId}/detections`；统一错误码表 | 现有功能迁移到规范接口 |
| P2 | `/query/execute` 支持 `groupBy`、`orderBy` 的度量排序、`compare`；接入更多实体（项目、批次等）；状态变化事件推送 | “每月检出 xx 的样本数”“肠道与呼吸道样本对比” |

### 5.3 实现 `/query/execute` 的要点

详细的请求、处理和响应示例见《[跨样本数据查询](sample-query-data-agent.md)》§6.2 和《[注册表运行时时序](semantic-runtime-sequence.md)》。实现时注意：

1. **只认白名单**：实体、字段、运算符必须在 `/meta/catalog` 中声明，否则返回 40010 或 40011。
2. **字段到数据库列的映射表**由 GPAS 维护，与数据目录放在一起，改列名时只改映射表。
3. **值全部参数绑定**，不拼接 SQL 字符串。
4. **团队过滤**：从会话确定团队，加在根查询和每个子查询上；建议再在数据库层加行级安全，防止遗漏。
5. **限额**：条件深度、IN 列表长度、每页条数、执行超时；超限返回明确的错误码，不静默截断。
6. **总数**：`page.total` 用同样的条件单独计数，必须精确。
7. **快照时间**：响应带 `asOf`。
8. 计数类条件（如“五星病原 ≥ 3 个”）查询量大时，可以建每个样本的汇总表（各危害等级的物种数）加速。

如果不想自己写查询翻译，也可以评估 Cube 等开源语义层工具，但对外的请求和响应格式要与目标说明书保持一致。

---

## 6. 以后新增接口时的检查清单

- [ ] 说明书中有这个接口，`operationId` 唯一，标注了 `x-gpas-kind` 和 `x-gpas-scope`
- [ ] 团队只取自会话，路径、参数、请求体中没有团队 ID
- [ ] 按 ID 访问对象时校验了团队归属
- [ ] 返回统一结构 `{ code, message, data }`，分页放在 `data.page`，总数精确
- [ ] 字段命名与已有接口一致（同一对象同一名称），使用 camelCase
- [ ] 数值是数字类型，单位写在 `x-gpas-unit`；时间是带时区的 ISO 8601
- [ ] 枚举字段标注了 `x-gpas-dict`，字典接口能查到全部取值和中文名
- [ ] 写接口支持 `Idempotency-Key`，并写明前置条件
- [ ] 错误码在错误码表中，并注明是否可以重试
- [ ] 格式检查和契约测试通过

---

## 7. 常见问题

**OpenAPI 和 Swagger 是什么关系？**
Swagger 是 OpenAPI 的前身，现在 Swagger 主要指一组工具（编辑器、界面）。我们用的是 OpenAPI 3.1 格式。

**说明书要写到多细？**
以“调用方不看你们的代码，也能正确调用和理解返回数据”为标准。尤其是单位、取值范围、枚举含义、空值的含义。

**现状接口的问题是不是都要马上改？**
不需要。阶段 1 只要求说明书准确描述现状。问题统一在目标接口中修正，旧接口保持不变，避免影响 GPAS Web。
唯一建议立即修复的是团队校验类的安全问题（问题 4、13、22）。

**数据目录和 OpenAPI 有什么区别？**
OpenAPI 描述“有哪些接口、怎么调用”；数据目录（`/meta/catalog`）描述“通用查询能查哪些数据、能怎么筛选”。
两者都由 GPAS 维护，使用同一个版本号。

**我们改了接口，bio-chatbot 怎么知道？**
bio-chatbot 每天比对一次你们发布的说明书和数据目录，发现变化会告警。但请仍然在改名或删除字段前通知我们。
