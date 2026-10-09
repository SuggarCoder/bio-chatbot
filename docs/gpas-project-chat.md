# GPAS 项目对话

在输入框发送“我是谁”“我们组临床样本还差多少”“帮我初始化项目”等，智能体会调用
对应的 GPAS 工具（用户资料、项目进度、初始化状态、首次初始化表单）并基于结果作答，
一条消息可以组合多个工具。工具选择由模型完成，身份与权限由服务端控制，没有正则、
关键词或单独的语义规划步骤。架构、隔离规则和新增接口方式见 [智能体与 GPAS 工具](agent.md)。

不支持的操作（重新初始化项目、修改/删除/提交/导出等未接入业务）作为策略写进模型指令，
模型按策略说明，不会改查近似功能。首次初始化工具只准备确认表单，不调用创建接口。
已存在项目不能重新初始化，也没有“删除重建”的替代路径。

项目未初始化时，消息中展示基础信息和四类样本计划表单。项目编码只读，
项目名称默认取存在性接口 `info.userName`，联系方式默认取 `info.phone`。
数量允许零，必须为非负安全整数。用户点击“确认创建项目”才调用创建 API。
创建后发送“我的任务进度”获取最新进度。

项目已存在时，按 `realSubmitInfo` 所有年月累计四类样本的顶层数量；
不再累加 `studies`，以免重复计数。月份缺少某类数量按零处理；缺失计划或
无效响应报错。计划为零显示“未设置计划”；超额提交保留大于 100% 的完成率。

## 接口与部署

复用 `GPAS2_AUTH_MODE` 和 `GPAS2_USER_INFO_URL`，无需新的端口或反向代理配置。用户信息 URL 必须以 `/user/info` 或 `/user/info/` 结尾，
业务地址使用它的同源版本前缀，去除查询参数和片段：

- `GET project/exist/{ownteamId}`
- `POST summary/submit/info/{ownteamId}`：`Content-Type: application/json`，请求体为空（不是 `{}`）
- `POST project/create`

汇总查询虽然读取数据，但旧系统要求 POST。请求方法按操作显式指定，不能根据
是否携带请求体推断为 GET。旧实现误用 GET，与原始浏览器请求不一致。

远端配置用户信息 URL 后，上述接口自动使用相同主机、端口和版本前缀。
浏览器始终请求同源 `/ai-chatbot/api/`，网关需保留 Cookie；服务端逐次鉴权，
仅向配置的 GPAS 服务转发 Cookie。智能体运行期间 Cookie 以 AES-256-GCM 加密保存在
`Generation.credential`（绑定用户与该次生成），生成结束即清除；它不进入 Redis 队列、
日志或模型提示词。
内网 CA 与网关要求见 [部署鉴权说明](deployment-auth.md)。

现有 `POST /ai-chatbot/api/conversations/:chatId/messages` 增加可选 `projectInput`：
`sourceMessageId`、`projectName`、`projectDesc`、`phone`、`samples`。
业务回复返回 `{ kind: 'business', userMessage, assistantMessage }`；其他回复保持
原有 generation 响应。项目表单作为 `gpas` 类型的消息 part 保存，刷新可恢复。
业务回复也保存为文本，供后续对话上下文使用。

创建时重新检查项目存在性，项目编码和团队 ID 来自已鉴权的服务端数据，
并核验表单所属会话及原始编码。相同请求 ID 复用已保存回复；数据库团队锁
串行处理本应用各实例的创建请求。其它系统仍需由上游保障团队项目唯一性。
创建响应超时表示结果未知；重新查询进度确认状态后再提交。

## 本地验证与远端验收

`GPAS2_AUTH_MODE=mock` 时不访问远端。项目初始为未创建，提交后保存在 API
进程内，进度为提交表单中的计划量和零实际提交量，重启后重置。
生产环境仍禁止 mock。示例数据均为演示用途。

本地运行 `npm run check`、`npm run build`、`npm test`，
以及 `npm run test:gpas-ui`。数据库集成测试需设置独立的 `TEST_DATABASE_URL`。
`npm test` 在本地模型存在时运行真实 BGE 召回回归（工具数超过 `AGENT_TOOL_LIMIT`
时才会在运行期使用 BGE）；缺少模型时明确跳过这项测试。

新增接口方式和扩展约束见 [智能体与 GPAS 工具](agent.md)。

远端需使用真实登录 Cookie 验收：身份与团队显示、已有项目四类进度、未初始化
团队的表单默认值、提交成功后再查询、双击或跨标签页提交、Cookie 失效、
上游异常、刷新对话恢复，以及 `/ai-chatbot/api/health`。

## 上游错误定位

`gpas_upstream_error` 表示收到上游非 2xx HTTP 响应（401/403 另作鉴权错误），
不是网络连接或超时错误。前端错误现在包含操作阶段和实际 HTTP 状态码，例如
“项目进度汇总查询返回错误（上游 HTTP 404）”。网络错误为 `gpas_unavailable`，
HTTP 成功但业务 `code` 非 200 为 `gpas_business_error`。

按响应的 `requestId` 查 API 日志中的 `GPAS upstream request failed`，查看：
`gpas.operation`、`gpas.method`、`gpas.endpoint`、`gpas.upstreamStatus`、
`gpas.responseContentType`，以及可用时
的 `gpas.upstreamCode`。操作分别是 `project_exists`、`project_summary` 和
`project_create`。`endpoint` 记录实际请求路径（含当前团队 ID），去除 URL 认证信息，
不记录 Cookie、提交内容或原始响应正文。旧版日志曾将团队 ID 替换为 `{teamId}`，
在 URL 序列化后显示为 `%7BteamId%7D`；这个占位符只用于日志，不是实际请求参数。
实际状态码、失败阶段和网关日志是定位远端问题的依据；
仅凭旧版通用错误无法判断是地址错误、网关拒绝还是上游服务故障。

智能体每次工具调用写入 `ToolRun`（工具名、校验后的参数、结果字节数、错误），可按
generation 查询；不记录 Cookie 或工具返回的数据。

## 测序文件上传（第一阶段）

输入框“上传文件”接受 `.fastq/.fastq.gz/.fq/.fq.gz`，单次最多 10 个；超出时本次选择不加入，
并提示前往 `{当前域名}/app/upload`（GPAS Web 上传页）。同名的不同文件、空文件直接拒绝。

选择后立即在浏览器内做单双端判断（`src/client/features/gpasUpload/fastqPairing.ts`）：
文件名预配对，再用 FASTQ 头部的 read ID 交叉验证；新增文件只读取新文件，但整批重新配对。
存在孤立 R2、文件名不规范、或未确认的疑似 R1 时不能发送。上传前必须选择样本类型。

文件列表显示在输入框上方，样本类型在文件列表下一行。可选的样本类型来自 `project.status` 工具
（`GET /ai-chatbot/api/gpas/upload/sample-types`）：团队未初始化项目时显示全部四类；已初始化时只显示
计划数量大于 0 的类型，多个项目取交集（AND）；只有一类时自动选中。发送按钮不可用时悬停显示原因。

点击发送时先上传，全部文件结束后才发送消息：

- 浏览器直接请求同源 `/api/gpas2/v1/file/*`，只带 GPAS Cookie（可用 `VITE_GPAS_API_BASE` 覆盖前缀）。
- 5MB 分片、全局并发 3、R1/R2 交错上传；每片最多 6 次尝试，指数退避加抖动；
  断网时等待恢复且不计次数；30 秒无上传进度或发完后 60 秒无响应视为超时。
- 401/403 停止整批并提示重新登录；部分失败时可重试失败文件（复用原任务补传缺失分片），
  或跳过失败直接发送；取消上传不发送消息，保留输入内容。
- 有文件上传成功后删除同源 `localStorage` 的 `pollingGate_{userName}_{teamId}`，
  让 GPAS Web 数据状态页立即重新判断是否轮询。

消息请求体增加可选 `uploads`（`gpasUploadBatchSchema`）。用户消息 `content` 追加服务端渲染的
上传结果摘要，供模型在本轮及后续上下文中读取；界面显示用户原文和 `gpas_upload` part 中的文件列表。
`uploads` 由客户端上报，只作为模型上下文，服务端不会据此对 GPAS 做任何写操作。

带上传结果的消息总会向助手提供 `file.list` 工具（`GET file/dual/merge/list`，参数放在查询串，服务端用会话 Cookie 和
当前团队 `ownTeamId` 查询）。助手按这批上传成功的**文件名**（`fileNames`）查询并展示它们的状态和分析结果，
而不是复述上传进度：每个文件名请求一次 `fileName=<名称>`（每次 10 条），只保留文件名完全相同的行，双端两个文件名命中同一样本时合并。
未找到的文件名作为“可能仍在入库”返回。用户之后也可以直接问“我上传的文件”。

`file.list` 的结果以“病原体分类分布”卡片展示在助手回复下方（每个样本一张，双端合并），由
`src/client/features/gpasUpload/FileAnalysisCards.tsx` 渲染，数据来自解析后的 `briefAnalysis`（`parseBrief`）：

- brief 只是摘要：每个类别只保留类别内相对丰度前 5 的物种，并标注“检出 X 种 · 占比 Y% · 丰度前 N”，
  剩余部分显示为“其它 N 种”。`abundance` 是类别内的相对丰度；数据中没有类别之间的丰度占比，
  类别占比按检出种数计算（该类别检出种数 / 全部检出种数，`categorySharePct`），类别块仍等宽排列。
- 单端与双端文件的分析结果一致，双端样本只展示一份：取第一个可解析的 `briefAnalysis`。
  `merge/list` 可能把同一对双端文件按 R1/R2、R2/R1 各返回一行，服务端合并同一样本的行（`mergeDuplicateRows`）：双端按 `groupId`，缺失时按 `analysisId`，单端按 `fileId`，保留有分析结果的那行。
- 检出类别最多显示 5 块，超过时按检出种数取前 4 块，其余合并为“其他”；未检出的类别列在“未检出”一行。
- ★ 数量为 `hazardIndex`。brief 缺失或无法解析时，卡片只显示文件信息和分析状态。
- 模型只拿到精简数据和措辞规则（“丰度前 N”“共检出 X 种”），原始 brief 字符串不交给模型。
- 卡片 header 右侧的「查看详情」（卡片有 `analysisId` 时显示）发送消息“通过分析ID查看样本详情”，
  分析 ID 放在请求体 `detail.taskId`（与 `uploads` 相同的做法）：用户气泡只显示这句文字，ID 只出现在
  `renderDetailContext` 追加给模型的上下文和 `gpas_detail` part 中。带 `detail` 的消息总会向助手提供 `file.result` 工具（`withDetailTool`）。
  上传与详情消息的隐藏上下文存在消息的 `content` 中：界面展示走 `mapMessage`（只取用户文字），
  模型上下文走 `contextContent`（`rebuildChatContext` 与生成起始消息都使用它），两者不能混用。
- 同一样本在当前会话里已经有详情回复时，再点「查看详情」直接打开面板，不再发消息、调用模型或请求 GPAS。
  面板按样本保留已加载的页面、当前 tab 和页码（最近 10 个样本），关闭后重新打开不会重新请求。

### 样本分析详情（`file.result`）

`file.result` 工具调用 `GET file/result/list`（`taskId`、可选 `speciesType`、`page`、`pageSize`，默认每页 20 条），
与其它 GPAS 工具一致：服务端用会话 Cookie 请求上游，字段白名单后的当页数据交给模型（不含颜色、覆盖度图链接和内部 id），
回复附带 `result` part（taskId、总数；agent 会把含 `result` 的 part 转发到回复中）。模型被要求只用 1–2 句概括，不复述 taskId、不逐条列举物种。`coverageUrl` 只保留 http(s) 链接，`color` 只保留 `#hex`/`rgb()`。

回复完成后自动在右侧面板（复用 Artifact 侧栏）打开分析详情，之后可点回复中的入口卡片重新打开。面板由
`src/client/features/gpasUpload/GpasResultPanel.tsx` 渲染：

- 顶部统计（取自该样本卡片的 briefAnalysis，使用应用的青绿主题色）：检出物种总数与大类数、测序 Reads 与数据量、最高风险等级、
  大类构成环形图（按检出种数占比，颜色与分析卡片的类别色一致）、类别内丰度 Top 3 物种。
- 物种表格列：序号、生物学编号（`taxId`）、物种名称、定植特性、风险程度分级（`hazardIndex`，1–5 级）、覆盖度、可信度雷达。
  面板宽度小于 460px 时生物学编号折到物种名下方，表格在自身容器内横向滚动。
- 可信度雷达（`src/client/features/gpasUpload/evidenceRadar.ts`）：六个维度各归一化为 0–100，缺失记 0 并显示「—」：
  物种自比对率 `selfAlignRatio`（×100）、基因组覆盖度（比例，20% 满分）、唯一匹配 Reads `onlyMatching`（对数，100 reads 满分）、
  基因组均一度 `unifPvalue`（−log10 P，指数饱和 1−e^(−x/6.6)）、样本内物种丰度 `abundance`（百分数，对数，1% 满分）、
  物种混淆度 `ani95SpeciesNums`（100/(1+n)）。表格内为无标注小图，点击打开完整雷达（原始值标注与明细表）。
  面积颜色按 `hazardIndex` 分 5 级渐变（`hazardGradients`），风险分级胶囊用同一色阶。
- tabs 为「全部」加该样本卡片中检出的大类（`microbialType` 作为 `speciesType`），找不到卡片时只有「全部」。
- 每个 tab、每一页只在显示时请求一次并缓存；加载时显示骨架屏，失败可重试。
- 翻页和切 tab 请求 `GET /ai-chatbot/api/gpas/file/results`，服务端以当前会话身份执行同一个 `file.result` 工具；
  浏览器不直接访问 GPAS，这些数据也不进入模型上下文（用户问到其它页时模型可带 `page`/`speciesType` 再调用工具）。

### 远端验收清单

上传接口无法在本地访问，以下需在远端用真实登录验证；默认假设集中在
`src/client/features/gpasUpload/gpasUploadApi.ts` 顶部，不符时在那里调整：

1. 只带 Cookie（不带 `Authorization`）能调用 `file/task`、`file/dual/task`、`file/upload/{id}`、`file/dual/upload/{id}`。
2. 同一分片 `no` 重复上传安全；同一任务可在失败后补传缺失分片。
3. `dual/task` 原样返回 `fileList[].name`；`endType` 两端取值不同。
4. `sampleType` 接受 `clinic/media/environment/lab`。
5. 哪些业务 `code` 可重试（填入 `RETRYABLE_BUSINESS_CODES`）。
6. 上传 1 个单端加 1 对双端后，GPAS Web 能看到文件，数据状态页立即开始轮询（同时确认 `pollingGate` 的 key 与 `/me` 的 `userName`、`externalTeamId` 对应）。
7. 上传中断网再恢复能继续；限速弱网下进度持续推进；Cookie 失效时整批停止并提示重新登录。
8. 服务端转发会话 Cookie 能调用 `file/dual/merge/list`；返回体为顶层 `dataPage`（不在 `data` 内）；
   文件行上是否有 `qcStatus` 字段，状态取值是否需要翻译成中文（见 `src/server/gpas/tools/file.ts`）。
9. 刚上传完成的文件能否立即出现在 `merge/list` 中；若有延迟，助手会提示部分文件“可能仍在入库”。
10. `summary/submit/info` 在多项目团队下 `projectPlanInfo` 的实际形状（当前同时接受对象或对象数组）。
11. 各类别的 `topInfos` 实际最多返回几条（卡片最多展示 5 条）。
12. `dataVolume` 的单位（当前显示为“数据量 10.68 G”）；`hazardIndex` 的取值范围（当前按 0–5 颗星显示）。
13. `metaStatus`、`analysisStatus` 的取值与中文含义（当前原样显示）。
14. `merge/list` 的 `fileName` 是精确匹配还是模糊匹配（服务端已按文件名精确过滤）；文件行上是否有 `analysisId`，且即为 `file/result/list` 的 `taskId`。
15. `file/result/list` 的 `speciesType` 取值是否与 brief 的 `microbialType`（bacteria/viral/fungi…）一致；`coverage` 的格式（百分比字符串或小数）。
16. `file/result/list` 是否按会话 Cookie 校验 taskId 属于当前团队（taskId 来自用户或模型输入）。
17. result 行上是否都有 `taxId`、`hazardIndex`、`selfAlignRatio`、`onlyMatching`、`unifPvalue`、`abundance`、`ani95SpeciesNums`；
    `unifPvalue` 是否已是 −log10 值，`abundance` 是否为百分数，`coverage` 是比例还是百分比（当前 ≤1 视为比例）。
