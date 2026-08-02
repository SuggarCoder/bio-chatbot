import { expect, test } from '@playwright/test'

type Harness = {
  buildHtmlSandboxDocument(content: string): string
  sanitizeArtifactSvg(content: string): string
  renderStrictMermaid(content: string): Promise<string>
  renderMarkdown(content: string): string
}

test.beforeEach(async ({ page }) => {
  await page.goto('/ai-chatbot/artifact-security.html')
  await page.waitForFunction(() => 'artifactSecurity' in window)
})

test('HTML runs in an opaque sandbox and cannot read host DOM or cookie', async ({ page }) => {
  await page.context().addCookies([{
    name: 'host-secret',
    value: 'private',
    domain: '127.0.0.1',
    path: '/',
  }])
  const document = await page.evaluate((content) => {
    const harness = (window as unknown as { artifactSecurity: Harness }).artifactSecurity
    return harness.buildHtmlSandboxDocument(content)
  }, `<script>
    let result = { cookie: null, parent: null }
    try { result.cookie = document.cookie } catch (error) { result.cookie = 'blocked' }
    try { result.parent = parent.document.querySelector('#host-secret').textContent } catch (error) { result.parent = 'blocked' }
    parent.postMessage(result, '*')
  <\/script>`)

  const result = await page.evaluate((srcdoc) => new Promise<{ cookie: string; parent: string }>((resolve) => {
    window.addEventListener('message', (event) => resolve(event.data), { once: true })
    const iframe = document.createElement('iframe')
    iframe.sandbox.add('allow-scripts')
    iframe.referrerPolicy = 'no-referrer'
    iframe.srcdoc = srcdoc
    document.body.append(iframe)
  }), document)
  expect(['', 'blocked']).toContain(result.cookie)
  expect(result.parent).toBe('blocked')
})

test('HTML CSP blocks network and sandbox blocks top navigation', async ({ page }) => {
  const responses: string[] = []
  page.on('response', (response) => responses.push(response.url()))
  const before = page.url()
  const srcdoc = await page.evaluate((content) => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity
      .buildHtmlSandboxDocument(content)
  ), `<img src="https://example.invalid/leak"><form action="https://example.invalid/form"><button>go</button></form><script>try { top.location='https://example.invalid/nav' } catch {}</script>`)
  await page.evaluate((value) => {
    const iframe = document.createElement('iframe')
    iframe.sandbox.add('allow-scripts')
    iframe.srcdoc = value
    document.body.append(iframe)
  }, srcdoc)
  await page.waitForTimeout(300)
  expect(page.url()).toBe(before)
  expect(responses.some((url) => url.includes('example.invalid'))).toBe(false)
})

test('SVG sanitizer removes active content and external resources', async ({ page }) => {
  const clean = await page.evaluate(() => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity.sanitizeArtifactSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject>x</foreignObject><use href="https://evil.test/a.svg#x"/><image href="javascript:alert(1)"/><rect style="fill:url(https://evil.test/x)"/></svg>',
    )
  ))
  expect(clean).not.toMatch(/script|foreignObject|onload|javascript:|evil\.test|style=/i)
})

test('Markdown blocks raw HTML, JavaScript URLs, and remote images', async ({ page }) => {
  const clean = await page.evaluate(() => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity.renderMarkdown(
      '<script>alert(1)</script>\n\n[safe](https://example.com) [bad](javascript:alert(1)) ![remote](https://example.com/a.png)',
    )
  ))
  expect(clean).toContain('rel="noopener noreferrer"')
  expect(clean).toContain('target="_blank"')
  expect(clean).not.toMatch(/<script|javascript:|<img/i)
})

test('Mermaid strict mode output is sanitized', async ({ page }) => {
  const clean = await page.evaluate(async () => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity
      .renderStrictMermaid('flowchart LR\nA[Safe] --> B[Done]', 'security-mermaid')
  ))
  expect(clean).toContain('<svg')
  expect(clean).not.toMatch(/<script|foreignObject|javascript:/i)
})
