import type { AppConfig } from '../config.js'
import type { Database } from '../db.js'
import type { LocalEmbeddingService } from '../embedding.js'
import type { TokenCounter } from '../tokenBudget.js'
import {
  listArtifactSections,
  listArtifactPromptCatalogForChat,
  searchArtifactSections,
} from './repository.js'
import type { ArtifactService } from './service.js'
import {
  ARTIFACT_PROTOCOL_SYSTEM_PROMPT,
  ARTIFACT_PATCH_SYSTEM_PROMPT,
  buildArtifactSystemPrompt,
  type ArtifactPromptCatalogItem,
} from './systemPrompt.js'

const fullContentLimit = 32 * 1024

function promptTerms(value: string): Set<string> {
  return new Set(
    (value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])
      .slice(0, 64),
  )
}

function keywordScore(value: string, terms: Set<string>): number {
  const normalized = value.toLocaleLowerCase()
  let score = 0
  for (const term of terms) {
    if (normalized.includes(term)) score += 1
  }
  return score
}

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
  }
}

export async function assembleArtifactContext(
  database: Database,
  input: {
    config: AppConfig
    artifactService: ArtifactService
    embeddings: LocalEmbeddingService
    tokenCounter: TokenCounter
    userId: string
    chatId: string
    prompt: string
    artifactId?: string
    signal?: AbortSignal
  },
): Promise<AssembledArtifactContext> {
  const protocol = input.config.artifactPatchEnabled
    ? `${ARTIFACT_PROTOCOL_SYSTEM_PROMPT}\n\n${ARTIFACT_PATCH_SYSTEM_PROMPT}`
    : ARTIFACT_PROTOCOL_SYSTEM_PROMPT
  const renderPrompt = () => buildArtifactSystemPrompt(promptCatalog, {
    patchEnabled: input.config.artifactPatchEnabled,
  })
  if (
    input.tokenCounter.countText(protocol) >
      input.config.artifactProtocolTokenBudget
  ) {
    throw new Error('ARTIFACT_PROTOCOL_TOKEN_BUDGET_EXCEEDED')
  }
  const rows = await listArtifactPromptCatalogForChat(
    database,
    input.userId,
    input.chatId,
  )
  const catalog = rows.flatMap((row) => row.logicalId && row.type
    ? [{
        artifactId: row.id,
        logicalId: row.logicalId,
        version: row.currentVersion,
        type: row.type,
        title: row.title,
        byteLength: Number(row.byteLength),
        outline: row.outline,
        outlineStatus: row.outlineStatus,
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
  }))

  if (!selected) {
    const instructions = renderPrompt()
    if (
      input.tokenCounter.countText(instructions) >
        input.config.instructionsTokenBudget
    ) {
      throw new Error('ARTIFACT_DIRECTORY_TOKEN_BUDGET_EXCEEDED')
    }
    return { instructions }
  }

  const selectedPrompt = promptCatalog.find(
    (item) => item.logicalId === selected.logicalId,
  )!
  let content: string | null = null
  if (selected.byteLength < fullContentLimit) {
    content = await input.artifactService.readVersionContent(
      input.userId,
      selected.artifactId,
      selected.version,
      fullContentLimit,
      input.signal,
    ).catch(() => null)
    if (content !== null) {
      selectedPrompt.content = content
      selectedPrompt.status = 'full_content_attached'
    } else {
      selectedPrompt.status = 'metadata_only'
    }
  } else if (selected.outlineStatus === 'ready' && selected.outline) {
    selectedPrompt.outline = truncateToTokens(
      selected.outline,
      input.config.artifactOutlineTokenBudget,
      input.tokenCounter,
    )
    try {
      const candidates = await input.embeddings.embed(input.prompt)
        .then((vector) => searchArtifactSections(database, {
          userId: input.userId,
          artifactId: selected.artifactId,
          version: selected.version,
          embedding: vector,
        }))
        .catch(() => listArtifactSections(database, {
          userId: input.userId,
          artifactId: selected.artifactId,
          version: selected.version,
        }).then((sections) => sections.map((section) => ({
          ...section,
          distance: 1,
        }))))
      const terms = promptTerms(input.prompt)
      const ranked = candidates
        .map((section) => ({
          ...section,
          score: keywordScore(
            `${section.headingPath}\n${section.preview}`,
            terms,
          ) - Number(section.distance ?? 1),
        }))
        .sort((left, right) => right.score - left.score)
      const fragments: NonNullable<ArtifactPromptCatalogItem['fragments']> = []
      let usedTokens = 0
      for (const section of ranked) {
        const byteStart = Number(section.byteStart)
        const byteEnd = Number(section.byteEnd)
        const fragment = await input.artifactService.readVersionRange(
          input.userId,
          selected.artifactId,
          selected.version,
          byteStart,
          byteEnd,
          input.signal,
        )
        if (fragment === null) continue
        const fragmentTokens = input.tokenCounter.countText(fragment)
        if (
          fragmentTokens > input.config.artifactFragmentTokenBudget ||
          usedTokens + fragmentTokens > input.config.artifactFragmentTokenBudget
        ) continue
        fragments.push({
          byteStart,
          byteEnd,
          headingPath: section.headingPath,
          content: fragment,
        })
        usedTokens += fragmentTokens
        if (fragments.length >= 4) break
      }
      selectedPrompt.fragments = fragments
      selectedPrompt.status = 'outline_fragments_attached'
    } catch {
      selectedPrompt.status = 'metadata_only'
      selectedPrompt.outline = undefined
    }
  } else {
    selectedPrompt.status = 'metadata_only'
  }

  let instructions = renderPrompt()
  while (
    selectedPrompt.fragments &&
    selectedPrompt.fragments.length > 0 &&
    input.tokenCounter.countText(instructions) >
      input.config.instructionsTokenBudget
  ) {
    selectedPrompt.fragments.pop()
    instructions = renderPrompt()
  }
  if (
    input.tokenCounter.countText(instructions) >
      input.config.instructionsTokenBudget
  ) {
    selectedPrompt.content = undefined
    selectedPrompt.outline = undefined
    selectedPrompt.fragments = undefined
    selectedPrompt.status = 'metadata_only'
    content = null
    instructions = renderPrompt()
  }
  if (
    input.tokenCounter.countText(instructions) >
      input.config.instructionsTokenBudget
  ) {
    throw new Error('ARTIFACT_DIRECTORY_TOKEN_BUDGET_EXCEEDED')
  }

  return {
    instructions,
    selectedArtifact: {
      artifactId: selected.artifactId,
      logicalId: selected.logicalId,
      version: selected.version,
      type: selected.type,
      title: selected.title,
      byteLength: selected.byteLength,
      content,
      status: selectedPrompt.status,
    },
  }
}
