# 生产部署清单

本文档描述 `bio-chatbot` 的生产发布前置条件、配置、上线步骤和验收标准。
身份认证细节参见 [deployment-auth.md](deployment-auth.md)，对象存储配置参见
[object-storage.md](object-storage.md)。

## 基础设施前置条件

- 使用 Node.js 22 构建，或直接使用仓库 `Dockerfile` 构建镜像。
- PostgreSQL 和 Redis 必须可从应用容器访问；生产环境不要使用开发环境数据库或
  Redis key prefix。
- 公网流量必须先经过 GPAS2 的 HTTPS 反向代理，不能直接暴露 Fastify 的 8090
  端口。
- `compose.yaml` 使用外部网络 `chatbot-backend`。部署前创建该网络，并按实际主机
  修改端口绑定地址。
- 若启用 Artifact Protocol，必须先提供可用的私有 S3/SeaweedFS bucket。不能在
  对象存储不健康时启用 Artifact。

## 必需配置

生产密钥放在仓库外部、权限受限的 env 文件中，不要提交 `.env`。至少配置：

```env
NODE_ENV=production
DATABASE_URL=postgresql://<user>:<password>@<postgres-host>:5432/<database>
REDIS_URL=redis://<redis-host>:6379/0
REDIS_KEY_PREFIX=gpas2cb:prod:v2:

QWEN_API_KEY=<secret>
QWEN_BASE_URL=https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen3.8-max-preview

GPAS2_AUTH_MODE=upstream
GPAS2_USER_INFO_URL=https://<internal-gpas-host>/api/gpas2/v1/user/info

# 只填写实际连接 Fastify 的 Nginx/Gateway 地址或 CIDR。
TRUSTED_PROXY_CIDRS=<proxy-ip-or-cidr>
GENERATION_DISCONNECT_GRACE_SECONDS=45
```

`TRUSTED_PROXY_CIDRS` 留空时，Fastify 会忽略 `X-Forwarded-*`。如果应用位于代理后却
留空，所有用户可能共享代理 IP 的限流额度；不要为了省事填写 `true`、`0.0.0.0/0`
或其他不受控网段。

`GENERATION_DISCONNECT_GRACE_SECONDS` 是 SSE 客户端断开后的恢复窗口。窗口内允许
页面刷新或网络重连；窗口结束仍无订阅者时，服务端取消上游模型请求。建议保持默认
45 秒，再根据实际移动网络和代理超时指标调整。

## Artifact 与对象存储

不使用 Artifact 时保持：

```env
ARTIFACT_PROTOCOL_ENABLED=false
OBJECT_STORAGE_ENABLED=false
```

启用时两个开关必须同时为 `true`，并完整配置 S3。生产 `S3_ENDPOINT` 必须使用
HTTPS，且必须是容器可访问的地址，不能填写 `127.0.0.1`：

```env
ARTIFACT_PROTOCOL_ENABLED=true
OBJECT_STORAGE_ENABLED=true
S3_ENDPOINT=https://<s3-gateway>
S3_REGION=us-east-1
S3_BUCKET=<private-bucket>
S3_ACCESS_KEY_ID=<access-key>
S3_SECRET_ACCESS_KEY=<secret-key>
S3_FORCE_PATH_STYLE=true
S3_MAX_ATTEMPTS=3
```

发布前必须执行 `npm run storage:check`。它需要同时确认签名访问成功和匿名访问被
拒绝。`/ai-chatbot/api/health` 中 `dependencies.objectStorage` 必须为 `ok`；若为
`unavailable`，健康检查会返回 HTTP 503；停止发布并修复网络、TLS、bucket 或 IAM。Artifact-only 回复依赖对象
存储持久化，当前服务会在保存失败时明确将生成标记为失败，绝不会再产生无消息的
`completed` 状态。

## 构建与上线顺序

```bash
npm ci
npm test
npm run check
npm run build
docker compose --env-file /secure/path/bio-chatbot.env build app
docker compose --env-file /secure/path/bio-chatbot.env run --rm app node dist/server/migrate.js
docker compose --env-file /secure/path/bio-chatbot.env up -d app
```

先迁移数据库，再替换应用。不要在多个发布任务中并发执行迁移。发布工具可以运行
`docker compose config` 做配置校验，但不要把包含密钥的展开结果写入日志或构建产物。

反向代理必须保留 `/ai-chatbot/*` URI 和 Cookie，并为 SSE 设置：

- 关闭响应缓冲；
- 足够长的 read timeout；
- 禁止中间层压缩或聚合事件流；
- 将客户端地址转发给应用，同时只允许 `TRUSTED_PROXY_CIDRS` 中的代理设置相关
  Header。

## 发布后验收

1. `GET /ai-chatbot/api/health` 返回 PostgreSQL、Redis 为 `ok`；启用 Artifact 时
   object storage 也必须为 `ok`。
2. 无 Cookie 请求 `/ai-chatbot/api/me` 返回 401；有效 GPAS2 Cookie 返回当前用户。
3. 创建普通文本会话，确认 SSE 中出现 `message.delta` 和带非空
   `assistantMessage` 的 `message.finish`，刷新页面后回复仍存在。
4. 启用 Artifact 时分别创建 Markdown/代码 Artifact，确认卡片可预览、下载，并在
   刷新后仍可重新加载。
5. 测试刷新页面和短暂断网后的流恢复；超过恢复窗口后确认上游生成被取消。
6. 检查限流使用真实客户端 IP，而不是代理 IP 或可伪造的 Header。
7. 检查应用和代理日志，确保 Cookie、数据库 URL、Qwen key 和 S3 credential 未被
   输出。

回滚应用镜像前应确认旧版本兼容已执行的 Drizzle migration。数据库迁移不能通过
删除生产数据回滚；需要为不兼容变更准备显式的向前修复 migration。
