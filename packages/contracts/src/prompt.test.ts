import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  MotionPromptSchema,
  NegativePromptSchema,
  StillPromptSchema,
  VersionedPromptSchema,
} from "./index.js";

const promptBase = {
  promptId: "prompt-1",
  version: 1,
  text: "A stable first frame.",
  source: "compiler",
  sha256: "a".repeat(64),
} as const;

const negativePromptFields = {
  mergePolicy: "append-comma-v1",
  components: [
    {
      kind: "official_default",
      text: "official default",
      sha256: "b".repeat(64),
      sourceId: "Wan-Video/Wan2.2:sample_neg_prompt",
      sourceRevision: "1".repeat(40),
    },
    {
      kind: "project_constraints",
      text: "project constraints",
      sha256: "c".repeat(64),
      sourceId: "pi-video-harness:negative-prompt",
      sourceRevision: "v1",
    },
  ],
} as const;

describe("versioned prompt contracts", () => {
  it("uses a discriminated prompt-version union", () => {
    expect(
      Value.Check(VersionedPromptSchema, { ...promptBase, kind: "still" }),
    ).toBe(true);
    expect(
      Value.Check(VersionedPromptSchema, { ...promptBase, kind: "motion" }),
    ).toBe(true);
    expect(
      Value.Check(VersionedPromptSchema, {
        ...promptBase,
        ...negativePromptFields,
        kind: "negative",
      }),
    ).toBe(true);
  });

  it("keeps field-specific prompt schemas distinct", () => {
    expect(
      Value.Check(StillPromptSchema, { ...promptBase, kind: "still" }),
    ).toBe(true);
    expect(
      Value.Check(StillPromptSchema, { ...promptBase, kind: "motion" }),
    ).toBe(false);
    expect(
      Value.Check(MotionPromptSchema, { ...promptBase, kind: "motion" }),
    ).toBe(true);
    expect(
      Value.Check(NegativePromptSchema, {
        ...promptBase,
        ...negativePromptFields,
        kind: "negative",
      }),
    ).toBe(true);
  });

  it("requires provenance components for negative Prompts", () => {
    expect(
      Value.Check(NegativePromptSchema, {
        ...promptBase,
        kind: "negative",
      }),
    ).toBe(false);
    expect(
      Value.Check(NegativePromptSchema, {
        ...promptBase,
        ...negativePromptFields,
        kind: "negative",
        mergePolicy: "replace",
      }),
    ).toBe(false);
    expect(
      Value.Check(NegativePromptSchema, {
        ...promptBase,
        ...negativePromptFields,
        kind: "negative",
        components: [...negativePromptFields.components].reverse(),
      }),
    ).toBe(false);
  });
});
