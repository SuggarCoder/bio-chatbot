export type ConversationAnchorOffset = {
  id: string
  top: number
}

export function normalizeQuestionAnchorText(content: string) {
  return content.trim().replace(/\s+/gu, ' ')
}

export function createQuestionAnchorLabel(content: string, limit = 18) {
  const normalized = normalizeQuestionAnchorText(content)
  const characters = Array.from(normalized)

  if (characters.length <= limit) {
    return normalized
  }

  return `${characters.slice(0, limit).join('')}…`
}

export function shouldShowConversationAnchors(
  scrollHeight: number,
  clientHeight: number,
  questionCount: number,
) {
  return (
    clientHeight > 0 &&
    questionCount >= 2 &&
    scrollHeight > clientHeight * 2
  )
}

export function getConversationAnchorPosition(
  top: number,
  maxScrollTop: number,
) {
  if (maxScrollTop <= 0) {
    return 0
  }

  return Math.min(Math.max(top / maxScrollTop, 0), 1)
}

export function findActiveConversationAnchor(
  anchors: ConversationAnchorOffset[],
  scrollTop: number,
  topOffset = 16,
) {
  if (anchors.length === 0) {
    return undefined
  }

  const probe = scrollTop + topOffset
  let activeId = anchors[0].id

  for (const anchor of anchors) {
    if (anchor.top > probe) {
      break
    }

    activeId = anchor.id
  }

  return activeId
}
