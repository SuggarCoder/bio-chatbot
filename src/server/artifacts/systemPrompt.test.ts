import assert from 'node:assert/strict'
import test from 'node:test'
import { buildArtifactSystemPrompt } from './systemPrompt.js'

test('Artifact prompt supplies exact current identity and complete snapshot', () => {
  const prompt = buildArtifactSystemPrompt([{
    logicalId: 'dashboard',
    version: 3,
    type: 'text/html',
    title: '数据看板',
    content: '<h1>current</h1>',
  }])
  assert.match(prompt, /id="dashboard" version=3/)
  assert.match(prompt, /"<h1>current<\/h1>"/)
  assert.match(prompt, /never an Artifact function\/tool call/i)
})

test('Artifact prompt forbids replace when complete content is unavailable', () => {
  const prompt = buildArtifactSystemPrompt([{
    logicalId: 'large',
    version: 7,
    type: 'text/plain',
    title: 'Large',
    content: null,
  }])
  assert.match(prompt, /Do not replace it/)
})

