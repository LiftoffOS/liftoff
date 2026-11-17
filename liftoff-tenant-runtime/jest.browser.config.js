// The real-Chromium project: what jsdom cannot show.
//
// A trusted click, a page that wraps the recorder's binding, an attach against
// a closed port, a browser killed mid-hold — these are behaviours of a real
// browser and a real CDP connection, and a mocked page proves nothing about
// them. So `*.browser.test.ts` runs against Chromium, driven over
// `connectOverCDP` exactly as the runtime drives a vendor's session. In CI the
// step runs in Playwright's own image at the version pinned to playwright-core
// (mcr.microsoft.com/playwright:v1.62.1-jammy); locally, `npx playwright
// install chromium` once, then `npm run test:browser`.
//
// Kept out of the unit project (jest.config.js ignores the suffix) because the
// unit project runs on node:20-slim with no browser.

const base = require('./jest.config.js');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  testMatch: ['<rootDir>/src/**/*.browser.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  // One browser at a time: the suites each own a Chromium process and a port.
  maxWorkers: 1,
  // A browser launch plus several navigations is seconds, not milliseconds.
  // The unit setup file pins 10 s with jest.setTimeout, so the suite sets its
  // own in a setup file that runs after it.
  testTimeout: 120_000,
  setupFilesAfterEnv: [...base.setupFilesAfterEnv, '<rootDir>/src/test-utils/browser-setup.ts'],
};
