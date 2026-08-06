import { sanitizeMermaidSvg } from '../artifacts/sanitizeSvg'

const mermaidThemeVariables = {
  background: '#ffffff',
  primaryColor: '#ecfdf5',
  primaryTextColor: '#0f172a',
  primaryBorderColor: '#0f766e',
  secondaryColor: '#eff6ff',
  secondaryTextColor: '#0f172a',
  secondaryBorderColor: '#3b82f6',
  tertiaryColor: '#f8fafc',
  tertiaryTextColor: '#1e293b',
  tertiaryBorderColor: '#94a3b8',
  lineColor: '#64748b',
  textColor: '#0f172a',
  mainBkg: '#ecfdf5',
  nodeBorder: '#0f766e',
  clusterBkg: '#f8fafc',
  clusterBorder: '#cbd5e1',
  edgeLabelBackground: '#ffffff',
  noteBkgColor: '#fffbeb',
  noteTextColor: '#78350f',
  noteBorderColor: '#f59e0b',
  actorBkg: '#ecfeff',
  actorBorder: '#0f766e',
  actorTextColor: '#134e4a',
  actorLineColor: '#94a3b8',
  signalColor: '#475569',
  signalTextColor: '#334155',
  labelBoxBkgColor: '#f8fafc',
  labelBoxBorderColor: '#94a3b8',
  labelTextColor: '#0f172a',
  loopTextColor: '#334155',
  activationBkgColor: '#ccfbf1',
  activationBorderColor: '#0f766e',
} as const

let mermaidPromise: Promise<(typeof import('mermaid'))['default']> | undefined

function getMermaid() {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'base',
      darkMode: false,
      htmlLabels: false,
      fontFamily: 'Inter, "Noto Sans SC", "Microsoft YaHei", sans-serif',
      fontSize: 15,
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'suppressErrorRendering',
        'maxEdges',
        'theme',
        'themeVariables',
        'themeCSS',
        'darkMode',
        'htmlLabels',
        'fontFamily',
        'fontSize',
      ],
      themeVariables: mermaidThemeVariables,
      themeCSS: `
        text, .label, .nodeLabel, .edgeLabel {
          color: #0f172a;
          fill: #0f172a;
        }
        .edgeLabel rect {
          fill: #ffffff;
          opacity: 0.96;
        }
        .cluster rect {
          rx: 12px;
          ry: 12px;
        }
      `,
    })
    return mermaid
  })
  return mermaidPromise
}

export async function renderStrictMermaid(
  content: string,
  id = `chat-mermaid-${crypto.randomUUID()}`,
): Promise<string> {
  const mermaid = await getMermaid()
  const result = await mermaid.render(id, content)
  return sanitizeMermaidSvg(result.svg)
}
