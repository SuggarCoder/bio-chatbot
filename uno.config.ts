import { defineConfig, presetWind4 } from 'unocss'
import presetIcons from '@unocss/preset-icons'

export default defineConfig({
  presets: [
    presetWind4(),
    presetIcons({
      extraProperties: {
        display: 'inline-block',
        'vertical-align': 'middle',
      },
    }),
  ],
  safelist: [
    'i-lucide:user',
    'i-lucide:lock-keyhole',
  ],
  rules: [
    // 将复杂的静态背景和变量提取为预定义的原子类
    ['bg-glow-pattern', {
      '--glow-a-size': '20%',
      '--glow-b-size': '22%',
      '--glow-c-size': '20%',
      'background-image': 'radial-gradient(circle at 17% 84%, rgba(188,232,240,0.9), transparent var(--glow-a-size)), radial-gradient(circle at 82% 10%, rgba(214,237,242,0.88), transparent var(--glow-b-size)), radial-gradient(circle at 92% 92%, rgba(229,242,245,0.72), transparent var(--glow-c-size)), linear-gradient(180deg, #f8f8f7 0%, #f3f5f4 100%)'
    }],
  ]
})
