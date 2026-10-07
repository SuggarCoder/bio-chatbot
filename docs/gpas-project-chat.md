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
当前团队 `ownTeamId` 查询）。助手按这批上传成功的 `fileId` 查询，并用表格展示文件状态、质检、分析和元信息状态，
而不是复述上传进度。接口不支持按 fileId 过滤，因此按接口默认排序（`-update_time, -create_time`）取最新一页（50 条）在服务端筛选，
未找到的 fileId 作为“可能仍在入库”返回。用户之后也可以直接问“我上传的文件”。

`file.list` 的结果以“病原体分类分布”卡片展示在助手回复下方（每个样本一张，双端合并），由
`src/client/features/gpasUpload/FileAnalysisCards.tsx` 渲染，数据来自解析后的 `briefAnalysis`（`parseBrief`）：

- brief 只是摘要：每个类别只保留类别内相对丰度前 3 的物种，并标注“检出 X 种 · 丰度前 N”，
  剩余部分显示为“其余 N 种”。`abundance` 是类别内的相对丰度，数据中没有类别之间的占比，
  因此类别块等宽排列，不标类别百分比。
- 检出类别最多显示 5 块，超过时按检出种数取前 4 块，其余合并为“其他”；未检出的类别列在“未检出”一行。
- ★ 数量为 `hazardIndex`。brief 缺失或无法解析时，卡片只显示文件信息和分析状态。
- 模型只拿到精简数据和措辞规则（“丰度前 N”“共检出 X 种”），原始 brief 字符串不交给模型。

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
11. 双端样本的分析摘要取 `lastDaulBriefAnalysis` 还是各文件的 `briefAnalysis`（当前优先前者）。
12. `dataVolume` 的单位（当前显示为“数据量 10.68 G”）；`hazardIndex` 的取值范围（当前按 0–5 颗星显示）。
13. `metaStatus`、`analysisStatus` 的取值与中文含义（当前原样显示）。
