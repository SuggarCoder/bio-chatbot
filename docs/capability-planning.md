# 能力目录与语义规划扩展指南

## 分层与边界

```text
用户消息 + 有限的已授权会话上下文
  → BGE 召回候选能力（不是执行决策）
  → Qwen 输出结构化意图（不是 HTTP 请求）
  → 注册表校验能力、范围、意图和操作限制
  → 说明限制 / 澄清 / 只读执行器 / 准备确认表单 / 普通生成
```

- `capabilities/registry.ts`：通用能力类型、注册校验、规划校验、执行分派。
- `capabilities/runtime.ts`：统一组合入口，检索与执行共享同一份注册表及服务实例。
- `capabilities/gpas.ts`：旧系统业务目录及执行器绑定。
- `gpasIntent.ts`：通用 BGE 检索，初始化时缓存描述和示例向量。
- `capabilities/planner.ts`：语义规划协议、有限历史、Qwen 适配器，不执行 API。
- `gpas.ts`：旧系统鉴权请求、响应验证、业务状态判断和结果呈现。
- `app.ts`：鉴权、会话归属、幂等重放、限流、规划、持久化和普通对话入口。

## 当前能力与意图

| 能力 ID | 真实操作 | 询问是否支持 / 解释 |
| --- | --- | --- |
| `user.profile` | 返回登录用户与所属团队资料 | 说明仅可访问自己的账号和团队 |
| `project.progress` | 查存在性；已有项目查四类样本进度，未创建则展示表单 | 说明统计范围与初始化前提 |
| `project.status` | 只查存在性，不查汇总；未创建可展示表单 | 说明初始化状态查询能力 |
| `project.initialize` | 只准备首次初始化表单；已有项目直接说明不能重复初始化 | 说明前提、填写内容和确认步骤，不拉取表单 |
| `project.reinitialize` | 不执行，说明旧系统明确不支持 | 同样说明限制，不改查进度 |
| `system.unavailable` | 说明助手尚未接入，不执行 | 不擅自断言旧系统也不支持 |
| `system.capabilities` | 不执行 API，展示注册能力清单 | 只用于整体功能介绍，不替代具体功能咨询 |

话语意图为 `query`、`request_action`、`ask_capability`、`explain`、`cancel`、
`general`、`clarify`。当前规划粒度是单项业务能力，不是任意多工具任务编排。
多项独立请求先澄清。已有项目的初始化请求不能被当作进度请求。

## 接入一个新 API

1. 在所属业务模块实现服务适配器：固定地址和 HTTP 方法、Cookie/权限范围、
   超时、响应 Zod 校验、错误诊断。只读操作也可能使用 POST，不能凭方法判断风险。
2. 注册稳定 ID（如 `sample.statistics`）、domain、标题、描述、语义示例、业务
   policy 和 effect。已知不支持的操作也注册为 `unsupported`，不要让模型猜测。
3. 将注册项加入 `createGpasCapabilities` 的组合数组，或在 `runtime.ts` 中通过
   它的 `additional` 参数组合其他模块的能力。路由算法和 `app.ts` 不需要新增逐项 if/else。
4. 编写执行器测试，检查正确 endpoint/method、身份来源、结果校验，以及不会调用
   其他 API。补充正向、反问、否定、流程咨询、编程干扰、多轮和未授权表达的评测。
5. 运行 `npm run check`、`npm run build`、`npm test`，在可访问模型的环境运行
   `npm run test:capability-model`。重启 API 进程，重新生成目录参考向量。

只读能力注册示例（伪代码，真实请求必须在适配器中实现）：

```ts
const sampleStatistics: Capability<GpasCapabilityContext> = {
  id: 'sample.statistics',
  domain: 'sample',
  title: '样本统计',
  description: '查询当前登录用户所属团队的样本统计，不查询其他团队。',
  examples: ['我们团队各类样本有多少', '查看样本统计'],
  policy: '仅支持查询当前团队的样本统计。',
  effect: 'read',
  execute: ({ profile, cookie }) => sampleService.statistics(profile, cookie),
}
const registry = createGpasCapabilities(gpasService, [sampleStatistics])
```

`effect` 只允许 `read`、`prepare_confirmation`、`unsupported`、`information`。
前两者必须有执行器，后两者禁止注册执行器。`reply` 可提供较完整的固定解释，
不会发送给规划模型；短 `policy` 用作权威业务规则。整体帮助清单自动由注册表生成，
不会把完整帮助清单又塞回模型上下文。

## 新增写操作或带参能力

当前不允许模型直接提交写 API。`prepare_confirmation` 必须只准备交互数据，
写入由用户明确确认后的独立处理器执行。沿用项目初始化的模式：持久化来源表单、
验证会话与所有者、Zod 校验输入、重新检查前提、幂等控制，必要时加业务实体锁。
新增表单或确认交互仍需相应协议、客户端组件和提交处理器，并不是仅填 API URL。

模型现在不抽取任意参数。后续如引入日期、样本编号等槽位，应在能力注册中添加
独立参数 schema 和缺失参数澄清步骤，再允许规划器返回该能力的参数；执行前
仍须服务器校验。用户/团队 ID、Cookie 和权限边界必须始终来自已认证服务端，
不能由模型、URL 文本或用户输入覆盖。

## 规模、运行成本与后续演进

现在按能力描述和示例向量召回前六项，保留全局规则、最近能力，再补充相关领域，
总候选最多十六项。同领域限制有机会随查询能力一起进入规划上下文，但容量限制
下不能保证所有同领域能力都被召回。新增大量能力时必须测 recall@K，不能只看分类
准确率；全局 `alwaysInclude` 应仅用于少量通用规则，避免挤掉业务候选。

对于数百、数千能力，可保持注册/规划/执行协议不变，将内存全量相似度计算替换
为分领域或向量索引检索，并加入显式相关能力依赖、目录版本和分片加载。权限过滤
也应进入候选召回，但不能替代执行器的真实授权检查。

首次落地选择固定、可信的业务说明和结构化结果，避免生成模型虚构“不支持”业务的
替代接口。如果未来需要更自然的措辞，可增加受限的结果表述层；它只能使用已验证
的规则和工具结果，不能越过策略层产生新操作。

每条新聊天消息都会额外调用一次 Qwen 规划（表单提交/已完成业务重放除外），
限流、并发、超时和成本边界见 [GPAS 对话说明](gpas-project-chat.md)。
本轮未加入规划调用的月度 token 入账、跨实例全局模型并发或自动多步骤编排；
扩容上线前应按业务量补齐这几项运营能力。语义模型有误判概率，评测通过不代表
任意表达都能正确识别；无效或不确定的计划不能默认变成进度查询。
