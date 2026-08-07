/// <reference types="node" />

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createQuestionAnchorLabel,
  findActiveConversationAnchor,
  getConversationAnchorPosition,
  normalizeQuestionAnchorText,
  shouldShowConversationAnchors,
} from './conversationAnchors'

test('question anchor labels normalize whitespace and keep 18 Unicode characters', () => {
  assert.equal(
    normalizeQuestionAnchorText('  第一行\n\n第二行   最后  '),
    '第一行 第二行 最后',
  )
  assert.equal(
    createQuestionAnchorLabel('一二三四五六七八九十一二三四五六七八九十'),
    '一二三四五六七八九十一二三四五六七八…',
  )
  assert.equal(
    createQuestionAnchorLabel('😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀'),
    '😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀…',
  )
})

test('conversation anchors only appear for long conversations with multiple questions', () => {
  assert.equal(shouldShowConversationAnchors(1201, 600, 2), true)
  assert.equal(shouldShowConversationAnchors(1200, 600, 2), false)
  assert.equal(shouldShowConversationAnchors(1600, 600, 1), false)
  assert.equal(shouldShowConversationAnchors(1600, 0, 4), false)
})

test('anchor positions are proportional and clamped to the scroll track', () => {
  assert.equal(getConversationAnchorPosition(250, 1000), 0.25)
  assert.equal(getConversationAnchorPosition(-20, 1000), 0)
  assert.equal(getConversationAnchorPosition(1200, 1000), 1)
  assert.equal(getConversationAnchorPosition(10, 0), 0)
})

test('active anchor follows the last question above the reading offset', () => {
  const anchors = [
    { id: 'first', top: 0 },
    { id: 'second', top: 300 },
    { id: 'third', top: 700 },
  ]

  assert.equal(findActiveConversationAnchor(anchors, 0), 'first')
  assert.equal(findActiveConversationAnchor(anchors, 285), 'second')
  assert.equal(findActiveConversationAnchor(anchors, 680), 'second')
  assert.equal(findActiveConversationAnchor(anchors, 684), 'third')
  assert.equal(findActiveConversationAnchor([], 0), undefined)
})
