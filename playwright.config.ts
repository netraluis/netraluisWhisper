import { defineConfig } from '@playwright/test'

// E2E against the real Electron app (launched via _electron). Serial, single
// worker: one app instance, deterministic state.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 40000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
})
