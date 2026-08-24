import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src/renderer/src') }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // Playwright owns e2e/; vitest must not pick those specs up.
    exclude: ['e2e/**', 'node_modules/**'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      // Vitest 4 replaced `all: true` with an explicit include list. Every
      // source file in this risk-focused baseline is included even if no test
      // imports it.
      include: [
        'src/main/cache.ts',
        'src/main/downloads.ts',
        'src/main/integration-tasks.ts',
        'src/main/notifications.ts',
        'src/main/settings-transfer.ts',
        'src/main/telemetry.ts',
        'src/main/star-reminder.ts',
        'src/main/integrations/{upload,export}.ts',
        'src/main/workers/{cache-worker,download-worker}.ts',
        'src/renderer/src/lib/{csv,diff,editor,errors,file-kinds,gguf,history,hub-urls,notebook,onnx,parquet,query,quote,syntax-highlighting,tag-colors,utils}.ts'
      ],
      exclude: ['src/**/*.test*'],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 65,
        branches: 60,
        autoUpdate: false
      }
    }
  }
})
