export class GenerationCancellationError extends Error {
  constructor() {
    super('Generation stopped')
    this.name = 'GenerationCancellationError'
  }
}

export class GenerationExecutionContext {
  private lastCancellationPollAt?: number
  private cancellationPoll?: Promise<boolean>

  constructor(
    readonly generationId: string,
    readonly signal: AbortSignal,
    private readonly cancellationRequested: () => Promise<boolean>,
    private readonly pollIntervalMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  async checkpoint(forceDatabasePoll = false): Promise<void> {
    if (this.signal.aborted) {
      throw new GenerationCancellationError()
    }

    const now = this.now()
    if (
      !forceDatabasePoll &&
      this.lastCancellationPollAt !== undefined &&
      now - this.lastCancellationPollAt < this.pollIntervalMs
    ) {
      return
    }

    const poll = this.cancellationPoll ?? this.cancellationRequested()
    this.cancellationPoll = poll
    this.lastCancellationPollAt = now
    try {
      if (await poll) throw new GenerationCancellationError()
    } finally {
      if (this.cancellationPoll === poll) this.cancellationPoll = undefined
    }
  }

  async runCancellable<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    await this.checkpoint(true)
    const result = await operation(this.signal)
    await this.checkpoint(true)
    return result
  }

  async runNonCancellable<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.checkpoint(true)
    const result = await operation()
    await this.checkpoint(true)
    return result
  }
}
