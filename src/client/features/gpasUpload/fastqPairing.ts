/**
 * FASTQ single/paired-end detection for a chat upload batch.
 *
 * Stage A  file names pre-group candidate pairs (strict: equal length, exactly
 *          one differing character which is 1/2).
 * Stage B  each candidate pair is checked against file content: read IDs
 *          (BaseID) must overlap >= 0.7 and the headers must not claim the
 *          same end. A failed check downgrades the pair to single files.
 * Stage C  remaining files are classified from their headers and paired by
 *          BaseID overlap; without usable BaseIDs a pair also needs valid names.
 *
 * Content analysis is cached per file fingerprint, so adding files re-reads
 * only the new ones while pairing always runs over the whole batch: the result
 * is identical to selecting every file at once.
 */
import { GPAS_UPLOAD_MAX_FILES, gpasFileNamePattern } from '../../../server/gpasContracts'

export const FASTQ_EXTENSIONS = ['.fastq', '.fastq.gz', '.fq', '.fq.gz'] as const
export const FASTQ_ACCEPT = FASTQ_EXTENSIONS.join(',')

/** Minimal file shape; `File` satisfies it. */
export type SequencingFile = {
  name: string
  size: number
  lastModified: number
}

export type ReadType = 1 | 2 | null
/**
 * none          headers carry no end marker → single
 * r2            headers say read 2
 * r1_confirmed  headers say read 1 and the name has an R1 marker
 * r1_ambiguous  headers say read 1 but the name has no marker
 */
export type ReadMarker = 'none' | 'r2' | 'r1_confirmed' | 'r1_ambiguous'
export type PairingStatus =
  | 'paired'
  | 'unpaired_dual'
  | 'single'
  | 'invalid_dual_name'
  | 'invalid_single_name'

export type PairingResult<T> = {
  file: T
  status: PairingStatus
  readType: ReadType
  readMarker: ReadMarker
  /** Unpaired file whose headers look like R1: the user must confirm it is single. */
  maybeR1: boolean
  pairGroupId: string | null
  /** Paired files whose sampled read counts differ by more than 10%. */
  mismatchWarning: boolean
}

export type FileAnalysis = {
  readFailed: boolean
  baseIds: string[]
  readCount: number
  dominantType: ReadType
}

export type LineReader = (file: SequencingFile, maxLines: number) => Promise<string[]>

const ANALYZE_LINES = 160
const BASE_ID_SAMPLE = 10
const BASE_ID_THRESHOLD = 0.7
const DOMINANT_RATIO = 0.8
const MAX_PLAIN_BYTES = 2 * 1024 * 1024

// ============================================================
// Screening before a file joins the batch
// ============================================================

export type ScreenResult<T> = {
  accepted: T[]
  /** Human-readable reasons for files that were not added. */
  rejected: string[]
  /** The batch would exceed the per-chat limit; nothing new was added. */
  overLimit: boolean
}

export const fileFingerprint = (file: SequencingFile) =>
  `${file.name}\u0000${file.size}\u0000${file.lastModified}`

export function isFastqName(name: string): boolean {
  const lower = name.toLowerCase()
  return FASTQ_EXTENSIONS.some(extension => lower.endsWith(extension))
}

/**
 * Exact duplicates (same fingerprint) are skipped silently. A different file
 * with an existing name is rejected because GPAS maps upload tasks by name.
 */
export function screenFiles<T extends SequencingFile>(
  existing: readonly T[],
  incoming: readonly T[],
  maxFiles: number = GPAS_UPLOAD_MAX_FILES,
): ScreenResult<T> {
  const fingerprints = new Set(existing.map(fileFingerprint))
  const names = new Set(existing.map(file => file.name))
  const accepted: T[] = []
  const rejected: string[] = []

  for (const file of incoming) {
    if (fingerprints.has(fileFingerprint(file))) continue
    if (!isFastqName(file.name)) rejected.push(`${file.name}：仅支持 ${FASTQ_EXTENSIONS.join(' / ')} 文件`)
    else if (file.size === 0) rejected.push(`${file.name}：文件为空`)
    else if (names.has(file.name)) rejected.push(`${file.name}：已存在同名文件`)
    else {
      accepted.push(file)
      names.add(file.name)
      fingerprints.add(fileFingerprint(file))
    }
  }

  if (existing.length + accepted.length > maxFiles) {
    return { accepted: [], rejected, overLimit: true }
  }
  return { accepted, rejected, overLimit: false }
}

// ============================================================
// Reading
// ============================================================

/** Reads up to `maxLines` non-empty lines; gzip is streamed and stopped early. */
export const readFirstLines: LineReader = async (file, maxLines) => {
  const blob = file as unknown as Blob
  if (!file.name.toLowerCase().endsWith('.gz')) {
    const text = await blob.slice(0, MAX_PLAIN_BYTES).text()
    return text.split('\n').map(line => line.trim()).filter(Boolean).slice(0, maxLines)
  }

  // Throws on browsers without gzip DecompressionStream; the caller degrades.
  const reader = blob.stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(new TextDecoderStream())
    .getReader()
  const lines: string[] = []
  let buffer = ''
  try {
    while (lines.length < maxLines) {
      let chunk: ReadableStreamReadResult<string>
      try {
        chunk = await reader.read()
      } catch (error) {
        // Concatenated BGZF members can fail at a boundary; keep what was read.
        if (lines.length > 0) break
        throw error
      }
      if (chunk.done) {
        if (buffer.trim()) lines.push(buffer.trim())
        break
      }
      buffer += chunk.value
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.trim()
        if (line) lines.push(line)
        if (lines.length >= maxLines) break
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return lines.slice(0, maxLines)
}

// ============================================================
// Header and name rules
// ============================================================

/**
 * Extracts the read ID and end from a FASTQ header line.
 * Casava 1.8+: `@ID 1:N:0:ATCACG`; legacy: `@ID/1`. Without a marker the ID
 * is still returned so pairs can be cross-checked.
 */
export function extractBaseId(header: string): { baseId: string; readType: ReadType } | null {
  if (!header.startsWith('@')) return null
  const raw = header.slice(1).trim()
  const space = raw.search(/\s/)
  if (space !== -1) {
    const id = raw.slice(0, space)
    const description = raw.slice(space + 1).trim()
    if (description.startsWith('1:')) return { baseId: id, readType: 1 }
    if (description.startsWith('2:')) return { baseId: id, readType: 2 }
  }
  const legacy = raw.match(/^(\S+?)\/([12])(?:\s|$)/)
  if (legacy) return { baseId: legacy[1], readType: Number(legacy[2]) as ReadType }
  return { baseId: space === -1 ? raw : raw.slice(0, space), readType: null }
}

/** `_R1_`, `.r1.`, `-F2-`, or a bare `_1` right before the extension. */
export function hasEndMarker(name: string, end: 1 | 2): boolean {
  return new RegExp(`[-_.][a-zA-Z]${end}[-_.]`).test(name)
    || new RegExp(`[-_. ]${end}(?:\\.[a-zA-Z]+)+$`).test(name)
}

export const isValidFileName = (name: string) => gpasFileNamePattern.test(name)

/** Equal length and exactly one differing character, which is 1↔2. */
export function isDualNameValid(first: string, second: string): boolean {
  if (first.length !== second.length) return false
  let position = -1
  for (let index = 0; index < first.length; index++) {
    if (first[index] === second[index]) continue
    if (position !== -1) return false
    position = index
  }
  if (position === -1) return false
  const pair = first[position] + second[position]
  return pair === '12' || pair === '21'
}

/** Name gate for stage A; two files explicitly marked as the same end never pair. */
function passesNameGate(first: string, second: string): boolean {
  if (!isDualNameValid(first, second)) return false
  return !([1, 2] as const).some(end => hasEndMarker(first, end) && hasEndMarker(second, end))
}

function assignRoles<T extends SequencingFile>(a: T, b: T): { r1: T; r2: T } {
  const aR1 = hasEndMarker(a.name, 1)
  const bR1 = hasEndMarker(b.name, 1)
  if (aR1 !== bR1) return aR1 ? { r1: a, r2: b } : { r1: b, r2: a }
  for (let index = 0; index < a.name.length; index++) {
    if (a.name[index] !== b.name[index]) return a.name[index] < b.name[index] ? { r1: a, r2: b } : { r1: b, r2: a }
  }
  return { r1: a, r2: b }
}

function guessMarkerFromName(name: string): ReadMarker {
  if (hasEndMarker(name, 2)) return 'r2'
  if (hasEndMarker(name, 1)) return 'r1_confirmed'
  return 'none'
}

function overlapScore(first: string[], second: string[]): number | null {
  if (first.length === 0 || second.length === 0) return null
  const ids = new Set(first)
  const shared = second.filter(id => ids.has(id)).length
  return shared / Math.min(ids.size, second.length)
}

// ============================================================
// Analysis
// ============================================================

export async function analyzeFile(file: SequencingFile, readLines: LineReader): Promise<FileAnalysis> {
  let lines: string[]
  try {
    lines = await readLines(file, ANALYZE_LINES)
  } catch {
    return { readFailed: true, baseIds: [], readCount: 0, dominantType: null }
  }
  const counts = { 1: 0, 2: 0, none: 0 }
  const baseIds: string[] = []
  const headers = lines.filter((_, index) => index % 4 === 0)
  for (const header of headers) {
    const parsed = extractBaseId(header)
    if (!parsed) continue
    baseIds.push(parsed.baseId)
    counts[parsed.readType ?? 'none']++
  }
  const total = headers.length
  const dominantType: ReadType = total > 0 && counts[2] / total > DOMINANT_RATIO
    ? 2
    : total > 0 && counts[1] / total > DOMINANT_RATIO
      ? 1
      : null
  return { readFailed: false, baseIds: baseIds.slice(0, BASE_ID_SAMPLE), readCount: total, dominantType }
}

function markerFor(name: string, analysis: FileAnalysis): ReadMarker {
  if (analysis.readFailed) return guessMarkerFromName(name)
  if (analysis.dominantType === 2) return 'r2'
  if (analysis.dominantType === 1) return hasEndMarker(name, 1) ? 'r1_confirmed' : 'r1_ambiguous'
  return 'none'
}

// ============================================================
// Pairing
// ============================================================

/** Pure pairing over already analysed files. */
export function pairFiles<T extends SequencingFile>(
  files: readonly T[],
  analyses: ReadonlyMap<T, FileAnalysis>,
): PairingResult<T>[] {
  const analysis = (file: T) => analyses.get(file) ?? { readFailed: true, baseIds: [], readCount: 0, dominantType: null }
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const partner = new Map<T, T>()
  const roles = new Map<T, 1 | 2>()
  const fromPoolA = new Set<T>()
  let groupCounter = 0
  const groupOf = new Map<T, string>()
  const link = (r1: T, r2: T) => {
    const group = `g${++groupCounter}`
    partner.set(r1, r2); partner.set(r2, r1)
    roles.set(r1, 1); roles.set(r2, 2)
    groupOf.set(r1, group); groupOf.set(r2, group)
  }

  // Stage A + B: name-gated candidates, kept only if content does not contradict.
  for (let i = 0; i < sorted.length; i++) {
    if (fromPoolA.has(sorted[i])) continue
    for (let j = i + 1; j < sorted.length; j++) {
      if (fromPoolA.has(sorted[j]) || !passesNameGate(sorted[i].name, sorted[j].name)) continue
      const { r1, r2 } = assignRoles(sorted[i], sorted[j])
      fromPoolA.add(r1); fromPoolA.add(r2)
      const a1 = analysis(r1)
      const a2 = analysis(r2)
      const score = a1.readFailed || a2.readFailed ? null : overlapScore(a1.baseIds, a2.baseIds)
      const sameEnd = !a1.readFailed && !a2.readFailed && a1.dominantType !== null && a1.dominantType === a2.dominantType
      // Unreadable content keeps the name pairing; contradicting content breaks it.
      if ((score === null || score >= BASE_ID_THRESHOLD) && !sameEnd) link(r1, r2)
      break
    }
  }

  // Stage C: header-led pairing of the remaining files.
  const poolB = sorted.filter(file => !fromPoolA.has(file))
  const markers = new Map<T, ReadMarker>(sorted.map(file => [file, markerFor(file.name, analysis(file))]))
  const r1Candidates = poolB.filter(file => markers.get(file)!.startsWith('r1'))
  const r2Candidates = poolB.filter(file => markers.get(file) === 'r2')
  const usedR2 = new Set<T>()
  for (const r1 of r1Candidates) {
    let best: T | null = null
    let bestScore = 0
    for (const r2 of r2Candidates) {
      if (usedR2.has(r2)) continue
      const score = overlapScore(analysis(r1).baseIds, analysis(r2).baseIds)
      if (score === null) {
        // No content evidence: only an exact name pair is acceptable.
        if (!best && isDualNameValid(r1.name, r2.name)) { best = r2; bestScore = 0 }
        continue
      }
      if (score >= BASE_ID_THRESHOLD && score > bestScore) { best = r2; bestScore = score }
    }
    if (best) {
      usedR2.add(best)
      link(r1, best)
    }
  }

  const statusOrder: Record<PairingStatus, number> = {
    paired: 0, invalid_dual_name: 1, unpaired_dual: 2, single: 3, invalid_single_name: 4,
  }
  const results = files.map((file): PairingResult<T> => {
    const mate = partner.get(file)
    const ownAnalysis = analysis(file)
    const nameOk = isValidFileName(file.name)
    if (mate) {
      const readType = roles.get(file)!
      let status: PairingStatus = 'paired'
      let mismatchWarning = false
      if (!nameOk || !isDualNameValid(file.name, mate.name)) status = 'invalid_dual_name'
      else {
        const mateAnalysis = analysis(mate)
        if (ownAnalysis.readCount > 0 && mateAnalysis.readCount > 0) {
          const diff = Math.abs(ownAnalysis.readCount - mateAnalysis.readCount)
            / Math.max(ownAnalysis.readCount, mateAnalysis.readCount)
          mismatchWarning = diff > 0.1
        }
      }
      return {
        file, status, readType, readMarker: readType === 1 ? 'r1_confirmed' : 'r2',
        maybeR1: false, pairGroupId: groupOf.get(file)!, mismatchWarning,
      }
    }
    // Pool A pairs broken by content are plain singles; their name markers are ignored.
    const marker = fromPoolA.has(file) ? 'none' : markers.get(file)!
    const status: PairingStatus = marker === 'r2'
      ? (nameOk ? 'unpaired_dual' : 'invalid_dual_name')
      : (nameOk ? 'single' : 'invalid_single_name')
    return {
      file,
      status,
      readType: marker === 'r2' ? 2 : marker.startsWith('r1') ? 1 : null,
      readMarker: marker,
      maybeR1: marker === 'r1_confirmed' || marker === 'r1_ambiguous',
      pairGroupId: null,
      mismatchWarning: false,
    }
  })

  return results.sort((a, b) => {
    const byStatus = statusOrder[a.status] - statusOrder[b.status]
    if (byStatus !== 0) return byStatus
    if (a.pairGroupId && b.pairGroupId) {
      if (a.pairGroupId !== b.pairGroupId) return a.pairGroupId < b.pairGroupId ? -1 : 1
      return (a.readType ?? 0) - (b.readType ?? 0)
    }
    return 0
  })
}

/**
 * Keeps per-file analyses between calls so incremental additions only read new
 * files. Each `detect` call pairs the full batch from scratch.
 */
export function createPairingSession(readLines: LineReader = readFirstLines) {
  const cache = new Map<string, Promise<FileAnalysis>>()
  return {
    async detect<T extends SequencingFile>(
      files: readonly T[],
      onAnalyzed?: (file: T, done: number, total: number) => void,
    ): Promise<PairingResult<T>[]> {
      let done = 0
      const analyses = new Map<T, FileAnalysis>()
      // Sequential reads keep memory and disk pressure low for large gz files.
      for (const file of files) {
        const key = fileFingerprint(file)
        let pending = cache.get(key)
        if (!pending) {
          pending = analyzeFile(file, readLines)
          cache.set(key, pending)
        }
        analyses.set(file, await pending)
        onAnalyzed?.(file, ++done, files.length)
      }
      return pairFiles(files, analyses)
    },
    forget(file: SequencingFile) {
      cache.delete(fileFingerprint(file))
    },
  }
}

/** Submission is allowed only when every file has a definite, valid layout. */
export function pairingBlockers<T>(results: readonly PairingResult<T>[], confirmedSingles: ReadonlySet<T>): string[] {
  const blockers: string[] = []
  if (results.some(result => result.status === 'unpaired_dual')) blockers.push('存在缺少配对文件的双端 R2 文件，请补充 R1 或移除。')
  if (results.some(result => result.status === 'invalid_dual_name')) blockers.push('双端文件名不规范：两文件名应只在端号 1/2 处不同，且只含字母、数字、中文和 ._-。')
  if (results.some(result => result.status === 'invalid_single_name')) blockers.push('文件名只能包含字母、数字、中文和 ._-。')
  if (results.some(result => result.maybeR1 && result.status === 'single' && !confirmedSingles.has(result.file))) {
    blockers.push('有疑似双端 R1 文件未找到 R2，请确认按单端上传或补充 R2。')
  }
  return blockers
}
