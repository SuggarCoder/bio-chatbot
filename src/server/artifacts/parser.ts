import { createHash, randomUUID } from 'node:crypto'
import {
  ARTIFACT_BODY_MAX_BYTES,
  ARTIFACT_OPEN_TAG_MAX_BYTES,
  artifactMimeTypes,
  artifactProtocolMetadataSchema,
  type ArtifactParserErrorCode,
  type ArtifactProtocolMetadata,
  type ArtifactStreamParserEvents,
} from './protocol.js'

export type ParserState =
  | 'TEXT'
  | 'OPEN_TAG_CANDIDATE'
  | 'OPEN_TAG'
  | 'ARTIFACT_BODY'
  | 'CLOSE_TAG_CANDIDATE'
  | 'FAILED'

export type ArtifactStreamParserOptions = {
  maxOpeningTagBytes?: number
  maxBodyBytes?: number
  createStreamArtifactId?: () => string
}

const OPEN_PREFIX = '<artifact'
const CLOSE_TAG = '</artifact>'
const ESCAPED_CLOSE_TAG = '\\</artifact>'
const BODY_TAIL_SIZE = ESCAPED_CLOSE_TAG.length

type ParsedOpeningTag =
  | { metadata: ArtifactProtocolMetadata }
  | { code: ArtifactParserErrorCode; message: string }

function decodeXmlAttribute(value: string): string | null {
  let output = ''

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '&') {
      output += value[index]
      continue
    }

    const semicolon = value.indexOf(';', index + 1)
    if (semicolon < 0) return null
    const entity = value.slice(index, semicolon + 1)
    const decoded = {
      '&amp;': '&',
      '&quot;': '"',
      '&lt;': '<',
      '&gt;': '>',
    }[entity]
    if (decoded === undefined) return null
    output += decoded
    index = semicolon
  }

  return output
}

function parseOpeningTag(tag: string): ParsedOpeningTag {
  if (!tag.startsWith(OPEN_PREFIX) || !tag.endsWith('>')) {
    return { code: 'INVALID_OPEN_TAG', message: 'Malformed Artifact opening tag.' }
  }

  let index = OPEN_PREFIX.length
  const attributes: Record<string, string> = {}
  const allowed = new Set([
    'v',
    'id',
    'op',
    'type',
    'title',
    'base_version',
    'language',
  ])

  if (tag[index] !== ' ' && tag[index] !== '\t' && tag[index] !== '\r' && tag[index] !== '\n') {
    return { code: 'INVALID_OPEN_TAG', message: 'Artifact attributes must follow whitespace.' }
  }

  while (index < tag.length - 1) {
    while (/\s/.test(tag[index] ?? '')) index += 1
    if (index === tag.length - 1) break

    const nameStart = index
    if (!/[A-Za-z_]/.test(tag[index] ?? '')) {
      return { code: 'INVALID_OPEN_TAG', message: 'Invalid Artifact attribute name.' }
    }
    index += 1
    while (/[A-Za-z0-9_.-]/.test(tag[index] ?? '')) index += 1
    const name = tag.slice(nameStart, index)

    if (!allowed.has(name) || Object.hasOwn(attributes, name)) {
      return { code: 'INVALID_OPEN_TAG', message: `Unknown or duplicate Artifact attribute: ${name}.` }
    }

    while (/\s/.test(tag[index] ?? '')) index += 1
    if (tag[index] !== '=') {
      return { code: 'INVALID_OPEN_TAG', message: `Artifact attribute ${name} is missing '='.` }
    }
    index += 1
    while (/\s/.test(tag[index] ?? '')) index += 1
    if (tag[index] !== '"') {
      return { code: 'INVALID_OPEN_TAG', message: `Artifact attribute ${name} must use double quotes.` }
    }
    index += 1
    const valueStart = index
    while (index < tag.length - 1 && tag[index] !== '"') index += 1
    if (tag[index] !== '"') {
      return { code: 'INVALID_OPEN_TAG', message: `Artifact attribute ${name} is not closed.` }
    }
    const decoded = decodeXmlAttribute(tag.slice(valueStart, index))
    if (decoded === null) {
      return { code: 'INVALID_OPEN_TAG', message: `Artifact attribute ${name} contains an invalid XML entity.` }
    }
    attributes[name] = decoded
    index += 1
  }

  if (attributes.v !== undefined && attributes.v !== '1') {
    return { code: 'UNSUPPORTED_VERSION', message: `Unsupported Artifact protocol version: ${attributes.v}.` }
  }
  if (
    attributes.type !== undefined &&
    !artifactMimeTypes.includes(attributes.type as (typeof artifactMimeTypes)[number])
  ) {
    return { code: 'UNSUPPORTED_TYPE', message: `Unsupported Artifact type: ${attributes.type}.` }
  }

  const result = artifactProtocolMetadataSchema.safeParse(attributes)
  if (!result.success) {
    return {
      code: 'INVALID_METADATA',
      message: result.error.issues.map((issue) => issue.message).join('; '),
    }
  }

  return { metadata: result.data }
}

export class ArtifactStreamParser {
  private stateValue: ParserState = 'TEXT'
  private openingBuffer = ''
  private bodyTail = ''
  private failedTail = ''
  private textBuffer = ''
  private lineBuffer = ''
  private inFence = false
  private fenceMarker: '```' | '~~~' | null = null
  private streamArtifactId: string | undefined
  private metadata: ArtifactProtocolMetadata | undefined
  private bodyParts: string[] = []
  private bodyDeltaBuffer = ''
  private bodySequence = 0
  private bodyBytes = 0
  private pendingHighSurrogate = ''
  private finished = false

  private readonly maxOpeningTagBytes: number
  private readonly maxBodyBytes: number
  private readonly createStreamArtifactId: () => string

  constructor(
    private readonly events: ArtifactStreamParserEvents,
    options: ArtifactStreamParserOptions = {},
  ) {
    this.maxOpeningTagBytes = options.maxOpeningTagBytes ?? ARTIFACT_OPEN_TAG_MAX_BYTES
    this.maxBodyBytes = options.maxBodyBytes ?? ARTIFACT_BODY_MAX_BYTES
    this.createStreamArtifactId = options.createStreamArtifactId ?? randomUUID
  }

  get state(): ParserState {
    return this.stateValue
  }

  push(chunk: string): void {
    if (this.finished) throw new Error('ArtifactStreamParser has finished')

    for (const character of chunk) {
      this.consume(character)
    }
    this.flushText()
    this.flushBodyDelta()
  }

  finish(): void {
    if (this.finished) return

    if (this.stateValue === 'OPEN_TAG_CANDIDATE') {
      this.appendText(this.openingBuffer)
    } else if (this.stateValue === 'OPEN_TAG') {
      this.fail('UNCLOSED_ARTIFACT', 'Model stream ended inside the Artifact opening tag.', true)
    } else if (this.stateValue === 'ARTIFACT_BODY' || this.stateValue === 'CLOSE_TAG_CANDIDATE') {
      this.emitBody(this.bodyTail)
      this.bodyTail = ''
      this.fail('UNCLOSED_ARTIFACT', 'Model stream ended before the Artifact closing tag.', true)
    }

    this.flushText()
    this.flushBodyDelta()
    this.finished = true
  }

  abort(reason = 'Artifact generation was aborted.'): void {
    if (this.finished) return
    if (this.hasActiveArtifact()) {
      this.emitBody(this.bodyTail)
      this.bodyTail = ''
      this.fail('ARTIFACT_ABORTED', reason, true)
    } else if (this.stateValue === 'OPEN_TAG_CANDIDATE') {
      this.appendText(this.openingBuffer)
    }
    this.flushText()
    this.flushBodyDelta()
    this.finished = true
  }

  reset(): void {
    this.stateValue = 'TEXT'
    this.openingBuffer = ''
    this.bodyTail = ''
    this.failedTail = ''
    this.textBuffer = ''
    this.lineBuffer = ''
    this.inFence = false
    this.fenceMarker = null
    this.streamArtifactId = undefined
    this.metadata = undefined
    this.bodyParts = []
    this.bodyDeltaBuffer = ''
    this.bodySequence = 0
    this.bodyBytes = 0
    this.pendingHighSurrogate = ''
    this.finished = false
  }

  private consume(character: string): void {
    if (this.stateValue === 'TEXT') {
      if (this.lineBuffer.length === 0 && !this.inFence && character === '<') {
        this.stateValue = 'OPEN_TAG_CANDIDATE'
        this.openingBuffer = '<'
      } else {
        this.appendText(character)
      }
      return
    }

    if (this.stateValue === 'OPEN_TAG_CANDIDATE') {
      this.openingBuffer += character
      if (OPEN_PREFIX.startsWith(this.openingBuffer)) {
        if (this.openingBuffer === OPEN_PREFIX) this.stateValue = 'OPEN_TAG'
        return
      }

      const rejected = this.openingBuffer
      this.openingBuffer = ''
      this.stateValue = 'TEXT'
      this.appendText(rejected)
      return
    }

    if (this.stateValue === 'OPEN_TAG') {
      this.openingBuffer += character
      if (Buffer.byteLength(this.openingBuffer, 'utf8') > this.maxOpeningTagBytes) {
        this.beginFailed('OPEN_TAG_TOO_LARGE', 'Artifact opening tag exceeds the byte limit.')
        return
      }

      if (character === '>' && !this.isInsideOpeningQuote()) {
        const parsed = parseOpeningTag(this.openingBuffer)
        if ('code' in parsed) {
          this.beginFailed(parsed.code, parsed.message)
          return
        }
        this.metadata = parsed.metadata
        this.streamArtifactId = this.createStreamArtifactId()
        this.stateValue = 'ARTIFACT_BODY'
        this.events.onArtifactStart({
          streamArtifactId: this.streamArtifactId,
          metadata: parsed.metadata,
        })
        this.openingBuffer = ''
      }
      return
    }

    if (this.stateValue === 'FAILED') {
      this.failedTail += character
      if (this.failedTail.endsWith(CLOSE_TAG)) {
        this.failedTail = ''
        this.clearArtifact()
        this.stateValue = 'TEXT'
        this.lineBuffer = ''
      } else if (this.failedTail.length > CLOSE_TAG.length) {
        this.failedTail = this.failedTail.slice(-CLOSE_TAG.length)
      }
      return
    }

    this.stateValue = 'CLOSE_TAG_CANDIDATE'
    this.bodyTail += character

    if (this.bodyTail.endsWith(ESCAPED_CLOSE_TAG)) {
      const prefix = this.bodyTail.slice(0, -ESCAPED_CLOSE_TAG.length)
      this.emitBody(prefix + CLOSE_TAG)
      this.bodyTail = ''
      this.stateValue = 'ARTIFACT_BODY'
      return
    }

    if (this.bodyTail.endsWith(CLOSE_TAG)) {
      const prefix = this.bodyTail.slice(0, -CLOSE_TAG.length)
      this.emitBody(prefix)
      this.bodyTail = ''
      if ((this.stateValue as ParserState) === 'FAILED') return
      this.completeArtifact()
      return
    }

    const nestedIndex = this.bodyTail.indexOf(OPEN_PREFIX)
    if (nestedIndex >= 0) {
      const following = this.bodyTail[nestedIndex + OPEN_PREFIX.length]
      if (following === undefined) {
        return
      }
      if (/\s|>/.test(following)) {
        this.beginFailed('NESTED_ARTIFACT', 'Nested Artifact blocks are not allowed.')
        return
      }
    }

    if (this.bodyTail.length > BODY_TAIL_SIZE) {
      this.emitBody(this.bodyTail.slice(0, -BODY_TAIL_SIZE))
      this.bodyTail = this.bodyTail.slice(-BODY_TAIL_SIZE)
    }
    this.stateValue = 'ARTIFACT_BODY'
  }

  private isInsideOpeningQuote(): boolean {
    let quoted = false
    for (let index = OPEN_PREFIX.length; index < this.openingBuffer.length; index += 1) {
      if (this.openingBuffer[index] === '"') quoted = !quoted
    }
    return quoted
  }

  private appendText(value: string): void {
    for (const character of value) {
      this.textBuffer += character
      if (character === '\n') {
        const fence = this.lineBuffer.match(/^ {0,3}(```|~~~)/)?.[1] as '```' | '~~~' | undefined
        if (fence) {
          if (!this.inFence) {
            this.inFence = true
            this.fenceMarker = fence
          } else if (this.fenceMarker === fence) {
            this.inFence = false
            this.fenceMarker = null
          }
        }
        this.lineBuffer = ''
      } else {
        this.lineBuffer += character
      }
    }
  }

  private flushText(): void {
    if (!this.textBuffer) return
    const delta = this.textBuffer
    this.textBuffer = ''
    this.events.onTextDelta(delta)
  }

  private emitBody(value: string): void {
    if (!value || !this.streamArtifactId) return
    this.bodyParts.push(value)
    this.bodyDeltaBuffer += value
    this.bodyBytes += this.countUtf8Bytes(value)

    if (this.bodyBytes > this.maxBodyBytes) {
      this.beginFailed('ARTIFACT_TOO_LARGE', 'Artifact body exceeds the byte limit.')
      return
    }

  }

  private flushBodyDelta(): void {
    if (!this.bodyDeltaBuffer || !this.streamArtifactId) return
    const delta = this.bodyDeltaBuffer
    this.bodyDeltaBuffer = ''
    this.bodySequence += 1
    this.events.onArtifactDelta({
      streamArtifactId: this.streamArtifactId,
      sequence: this.bodySequence,
      delta,
    })
  }

  private countUtf8Bytes(value: string): number {
    let input = this.pendingHighSurrogate + value
    this.pendingHighSurrogate = ''
    if (input.length > 0) {
      const last = input.charCodeAt(input.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) {
        this.pendingHighSurrogate = input.slice(-1)
        input = input.slice(0, -1)
      }
    }
    return Buffer.byteLength(input, 'utf8')
  }

  private completeArtifact(): void {
    if (!this.streamArtifactId || !this.metadata) return
    if (this.pendingHighSurrogate) {
      this.bodyBytes += Buffer.byteLength(this.pendingHighSurrogate, 'utf8')
      this.pendingHighSurrogate = ''
    }
    const content = this.bodyParts.join('')
    const byteLength = Buffer.byteLength(content, 'utf8')
    if (byteLength > this.maxBodyBytes) {
      this.beginFailed('ARTIFACT_TOO_LARGE', 'Artifact body exceeds the byte limit.')
      return
    }

    this.flushBodyDelta()
    this.events.onArtifactCommit({
      streamArtifactId: this.streamArtifactId,
      metadata: this.metadata,
      content,
      byteLength,
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    })
    this.clearArtifact()
    this.stateValue = 'TEXT'
    this.lineBuffer = ''
  }

  private beginFailed(code: ArtifactParserErrorCode, message: string): void {
    this.fail(code, message, true)
    this.stateValue = 'FAILED'
    this.failedTail = this.openingBuffer.endsWith('>') ? '' : this.openingBuffer.slice(-CLOSE_TAG.length)
    this.openingBuffer = ''
  }

  private fail(code: ArtifactParserErrorCode, message: string, recoverable: boolean): void {
    this.events.onArtifactError({
      streamArtifactId: this.streamArtifactId,
      code,
      message,
      recoverable,
    })
  }

  private hasActiveArtifact(): boolean {
    return this.stateValue === 'OPEN_TAG' ||
      this.stateValue === 'ARTIFACT_BODY' ||
      this.stateValue === 'CLOSE_TAG_CANDIDATE' ||
      this.stateValue === 'FAILED'
  }

  private clearArtifact(): void {
    this.openingBuffer = ''
    this.bodyTail = ''
    this.failedTail = ''
    this.streamArtifactId = undefined
    this.metadata = undefined
    this.bodyParts = []
    this.bodyDeltaBuffer = ''
    this.bodySequence = 0
    this.bodyBytes = 0
    this.pendingHighSurrogate = ''
  }
}

export class ArtifactUtf8StreamDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false })

  constructor(private readonly parser: ArtifactStreamParser) {}

  push(bytes: Uint8Array): void {
    const decoded = this.decoder.decode(bytes, { stream: true })
    if (decoded) this.parser.push(decoded)
  }

  finish(): void {
    const decoded = this.decoder.decode()
    if (decoded) this.parser.push(decoded)
    this.parser.finish()
  }
}
