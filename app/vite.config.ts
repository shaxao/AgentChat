import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('katex')) return 'vendor-katex'
          if (id.includes('react') || id.includes('react-dom') || id.includes('scheduler')) return 'vendor-react'
          if (id.includes('lucide-react')) return 'vendor-icons'
          if (id.includes('recharts') || id.includes('d3-')) return 'vendor-charts'
          if (id.includes('marked') || id.includes('dompurify')) return 'vendor-markdown'
          return undefined
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      // 台账文件 API 代理 → Spring Boot 后端（优先级高于通配 /api）
      '/api/v1/ledger': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      // Spring Boot 后端 API 代理（chat、agent 等核心接口）
      '/api/chat': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/api/v1': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      // AutoCode Agent Platform API 代理（开发环境）
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      // AutoCode 前端代理
      '/tasks': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
