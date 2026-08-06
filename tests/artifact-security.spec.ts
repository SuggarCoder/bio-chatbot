import { expect, test } from '@playwright/test'

type Harness = {
  buildHtmlSandboxDocument(content: string): string
  htmlArtifactSandbox: string
  sanitizeArtifactSvg(content: string): string
  sanitizeMermaidSvg(content: string): string
  renderStrictMermaid(content: string): Promise<string>
  mountMarkdownFixture(content: string): Promise<void>
  mountCommittedArtifactPanel(): Promise<void>
  mountSandboxCapabilityPanel(): Promise<void>
  mountSvgArtifactPanel(): Promise<void>
  mountMarkdownArtifactPanel(): Promise<void>
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
    const harness = (window as unknown as { artifactSecurity: Harness }).artifactSecurity
    window.addEventListener('message', (event) => resolve(event.data), { once: true })
    const iframe = document.createElement('iframe')
    iframe.sandbox.value = harness.htmlArtifactSandbox
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

test('HTML Artifact sandbox declares modal and form permissions and allows downloads', async ({ page }) => {
  await page.evaluate(() => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity
      .mountSandboxCapabilityPanel()
  ))
  const panel = page.getByRole('complementary', { name: 'Artifact panel' })
  const frame = panel.locator('iframe')
  await expect(frame).toHaveAttribute(
    'sandbox',
    'allow-scripts allow-modals allow-downloads allow-forms',
  )

  const downloadPromise = page.waitForEvent('download', { timeout: 5_000 })
  const downloadClick = frame.contentFrame()
    .locator('#artifact-download-fixture')
    .click({ noWaitAfter: true })
  const download = await downloadPromise
  await downloadClick
  expect(download.suggestedFilename()).toBe('artifact-download.txt')
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

test('SVG and Markdown Artifacts expose preview only', async ({ page }) => {
  await page.evaluate(() => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity
      .mountSvgArtifactPanel()
  ))
  let panel = page.getByRole('complementary', { name: 'Artifact panel' })
  await expect(panel.locator('img')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Preview' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Code', exact: true })).toHaveCount(0)

  await page.evaluate(() => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity
      .mountMarkdownArtifactPanel()
  ))
  panel = page.getByRole('complementary', { name: 'Artifact panel' })
  await expect(panel.getByRole('heading', { name: 'Markdown preview' })).toBeVisible()
  await expect(panel.getByText('Rich content')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Preview' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: 'Code', exact: true })).toHaveCount(0)
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
    const harness = (window as unknown as { artifactSecurity: Harness }).artifactSecurity
    const iframe = document.createElement('iframe')
    iframe.id = 'sandbox-security-frame'
    iframe.sandbox.value = harness.htmlArtifactSandbox
    iframe.srcdoc = value
    document.body.append(iframe)
  }, srcdoc)
  await page.locator('#sandbox-security-frame').contentFrame().getByRole('button').click()
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

test('standalone source files provide a safe Blob download without affecting snippets', async ({ page }) => {
  await page.evaluate(() => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity.mountMarkdownFixture(
      '```python filename=analysis.py\nprint("file")\n```\n\n```python\nprint("snippet")\n```',
    )
  ))

  const markdown = page.locator('#markdown-test-root')
  await expect(markdown.getByRole('note')).toHaveCount(1)
  await expect(markdown.getByRole('note')).toHaveText(/可下载或复制保存为 analysis\.py/)
  await expect(markdown.locator('.code-block-toolbar').first()).toContainText('analysis.py')
  await expect(markdown.getByRole('button', { name: '下载 analysis.py' })).toHaveCount(1)

  const downloadPromise = page.waitForEvent('download')
  await markdown.getByRole('button', { name: '下载 analysis.py' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('analysis.py')
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks).toString('utf8')).toBe('print("file")')
})

test('Mermaid renders inline with a source toggle and never opens the Artifact panel', async ({ page }) => {
  await page.evaluate(() => (
    (window as unknown as { artifactSecurity: Harness }).artifactSecurity.mountMarkdownFixture(
      '```mermaid\nflowchart LR\nA[Safe] --> B[Done]\n```',
    )
  ))

  const markdown = page.locator('#markdown-test-root')
  const mermaid = markdown.locator('.inline-mermaid')
  const diagram = mermaid.locator('svg')
  await expect(diagram).toBeVisible()
  await expect(diagram.locator('style')).toHaveCount(1)
  await expect(diagram.locator('foreignObject')).toHaveCount(0)
  const palette = await diagram.evaluate((svg) => {
    const node = svg.querySelector('.node rect, .node path, .node polygon')
    const label = svg.querySelector('.nodeLabel, .label text, text')
    return {
      nodeFill: node ? getComputedStyle(node).fill : null,
      labelFill: label ? getComputedStyle(label).fill : null,
    }
  })
  expect(palette.nodeFill).toBe('rgb(236, 253, 245)')
  expect(palette.labelFill).toBe('rgb(15, 23, 42)')
  await expect(page.getByRole('complementary', { name: 'Artifact panel' })).toHaveCount(0)
  await mermaid.getByRole('button', { name: 'Mermaid 源码' }).click()
  await expect(mermaid.locator('.code-block')).toContainText('flowchart LR')
  await expect(mermaid.getByRole('button', { name: 'Copy code' })).toBeVisible()
})

test('Mermaid strict mode keeps local theme styles and removes unsafe styles', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const harness = (window as unknown as { artifactSecurity: Harness }).artifactSecurity
    return {
      clean: await harness.renderStrictMermaid(
        'flowchart LR\nA[Safe] --> B[Done]',
        'security-mermaid',
      ),
      attacked: harness.sanitizeMermaidSvg(
        '<svg xmlns="http://www.w3.org/2000/svg"><style>.node{fill:url(https://evil.test/a.svg)}</style><script>alert(1)</script><rect style="fill:url(https://evil.test/a.svg)"/></svg>',
      ),
    }
  })
  expect(result.clean).toContain('<svg')
  expect(result.clean).toContain('<style')
  expect(result.clean).not.toMatch(/<script|foreignObject|javascript:/i)
  expect(result.attacked).not.toMatch(/<style|style=|<script|https:\/\/evil\.test/i)
})
