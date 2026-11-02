/**
 * Per-generation byte accounting. Token limits bound each piece only
 * indirectly; this puts one explicit ceiling on everything a single
 * generation pulls into memory and records how much it used.
 */
export type GenerationByteKind = 'input' | 'output' | 'tool' | 'artifact'

export type GenerationMemoryReport = {
  inputBytes: number
  outputBytes: number
  toolBytes: number
  artifactBytes: number
  totalBytes: number
  capBytes: number
  limited: boolean
}

/** The generation crossed GENERATION_MAX_BYTES; it ends like a length limit. */
export class GenerationByteLimitError extends Error {
  constructor(readonly totalBytes: number, readonly capBytes: number) {
    super(`Generation exceeded its memory limit (${totalBytes} of ${capBytes} bytes)`)
    this.name = 'GenerationByteLimitError'
  }
}

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

export class GenerationByteBudget {
  private readonly bytes: Record<GenerationByteKind, number> = {
    input: 0,
    output: 0,
    tool: 0,
    artifact: 0,
  }
  private total = 0
  private limited = false

  constructor(readonly capBytes: number) {}

  /** Adds bytes; throws GenerationByteLimitError once the total passes the cap. */
  charge(kind: GenerationByteKind, bytes: number): void {
    this.bytes[kind] += bytes
    this.total += bytes
    if (this.total > this.capBytes) {
      this.limited = true
      throw new GenerationByteLimitError(this.total, this.capBytes)
    }
  }

  get totalBytes(): number {
    return this.total
  }

  report(): GenerationMemoryReport {
    return {
      inputBytes: this.bytes.input,
      outputBytes: this.bytes.output,
      toolBytes: this.bytes.tool,
      artifactBytes: this.bytes.artifact,
      totalBytes: this.total,
      capBytes: this.capBytes,
      limited: this.limited,
    }
  }
}
