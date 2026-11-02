/**
 * Memory extraction eval: runs the production extraction prompt against the
 * configured background model on fixed scenarios and checks the operations.
 *
 *   QWEN_API_KEY=... npm run eval:memory
 *
 * Optional: QWEN_BASE_URL, BACKGROUND_MODEL, EVAL_REPEAT (runs per scenario).
 * Exits non-zero when the pass rate is below EVAL_MIN_PASS_RATE (default 0.8).
 */
import 'dotenv/config'
import OpenAI from 'openai'

import {
  extractionInstructions,
  parseMemoryOperations,
  type MemoryOperation,
} from '../src/server/memoryWorker.js'

type Memory = { key: string; category: string; content: string; source: 'auto' | 'user' | 'tool' }
type Scenario = {
  name: string
  existing?: Memory[]
  preceding?: Array<[string, string]>
  turns: Array<[string, string]>
  check(operations: MemoryOperation[]): string | null
}

const upserts = (operations: MemoryOperation[]) =>
  operations.filter((operation): operation is Extract<MemoryOperation, { action: 'upsert' }> => operation.action === 'upsert')
const text = (operations: MemoryOperation[]) => JSON.stringify(operations)

const scenarios: Scenario[] = [
  {
    name: '身份陈述 → identity',
    turns: [['我是中科院微生物所的博士后，主要做土壤宏基因组', '你好，很高兴认识你。']],
    check: (ops) => upserts(ops).some((op) => op.category === 'identity' || op.category === 'work') && /宏基因组/.test(text(ops))
      ? null : '应保存身份/研究方向',
  },
  {
    name: '一次性请求 → 不保存',
    turns: [['把这段话翻译成英文：样本已送检', 'The samples have been submitted for testing.']],
    check: (ops) => ops.length === 0 ? null : `不应有操作：${text(ops)}`,
  },
  {
    name: '只是提问 → 不保存助手的回答',
    turns: [['DESeq2 和 edgeR 有什么区别？', 'DESeq2 使用负二项分布……建议你用 DESeq2。']],
    check: (ops) => !/DESeq2|edgeR/.test(text(ops)) ? null : `把助手建议当成了用户事实：${text(ops)}`,
  },
  {
    name: '敏感凭据 → 不保存',
    turns: [['我的服务器密码是 Abc12345，帮我写个登录脚本', '好的，下面是脚本……']],
    check: (ops) => !/Abc12345|密码/.test(text(ops)) ? null : `保存了敏感信息：${text(ops)}`,
  },
  {
    name: '偏好 → preference',
    turns: [['以后回答都用中文，代码注释用英文，尽量简短', '好的，明白了。']],
    check: (ops) => upserts(ops).some((op) => op.category === 'preference') ? null : '应保存为 preference',
  },
  {
    name: '更正 → 复用原 key',
    existing: [{ key: 'research_field', category: 'identity', content: '用户研究水稻病害', source: 'auto' }],
    turns: [['我已经不做水稻了，现在转做小麦条锈病', '了解，小麦条锈病……']],
    check: (ops) => upserts(ops).some((op) => op.key === 'research_field' && /小麦/.test(op.content))
      ? null : `应覆盖 research_field：${text(ops)}`,
  },
  {
    name: '要求忘记 → delete',
    existing: [{ key: 'employer', category: 'identity', content: '用户在 A 公司工作', source: 'auto' }],
    turns: [['别再记着我在哪个公司了，忘掉这个', '好的，我不会再提。']],
    check: (ops) => ops.some((op) => op.action === 'delete' && op.key === 'employer') ? null : `应删除 employer：${text(ops)}`,
  },
  {
    name: '用户填写的条目不被改写',
    existing: [{ key: 'note_a1', category: 'work', content: '用户负责项目 P-17 的数据分析', source: 'user' }],
    turns: [['P-17 这周的数据什么时候能出？', '预计周五。']],
    check: (ops) => !ops.some((op) => op.key === 'note_a1') ? null : `改写了用户条目：${text(ops)}`,
  },
  {
    name: '指代上文 → 结合上文理解',
    preceding: [['我们组有两个方向：线虫抗性和真菌毒素检测', '这两个方向都很有意思。']],
    turns: [['我主要负责后一个', '好的。']],
    check: (ops) => /真菌毒素/.test(text(ops)) ? null : `没有理解“后一个”：${text(ops)}`,
  },
  {
    name: '具体分析结果 → 不保存',
    turns: [['这批样本 Shannon 指数是多少？', '平均 5.82，最高 6.4。']],
    check: (ops) => !/5\.82|6\.4|Shannon/.test(text(ops)) ? null : `保存了一次性结果：${text(ops)}`,
  },
]

function render(turns: Array<[string, string]>): string {
  return turns.map(([user, assistant]) => `[用户] ${user}\n\n[助手] ${assistant}`).join('\n\n')
}

const apiKey = process.env.QWEN_API_KEY
if (!apiKey) {
  console.error('QWEN_API_KEY is required to run the memory eval.')
  process.exit(2)
}
const client = new OpenAI({
  apiKey,
  baseURL: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
})
const model = process.env.BACKGROUND_MODEL || 'qwen-plus'
const repeat = Math.max(1, Number(process.env.EVAL_REPEAT ?? 1))
const minPassRate = Number(process.env.EVAL_MIN_PASS_RATE ?? 0.8)

let passed = 0
let total = 0
for (const scenario of scenarios) {
  for (let run = 0; run < repeat; run += 1) {
    total += 1
    const input = [
      `今天：${new Date().toISOString().slice(0, 10)}`,
      `现有记忆：${JSON.stringify(scenario.existing ?? [])}`,
      scenario.preceding ? `上文（仅用于理解指代）：\n${render(scenario.preceding)}` : '',
      `新对话：\n${render(scenario.turns)}`,
    ].filter(Boolean).join('\n\n')
    try {
      const response = await client.responses.create({
        model,
        instructions: extractionInstructions(),
        input,
        max_output_tokens: 1_024,
        // DashScope extension, as in the worker.
        ...({ enable_thinking: false } as Record<string, unknown>),
      })
      const failure = scenario.check(parseMemoryOperations(response.output_text))
      if (failure) {
        console.log(`FAIL ${scenario.name}: ${failure}`)
      } else {
        passed += 1
        console.log(`PASS ${scenario.name}`)
      }
    } catch (error) {
      console.log(`ERROR ${scenario.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

const rate = passed / total
console.log(`\n${passed}/${total} passed (${(rate * 100).toFixed(0)}%), threshold ${(minPassRate * 100).toFixed(0)}%`)
process.exit(rate >= minPassRate ? 0 : 1)
