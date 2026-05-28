import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages serves this project at https://miffycs.github.io/ui-watercolor-reveal/
// so the production bundle has to use that path as its base. Local dev keeps `/`.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/ui-watercolor-reveal/' : '/',
  server: {
    host: true,
    port: 5173,
  },
}))
