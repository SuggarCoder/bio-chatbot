import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyArtifactPatch,
  ArtifactPatchError,
  createPatchedArtifactDraft,
  parseArtifactPatch,
} from './patch.js'

const lines = Array.from({ length: 16 }, (_, index) => `line ${index + 1}`)
const content = `${lines.join('\n')}\n`
const search = lines.slice(2, 12).join('\n')
const output = [
  '<artifact_edit id="report">',
  '<<<<<<< SEARCH',
  search,
  '=======',
  search.replace('line 7', 'line seven'),
  '>>>>>>> REPLACE',
  '</artifact_edit>',
].join('\n')

test('applies an exact unique SEARCH/REPLACE patch', () => {
  const hunks = parseArtifactPatch(output, 'report')
  const patched = applyArtifactPatch(content, hunks, 'text/markdown')
  assert.ok(patched.includes('line seven'))
  assert.ok(!patched.includes('\nline 7\n'))

  const draft = createPatchedArtifactDraft({
    output,
    logicalId: 'report',
    title: 'Report',
    type: 'text/markdown',
    baseVersion: 3,
    content,
  })
  assert.equal(draft.metadata.op, 'replace')
  assert.equal(draft.metadata.base_version, 3)
  assert.equal(draft.byteLength, Buffer.byteLength(draft.content, 'utf8'))
  assert.match(draft.sha256, /^[a-f0-9]{64}$/)
})

test('rejects SEARCH text that is not unique', () => {
  assert.throws(
    () => applyArtifactPatch(`${content}${content}`, parseArtifactPatch(
      output,
      'report',
    ), 'text/markdown'),
    (error) => error instanceof ArtifactPatchError &&
      error.code === 'PATCH_SEARCH_NOT_UNIQUE',
  )
})

test('rejects a patch for another logical id', () => {
  assert.throws(
    () => parseArtifactPatch(output, 'dashboard'),
    (error) => error instanceof ArtifactPatchError &&
      error.code === 'PATCH_WRONG_ARTIFACT',
  )
})
