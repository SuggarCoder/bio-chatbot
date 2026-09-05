import { AuthenticationError } from './auth.js'

export type GpasIntent = 'profile' | 'progress'
type IntentClass = GpasIntent | 'general'
type Embedder = { embed: (text: string, pooling: 'cls') => Promise<number[]> }

// Reference utterances are embedded once. Incoming text is classified by vector
// similarity, never by literal membership, keywords, or regular expressions.
export const intentExamples: Record<IntentClass, readonly string[]> = {
  profile: [
    '我是谁', '查看当前登录用户的个人信息', '我的账号叫什么名字',
    '我属于哪个团队', '查询我所在团队的信息', '我在系统里登记的姓名是什么',
    '显示我的用户信息和团队信息', '我的联系方式和邮箱是什么',
    '当前登录的是哪位用户', '请介绍一下我的个人资料',
    '查一下我目前使用的账户', '我的登录账号和所属团队是什么',
  ],
  progress: [
    '我的任务进度', '查询我的项目', '查看我的项目进度',
    '我们团队的项目目前进行到哪一步了', '我还有多少样本没有提交',
    '统计我的四类样本提交完成情况', '查看我的样本计划和实际提交数量',
    '我们的项目是否已经初始化', '我要初始化团队项目', '帮我创建我的项目',
    '看看我当前项目的完成率', '显示我的临床虫媒环境实验室样本提交进度',
    '我们组应该交的样本都提交完了吗', '请帮我初始化项目',
    '帮我查一下项目现在的状态', '项目的样本还差多少才能交完',
  ],
  general: [
    '你好', '你是谁', '你能做什么', '谢谢', '给我讲个故事',
    '什么是临床样本', '解释虫媒传播的原理', '如何开展环境样本采集',
    '帮我设计一个科研项目方案', '写一份项目进度报告模板',
    '用代码实现用户信息查询API', '帮我调试项目创建接口的错误',
    '设计一个项目管理系统', '项目初始化是什么意思',
    '用户信息接口怎么实现', '怎样计算项目完成率',
    '帮我翻译这段论文', '分析基因组测序结果',
    '比较PCR和宏基因组测序', '什么是团队协作',
    '不要查询我的项目，解释项目管理的方法',
    '不要查询我的个人信息', '查询另一个用户的个人资料',
    '请编写一个查询项目的接口', '写个查询项目进度的API给我',
    '实现查询项目状态的TypeScript函数', '编写项目初始化功能的代码',
    '我要写一个查询用户资料的程序', '设计一个查询团队信息的数据库表',
    '不用帮我查任务进度，我只需要写一篇文章',
    '别查询项目了，帮我作首诗', '不要查询用户资料，给我解释一下数据库',
    '我不需要你查询样本进度', '查询项目这个词用英语怎么说',
    '项目查询功能怎么开发', '查询团队信息的功能应该怎么实现',
    '帮我设计一份项目初始化表单', '项目创建页面应该包含哪些表单字段',
    '哲学中的自我身份认同是什么', '从哲学角度讨论我是谁',
    '给我其他人的手机号和电子邮箱', '能查到同事的联系方式吗',
  ],
}

export type IntentDecision = {
  intent: GpasIntent | null
  scores: Record<IntentClass, number>
  margin: number
}

function normalized(vector: number[]): number[] {
  const norm = Math.hypot(...vector)
  if (vector.length !== 512 || !Number.isFinite(norm) || norm === 0) {
    throw new Error('Intent embedding must be a finite nonzero 512-dimensional vector')
  }
  return vector.map((value) => value / norm)
}

export class SemanticIntentRouter {
  private references: Array<{ intent: IntentClass, vector: number[] }> = []
  private initializing?: Promise<void>

  constructor(private readonly embedding: Embedder) {}

  get ready() { return this.references.length > 0 }

  initialize(): Promise<void> {
    if (this.ready) return Promise.resolve()
    this.initializing ??= (async () => {
      const references: typeof this.references = []
      for (const intent of ['profile', 'progress', 'general'] as const) {
        for (const text of intentExamples[intent]) {
          references.push({ intent, vector: normalized(await this.embedding.embed(text, 'cls')) })
        }
      }
      this.references = references
    })().catch((error: unknown) => {
      this.initializing = undefined
      throw error
    })
    return this.initializing
  }

  async classify(text: string): Promise<IntentDecision> {
    try {
      await this.initialize()
      const vector = normalized(await this.embedding.embed(text, 'cls'))
      const scores = { profile: -1, progress: -1, general: -1 }
      for (const reference of this.references) {
        const similarity = vector.reduce((sum, value, index) => sum + value * reference.vector[index], 0)
        scores[reference.intent] = Math.max(scores[reference.intent], similarity)
      }
      const ranked = (Object.keys(scores) as IntentClass[]).sort((left, right) => scores[right] - scores[left])
      const best = ranked[0]
      const margin = scores[best] - scores[ranked[1]]
      return {
        intent: best !== 'general' && scores[best] >= 0.7 && margin >= 0.04 ? best : null,
        scores,
        margin,
      }
    } catch {
      throw new AuthenticationError('本地语义识别模型暂时不可用，请稍后重试。', 503, 'intent_model_unavailable')
    }
  }
}
