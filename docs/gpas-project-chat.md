# GPAS 项目对话

在输入框发送“我是谁”“我的用户信息”“我的团队信息”可查询当前 Cookie
对应的用户和团队。发送“我的任务进度”“查看当前项目进度”“初始化项目”
可检查团队项目。业务分流现在使用“能力目录 → 本地 BGE 召回 → Qwen 语义规划 →
服务端策略校验 → 注册执行器”，不使用正则、关键词或字面匹配。BGE 的余弦相似度
仅用于召回候选，不再直接决定调用哪个 API，也不代表概率。

能力分为用户资料、项目进度、初始化状态、首次初始化、重新初始化（明确不支持）、
尚未接入的操作、整体能力说明。规划器进一步区分查询、请求操作、询问是否支持、
解释原因/流程、否定取消、普通对话和需要澄清，并独立判断当前用户或其他人的范围。
例如“我不能重新初始化这个项目吗？”应解释旧系统不支持重新初始化，不查询进度。
“我的项目初始化了吗？”只查存在性；“帮我初始化”只准备表单；“写初始化 API”
走普通编程对话。一个消息内的多项独立业务需求目前先澄清，不自动批量执行。

调用规划器前验证会话归属；最近六条消息提供有限上下文，用户历史每条最多 600
字符，助手历史只包含能力 ID、意图、执行结果类型和是否有待确认表单。
用户信息与项目 API 响应正文、表单值不会额外发送给规划器。用户当前输入按原有
32,000 字符上限传入；用户自行写进消息的内容仍会作为聊天输入发送给模型。
新的 `gpas.capability` 消息元数据持久化后支持“为什么不行”“那能重新来吗”等追问。
旧消息没有该元数据时只能依赖保留的用户问句，不伪造历史能力状态。

启动时使用已有 `EMBEDDING_MODEL_PATH` 加载模型并预计算参考向量，复用同一个
`LocalEmbeddingService`。意图向量采用 CLS pooling 和归一化，已有检索向量的
mean pooling 保持兼容。模型缺失时启动失败，运行时推理失败返回
`intent_model_unavailable`，不回退到正则。`/ai-chatbot/api/health` 的 `embeddings`
现在始终检查语义路由是否就绪，独立于 `ARTIFACT_CONTEXT_V2_ENABLED`。

规划器复用 `QWEN_API_KEY`、`QWEN_BASE_URL`、`QWEN_MODEL`，调用已有 Responses
接口。每个普通消息增加一次语义规划请求（表单提交和已完成业务请求重放除外），
包括本地 GPAS mock 模式；业务接口 mock 不等于模型 mock。
规划采用非思考模式、temperature=0、输出最多 400 token、15 秒超时、不自动重试，
单进程最多四个并行规划请求。参数依据 [Qwen Responses 文档](https://www.alibabacloud.com/help/zh/model-studio/qwen-api-via-openai-responses)，
更换模型或兼容网关后须重新运行真实语义评测，确认非思考模式和结构化输出兼容性。
规划请求设置 `store: false`，不使用服务商会话关联。

规划请求有独立 Redis 用户限流桶，复用 `CHAT_RATE_LIMIT_PER_MINUTE`，不会重复
扣减普通生成的限流桶；它产生的模型费用需单独关注，目前不计入 generation 的
月度 token 统计。模型自报置信度低于 0.75、无效/截断 JSON、未知能力 ID 或
不在候选内时先澄清，不兜底查询进度。置信度是保守门槛，不是经校准的正确率。
模型不可用返回 `intent_planner_unavailable`，繁忙返回 `intent_planner_busy`，
不转入可能误答业务限制的普通聊天。健康检查的 embeddings 不代表远端 Qwen 可用。

规划器只输出能力 ID、意图、范围和置信度，不接收 Cookie，不可指定 URL、方法、
团队 ID 或创建参数；真正的 API 请求继续由服务端鉴权后的执行器构造。
不支持的能力没有执行器；首次初始化即使被规划为操作也只能生成确认表单。
已存在项目不能重新初始化，也没有“删除重建”的替代路径。

项目未初始化时，消息中展示基础信息和四类样本计划表单。项目编码只读，
项目名称默认取存在性接口 `info.userName`，联系方式默认取 `info.phone`。
数量允许零，必须为非负安全整数。用户点击“确认创建项目”才调用创建 API。
创建后发送“我的任务进度”获取最新进度。

项目已存在时，按 `realSubmitInfo` 所有年月累计四类样本的顶层数量；
不再累加 `studies`，以免重复计数。月份缺少某类数量按零处理；缺失计划或
无效响应报错。计划为零显示“未设置计划”；超额提交保留大于 100% 的完成率。

## 接口与部署

复用 `GPAS2_AUTH_MODE` 和 `GPAS2_USER_INFO_URL`，无需新环境变量、数据库迁移、
端口或反向代理配置。用户信息 URL 必须以 `/user/info` 或 `/user/info/` 结尾，
业务地址使用它的同源版本前缀，去除查询参数和片段：

- `GET project/exist/{ownteamId}`
- `POST summary/submit/info/{ownteamId}`：`Content-Type: application/json`，请求体为空（不是 `{}`）
- `POST project/create`

汇总查询虽然读取数据，但旧系统要求 POST。请求方法按操作显式指定，不能根据
是否携带请求体推断为 GET。旧实现误用 GET，与原始浏览器请求不一致。

远端配置用户信息 URL 后，上述接口自动使用相同主机、端口和版本前缀。
浏览器始终请求同源 `/ai-chatbot/api/`，网关需保留 Cookie；服务端逐次鉴权，
仅向配置的 GPAS 服务转发 Cookie。Cookie 不进入数据库、Redis 队列或模型提示词。
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
`npm test` 在本地模型存在时运行真实 BGE 语义回归；缺少模型时明确跳过这项测试。
这项测试检查候选召回，不代表 Qwen 的最终意图准确率。
显式运行 `npm run test:capability-model` 使用当前配置的真实 Qwen 和本地 BGE，
验证 25 条合成问句（反问、否定、流程咨询、编程需求、权限范围、多轮追问等），
会产生模型调用费用，但不调用旧系统 API。默认 `npm test` 跳过外部模型评测。

能力设计、接入方式和扩展约束见 [能力扩展指南](capability-planning.md)。

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

语义分流日志为 `Semantic capability planned`，包含候选 ID/相似度、最终能力、
意图、执行模式和模型置信度，不记录用户原文或模型输出。规划网络/服务错误日志
为 `Semantic planner request failed`，只记录错误类别及可用的上游 HTTP 状态码。
