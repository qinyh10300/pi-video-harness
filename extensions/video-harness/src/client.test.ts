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

  it("sends bounded event cursors and keeps long-poll transport alive", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 20);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          },
          { once: true },
        );
      });
      return Response.json({
        events: [],
        nextAfterSequence: 7,
        timedOut: true,
      });
    });
    const client = new VideoHarnessClient({ requestTimeoutMs: 1, fetch });

    await expect(
      client.getEvents("pipeline-1", {
        after: 7,
        limit: 20,
        waitMs: 10,
      }),
    ).resolves.toMatchObject({ nextAfterSequence: 7, timedOut: true });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:8787/v1/pipelines/pipeline-1/events?afterSequence=7&limit=20&waitMs=10",
    );
    expect(() => client.getEvents("pipeline-1", { limit: 201 })).toThrow(
      /limit/,
    );
    expect(() => client.getEvents("pipeline-1", { waitMs: -1 })).toThrow(
      /waitMs/,
    );
  });

  it("downloads authenticated Artifact bytes with response metadata", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "content-type": "video/mp4",
          "content-length": "3",
          etag: '"abc"',
          "x-request-id": "request-download",
        },
      }),
    );
    const client = new VideoHarnessClient({
      authToken: "local-secret",
      fetch,
    });

    const result = await client.downloadArtifact(
      "pipeline/one",
      "artifact/two",
    );

    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(result).toMatchObject({
      mimeType: "video/mp4",
      sizeBytes: 3,
      etag: '"abc"',
      requestId: "request-download",
    });
    const [url, request] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      "http://127.0.0.1:8787/v1/pipelines/pipeline%2Fone/artifacts/artifact%2Ftwo/content",
    );
    const headers = new Headers(request?.headers);
    expect(headers.get("accept")).toBe("*/*");
    expect(headers.get("authorization")).toBe("Bearer local-secret");
  });
});
