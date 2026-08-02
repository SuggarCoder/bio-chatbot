import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ArtifactStreamParser,
  ArtifactUtf8StreamDecoder,
} from './parser.js'
import type {
  ArtifactParserErrorCode,
  ArtifactProtocolMetadata,
  ArtifactStreamParserEvents,
} from './protocol.js'

type Result = {
  text: string
  artifacts: Array<{
    metadata: ArtifactProtocolMetadata
    deltas: string
    content?: string
    sha256?: string
    byteLength?: number
  }>
  errors: ArtifactParserErrorCode[]
}

function parse(chunks: string[], options: { finish?: boolean; maxBodyBytes?: number } = {}): Result {
  const result: Result = { text: '', artifacts: [], errors: [] }
  const byId = new Map<string, Result['artifacts'][number]>()
  let nextId = 0
  const events: ArtifactStreamParserEvents = {
    onTextDelta: (delta) => {
      result.text += delta
    },
    onArtifactStart: ({ streamArtifactId, metadata }) => {
      const artifact = { metadata, deltas: '' }
      result.artifacts.push(artifact)
      byId.set(streamArtifactId, artifact)
    },
    onArtifactDelta: ({ streamArtifactId, delta }) => {
      const artifact = byId.get(streamArtifactId)
      assert.ok(artifact)
      artifact.deltas += delta
    },
    onArtifactCommit: ({ streamArtifactId, content, sha256, byteLength }) => {
      const artifact = byId.get(streamArtifactId)
      assert.ok(artifact)
      artifact.content = content
      artifact.sha256 = sha256
      artifact.byteLength = byteLength
    },
    onArtifactError: ({ code }) => {
      result.errors.push(code)
    },
  }
  const parser = new ArtifactStreamParser(events, {
    maxBodyBytes: options.maxBodyBytes,
    createStreamArtifactId: () => `stream-${nextId += 1}`,
  })
  chunks.forEach((chunk) => parser.push(chunk))
  if (options.finish !== false) parser.finish()
  return result
}

const opening = '<artifact v="1" id="dashboard" op="create" type="text/html" title="数据看板">'
const complete = `前言\n${opening}<h1>你好</h1></artifact>\n后记`

test('passes ordinary text through unchanged', () => {
  assert.deepEqual(parse(['普通 <article> 文本']), {
    text: '普通 <article> 文本',
    artifacts: [],
    errors: [],
  })
})

test('parses an Artifact with surrounding text', () => {
  const result = parse([complete])
  assert.equal(result.text, '前言\n\n后记')
  assert.equal(result.artifacts.length, 1)
  assert.equal(result.artifacts[0]?.metadata.id, 'dashboard')
  assert.equal(result.artifacts[0]?.content, '<h1>你好</h1>')
  assert.equal(result.artifacts[0]?.deltas, '<h1>你好</h1>')
  assert.equal(result.artifacts[0]?.byteLength, 15)
  assert.match(result.artifacts[0]?.sha256 ?? '', /^[a-f0-9]{64}$/)
})

test('supports replace metadata and XML attribute entities', () => {
  const input = '<artifact v="1" id="doc" op="replace" base_version="3" type="text/plain" title="A &amp; &quot;B&quot;">next</artifact>'
  const result = parse([input])
  assert.equal(result.artifacts[0]?.metadata.base_version, 3)
  assert.equal(result.artifacts[0]?.metadata.title, 'A & "B"')
})

test('supports multiple Artifacts in one response', () => {
  const first = '<artifact v="1" id="one" op="create" type="text/plain" title="One">1</artifact>'
  const second = '<artifact v="1" id="two" op="create" type="text/plain" title="Two">2</artifact>'
  const result = parse([`${first}\n${second}`])
  assert.deepEqual(result.artifacts.map((item) => item.content), ['1', '2'])
})

test('does not parse a tag outside line column one', () => {
  const result = parse([`prefix ${opening}body</artifact>`])
  assert.equal(result.text, `prefix ${opening}body</artifact>`)
  assert.equal(result.artifacts.length, 0)
})

test('does not parse protocol examples inside Markdown fences', () => {
  const input = `\`\`\`xml\n${opening}\nbody\n</artifact>\n\`\`\`\n`
  const result = parse([input])
  assert.equal(result.text, input)
  assert.equal(result.artifacts.length, 0)
})

test('unescapes only the exact escaped closing tag in a body', () => {
  const input = `${opening}before \\</artifact> after \\other</artifact>`
  const result = parse([input])
  assert.equal(result.artifacts[0]?.content, 'before </artifact> after \\other')
})

test('reports malformed metadata and resumes outer text after close', () => {
  const input = '<artifact v="1" id="INVALID" op="create" type="text/plain" title="Bad">hidden</artifact>\nvisible'
  const result = parse([input])
  assert.deepEqual(result.errors, ['INVALID_METADATA'])
  assert.equal(result.text, '\nvisible')
  assert.equal(result.artifacts.length, 0)
})

test('reports unsupported version and MIME type distinctly', () => {
  const version = parse(['<artifact v="2" id="x" op="create" type="text/plain" title="X">x</artifact>'])
  const type = parse(['<artifact v="1" id="x" op="create" type="application/javascript" title="X">x</artifact>'])
  assert.deepEqual(version.errors, ['UNSUPPORTED_VERSION'])
  assert.deepEqual(type.errors, ['UNSUPPORTED_TYPE'])
})

test('requires base_version only for replace', () => {
  const missing = parse(['<artifact v="1" id="x" op="replace" type="text/plain" title="X">x</artifact>'])
  const extra = parse(['<artifact v="1" id="x" op="create" base_version="1" type="text/plain" title="X">x</artifact>'])
  assert.deepEqual(missing.errors, ['INVALID_METADATA'])
  assert.deepEqual(extra.errors, ['INVALID_METADATA'])
})

test('reports an unclosed Artifact without committing it', () => {
  const result = parse([`${opening}partial`])
  assert.equal(result.artifacts[0]?.deltas, 'partial')
  assert.equal(result.artifacts[0]?.content, undefined)
  assert.deepEqual(result.errors, ['UNCLOSED_ARTIFACT'])
})

test('reports abort and does not commit a draft', () => {
  const result: Result = { text: '', artifacts: [], errors: [] }
  const parser = new ArtifactStreamParser({
    onTextDelta: (delta) => { result.text += delta },
    onArtifactStart: ({ metadata }) => { result.artifacts.push({ metadata, deltas: '' }) },
    onArtifactDelta: ({ delta }) => { result.artifacts[0]!.deltas += delta },
    onArtifactCommit: () => assert.fail('must not commit'),
    onArtifactError: ({ code }) => { result.errors.push(code) },
  })
  parser.push(`${opening}partial`)
  parser.abort('stopped')
  assert.deepEqual(result.errors, ['ARTIFACT_ABORTED'])
  assert.equal(result.artifacts[0]?.deltas, 'partial')
})

test('rejects an oversized opening tag and body', () => {
  const longTitle = 'x'.repeat(4100)
  const tag = `<artifact v="1" id="x" op="create" type="text/plain" title="${longTitle}">x</artifact>`
  assert.deepEqual(parse([tag]).errors, ['OPEN_TAG_TOO_LARGE'])
  assert.deepEqual(parse([`${opening}12345</artifact>`], { maxBodyBytes: 4 }).errors, ['ARTIFACT_TOO_LARGE'])
})

test('rejects nested Artifacts and handles many angle brackets', () => {
  const nested = `${opening}<artifact v="1" id="inner" op="create" type="text/plain" title="Inner">x</artifact></artifact>`
  assert.deepEqual(parse([nested]).errors, ['NESTED_ARTIFACT'])

  const angles = '<div><span data-x=">">ok</span></div>'.repeat(100)
  assert.equal(parse([`${opening}${angles}</artifact>`]).artifacts[0]?.content, angles)
})

test('reset makes the parser reusable', () => {
  let text = ''
  const parser = new ArtifactStreamParser({
    onTextDelta: (delta) => { text += delta },
    onArtifactStart: () => undefined,
    onArtifactDelta: () => undefined,
    onArtifactCommit: () => undefined,
    onArtifactError: () => undefined,
  })
  parser.push('one')
  parser.finish()
  parser.reset()
  parser.push('two')
  parser.finish()
  assert.equal(text, 'onetwo')
})

test('all character split points are semantically equivalent', () => {
  const expected = parse([complete])
  for (let split = 0; split <= complete.length; split += 1) {
    assert.deepEqual(parse([complete.slice(0, split), complete.slice(split)]), expected)
  }
})

test('seeded random chunking is semantically equivalent', () => {
  const response = `说明\n${opening}${'<section>中文 & symbols \\</artifact></section>'.repeat(30)}</artifact>\n完成`
  const expected = parse([response])
  let seed = 0x12345678
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0x100000000
  }

  for (let run = 0; run < 100; run += 1) {
    const chunks: string[] = []
    let offset = 0
    while (offset < response.length) {
      const size = 1 + Math.floor(random() * 17)
      chunks.push(response.slice(offset, offset + size))
      offset += size
    }
    assert.deepEqual(parse(chunks), expected)
  }
})

test('streaming TextDecoder preserves UTF-8 split across every byte boundary', () => {
  const bytes = new TextEncoder().encode(complete)
  const expected = parse([complete])

  for (let split = 0; split <= bytes.length; split += 1) {
    const result: Result = { text: '', artifacts: [], errors: [] }
    const byId = new Map<string, Result['artifacts'][number]>()
    const parser = new ArtifactStreamParser({
      onTextDelta: (delta) => { result.text += delta },
      onArtifactStart: ({ streamArtifactId, metadata }) => {
        const artifact = { metadata, deltas: '' }
        result.artifacts.push(artifact)
        byId.set(streamArtifactId, artifact)
      },
      onArtifactDelta: ({ streamArtifactId, delta }) => { byId.get(streamArtifactId)!.deltas += delta },
      onArtifactCommit: ({ streamArtifactId, content, byteLength, sha256 }) => {
        Object.assign(byId.get(streamArtifactId)!, { content, byteLength, sha256 })
      },
      onArtifactError: ({ code }) => { result.errors.push(code) },
    }, { createStreamArtifactId: () => 'stream-1' })
    const decoder = new ArtifactUtf8StreamDecoder(parser)
    decoder.push(bytes.slice(0, split))
    decoder.push(bytes.slice(split))
    decoder.finish()
    assert.deepEqual(result, expected)
  }
})
