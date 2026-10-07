import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  createPairingSession,
  extractBaseId,
  pairingBlockers,
  readFirstLines,
  screenFiles,
  type LineReader,
  type PairingResult,
} from './fastqPairing'

const fastq = (ids: string[], end: 1 | 2 | null) =>
  ids.map(id => `@${id}${end ? ` ${end}:N:0:ACGT` : ''}\nACGT\n+\nIIII\n`).join('')
const file = (name: string, content: string, lastModified = 1) => new File([content], name, { lastModified })
const ids = (prefix: string, count = 12) => Array.from({ length: count }, (_, index) => `${prefix}:${index}`)

const detect = (files: File[], reader: LineReader = readFirstLines) => createPairingSession(reader).detect(files)
const byName = (results: PairingResult<File>[]) => Object.fromEntries(results.map(result => [result.file.name, result]))

test('name-gated pair confirmed by shared read IDs', async () => {
  const shared = ids('A00')
  const results = byName(await detect([file('s_R2.fq', fastq(shared, 2)), file('s_R1.fq', fastq(shared, 1))]))
  assert.equal(results['s_R1.fq'].status, 'paired')
  assert.equal(results['s_R1.fq'].readType, 1)
  assert.equal(results['s_R2.fq'].readType, 2)
  assert.equal(results['s_R1.fq'].pairGroupId, results['s_R2.fq'].pairGroupId)
})

test('names that differ only by sample number are not paired when read IDs differ', async () => {
  const results = byName(await detect([file('sample1.fq', fastq(ids('X'), null)), file('sample2.fq', fastq(ids('Y'), null))]))
  assert.equal(results['sample1.fq'].status, 'single')
  assert.equal(results['sample2.fq'].status, 'single')
  assert.equal(results['sample1.fq'].pairGroupId, null)
})

test('two files both marked R1 never pair by name', async () => {
  const results = byName(await detect([file('s1_R1_x.fq', fastq(ids('P'), 1)), file('s2_R1_x.fq', fastq(ids('Q'), 1))]))
  assert.equal(results['s1_R1_x.fq'].status, 'single')
  assert.equal(results['s1_R1_x.fq'].maybeR1, true)
})

test('pool A pair whose headers claim the same end is broken even with shared IDs', async () => {
  const shared = ids('S')
  const results = byName(await detect([file('a_1.fq', fastq(shared, 1)), file('a_2.fq', fastq(shared, 1))]))
  assert.equal(results['a_1.fq'].status, 'single')
  assert.equal(results['a_2.fq'].status, 'single')
})

test('content pairing with irregular names is flagged as an invalid dual name', async () => {
  const shared = ids('C')
  const results = byName(await detect([file('left_R1.fq', fastq(shared, 1)), file('right_reads_R2.fq', fastq(shared, 2))]))
  assert.equal(results['left_R1.fq'].status, 'invalid_dual_name')
  assert.equal(results['right_reads_R2.fq'].status, 'invalid_dual_name')
})

test('unreadable files without valid pair names are not paired by order', async () => {
  const failing: LineReader = async () => { throw new Error('unreadable') }
  const results = byName(await detect([file('x_R1.fq', 'a'), file('y_R2.fq', 'b')], failing))
  assert.equal(results['x_R1.fq'].status, 'single')
  assert.equal(results['x_R1.fq'].maybeR1, true)
  assert.equal(results['y_R2.fq'].status, 'unpaired_dual')
})

test('unreadable files keep a valid name pairing', async () => {
  const failing: LineReader = async () => { throw new Error('DecompressionStream unsupported') }
  const results = byName(await detect([file('z_R1.fq.gz', 'a'), file('z_R2.fq.gz', 'b')], failing))
  assert.equal(results['z_R1.fq.gz'].status, 'paired')
})

test('invalid characters block single files', async () => {
  const results = byName(await detect([file('bad name.fq', fastq(ids('N'), null))]))
  assert.equal(results['bad name.fq'].status, 'invalid_single_name')
  assert.ok(pairingBlockers(Object.values(results), new Set()).length > 0)
})

test('incremental detection only reads new files and matches a one-shot selection', async () => {
  const shared = ids('I')
  const r1 = file('inc_R1.fq', fastq(shared, 1))
  const r2 = file('inc_R2.fq', fastq(shared, 2))
  const reads: string[] = []
  const counting: LineReader = (target, max) => { reads.push(target.name); return readFirstLines(target, max) }
  const session = createPairingSession(counting)
  const first = await session.detect([r1])
  assert.equal(first[0].status, 'single')
  assert.equal(first[0].maybeR1, true)
  const incremental = await session.detect([r1, r2])
  assert.deepEqual(reads, ['inc_R1.fq', 'inc_R2.fq'])
  const oneShot = await detect([r1, r2])
  assert.deepEqual(incremental.map(r => [r.file.name, r.status, r.readType]), oneShot.map(r => [r.file.name, r.status, r.readType]))
})

test('maybe-R1 files block until confirmed as single', async () => {
  const results = await detect([file('lonely_R1.fq', fastq(ids('L'), 1))])
  assert.ok(pairingBlockers(results, new Set()).some(message => message.includes('疑似双端')))
  assert.deepEqual(pairingBlockers(results, new Set([results[0].file])), [])
})

test('screening enforces the batch limit, extensions, empties and name uniqueness', () => {
  const existing = Array.from({ length: 9 }, (_, index) => file(`f${index}.fq`, 'x'))
  const ok = screenFiles(existing, [file('new.fastq.gz', 'x')])
  assert.equal(ok.accepted.length, 1)
  const over = screenFiles(existing, [file('a.fq', 'x'), file('b.fq', 'x')])
  assert.equal(over.overLimit, true)
  assert.equal(over.accepted.length, 0)

  const screened = screenFiles([existing[0]], [
    existing[0],                      // exact duplicate: skipped silently
    file('f0.fq', 'different size'),  // same name, other file
    file('notes.txt', 'x'),
    file('empty.fq', ''),
  ])
  assert.equal(screened.accepted.length, 0)
  assert.equal(screened.rejected.length, 3)
})

test('gzip input is streamed and decoded', async () => {
  const content = gzipSync(Buffer.from(fastq(ids('G', 50), 2)))
  const lines = await readFirstLines(new File([content], 'g_R2.fq.gz'), 8)
  assert.equal(lines.length, 8)
  assert.equal(lines[0], '@G:0 2:N:0:ACGT')
})

test('header formats', () => {
  assert.deepEqual(extractBaseId('@EAS139:136:FC706VJ:2:5:1000/1'), { baseId: 'EAS139:136:FC706VJ:2:5:1000', readType: 1 })
  assert.deepEqual(extractBaseId('@SEQ_ID 2:N:0:ATCACG'), { baseId: 'SEQ_ID', readType: 2 })
  assert.deepEqual(extractBaseId('@SRR001 length=36'), { baseId: 'SRR001', readType: null })
  assert.equal(extractBaseId('ACGT'), null)
})
