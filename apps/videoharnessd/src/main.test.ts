import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadServiceConfig } from "./config.js";
import {
  createAppDependencies,
  DependencyCompositionError,
  startupErrorMessage,
  startupSummary,
} from "./main.js";

describe("default application composition", () => {
  it("starts the offline fake service while external adapters remain disabled", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "videoharnessd-main-"));
    const config = loadServiceConfig(
      {
        OPENAI_API_KEY: "present-but-must-not-be-used",
        VIDEOHARNESS_ENABLE_CLOUD_IMAGE: "false",
      },
      directory,
    );
    const dependencies = await createAppDependencies(config);

    try {
      const health = await dependencies.service.health({
        requestId: "request-1",
        signal: new AbortController().signal,
      });
      expect(health.status).toBe("ok");
      expect(health.checks["fake-image"]?.status).toBe("ok");
      expect(health.checks["openai-image"]?.status).toBe("not_configured");
      expect(JSON.stringify(health)).not.toContain(
        "present-but-must-not-be-used",
      );
    } finally {
      await dependencies.close?.();
    }
  });

  it("reports a useful startup summary without exposing configuration secrets", () => {
    const config = loadServiceConfig({
      VIDEOHARNESS_AUTH_TOKEN: "do-not-print",
    });
    const summary = startupSummary(config);
    expect(summary).toContain("http://127.0.0.1:8787");
    expect(summary).toContain("phase=phase_a");
    expect(summary).toContain("mode=offline_fake");
    expect(summary).toContain("auth=required");
    expect(summary).not.toContain("do-not-print");
    expect(summary).not.toContain(config.dataDir);

    expect(
      startupErrorMessage(
        new DependencyCompositionError("address already in use"),
      ),
    ).toBe("address already in use");
    expect(
      startupErrorMessage({
        code: "EADDRINUSE",
        message: "private operating system detail",
      }),
    ).toBe("VideoHarness failed to start");
  });
});
