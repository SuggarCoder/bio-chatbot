import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'
import solidPlugin from 'vite-plugin-solid'

export default defineConfig({
  /*
   * 必须和 Nginx location 保持一致。
   */
  base: '/ai-chatbot/',

  /*
   * UnoCSS 必须放在 Solid 插件前面。
   */
  plugins: [
    UnoCSS(),
    solidPlugin(),
  ],

  build: {
    target: 'es2022',
    outDir: 'dist/client',
    emptyOutDir: true,
  },

  server: {
    port: 5173,
    strictPort: true,

    /*
     * 本地开发时：
     * 浏览器请求 /ai-chatbot/api/*
     * 转发到本地 Fastify 8090。
     */
    proxy: {
      '/ai-chatbot/api': {
        target: 'http://127.0.0.1:8090',
        changeOrigin: true,
      },
    },
  },
})