import type { GpasService } from '../gpas.js'
import { createGpasTools } from '../gpas/tools/index.js'
import { CapabilityRegistry, type CapabilityDescription } from './registry.js'

export function createGpasCapabilities(service: GpasService) {
  // Agent tools come from declarative specs (src/server/gpas/tools).
  const capabilities: CapabilityDescription[] = createGpasTools(service).map((tool) => ({
    id: tool.id, domain: tool.domain, title: tool.title, description: tool.description,
    examples: tool.examples, policy: tool.policy, effect: tool.effect,
    ...(tool.alwaysInclude ? { alwaysInclude: true } : {}),
  }))
  // Policies for operations the agent must refuse rather than approximate.
  capabilities.push(
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
  )
  return new CapabilityRegistry(capabilities)
}
