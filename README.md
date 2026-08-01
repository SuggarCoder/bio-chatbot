# bio-chatbot

SeaweedFS S3 底仓配置与本地验证参见 [docs/object-storage.md](docs/object-storage.md)。

基于 SolidJS、Fastify、PostgreSQL、Redis 和阿里云百炼 Qwen 的 GPAS2 Chatbot。

## 本地开发

需要 Node.js 22、PostgreSQL 15+ 和 Redis。复制 `.env.example` 为 `.env`，填写数据库、Redis 和 `QWEN_API_KEY`。本地默认使用内置的 GPAS2 `/user/info` Mock，不建立独立登录态。

```bash
npm ci
npm run db:migrate
npm run dev
```

- Web：`http://127.0.0.1:5173/ai-chatbot/`
- API：`http://127.0.0.1:8090/ai-chatbot/api`
- 健康检查：`GET /ai-chatbot/api/health`

## 身份流程

开发环境的 `GPAS2_AUTH_MODE=mock` 返回固定测试用户。生产环境必须设置：

```text
NODE_ENV=production
GPAS2_AUTH_MODE=upstream
GPAS2_USER_INFO_URL=https://<gpas-host>/api/gpas2/v1/user/info
```

Fastify 会把浏览器请求携带的同域 Cookie 转发给 GPAS2，并以响应中的 `data.userId` 自动创建或更新 Chatbot 用户。请求体、查询参数和自定义 Header 中的 userId 不参与身份判定。

生产环境通过 GPAS2 同一个 HTTPS 域名下的 `/ai-chatbot/` 路径访问。反向代理、Cookie、内部 TLS、错误语义和上线验证参见 [部署认证说明](docs/deployment-auth.md)。

## 数据与缓存

- `src/server/db/schema.ts` 是 PostgreSQL 结构的唯一代码真源，提交的 `drizzle/` 迁移通过 `npm run db:migrate` 显式应用。
- 修改数据库结构后运行 `npm run db:generate` 生成迁移，并用 `npm run db:check` 校验迁移历史。
- PostgreSQL 保存用户、会话、最终消息、Generation 和 UsageEvent。
- Redis 仅保存资料/上下文缓存、生成实时状态、可续传流、限流、并发租约和月度用量投影。
- `MONTHLY_TOKEN_LIMIT=0` 表示记录用量但不拦截；正整数表示月度 Token 上限。
- UI 只有在服务端确认消息和 Generation 已落库后才显示 Streaming。关闭浏览器不会取消模型任务；再次进入会话时优先续传，Redis 流不可用时回退轮询 PostgreSQL 最终结果。

## 验证

```bash
npm test
npm run check
npm run build
```
