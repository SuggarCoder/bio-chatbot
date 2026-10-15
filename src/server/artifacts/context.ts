import type { AppConfig } from '../config.js'
import type { Database } from '../db.js'
import type { TokenCounter } from '../tokenBudget.js'
import { extractArtifactOutline, type ArtifactOutlineSection } from './outline.js'
import { ARTIFACT_BODY_MAX_BYTES } from './protocol.js'
import { listArtifactPromptCatalogForChat } from './repository.js'
import type { ArtifactService } from './service.js'
import {
  ARTIFACT_PROTOCOL_SYSTEM_PROMPT,
  ARTIFACT_PATCH_SYSTEM_PROMPT,
  buildArtifactSystemPrompt,
  type ArtifactEditMode,
  type ArtifactPromptCatalogItem,
} from './systemPrompt.js'

/**
 * From this size on an Artifact is edited with SEARCH/REPLACE patches: a full
 * rewrite would not fit the model's output budget reliably.
 */
export const ARTIFACT_PATCH_MIN_BYTES = 32 * 1024
/** Fragments attached for one large Artifact. */
const MAX_FRAGMENTS = 8
/** Generous byte bound for a text that could fit the full-content token budget. */
const MAX_BYTES_PER_TOKEN = 6
const SECTION_PREVIEW_CHARS = 160

export type ArtifactSectionChoice = {
  ordinal: number
  headingPath: string
  preview: string
  bytes: number
}

/**
 * Picks the sections of a large Artifact that a request needs, most relevant
 * first. Backed by the model; returns ordinals from `sections`.
 */
export type SelectArtifactSections = (request: {
  title: string
  type: string
  prompt: string
  sections: ArtifactSectionChoice[]
  maxSections: number
  signal?: AbortSignal
}) => Promise<number[]>

function truncateToTokens(
  value: string,
  budget: number,
  counter: TokenCounter,
): string {
  if (counter.countText(value) <= budget) return value
  const lines = value.split('\n')
  let low = 0
  let high = lines.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = lines.slice(0, middle).join('\n')
    if (counter.countText(candidate) <= budget) low = middle
    else high = middle - 1
  }
  return `${lines.slice(0, low).join('\n')}\n[truncated]`.trim()
}

function sectionText(buffer: Buffer, section: ArtifactOutlineSection): string {
  return buffer.subarray(section.byteStart, section.byteEnd).toString('utf8')
}

function editModeFor(byteLength: number, patchEnabled: boolean, attachedWhole: boolean): ArtifactEditMode {
  if (attachedWhole && byteLength < ARTIFACT_PATCH_MIN_BYTES) return 'replace'
  return patchEnabled ? 'patch' : 'none'
}

export type AssembledArtifactContext = {
  instructions: string
  selectedArtifact?: {
    artifactId: string
    logicalId: string
    version: number
    type: string
    title: string
    byteLength: number
    content: string | null
    status: ArtifactPromptCatalogItem['status']
    edit: ArtifactEditMode
  }
}

/**
 * Builds the Artifact instructions for one request in two tiers:
 * - an Artifact within ARTIFACT_FULL_CONTENT_TOKEN_BUDGET is attached whole;
 * - a larger one gets its structural outline plus the sections the model
 *   picks for this request, within ARTIFACT_FRAGMENT_TOKEN_BUDGET.
 * The outline is extracted from the current version on demand, so it never
 * lags behind a just-saved version.
 */
export async function assembleArtifactContext(
  database: Database,
  input: {
    config: AppConfig
    artifactService: ArtifactService
    tokenCounter: TokenCounter
    selectSections: SelectArtifactSections
    userId: string
    chatId: string
    prompt: string
    artifactId?: string
    /** Instruction tokens left for Artifacts after other instructions. */
    tokenBudget: number
    signal?: AbortSignal
  },
): Promise<AssembledArtifactContext> {
  const { config, tokenCounter } = input
  const patchEnabled = config.artifactPatchEnabled
  const protocol = patchEnabled
    ? `${ARTIFACT_PROTOCOL_SYSTEM_PROMPT}\n\n${ARTIFACT_PATCH_SYSTEM_PROMPT}`
    : ARTIFACT_PROTOCOL_SYSTEM_PROMPT
  if (tokenCounter.countText(protocol) > config.artifactProtocolTokenBudget) {
    throw new Error('ARTIFACT_PROTOCOL_TOKEN_BUDGET_EXCEEDED')
  }
  const rows = await listArtifactPromptCatalogForChat(database, input.userId, input.chatId)
  const catalog = rows.flatMap((row) => row.logicalId && row.type
    ? [{
        artifactId: row.id,
        logicalId: row.logicalId,
        version: row.currentVersion,
        type: row.type,
        title: row.title,
        byteLength: Number(row.byteLength),
      }]
    : [])
  const normalizedPrompt = input.prompt.toLocaleLowerCase()
  const referenced = catalog.filter((item) =>
    item.artifactId === input.artifactId ||
    normalizedPrompt.includes(item.logicalId.toLocaleLowerCase()) ||
    (
      item.title.trim().length >= 2 &&
      normalizedPrompt.includes(item.title.trim().toLocaleLowerCase())
    ),
  )
  const selected = input.artifactId
    ? catalog.find((item) => item.artifactId === input.artifactId)
    : referenced.length === 1
      ? referenced[0]
      : undefined

  const promptCatalog: ArtifactPromptCatalogItem[] = catalog.map((item) => ({
    logicalId: item.logicalId,
    version: item.version,
    type: item.type,
    title: item.title,
    byteLength: item.byteLength,
    status: 'catalog_loaded',
    edit: 'none',
  }))
  const renderPrompt = () => buildArtifactSystemPrompt(promptCatalog, { patchEnabled })
  const fits = (instructions: string) => tokenCounter.countText(instructions) <= input.tokenBudget

  if (!selected) {
    const instructions = renderPrompt()
    if (!fits(instructions)) throw new Error('ARTIFACT_DIRECTORY_TOKEN_BUDGET_EXCEEDED')
    return { instructions }
  }

  const selectedPrompt = promptCatalog.find((item) => item.logicalId === selected.logicalId)!
  const content = await input.artifactService.readVersionContent(
    input.userId,
    selected.artifactId,
    selected.version,
    ARTIFACT_BODY_MAX_BYTES,
    input.signal,
  ).catch(() => null)

  if (content === null) {
    selectedPrompt.status = 'metadata_only'
  } else if (
    selected.byteLength <= config.artifactFullContentTokenBudget * MAX_BYTES_PER_TOKEN &&
    tokenCounter.countText(content) <= config.artifactFullContentTokenBudget
  ) {
    selectedPrompt.content = content
    selectedPrompt.status = 'full_content_attached'
    selectedPrompt.edit = editModeFor(selected.byteLength, patchEnabled, true)
  } else {
    const buffer = Buffer.from(content, 'utf8')
    const extracted = extractArtifactOutline(content, selected.type, Number.MAX_SAFE_INTEGER)
    const byOrdinal = new Map(extracted.sections.map((section) => [section.ordinal, section]))
    const chosen = await input.selectSections({
      title: selected.title,
      type: selected.type,
      prompt: input.prompt,
      sections: extracted.sections.map((section) => ({
        ordinal: section.ordinal,
        headingPath: section.headingPath,
        preview: section.preview.slice(0, SECTION_PREVIEW_CHARS),
        bytes: section.byteEnd - section.byteStart,
      })),
      maxSections: MAX_FRAGMENTS,
      signal: input.signal,
    }).catch((error: unknown) => {
      if (input.signal?.aborted) throw error
      return []
    })
    // Without a usable choice, read from the start of the document.
    const ranked = [...new Set(chosen)].filter((ordinal) => byOrdinal.has(ordinal))
    const order = ranked.length > 0 ? ranked : extracted.sections.map((section) => section.ordinal)
    const picked: ArtifactOutlineSection[] = []
    let usedTokens = 0
    for (const ordinal of order) {
      if (picked.length >= MAX_FRAGMENTS) break
      const section = byOrdinal.get(ordinal)!
      const tokens = tokenCounter.countText(sectionText(buffer, section))
      if (usedTokens + tokens > config.artifactFragmentTokenBudget) continue
      picked.push(section)
      usedTokens += tokens
    }
    picked.sort((left, right) => left.ordinal - right.ordinal)
    selectedPrompt.outline = truncateToTokens(
      extracted.outline,
      config.artifactOutlineTokenBudget,
      tokenCounter,
    )
    selectedPrompt.fragments = picked.map((section) => ({
      byteStart: section.byteStart,
      byteEnd: section.byteEnd,
      headingPath: section.headingPath,
      content: sectionText(buffer, section),
    }))
    selectedPrompt.status = 'outline_fragments_attached'
    selectedPrompt.edit = editModeFor(selected.byteLength, patchEnabled, false)
  }

  let instructions = renderPrompt()
  while (selectedPrompt.fragments?.length && !fits(instructions)) {
    selectedPrompt.fragments.pop()
    instructions = renderPrompt()
  }
  if (!fits(instructions)) {
    selectedPrompt.content = undefined
    selectedPrompt.outline = undefined
    selectedPrompt.fragments = undefined
    selectedPrompt.status = 'metadata_only'
    selectedPrompt.edit = 'none'
    instructions = renderPrompt()
  }
  if (!fits(instructions)) throw new Error('ARTIFACT_DIRECTORY_TOKEN_BUDGET_EXCEEDED')

  return {
    instructions,
    selectedArtifact: {
      artifactId: selected.artifactId,
      logicalId: selected.logicalId,
      version: selected.version,
      type: selected.type,
      title: selected.title,
      byteLength: selected.byteLength,
      content: selectedPrompt.status === 'full_content_attached' ? content : null,
      status: selectedPrompt.status,
      edit: selectedPrompt.edit ?? 'none',
    },
  }
}
