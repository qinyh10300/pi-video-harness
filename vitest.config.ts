import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const fromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@pi-video-harness/backend-comfyui": fromRoot(
        "./packages/backend-comfyui/src/index.ts",
      ),
      "@pi-video-harness/backend-fake": fromRoot(
        "./packages/backend-fake/src/index.ts",
      ),
      "@pi-video-harness/backend-openai-image": fromRoot(
        "./packages/backend-openai-image/src/index.ts",
      ),
      "@pi-video-harness/contracts": fromRoot(
        "./packages/contracts/src/index.ts",
      ),
      "@pi-video-harness/core": fromRoot("./packages/core/src/index.ts"),
      "@pi-video-harness/media": fromRoot("./packages/media/src/index.ts"),
      "@pi-video-harness/knowledge": fromRoot(
        "./packages/knowledge/src/index.ts",
      ),
      "@pi-video-harness/pipeline": fromRoot(
        "./packages/pipeline/src/index.ts",
      ),
    },
  },
  test: {
    coverage: {
      enabled: false,
    },
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "extensions/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
