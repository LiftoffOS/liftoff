// Runs after the unit setup for the real-Chromium project (jest.browser
// .config.js). That setup pins a 10 s timeout for unit tests; a browser
// launch, a navigation and a lease timeout are seconds each, so this project
// takes two minutes.
jest.setTimeout(120_000);
