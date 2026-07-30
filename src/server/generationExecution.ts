export class GenerationCancellationError extends Error {
  constructor() {
    super('Generation stopped')
    this.name = 'GenerationCancellationError'
  }
}

export class GenerationExecutionContext {
  constructor(
    readonly generationId: string,
    readonly signal: AbortSignal,
    private readonly cancellationRequested: () => Promise<boolean>,
  ) {}

  async checkpoint(): Promise<void> {
    if (this.signal.aborted || await this.cancellationRequested()) {
      throw new GenerationCancellationError()
    }
  }

  async runCancellable<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    await this.checkpoint()
    const result = await operation(this.signal)
    await this.checkpoint()
    return result
  }

  async runNonCancellable<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.checkpoint()
    const result = await operation()
    await this.checkpoint()
    return result
  }
}
