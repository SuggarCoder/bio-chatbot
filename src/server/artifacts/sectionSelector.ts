import type OpenAI from 'openai'

import type { ArtifactSectionChoice, SelectArtifactSections } from './context.js'

const SECTION_SELECTION_MAX_OUTPUT_TOKENS = 256

function renderSection(section: ArtifactSectionChoice): string {
  const size = `${Math.max(1, Math.round(section.bytes / 1024))}KB`
  return `[${section.ordinal}] ${section.headingPath || '（无标题）'}${section.preview ? ` — ${section.preview}` : ''} (${size})`
}

/** Ordinals from a `{"sections":[...]}` reply that exist in the outline. */
export function parseSectionSelection(text: string, known: ReadonlySet<number>): number[] {
  const normalized = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const parsed: unknown = JSON.parse(normalized)
  const values = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { sections?: unknown }).sections
    : undefined
  if (!Array.isArray(values)) throw new Error('Section selection has no sections array')
  return [...new Set(values.filter((value): value is number =>
    Number.isInteger(value) && known.has(value as number)))]
}

/**
 * Lets the model choose which sections of a large Artifact to attach, reading
 * the outline the way a person would ("第三节", "结论部分", "表格样式").
 */
export function createModelSectionSelector(input: {
  client: OpenAI
  model: string
  onResponse?: (response: unknown) => void
}): SelectArtifactSections {
  return async (request) => {
    const response = await input.client.responses.create({
      // DashScope extension: a lookup does not need a reasoning trace.
      ...({ enable_thinking: false } as Record<string, unknown>),
      model: input.model,
      instructions: [
        '你负责为用户的请求，从一份大型文档的章节目录中挑选需要阅读或修改的章节。',
        `按相关性从高到低列出章节编号，最多 ${request.maxSections} 个。修改请求必须包含要修改的章节；“第三节”“结论”“表格样式”等指代按目录判断；样式或脚本相关的请求要包含对应的 style 或 script 章节。`,
        '无法判断时选最可能相关的章节，不要返回空列表。',
        '只输出 JSON：{"sections":[编号,...]}。',
      ].join('\n'),
      input: [
        `文档：${JSON.stringify(request.title)}（${request.type}）`,
        `章节目录：\n${request.sections.map(renderSection).join('\n')}`,
        `用户请求：${request.prompt}`,
      ].join('\n\n'),
      max_output_tokens: SECTION_SELECTION_MAX_OUTPUT_TOKENS,
    }, { signal: request.signal })
    input.onResponse?.(response)
    return parseSectionSelection(
      response.output_text,
      new Set(request.sections.map((section) => section.ordinal)),
    ).slice(0, request.maxSections)
  }
}
