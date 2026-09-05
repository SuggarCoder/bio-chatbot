# GPAS 项目对话

在输入框发送“我是谁”“我的用户信息”“我的团队信息”可查询当前 Cookie
对应的用户和团队。发送“我的任务进度”“查看当前项目进度”“初始化项目”
可检查团队项目。API 进程使用本地 `bge-small-zh-v1.5` INT8 模型识别语义，
将用户输入与用户信息、项目进度、普通对话三类参考语句的向量作余弦相似度比较。
业务类别最高相似度须达到 0.70，且领先另一类别至少 0.04；低置信度及普通对话
继续走原有模型回复。业务分流不使用正则、关键词或字面匹配；相似度不是概率。
参考语句和阈值位于 `src/server/gpasIntent.ts`，回归语句位于
`src/server/gpasIntent.model.test.ts`。语义近似分类不能保证覆盖所有表达。

启动时使用已有 `EMBEDDING_MODEL_PATH` 加载模型并预计算参考向量，复用同一个
`LocalEmbeddingService`。意图向量采用 CLS pooling 和归一化，已有检索向量的
mean pooling 保持兼容。模型缺失时启动失败，运行时推理失败返回
`intent_model_unavailable`，不回退到正则。`/ai-chatbot/api/health` 的 `embeddings`
现在始终检查语义路由是否就绪，独立于 `ARTIFACT_CONTEXT_V2_ENABLED`。

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
- `GET summary/submit/info/{ownteamId}`
- `POST project/create`

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
