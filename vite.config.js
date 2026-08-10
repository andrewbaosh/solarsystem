import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
  // GitHub Pages 是项目页，站点挂在 /solarsystem/ 下；本地 dev 仍然用根路径。
  // 贴图路径走 import.meta.env.BASE_URL，会自动跟着这里变。
  base: mode === 'production' ? '/solarsystem/' : '/',
  server: {
    host: '127.0.0.1',
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
  },
  build: {
    target: 'es2022',
  },
}))
