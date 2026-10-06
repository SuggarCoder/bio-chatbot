import { AuthenticationError } from './auth.js'

/** FIFO admission: limit expensive work, not the number of connected users. */
export class AdmissionQueue {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly concurrency: number, private readonly maxWaiting = 128) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency')
    if (!Number.isInteger(maxWaiting) || maxWaiting < 0) throw new Error('Invalid queue capacity')
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxWaiting) {
        throw new AuthenticationError('服务排队已满，请稍后重试。', 429, 'admission_queue_full')
      }
      await new Promise<void>(resolve => this.waiting.push(resolve))
    } else {
      this.active += 1
    }
    try {
      return await operation()
    } finally {
      const next = this.waiting.shift()
      if (next) next() // Transfer this slot; do not let a new arrival steal it.
      else this.active -= 1
    }
  }
}

export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Operation aborted'))
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
