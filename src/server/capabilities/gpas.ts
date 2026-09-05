import { GpasService, profileReply } from '../gpas.js'
import type { Gpas2UserInfo } from '../domain.js'
import { CapabilityRegistry, type Capability } from './registry.js'

export type GpasCapabilityContext = { profile: Gpas2UserInfo, cookie?: string }

export function createGpasCapabilities(service: GpasService, additional: readonly Capability<GpasCapabilityContext>[] = []) {
  const capabilities: Capability<GpasCapabilityContext>[] = [
    {
      id: 'user.profile', domain: 'user', title: '当前用户与团队信息', effect: 'read',
      description: '读取当前登录者的姓名、账号、联系方式、邮箱及所属团队，不查询其他人。',
      examples: ['我是谁', '我的用户信息', '我属于哪个团队', '我的邮箱是多少', '能告诉我现在登录的是谁吗', '我在这里用的是哪个账户', '我的联系方式和邮箱是什么'],
      policy: '可以查询当前登录账号的用户信息和所属团队信息；不支持访问其他用户或其他团队的资料。',
      execute: async ({ profile }) => ({ content: profileReply(profile), part: { type: 'gpas', order: 1 } }),
    },
    {
      id: 'project.progress', domain: 'project', title: '项目样本提交进度', effect: 'read',
      description: '查询当前团队四类样本的计划数量、累计提交量、剩余量与完成率。未初始化则提供首次初始化表单，不自动创建。',
      examples: ['我的任务进度', '我的项目查询', '查下我的项目现在怎么样了', '我们组的样本都交齐了吗', '我还差多少份样本才能完成任务', '目前我们团队的提交完成率是多少', '我想看一下临床样本已经上报了多少'],
      policy: '可以查询当前团队临床、虫媒、环境、实验室四类样本的提交进度。尚未初始化时会提供表单，只有确认提交后才创建项目。',
      execute: ({ profile, cookie }) => service.progress(profile, cookie),
    },
    {
      id: 'project.status', domain: 'project', title: '项目初始化状态', effect: 'read',
      description: '只判断当前团队是否已经创建或初始化项目，不查询样本完成进度。',
      examples: ['我们的项目是否已经初始化', '团队项目建好了没有', '查下我的项目创建了没', '我们有项目了吗'],
      policy: '可以检查当前团队是否已初始化项目。一个团队的项目仅允许首次初始化。',
      execute: ({ profile, cookie }) => service.initializationStatus(profile, cookie),
    },
    {
      id: 'project.initialize', domain: 'project', title: '首次初始化项目', effect: 'prepare_confirmation',
      description: '实际使用系统进行首次项目初始化，或询问此功能是否支持、流程和填写要求。不是设计表单方案或编写代码（这些是普通对话）。明确要求创建才准备表单；已有项目不重复创建。',
      examples: ['我要初始化团队项目', '帮我创建我的项目', '请帮我把项目初始化一下', '怎么初始化项目', '初始化项目要填写哪些信息', '能帮我创建项目吗'],
      policy: '仅支持尚未创建项目的团队进行首次初始化：填写项目名称、说明、联系方式及四类样本计划数量，项目编码不可修改，点击表单确认后才创建。已有项目不能重新初始化。',
      execute: ({ profile, cookie }) => service.prepareInitialization(profile, cookie),
    },
    {
      id: 'project.reinitialize', domain: 'project', title: '重新初始化项目（不支持）', effect: 'unsupported',
      description: '涉及已有项目重新初始化、重置、清空重来或删除重建，无论是询问、反问还是请求操作，均不执行，也不转查进度。',
      examples: ['我不能重新初始化这个项目吗', '能不能把项目重置一下', '项目可以重新来一遍吗', '我想清空已有项目重新创建', '为什么不能重新初始化', '删掉项目重新建', '重新初始化会丢失样本吗'],
      policy: '当前系统不支持重新初始化项目。旧系统仅允许首次初始化，且未提供重置或删除后重建的接口，因此无法执行该操作。你可以继续查询现有项目的提交进度。',
    },
    {
      id: 'system.unavailable', domain: 'system', title: '尚未接入的业务操作', effect: 'unsupported', alwaysInclude: true,
      description: '用户想在当前系统执行目录以外的业务操作，如修改项目、删除数据、提交样本、导出数据。不是编程、知识问答或一般创作。不能声称旧系统也不支持。',
      examples: ['帮我修改项目名称', '把样本计划改成五百', '删除这条样本', '帮我提交临床样本', '导出项目数据'],
      policy: '当前助手尚未接入这项业务操作，无法代你执行。这不代表旧系统一定不支持；请在旧系统中确认可用功能。',
    },
  ]
  capabilities.push(...additional)
  capabilities.push({
    id: 'system.capabilities', domain: 'system', title: '助手能力说明', effect: 'information', alwaysInclude: true,
    description: '仅用于整体能力清单、泛问你能做什么。询问一个具体功能（如系统支持初始化吗）必须选择那个具体能力，而不是本项。不执行业务 API。',
    examples: ['你能做什么', '目前支持哪些功能', '你能帮我操作哪些业务'],
    policy: '根据服务端已注册的能力介绍可用业务功能与限制。仅说明，不执行业务操作。',
    reply: `目前已接入以下业务能力：\n\n${capabilities.filter(item => item.effect === 'read' || item.effect === 'prepare_confirmation').map(item => `- ${item.title}：${item.policy}`).join('\n')}\n\n不支持重新初始化项目；尚未接入的业务操作不会执行。`,
  })
  return new CapabilityRegistry(capabilities)
}
