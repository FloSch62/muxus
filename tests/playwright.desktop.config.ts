import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const testsDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: './desktop/specs',
  outputDir: './desktop/.results',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: path.join(testsDir, 'desktop-report') }]] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
});
