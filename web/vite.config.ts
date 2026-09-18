import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Relative assets let the same embedded bundle run at both /admin/ and /portal/.
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
})
