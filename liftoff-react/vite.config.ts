import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import svgr from 'vite-plugin-svgr'
// @ts-expect-error — package ships without TS types



export default defineConfig({
  resolve: {
    // One copy of React, wherever it happens to live.
    //
    // This used to be an alias to path.resolve('./node_modules/react'), which
    // says the same thing while also asserting WHERE react is. That holds when
    // this repo is installed on its own and fails the moment it is a member of
    // a workspace: npm hoists react to the root, ./node_modules/react does not
    // exist, and the build dies on `Could not load .../node_modules/react/jsx-runtime`
    // after transforming eleven modules.
    //
    // `dedupe` is the first-class option for the thing the alias was actually
    // for — never bundle two Reacts — and it resolves the package rather than
    // naming a directory.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    proxy: {
      // Mirrors the nginx vanity route: the MCP setup page shows
      // <origin>/SKILL.md, so make it resolve on localhost too, with the
      // original /agent-setup.md address beside it.
      // No fallback host. The dev server proxies these only when VITE_API_URL
      // says where to; defaulting to somebody else's API is worse than a 502.
      '/SKILL.md': {
        target: process.env.VITE_API_URL || 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
      '/agent-setup.md': {
        target: process.env.VITE_API_URL || 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Emitted so scripts/verify/css-closure.mjs can check the per-route CSS
    // closure; that script deletes the manifest afterwards, so it is never
    // shipped or counted against the bundle-size budget.
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/') || id.includes('/node_modules/scheduler/')) return 'vendor-react'
          if (id.includes('/node_modules/firebase/') || id.includes('/node_modules/@firebase/')) {
            // Messaging is excluded so its dynamic import in lib/pushNotifications
            // actually splits. Folding it into vendor-firebase put it behind a
            // modulepreload in index.html, so every first paint downloaded the
            // FCM client whether or not the person ever enables notifications.
            // Auth and Remote Config stay: both are needed before anything renders.
            if (id.includes('/messaging')) return
            return 'vendor-firebase'
          }
        },
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    svgr(),
    // No prerender step: this build is an application behind a sign-in, so
    // there is nothing for a crawler or link unfurler to render.
  ],
})
