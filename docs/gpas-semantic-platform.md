# GPAS 接口语义注册表规划

> **当前采用简化方案**：GPAS 上游评估后，跨样本查询改用《[跨样本查询：简化方案](sample-query-simple.md)》。本文保留为长期参考。

《[跨样本数据查询](sample-query-data-agent.md)》为样本查询设计了语义层注册表。本文把同一思路推广到**全部 GPAS 接口**：
现有接口、正在沟通的接口，以及以后接入的接口，都用同一份契约来描述。
目标是新接口接入时主要写声明，而不是写代码；同时工具数量保持不变，口径和安全规则全局一致。

第一次接触这套机制，可以先读《[语义注册表与 OpenAPI 入门](semantic-registry-guide.md)》。

适用现状（截至本文）：

- 所有工具每次运行都提供给模型，由模型选择。工具数超过 `AGENT_TOOL_LIMIT` 时服务启动失败。
- 单个工具结果的上限是 32 KB，超出时按整条记录删减。
- 本地已不再加载 BGE，也没有 pgvector。

---

## 1. 现状盘点

| GPAS 接口 | 方法 | 现有工具 / 通道 | 问题 |
|---|---|---|---|
| `user/info` | GET | `user.profile`（直接用会话资料） | — |
| `project/exist/{ownteamId}` | GET | `project.status` | 团队 ID 放在路径里，由调用方传入 |
| `summary/submit/info/{ownteamId}` | POST（实际是读） | `project.progress` | 读操作用 POST；`projectPlanInfo` 有时是对象、有时是数组 |
| `project/create` | POST | `project.initialize`（只准备表单） | 没有幂等键，只能靠本地团队锁 |
| `file/dual/merge/list` | GET | `file.list` | 返回体是顶层 `dataPage`，不在 `data` 里；同一对双端文件返回两行；按文件名还是样本名匹配不明确 |
| `file/result/list` | GET | `file.result` | 参数叫 `taskId`，列表里叫 `analysisId`；`taxid`/`taxId` 两种写法并存；是否校验 `taskId` 属于当前团队待确认 |
| `file/task`、`file/dual/task`、`file/upload/{id}` 等 | POST | 浏览器直传 | 可重试的业务码、分片幂等等行为没有文档 |

`docs/gpas-project-chat.md` 的远端验收清单有 18 项待确认，大多是契约问题：单位、取值范围、枚举含义、是否分页、团队校验。

目前每接入一个接口，要手写 zod 校验、结果裁剪、回复、策略和示例，并写一个新工具。照这样做下去：

- 工具数线性增长，很快需要调大 `AGENT_TOOL_LIMIT`，模型选错工具的概率也随之上升；
- 同一类问题（单位、团队范围、分页、状态翻译）在每个工具里各处理一遍，口径容易不一致。

---

## 2. 核心判断：接口分四类，分别建模

不是所有接口都是“查询”。注册表按接口的性质分类，每类有自己的描述方式和通用工具：

| 类别 | 例子 | 注册表中描述什么 | 智能体怎么用 |
|---|---|---|---|
| **数据（查询）** | 项目进度、样本列表、检测结果、各类统计 | 实体、字段、关系、度量、字典、业务口径 | `data.catalog` 和 `data.query`（见跨样本查询方案） |
| **操作（写入）** | 创建项目、发起重分析、导出报告、修改计划 | 操作名、输入 schema、前置条件、影响级别、幂等方式、确认表单 | `action.prepare` 只生成确认表单；用户确认后走业务路径执行，模型永远不能直接执行 |
| **长任务与状态** | 上传 → 质检 → 分析 → 审核 | 状态机：状态、转换、各状态的含义与预计耗时 | 作为实体的状态字段查询；状态说明来自注册表，不在提示词里写死 |
| **传输与会话** | 分片上传、下载、登录身份 | 只登记，不建模为工具 | 保留专用通道（浏览器直传、会话资料） |

这样分类后，**工具数量不随接口数量增长**：

| 工具 | 覆盖 |
|---|---|
| `data.catalog` | 所有数据类接口的字段、字典、口径 |
| `data.query` | 所有数据类接口的查询、统计、分页 |
| `action.prepare` | 所有操作类接口的确认表单 |
| `user.profile` | 会话身份（保留） |

只有在通用工具确实表达不了时，才允许新增专用工具（判定标准见 §6.2）。

---

## 3. 注册表分三层

```text
L1 上游契约（GPAS 负责，机器可读）
   · 数据目录 GET meta/catalog：实体、主键、字段类型、单位、取值范围、字典、允许的运算符、实体关系、查询能力
   · OpenAPI 3.1：每个接口的地址、方法、参数、返回结构、错误码、幂等方式、身份范围、状态机
   · 两者使用同一个版本号 catalogVersion
        │  npm run semantic:sync 拉取 → 提交到仓库的快照 src/server/semantic/upstream/
        │  CI 比对：L2 引用的字段、运算符、字典是否都存在
        ▼
L2 语义层（本项目负责，人工评审）
   · 按领域拆文件：src/server/semantic/domains/<domain>.ts，统一格式见 §3.2
   · 中文名、同义词、敏感级别、业务口径、隐含条件、默认列、展示方式、绑定方式、表单、策略
        │  启动时合并全部领域并校验，失败则服务启动失败
        ▼
L3 运行时派生（不手写）
   · 通用工具的参数说明和校验、查询编译器、操作表单、结果列渲染、口径复述、
     skill 中的字段目录、评测用例模板、契约测试用的 mock 数据
```

为什么分三层：

- **事实归上游，含义归我们。** 字段类型、单位、枚举值只能由数据的主人给出，写在 L1；
  “五星病原”指什么、要不要给模型看，是业务口径和产品决策，写在 L2。
  Anthropic 的经验是：口径由人维护，让 LLM 自动生成口径反而降低准确率。
- **L2 只引用 L1，不复制。** 上游改字段时，CI 能立刻发现 L2 中失效的引用。
- **L3 全部派生。** 新增接口时，不需要同时改工具说明、校验、界面和文档，避免各处不一致。
- **运行时只读快照，不实时拉取上游目录。** 启动结果可复现；上游目录的变化由每天的漂移检查发现，
  确认后通过 `semantic:sync` 更新快照并在同一个 PR 中修改 L2。运行中的请求和响应只核对 `catalogVersion`。

**什么信息写在哪一层**（两份方案文档都以此为准）：

| 信息 | 写在 |
|---|---|
| 实体、主键、字段类型、单位、取值范围、字典、允许的运算符、实体之间的关系、查询能力 | L1 |
| 接口地址、方法、参数、错误码、幂等方式、状态机 | L1 |
| 中文名、同义词、敏感级别、口径说明（`note`） | L2 |
| 业务口径（`segments`）、度量与派生度量（`measures`） | L2 |
| 隐含条件（`requiresParent`）、默认列、展示方式（`view`）、绑定方式（`binding`） | L2 |
| 操作的表单、前置条件、策略说明，不支持操作的说明 | L2 |

### 3.1 L1：对上游的契约要求

建议 GPAS 为所有接口发布 OpenAPI 3.1，并用扩展字段补充语义（字段名示意）：

```yaml
paths:
  /query/execute:
    post:
      operationId: queryExecute
      x-gpas-kind: data            # data | action | job | transfer
      x-gpas-scope: team           # 团队来自会话，请求中不得出现团队参数
  /project/create:
    post:
      operationId: projectCreate
      x-gpas-kind: action
      x-gpas-effect: create        # create | update | delete | trigger
      x-gpas-idempotency: header   # 请求头 Idempotency-Key
      x-gpas-preconditions: [project.notExists]
components:
  schemas:
    Detection:
      x-gpas-entity: detection     # 对应数据目录中的实体
      properties:
        abundance:   { type: number, x-gpas-unit: percent }
        hazardIndex: { type: integer, minimum: 1, maximum: 5, x-gpas-dict: hazard-levels }
        taxId:       { type: string, x-gpas-dict: species }
    Sample:
      x-gpas-entity: sample
      properties:
        analysisStatus:
          type: string
          x-gpas-dict: analysis-status
          x-gpas-state-machine: { uploaded: [qc], qc: [analysing, qcFailed], analysing: [analysisverified, failed] }
```

数据目录 `GET meta/catalog` 的格式见跨样本查询方案 §6.1，一次请求在各层之间如何流转见《[注册表运行时时序](semantic-runtime-sequence.md)》。上游短期做不了完整的 OpenAPI 时，
至少先提供数据目录和统一的字典接口。

根据现有接口起草的 OpenAPI 现状与目标说明书，以及给 GPAS 团队的实施步骤，见《[GPAS OpenAPI 规划](gpas-openapi-plan.md)》。

### 3.2 L2：领域文件的统一格式

所有领域文件都用 `defineDomain` 声明，结构如下。跨样本查询方案 §5.2 的样本和分析结果领域也按这个格式写。

```ts
defineDomain({
  id: string,                            // 领域 ID，如 'project'、'sample'、'analysis'
  label: string,
  owners: { gpas: string, app: string },
  skill: { knowledge: string, runbook: string },
  entities: Record<string, EntitySpec>,
  segments?: Record<string, SegmentSpec>,  // 业务口径；名称在全部领域中唯一
  actions?: Record<string, ActionSpec>,
  unsupported?: UnsupportedSpec[],
})

type EntitySpec = {
  ref: string                            // L1 数据目录中的实体名
  label: string, synonyms?: string[]
  binding: { kind: 'generic' } | { kind: 'adapter', adapter: string }   // 见第 4 节
  fields: Record<string, FieldSpec>      // 只登记要用的字段；未登记的 L1 字段对模型和查询都不可见
  measures?: Record<string, MeasureSpec>
  requiresParent?: Predicate             // 查询涉及该实体时，父实体必须满足的条件
  defaultSelect?: string[]               // 默认返回列
  view?: string                          // 结果展示组件
}

type FieldSpec = {
  ref?: string                           // L1 字段名；省略时与键名相同
  label: string, synonyms?: string[]
  sensitivity: 'public' | 'internal' | 'personal'   // secret 字段不允许登记
  ops?: Op[]                             // 只能收窄 L1 声明的运算符，不能放宽
  note?: string                          // 口径说明，进入 skill 和口径复述
}

type MeasureSpec =
  | { label: string, agg: 'count', note?: string }
  | { label: string, agg: 'count_distinct' | 'sum' | 'avg' | 'min' | 'max', field: string, note?: string }
  | { label: string, ratio: { numerator: MeasureRef, denominator: MeasureRef }, note?: string }
type MeasureRef = string | { measure: string, where?: Predicate }   // 字符串是 { measure } 的简写

type SegmentSpec = { label: string, synonyms?: string[], entity: string, where: Predicate, note?: string }
type ActionSpec = { ref: string /* OpenAPI operationId */, label: string, synonyms?: string[],
                    form: string, preconditions?: string[], policy: string }
type UnsupportedSpec = { id: string, label: string, examples: string[], policy: string }
```

**命名规则**：

- 模型和查询 IR 只使用 L2 的键名，例如 `hazardLevel`；
- 发给上游时，编译器按 `ref` 换成 L1 名称，例如 `hazardIndex`；
- 上游改名只需要改 `ref`，模型看到的名称不变。

示例：项目领域。

```ts
// src/server/semantic/domains/project.ts（示意）
export const projectDomain = defineDomain({
  id: 'project', label: '项目',
  owners: { gpas: '项目服务负责人', app: '本仓库负责人' },
  skill: { knowledge: 'skills/project/knowledge.md', runbook: 'skills/project/runbook.md' },
  entities: {
    progress: {
      ref: 'projectProgress', label: '样本提交进度', synonyms: ['任务进度', '完成情况'],
      binding: { kind: 'adapter', adapter: 'summarySubmitInfo' },   // 旧接口 POST summary/submit/info
      fields: {
        sampleType: { label: '样本类型', synonyms: ['样本类别'], sensitivity: 'public' },
        month:      { label: '提交月份', sensitivity: 'public' },
        planCount:  { label: '计划数量', sensitivity: 'public' },
        submittedCount: { label: '提交数量', sensitivity: 'public' },
      },
      measures: {
        plan:      { label: '计划数量', agg: 'sum', field: 'planCount' },
        submitted: { label: '累计提交', agg: 'sum', field: 'submittedCount' },
        completionRate: { label: '完成率', ratio: { numerator: 'submitted', denominator: 'plan' },
                          note: '计划为 0 时显示“未设置计划”；超额提交保留大于 100% 的值' },
      },
      view: 'progressChart',                     // 复用现有 ProjectProgressCard
    },
  },
  actions: {
    'project.create': {
      ref: 'projectCreate', label: '首次初始化项目', synonyms: ['创建项目', '初始化项目'],
      form: 'projectInit',                       // 复用现有确认表单
      preconditions: ['project.notExists'],
      policy: '仅支持尚未创建项目的团队首次初始化；已有项目不能重新初始化。',
    },
  },
  unsupported: [
    { id: 'project.reinitialize', label: '重新初始化项目', examples: ['能不能把项目重置一下'], policy: '当前系统不支持……' },
  ],
})
```

每个登记的字段都要声明**敏感级别**：

| 级别 | 例子 | 给模型 | 给用户界面 |
|---|---|---|---|
| `public` | 物种名称、危害等级、统计数 | 可以 | 可以 |
| `internal` | 内部 ID、颜色、图片链接 | 不给（taskId 这类只用于工具串联的 ID 例外，并要求不展示） | 按需 |
| `personal` | 手机号、邮箱 | 只在用户问到本人信息时给 | 可以 |
| `secret` | Cookie、令牌 | 不允许登记 | 不允许登记 |

现在由各工具 `toModel` 手写的字段白名单，以后由登记的字段和敏感级别统一生成。L1 中有、但 L2 没有登记的字段一律不可见。


---

## 4. 遗留接口的接入方式：适配器

上游不会一次性改完全部接口。注册表条目可以绑定两种实现：

| 绑定方式 | 用于 | 说明 |
|---|---|---|
| **通用执行**（`binding: { kind: 'generic' }`） | 已支持 `query/execute` 或符合契约规范的新接口 | 编译器直接生成请求，不写代码 |
| **适配器**（`binding: { kind: 'adapter', adapter }`） | 暂时不改的旧接口 | 手写一个小函数，把查询 IR 的一个子集翻译成旧接口调用，再整理成注册表声明的形状。现有的 `file.list` 扫描和去重、`project.progress` 的月度合并，都会变成适配器 |

适配器声明自己支持哪些字段和运算符；不支持的组合由编译器直接拒绝，返回“暂不支持”。
上游接口升级后，把绑定从适配器改为通用执行，工具、提示词和界面都不用改。

这让迁移可以按接口逐个进行，不需要一次切换。

---

## 5. 领域划分与负责人

| 领域 | 内容 | 现有接口 | 以后可能接入 |
|---|---|---|---|
| `identity` | 用户、团队 | `user/info` | 团队成员、角色权限 |
| `project` | 项目、计划、提交进度 | `project/*`、`summary/*` | 修改计划、项目里程碑 |
| `sample` | 文件、样本、质检、分析状态 | `file/dual/merge/list`、上传 | 元信息、重分析、批次 |
| `analysis` | 检出结果、物种、危害等级 | `file/result/list` | 耐药基因、毒力因子、报告 |
| `dictionary` | 物种分类、检测项目、危害等级、状态 | 暂无 | 地区、宿主、平台 |

- 每个领域有**双方负责人**：GPAS 侧对 L1 负责，本项目对 L2 和 skill 负责。领域文件用 `CODEOWNERS` 绑定评审人。
- 每个领域一对 skill（knowledge 和 runbook）。提示词中只放一行一个领域的索引，
  模型需要细节时用 `data.catalog` 按领域加载，上下文不会随领域增多而膨胀。

---

## 6. 新接口接入流程

### 6.1 步骤与产出

| 步骤 | 负责方 | 产出 | 完成标准 |
|---|---|---|---|
| 1. 需求 | 产品与业务 | 至少 10 条真实用户问题；说明属于哪类接口（数据、操作、长任务、传输） | 问题能对应到第 1 节跨样本查询方案中的形状，或某个操作 |
| 2. 契约 | GPAS | OpenAPI 与语义扩展；字典；沙箱团队里固定的测试数据 | 通过 §7 的契约规范检查 |
| 3. 语义 | 本项目，业务方评审 | L2 条目：中文名、同义词、口径、可见性、展示方式；skill 更新 | 业务方签字确认口径 |
| 4. 评测 | 本项目 | 评测用例（模板自动生成，人工补措辞）；适配器或通用执行 | 问题 → 查询或操作的准确率 ≥ 90% |
| 5. 上线 | 双方 | 按领域的功能开关；监控 `ToolRun` 中的错误率和“暂不支持”比例 | 一周内无口径相关的用户纠错 |

### 6.2 判断该怎么接

```text
新接口
 ├─ 能表达为已有实体的字段、关系、度量？ ── 是 → 只加 L1 字段和 L2 条目（不写代码）
 ├─ 是新实体或新关系？ ─────────────────── 是 → 加实体与关系；查询能力不够时扩展 IR（需评审）
 ├─ 是写操作？ ─────────────────────────── 是 → 加 action 条目和表单；执行走用户确认后的业务路径
 ├─ 有特殊交互（如分片传输、实时流）？ ──── 是 → 专用通道或专用工具，需写明为什么通用工具不行
 └─ 都不是 → 先登记为 unsupported，并给出说明，等需求明确
```

**专用工具的准入条件**（同时满足）：通用工具表达不了；有明确的交互或安全理由；已经登记在注册表中，策略说明和审计规则与其它工具一致。

---

## 7. 给 GPAS 的接口规范（建议作为双方约定）

所有新接口，以及逐步改造的旧接口，都遵守下面这些规则：

1. **统一返回结构**：`{ code, message, data }`，分页统一放在 `data.page = { page, pageSize, total }`；`total` 必须是精确值。
2. **身份只取自会话**：团队、用户不出现在路径、查询串或请求体中；所有按 ID 访问的接口都在服务端校验对象属于当前团队，否则返回 403。
3. **方法语义**：读用 GET；条件复杂的读用 `POST .../query`，并在契约中标记为安全只读；写用 POST/PUT/DELETE，并支持 `Idempotency-Key`。
4. **命名与 ID**：camelCase；同一个对象在所有接口里同名（不再出现 `taskId` 和 `analysisId` 指同一个东西）。
5. **单位、取值范围、枚举**：写在契约里；枚举有对应的字典接口；枚举代码发布后不再改名。
6. **时间**：ISO 8601，带时区。
7. **错误码**：有一份稳定的业务错误码表，注明哪些可以重试。
8. **状态机**：长任务对象公布状态、转换和含义。
9. **数据新鲜度**：查询结果带 `asOf`。可选：状态变化事件（例如分析完成）通过 webhook 或事件流推送，用于通知和缓存失效。
10. **版本**：契约带版本号；新增字段属于兼容变更；改名或删除要先标记 `deprecated`，至少保留一个版本周期，并提供变更日志。
11. **测试环境**：提供一个沙箱团队和固定数据，用于契约测试和评测。现在只能在远端用真实账号验收。
12. **性能**：列表和查询接口 p95 < 1 秒；公布限流规则。

---

## 8. 治理

- **同一个 PR 修改**：上游契约版本变化时，L2 条目、skill、评测在同一个 PR 中更新（这也是 Anthropic 的做法）。
- **CI 检查**：
  - 每次构建：L2 引用的 L1 字段、运算符、字典都存在；生成物与提交的版本一致；确定性部分的单元测试通过。
  - 每天：拉取生产环境的 `meta/catalog` 与注册表比对，不一致时告警（防漂移）。
- **口径评审**：L2 中的业务口径（segments、派生度量、`note`）修改需要业务方评审。
- **线上信号**：
  - “暂不支持”比例上升，说明有新需求，进入 §6 的流程；
  - 用户纠错和参数校验失败率上升，说明口径或 skill 需要修订。

---

## 9. 路线图

| 阶段 | 内容 | 结果 |
|---|---|---|
| 0. 对齐 | 与 GPAS 确认 §7 规范和 L1 元数据格式；按第 1 节盘点所有现有和计划中的接口，给每个接口归类 | 双方签署的接口规范；接口清单 |
| 1. 框架和数据类迁移 | 实现注册表、`data.catalog`、`data.query` 和编译器；`file.list`、`file.result`、`project.progress`、`project.status` 改为注册表条目加适配器；界面通过 `view` 继续使用现有卡片和面板 | 工具从 6 个变为 4 个通用工具；跨样本查询的新能力上线 |
| 2. 操作类 | 实现 `action.prepare` 和表单生成；`project.initialize` 迁移；接入新的写操作 | 新增写操作不再需要新工具 |
| 3. 上游升级 | 上游提供 `query/execute` 和完整元数据后，把适配器逐个切换为通用执行 | 适配器代码逐步删除 |
| 4. 复用 | 深度研究通过同一注册表读取团队数据；需要时把注册表暴露为 MCP 服务器，供其它客户端或智能体使用 | 一份契约，多处使用 |

**第 1 阶段的风险**：把现有工具合并成通用工具后，模型选工具更简单，但填写查询 IR 更难。
迁移前先为现有问题（`docs/gpas-project-chat.md` 中的各类说法）建立评测基线，迁移后准确率不低于基线才切换。
