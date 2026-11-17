/**
 * Lighthouse CI config — runs against the static build in dist/.
 *
 * Thresholds are enforced as warnings.
 */
module.exports = {
  ci: {
    collect: {
      // Serve dist/ statically. The plugin spawns this and tears it down after.
      staticDistDir: './dist',
      // The app shell, which every route loads first.
      url: [
        'http://localhost/',
      ],
      numberOfRuns: 1,
      settings: {
        preset: 'desktop',
      },
    },
    assert: {
      assertions: {
        'categories:performance': ['warn', { minScore: 0.85 }],
        'categories:accessibility': ['warn', { minScore: 0.9 }],
        'categories:best-practices': ['warn', { minScore: 0.9 }],
        'categories:seo': ['warn', { minScore: 0.9 }],
      },
    },
    upload: {
      // Store reports as workflow artifacts; no external server.
      target: 'temporary-public-storage',
    },
  },
}
