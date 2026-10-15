import { z } from 'zod'

import { progressReply, type GpasService } from '../../gpas.js'
import { sampleKeys } from '../../gpasContracts.js'
import { defineGpasTool } from '../defineTool.js'

/** Project tools still use GpasService for its local mock fixtures. */
export function createProjectTools(service: GpasService) {
  const progress = defineGpasTool({
    id: 'project.progress', domain: 'project', title: '项目样本提交进度', effect: 'read',
    description: '查询当前团队四类样本的计划数量、累计提交量、剩余量与完成率。未初始化则提供首次初始化表单，不自动创建。',
    examples: ['我的任务进度', '我的项目查询', '查下我的项目现在怎么样了', '我们组的样本都交齐了吗', '我还差多少份样本才能完成任务', '目前我们团队的提交完成率是多少', '我想看一下临床样本已经上报了多少'],
    policy: '可以查询当前团队临床、虫媒、环境、实验室四类样本的提交进度。尚未初始化时会提供表单，只有确认提交后才创建项目。',
    input: z.object({}),
    run: ({ profile, cookie }) => service.progressData(profile, cookie),
    toModel: (data) => data.initialized
      ? { initialized: true, projectName: data.projectName, samples: data.samples, monthly: data.monthly }
      : { initialized: false, note: '团队尚未初始化项目，已向用户展示初始化表单。' },
    toReply: (data) => progressReply(data),
  })

  const status = defineGpasTool({
    id: 'project.status', domain: 'project', title: '项目初始化状态', effect: 'read',
    description: '判断当前团队是否已经创建或初始化项目，并给出可上传的样本类型（已初始化时为各项目都有计划的类型，未初始化时为全部四类），不查询样本完成进度。',
    examples: ['我们的项目是否已经初始化', '团队项目建好了没有', '查下我的项目创建了没', '我们有项目了吗'],
    policy: '可以检查当前团队是否已初始化项目。一个团队的项目仅允许首次初始化。',
    input: z.object({}),
    run: async ({ profile, cookie }) => {
      const reply = await service.initializationStatus(profile, cookie)
      const initialized = !reply.part.form
      const sampleTypes = initialized ? (await service.sampleTypes(profile, cookie)).types : [...sampleKeys]
      return { initialized, sampleTypes, reply }
    },
    toModel: (data) => ({ initialized: data.initialized, sampleTypes: data.sampleTypes }),
    toReply: (data) => data.reply,
  })

  const initialize = defineGpasTool({
    id: 'project.initialize', domain: 'project', title: '首次初始化项目', effect: 'prepare_confirmation',
    description: '实际使用系统进行首次项目初始化，或询问此功能是否支持、流程和填写要求。不是设计表单方案或编写代码（这些是普通对话）。明确要求创建才准备表单；已有项目不重复创建。',
    examples: ['我要初始化团队项目', '帮我创建我的项目', '请帮我把项目初始化一下', '怎么初始化项目', '初始化项目要填写哪些信息', '能帮我创建项目吗'],
    policy: '仅支持尚未创建项目的团队进行首次初始化：填写项目名称、说明、联系方式及四类样本计划数量，项目编码不可修改，点击表单确认后才创建。已有项目不能重新初始化。',
    input: z.object({}),
    // Preparing a form never calls create; the user confirms through the form.
    run: async ({ profile, cookie }) => {
      const reply = await service.prepareInitialization(profile, cookie)
      return { formPrepared: Boolean(reply.part.form), reply }
    },
    toModel: (data) => data.formPrepared
      ? { formPrepared: true, note: '已向用户展示初始化表单，需用户确认提交后才会创建。' }
      : { formPrepared: false, note: '项目已初始化，不能重新初始化。' },
    toReply: (data) => data.reply,
  })

  return [progress, status, initialize] as const
}
