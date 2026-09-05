# GPAS 项目对话

在输入框发送“我是谁”“我的用户信息”“我的团队信息”可查询当前 Cookie
对应的用户和团队。发送“我的任务进度”“查看当前项目进度”“初始化项目”
可检查团队项目。当前使用服务端的短句意图匹配，其他问题继续走原有模型回复。

项目未初始化时，消息中展示基础信息和四类样本计划表单。项目编码只读，
项目名称默认取存在性接口 `info.userName`，联系方式默认取 `info.phone`。
数量允许零，必须为非负安全整数。用户点击“确认创建项目”才调用创建 API。
创建后发送“我的任务进度”获取最新进度。

项目已存在时，按 `realSubmitInfo` 所有年月累计四类样本的顶层数量；
不再累加 `studies`，以免重复计数。月份缺少某类数量按零处理；缺失计划或
无效响应报错。计划为零显示“未设置计划”；超额提交保留大于 100% 的完成率。

## 接口与部署

复用 `GPAS2_AUTH_MODE` 和 `GPAS2_USER_INFO_URL`，无需新环境变量、数据库迁移、
端口或反向代理配置。业务接口地址由用户信息 URL 的 `../` 相对路径解析：

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

远端需使用真实登录 Cookie 验收：身份与团队显示、已有项目四类进度、未初始化
团队的表单默认值、提交成功后再查询、双击或跨标签页提交、Cookie 失效、
上游异常、刷新对话恢复，以及 `/ai-chatbot/api/health`。
