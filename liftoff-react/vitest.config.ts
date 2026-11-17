import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import svgr from 'vite-plugin-svgr'

export default defineConfig({
  plugins: [react(), svgr()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    // jsdom + MSW component tests legitimately take ~1s each; under a full
    // parallel run on a loaded machine the slowest (ContactPage form flows)
    // starve past vitest's tight 5s default and flake. 15s matches the
    // spirit of the backend's 10s jest budget — a ceiling for stragglers,
    // not a target.
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test/',
      ],
    },
  },
})
