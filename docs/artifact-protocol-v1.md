# Artifact Protocol v1

## A. 现有消息流分析

Fastify generation runner 消费 Qwen Responses API 的
`response.output_text.delta`。现在 provider 流与可恢复 SSE 之间加入增量
Artifact parser；模型没有 Artifact Tool。现有 `Message` 不可变语义不变：
只有终态 finalization 才插入 Assistant Message。

`Message.parts` 规范化为有序 `text` 与 `artifact_ref`。旧 text part 没有
`order` 时仍按数组顺序读取。Artifact 正文不会复制进 Message。

## B. Artifact 数据流设计

```text
Qwen 普通文本流
  -> ArtifactStreamParser
     -> message.delta -> 普通聊天正文
     -> artifact.start/delta -> 浏览器内存 Draft + Side Panel
     -> 完整 Draft（尚未成为正式版本）
  -> provider 正常结束
  -> 正文上传并校验 SeaweedFS S3
  -> 单个 PostgreSQL 事务
     -> 带规范化引用的 Assistant Message
     -> Artifact 身份 create/乐观锁 update
     -> append-only ArtifactVersion
     -> Generation 与 UsageEvent 终态
  -> artifact.commit -> message.finish
```

Stop、超时、provider 失败、标签未闭合、属性非法、正文超限、存储失败和
版本冲突都不会推进 `currentVersion`。Artifact 外的普通文本会保留。数据库
事务失败前已上传的对象会尽力删除。

## C. 协议定义

Opening tag 必须从行首第 1 列开始。TEXT 状态会跟踪 Markdown fenced code
block，因此代码块中的协议示例仍是普通消息。

```xml
<artifact v="1" id="dashboard" op="create" type="text/html" title="数据看板">
<!doctype html><html><body>...</body></html>
</artifact>
```

```xml
<artifact v="1" id="dashboard" op="replace" base_version="3" type="text/html" title="数据看板">
<!doctype html><html><body>完整的 version 4...</body></html>
</artifact>
```

允许的 MIME：`text/markdown`、`text/plain`、`text/html`、
`image/svg+xml`、`application/vnd.artifact.code`、
`application/vnd.artifact.mermaid`。

`id` 匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`；title 为 1–200 字符；
opening tag 不超过 4096 UTF-8 bytes；正文不超过 1 MiB。`replace` 必须带
正整数 `base_version`，`create` 禁止携带。属性只接受 `&amp;`、`&quot;`、
`&lt;`、`&gt;`。正文中的字面量关闭标记写成 `\</artifact>`，解析器只反转义
这个精确序列。禁止嵌套。Parser 支持多个 block，但 v1 orchestrator 每条
Assistant Message 最多提交一个。

Parser 是线性状态机：`TEXT`、`OPEN_TAG_CANDIDATE`、`OPEN_TAG`、
`ARTIFACT_BODY`、`CLOSE_TAG_CANDIDATE`、`FAILED`。它不会反复扫描全文；
除最多 1 MiB Draft 外只保留有界 closing-marker tail。byte stream 使用：

```ts
const decoder = new TextDecoder('utf-8', { fatal: false })
decoder.decode(bytes, { stream: true })
```

### 独立 System Prompt

正式 prompt 导出于 `src/server/artifacts/systemPrompt.ts`。服务器附加当前
用户、当前会话内的 logical ID/version catalog。主要规则：

- 只为独立页面、视觉内容、可继续编辑文档或有独立价值的较长代码创建；
- 不使用 Function Call，不放在 Markdown fence 中；
- Artifact 内只放完整最终快照；
- 新建使用 `create`，修改复用准确 ID 并带准确版本；
- 不使用省略号、`rest unchanged`，不虚构既有 ID/version；
- 不向最终用户解释内部协议。

### SSE 事件

所有事件包含 `eventId`、`generationId`、`streamId` 和预留的 Assistant
`messageId`，SSE record 同时写 `id: <eventId>`。event ID 在 generation 内
递增，客户端重连后去重。`message.delta` 另带 text `sequence`/`startIndex`，
`artifact.delta` 带 Draft 局部 sequence。

- `message.start`
- `message.delta`
- `artifact.start`
- `artifact.delta`
- `artifact.commit`
- `artifact.error`
- `message.finish`（`stop`、`cancelled`、`error`、`length`）

稳定错误码包括 `INVALID_OPEN_TAG`、`OPEN_TAG_TOO_LARGE`、
`INVALID_METADATA`、`UNSUPPORTED_VERSION`、`UNSUPPORTED_TYPE`、
`NESTED_ARTIFACT`、`ARTIFACT_TOO_LARGE`、`UNCLOSED_ARTIFACT`、
`ARTIFACT_ABORTED`、`ARTIFACT_LIMIT_EXCEEDED`、
`ARTIFACT_ALREADY_EXISTS`、`ARTIFACT_NOT_FOUND`、
`ARTIFACT_VERSION_CONFLICT`、`ARTIFACT_STORAGE_FAILED`、
`ARTIFACT_COMMIT_FAILED`。

## D. 文件改动清单

- 协议/parser/prompt：`src/server/artifacts/protocol.ts`、`parser.ts`、
  `systemPrompt.ts` 和 parser tests。
- 持久化：`repository.ts`、`service.ts`、Drizzle schema/migrations。
- Runtime/API：`generation.ts`、`generationFinalizer.ts`、`domain.ts`、`app.ts`。
- Client：`src/client/features/artifacts/` 中的 API/store/card/panel/registry/
  renderers，以及 chat stream/message integration。
- 安全：`artifact-security.html`、Playwright config 和浏览器测试。

## E. 数据库迁移计划

Migration `0001` 为兼容旧行增加 nullable `Artifact.logicalId`、默认 0 的
`currentVersion`、live unique `(userId, chatId, logicalId)` 和 append-only
`ArtifactVersion`。Migration `0002` 扩展已有 format check；`0003` 让来源
引用在物理清理 Message/Generation 时安全置空，避免破坏原有级联删除。新协议行一定有
logical ID 与正 current version。旧 `Artifact.content` 不重写；新版本正文只用
`ArtifactVersion.storageKey`。

先执行 `npm run db:migrate`，确认 S3 health 后才设置
`ARTIFACT_PROTOCOL_ENABLED=true`。新旧 SSE client/server 必须原子部署。

## F. 安全边界

- v1 tenant 为内部 `User.id`；list/read/version 全部按 owner 过滤。模型 logical
  ID 绝不作为主键。
- HTML 使用 `iframe srcdoc`、`sandbox="allow-scripts"`，不加
  `allow-same-origin`；CSP 禁止网络、表单、frame、worker、object、base，且
  no-referrer。v1 没有宿主 `postMessage` bridge。
- SVG 先 DOMPurify，再剔除 script、事件属性、`foreignObject`、style/CSS URL、
  JavaScript URL、外部资源和非 fragment `use`，最后用 Blob image 展示。
- Mermaid 使用 `securityLevel: "strict"`，输出再走同一个 SVG sanitizer。
- Markdown 禁止 raw HTML 并清洗；未知 MIME 显示 Unsupported，绝不执行。
- 下载 owner-scoped，并设置 attachment、nosniff、private/no-store。

生产环境建议进一步把可执行预览部署到独立、无 Cookie 的 origin。

## G. 分阶段实施顺序

Phase 1 已实现 protocol、snapshot create/replace、streaming draft、append-only
storage/history read、六类 renderer、side panel、权限边界和浏览器安全基线。
feature flag 默认关闭。

Phase 2 可增加用户编辑、restore-as-new-version、精确字符串替换、选区编辑和
durable draft replay；仍必须乐观锁并保存完整快照，禁止任意行号 Patch。

Phase 3 的 React/multi-file 建议使用签名、版本化 manifest 指向不可变文件；
在独立 origin worker/iframe 内编译，限制 CPU、内存、输出与 wall-clock；依赖
只能使用 server allowlist 和固定版本，模型声明的包不得自动安装。console/
runtime error 仅通过带版本且 schema 校验的 `postMessage` allowlist 传递。

## 验证

```bash
npm test
npm run check
npm run build
npm run test:artifact-security
RUN_ARTIFACT_INTEGRATION=true npm run test:artifact-integration
```

集成测试使用 local-only `TEST_DATABASE_URL`、`TEST_S3_ENDPOINT`、
`TEST_S3_BUCKET` 和可选 `TEST_S3_*` credential；测试拒绝 production 与非
loopback endpoint。
