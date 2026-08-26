import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadServiceConfig,
  toPublicServiceConfig,
} from "./config.js";

describe("loadServiceConfig", () => {
  it("defaults to the offline fake profile", () => {
    const config = loadServiceConfig({}, "/worktree");

    expect(config.defaultProfileId).toBe("fake-image2-video-v1");
    expect(config.openAI.enabled).toBe(false);
    expect(config.openAI.apiKeyConfigured).toBe(false);
    expect(config.comfyUI.baseUrl).toBeUndefined();
    expect(config.dataDir).toBe("/worktree/data");
  });

  it("refuses to enable cloud image generation without a key", () => {
    expect(() =>
      loadServiceConfig({ VIDEOHARNESS_ENABLE_CLOUD_IMAGE: "true" }),
    ).toThrowError(ConfigurationError);
  });

  it("accepts an explicit disabled real profile without contacting it", () => {
    const config = loadServiceConfig({
      VIDEOHARNESS_PIPELINE_PROFILES:
        "fake-image2-video-v1,gpt-image2-wan22-i2v-a14b-v1",
      VIDEOHARNESS_DEFAULT_PIPELINE_PROFILE: "fake-image2-video-v1",
      OPENAI_API_KEY: "not-returned",
      VIDEOHARNESS_ENABLE_CLOUD_IMAGE: "false",
    });

    const publicConfig = toPublicServiceConfig(config);
    expect(publicConfig.openAI).toEqual({
      enabled: false,
      apiKeyConfigured: true,
    });
    expect(JSON.stringify(publicConfig)).not.toContain("not-returned");
    expect(JSON.stringify(publicConfig)).not.toContain(config.dataDir);
  });

  it("rejects unsafe or inconsistent values", () => {
    expect(() => loadServiceConfig({ VIDEOHARNESS_PORT: "0" })).toThrowError(
      /VIDEOHARNESS_PORT/,
    );
    expect(() =>
      loadServiceConfig({ COMFYUI_BASE_URL: "file:///tmp/comfy" }),
    ).toThrowError(/COMFYUI_BASE_URL/);
    expect(() =>
      loadServiceConfig({ COMFYUI_WS_URL: "ws://127.0.0.1:8188/ws" }),
    ).toThrowError(/COMFYUI_BASE_URL/);
    expect(() =>
      loadServiceConfig({
        VIDEOHARNESS_PIPELINE_PROFILES: "fake-image2-video-v1",
        VIDEOHARNESS_DEFAULT_PIPELINE_PROFILE: "missing-profile-v1",
      }),
    ).toThrowError(/DEFAULT_PIPELINE_PROFILE/);
    expect(() =>
      loadServiceConfig({ VIDEOHARNESS_HOST: "0.0.0.0" }),
    ).toThrowError(/VIDEOHARNESS_AUTH_TOKEN/);
  });

  it("requires authentication off loopback", () => {
    const config = loadServiceConfig({
      VIDEOHARNESS_HOST: "192.0.2.10",
      VIDEOHARNESS_AUTH_TOKEN: "local-network-secret",
    });
    expect(config.host).toBe("192.0.2.10");
    expect(toPublicServiceConfig(config).authConfigured).toBe(true);
    expect(JSON.stringify(toPublicServiceConfig(config))).not.toContain(
      "local-network-secret",
    );

    for (const host of ["localhost", "127.0.0.1", "127.12.34.56", "::1"]) {
      expect(loadServiceConfig({ VIDEOHARNESS_HOST: host }).host).toBe(host);
    }
  });
});
