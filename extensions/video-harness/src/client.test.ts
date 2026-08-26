import { describe, expect, it, vi } from "vitest";

import { VideoHarnessClient, VideoHarnessHttpError } from "./client.js";

describe("VideoHarnessClient", () => {
  it("uses a bearer token without putting it in the URL", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ status: "ok" }));
    const client = new VideoHarnessClient({
      baseUrl: "http://127.0.0.1:8787",
      authToken: "local-secret",
      fetch,
    });

    await client.health();

    const [url, request] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:8787/v1/health");
    expect(String(url)).not.toContain("local-secret");
    expect(new Headers(request?.headers).get("authorization")).toBe(
      "Bearer local-secret",
    );
  });

  it("encodes resource identifiers as a single path segment", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json({ planId: "plan-1", planVersion: 1, planHash: "hash" }),
      );
    const client = new VideoHarnessClient({ fetch });

    await client.getPlan("../../unexpected");

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:8787/v1/plans/..%2F..%2Funexpected",
    );
  });

  it("maps structured service errors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json(
        {
          requestId: "request-1",
          error: {
            code: "approval_required",
            message: "Plan approval is required",
            retryDisposition: "never",
          },
        },
        { status: 409 },
      ),
    );
    const client = new VideoHarnessClient({ fetch });

    const error = await client
      .getPipeline("pipeline-1")
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(VideoHarnessHttpError);
    expect(error).toMatchObject({
      statusCode: 409,
      requestId: "request-1",
      backendError: { code: "approval_required" },
    });
  });
});
