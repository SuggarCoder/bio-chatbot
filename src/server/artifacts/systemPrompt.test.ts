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
  assert.match(prompt, /Preserve real source newlines and indentation/i)
  assert.match(prompt, /Artifact bodies[\s\S]*must never be wrapped in Markdown fences/i)
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

test('Artifact prompt requires structured source formatting', () => {
  const prompt = buildArtifactSystemPrompt([])

  assert.match(prompt, /Artifact source formatting:/)
  assert.match(prompt, /actual newline and indentation characters/i)
  assert.match(prompt, /human-readable, multiline source/i)
  assert.match(prompt, /Do not minify or collapse the source onto one line/i)
  assert.match(prompt, /<html lang="en">\n  <head>\n    <meta charset="utf-8">/)
  assert.match(
    prompt,
    /application\/vnd\.artifact\.code[\s\S]*always include a lowercase language\s+attribute/i,
  )
  assert.match(
    prompt,
    /text\/markdown Artifact[\s\S]*Fenced code blocks[\s\S]*preserve the source's real indentation and lines/i,
  )
})

test('Artifact protocol stays within its static prompt budget', () => {
  const prompt = buildArtifactSystemPrompt([])

  assert.ok(Buffer.byteLength(prompt, 'utf8') <= 2_800)
})
