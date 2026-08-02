import { expect, test } from '@playwright/test'

type Harness = {
  buildHtmlSandboxDocument(content: string): string
  sanitizeArtifactSvg(content: string): string
  renderStrictMermaid(content: string): Promise<string>
  mountMarkdownFixture(content: string): Promise<void>
  mountCommittedArtifactPanel(): Promise<void>
  switchArtifactPanelConversation(): Promise<{
    isPanelOpen: boolean
    activeArtifactId: string | null
    activeVersion: number | null
  }>
  mountArtifactPair(): Promise<void>
  openSecondArtifactPanel(): Promise<void>
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

test('committed Artifact panel enters the viewport with its renderer content', async ({ page }) => {
  await page.evaluate(() => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity
      .mountCommittedArtifactPanel()
  ))
  const panel = page.getByRole('complementary', { name: 'Artifact panel' })
  await expect(panel).toBeVisible()
  const panelBox = await panel.boundingBox()
  const viewport = page.viewportSize()
  expect(panelBox).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(panelBox!.x).toBeGreaterThanOrEqual(0)
  expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(viewport!.width + 1)
  const frame = panel.locator('iframe')
  await expect(frame).toHaveAttribute('srcdoc', /panel-test-content/)

  const switched = await page.evaluate(() => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity
      .switchArtifactPanelConversation()
  ))
  await expect(panel).toHaveCount(0)
  expect(switched).toEqual({
    isPanelOpen: false,
    activeArtifactId: null,
    activeVersion: null,
  })
})

test('Artifact panel divider resizes the panel with pointer and keyboard input', async ({ page }) => {
  await page.evaluate(() => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity
      .mountCommittedArtifactPanel()
  ))
  const panel = page.getByRole('complementary', { name: 'Artifact panel' })
  const divider = page.getByRole('separator', { name: 'Resize Artifact panel' })
  await expect(divider).toBeVisible()

  const initialPanelBox = await panel.boundingBox()
  const dividerBox = await divider.boundingBox()
  expect(initialPanelBox).not.toBeNull()
  expect(dividerBox).not.toBeNull()

  await page.mouse.move(
    dividerBox!.x + dividerBox!.width / 2,
    dividerBox!.y + dividerBox!.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(dividerBox!.x - 80, dividerBox!.y + dividerBox!.height / 2)
  await page.mouse.up()

  await expect.poll(async () => (await panel.boundingBox())?.width).toBeGreaterThan(
    initialPanelBox!.width + 60,
  )
  const pointerWidth = (await panel.boundingBox())!.width
  await divider.focus()
  await divider.press('ArrowRight')
  await expect.poll(async () => (await panel.boundingBox())?.width).toBeLessThan(
    pointerWidth,
  )
})

test('Artifact panel uses the glass toolbar and keeps download unavailable', async ({ page }) => {
  await page.evaluate(() => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity
      .mountCommittedArtifactPanel()
  ))
  const panel = page.getByRole('complementary', { name: 'Artifact panel' })
  const toolbar = panel.locator('nav')
  const preview = page.getByRole('button', { name: 'Preview' })
  const code = page.getByRole('button', { name: 'Code', exact: true })

  await expect(panel.locator('header')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'History' })).toHaveCount(0)
  await expect(preview).toHaveAttribute('aria-pressed', 'true')
  await expect(toolbar.getByText('Panel test')).toBeVisible()
  await expect(toolbar.getByText('Version 1')).toBeVisible()
  await preview.hover()
  await expect(page.getByRole('tooltip').filter({ hasText: 'Preview' })).toBeVisible()
  await preview.click()
  await expect(page.getByRole('tooltip').filter({ hasText: 'Preview' })).toHaveCount(0)
  await page.mouse.move(0, 0)
  await preview.evaluate((element) => element.blur())
  await preview.focus()
  await expect(page.getByRole('tooltip').filter({ hasText: 'Preview' })).toBeVisible()
  await preview.evaluate((element) => element.blur())
  await code.hover()
  await expect(page.getByRole('tooltip').filter({ hasText: 'Preview' })).toHaveCount(0)
  await expect(page.getByRole('tooltip').filter({ hasText: 'Code' })).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(page.getByRole('tooltip').filter({ hasText: 'Code' })).toHaveCount(0)

  await code.click()
  await expect(code).toHaveAttribute('aria-pressed', 'true')
  const sourceView = panel.locator('.artifact-source-view')
  await expect(sourceView).toContainText('panel-test-content')
  await expect(panel.locator('[data-line-number]')).toHaveCount(2)
  await expect(panel.locator('[data-line-number]').nth(0)).toHaveText('1')
  await expect(panel.locator('[data-line-number]').nth(1)).toHaveText('2')
  await expect(sourceView.locator('.code-block')).toHaveAttribute('data-highlighted', 'true')
  await expect(sourceView.locator('.code-block')).toHaveAttribute('data-wrap', 'true')
  await preview.click()
  await expect(panel.locator('iframe')).toBeVisible()

  const beforeDownload = page.url()
  await page.getByRole('button', { name: 'Download Artifact' }).click()
  await expect(page.getByRole('status')).toHaveText('下载功能暂未开放')
  expect(page.url()).toBe(beforeDownload)
  await expect(toolbar).toHaveCSS('backdrop-filter', /blur/)
})

test('opening Artifact B after closing A code view mounts B preview only', async ({ page }) => {
  await page.evaluate(() => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity
      .mountArtifactPair()
  ))
  let panel = page.getByRole('complementary', { name: 'Artifact panel' })
  await page.getByRole('button', { name: 'Code' }).click()
  await expect(panel.locator('.artifact-source-view')).toBeVisible()
  await expect(panel.locator('.artifact-source-view')).toContainText('artifact-a-preview')

  await page.getByRole('button', { name: 'Close Artifact panel' }).click()
  await expect(panel).toHaveCount(0)
  await page.evaluate(() => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity
      .openSecondArtifactPanel()
  ))

  panel = page.getByRole('complementary', { name: 'Artifact panel' })
  await expect(page.getByRole('button', { name: 'Preview' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(panel.locator('.artifact-source-view')).toHaveCount(0)
  const frame = panel.locator('iframe')
  await expect(frame).toBeVisible()
  await expect(frame).toHaveAttribute('srcdoc', /artifact-b-preview/)
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

test('Markdown code uses Shiki, preserves lines, and blocks active content', async ({ page }) => {
  await page.evaluate(() => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity.mountMarkdownFixture(
      '<script>window.markdownExecuted = true</script>\n\n[safe](https://example.com) [bad](javascript:alert(1)) ![remote](https://example.com/a.png)\n\n```python\ndef main():\n    print("ok")\n\nmain()\n```',
    )
  ))

  const markdown = page.locator('#markdown-test-root')
  await expect(markdown.locator('script')).toHaveCount(0)
  await expect(markdown.locator('img')).toHaveCount(0)
  await expect(markdown.locator('a').filter({ hasText: 'safe' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  )
  await expect(markdown).toContainText('bad')
  await expect(markdown.locator('a[href^="javascript:"]')).toHaveCount(0)
  await expect(markdown.locator('.code-block')).toHaveAttribute('data-highlighted', 'true')
  await expect(markdown.locator('.code-block')).toHaveAttribute('data-wrap', 'true')
  await expect(markdown.locator('[data-line-number]')).toHaveCount(4)
  await expect(markdown.locator('.code-block-line-content').nth(1)).toHaveText('    print("ok")')
  expect(await page.evaluate(() => 'markdownExecuted' in window)).toBe(false)
})

test('Mermaid strict mode output is sanitized', async ({ page }) => {
  const clean = await page.evaluate(async () => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity
      .renderStrictMermaid('flowchart LR\nA[Safe] --> B[Done]', 'security-mermaid')
  ))
  expect(clean).toContain('<svg')
  expect(clean).not.toMatch(/<script|foreignObject|javascript:/i)
})
