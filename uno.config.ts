import {
    defineConfig,
    presetWind3,
    transformerVariantGroup,
  } from 'unocss'
  
  export default defineConfig({
    presets: [
      presetWind3(),
    ],
  
    transformers: [
      transformerVariantGroup(),
    ],
  
    shortcuts: {
      panel:
        'rounded-6 border border-slate-200 bg-white shadow-xl shadow-slate-900/5',
  
      'btn-primary':
        'inline-flex items-center justify-center rounded-3 bg-slate-950 px-4 py-2.5 text-sm font-600 text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50',
    },
  
    theme: {
      colors: {
        brand: '#4f46e5',
      },
    },
  })