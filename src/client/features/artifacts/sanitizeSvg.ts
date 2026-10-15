import DOMPurify from 'dompurify'

const unsafeCssPattern = /(?:@import|@namespace|expression\s*\(|javascript\s*:|vbscript\s*:|data\s*:|behavior\s*:|-moz-binding\s*:)/i

function hasUnsafeCssReference(value: string): boolean {
  if (unsafeCssPattern.test(value)) return true
  if (!/url\s*\(/i.test(value)) return false

  const references = value.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi)
  let foundReference = false
  for (const reference of references) {
    foundReference = true
    if (!reference[2].trim().startsWith('#')) return true
  }
  return !foundReference
}

function sanitizeSvg(source: string, preserveStyleElements: boolean): string {
  const clean = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      'script',
      'foreignObject',
      ...(preserveStyleElements ? [] : ['style']),
      'iframe',
      'object',
      'embed',
    ],
    FORBID_ATTR: ['style'],
  })
  const document = new DOMParser().parseFromString(String(clean), 'image/svg+xml')
  for (const style of document.querySelectorAll('style')) {
    if (!preserveStyleElements || hasUnsafeCssReference(style.textContent ?? '')) {
      style.remove()
    }
  }
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim()
      if (name.startsWith('on')) element.removeAttribute(attribute.name)
      if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) {
        element.removeAttribute(attribute.name)
      }
      if (hasUnsafeCssReference(value)) {
        element.removeAttribute(attribute.name)
      }
    }
  }
  return new XMLSerializer().serializeToString(document.documentElement)
}

export function sanitizeArtifactSvg(source: string): string {
  return sanitizeSvg(source, false)
}

export function sanitizeMermaidSvg(source: string): string {
  return sanitizeSvg(source, true)
}
