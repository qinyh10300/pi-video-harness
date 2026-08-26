import { describe, expect, it } from "vitest";

import { canonicalJson, hashBackendCommand } from "./index.js";

describe("canonical fake command hashing", () => {
  it("sorts object keys but preserves array order", () => {
    expect(canonicalJson({ z: 1, a: [2, 1], omitted: undefined })).toBe(
      '{"a":[2,1],"z":1}',
    );
    expect(hashBackendCommand({ b: 2, a: 1 })).toBe(
      hashBackendCommand({ a: 1, b: 2 }),
    );
    expect(hashBackendCommand({ a: [1, 2] })).not.toBe(
      hashBackendCommand({ a: [2, 1] }),
    );
  });

  it("rejects non-finite and cyclic command values", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow("non-finite");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow("cycles");
  });
});
