import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { KnowledgeSelection } from "@pi-video-harness/contracts";
import { sha256Hex } from "@pi-video-harness/core";
import { ProductKnowledgeRegistry } from "@pi-video-harness/knowledge";

import {
  PlanCompilationError,
  PlanCompiler,
  WAN22_OFFICIAL_NEGATIVE_PROMPT,
  WAN_PROJECT_NEGATIVE_PROMPT,
} from "./plan-compiler.js";
import {
  ProfileConfigurationError,
  ProfileRegistry,
} from "./profile-registry.js";

const profileDirectory = fileURLToPath(
  new URL("../../../config/pipelines", import.meta.url),
);
const knowledgeSourceDirectory = fileURLToPath(
  new URL("../../../knowledge/lynxon-product-knowledge", import.meta.url),
);
const knowledgeManifestPath = fileURLToPath(
  new URL(
    "../../../config/knowledge/lynxon-product-knowledge.v1.json",
    import.meta.url,
  ),
);

describe("ProfileRegistry", () => {
  it("loads the closed fake and reserved real profiles with stable hashes", async () => {
    const registry = await ProfileRegistry.load({
      directory: profileDirectory,
    });
    const fake = registry.getRequired("fake-image2-video-v1");
    const real = registry.getRequired("gpt-image2-wan22-i2v-a14b-v1");

    expect(fake.executionDisposition).toBe("offline_fake");
    expect(fake.profileHash).toMatch(/^[a-f0-9]{64}$/);
    expect(real.executionDisposition).toBe("disabled");
    expect(real.profileHash).toMatch(/^[a-f0-9]{64}$/);
    for (const entry of [fake, real]) {
      const policy = entry.profile.video.negativePromptPolicy;
      expect(policy.officialDefault.text).toBe(WAN22_OFFICIAL_NEGATIVE_PROMPT);
      expect(policy.projectConstraints.text).toBe(WAN_PROJECT_NEGATIVE_PROMPT);
      expect(policy.officialDefault.sha256).toBe(
        sha256Hex(policy.officialDefault.text),
      );
      expect(policy.projectConstraints.sha256).toBe(
        sha256Hex(policy.projectConstraints.text),
      );
      expect(policy.officialDefault.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
    }
  });

  it("refuses the unfrozen profile in production mode", async () => {
    await expect(
      ProfileRegistry.load({
        directory: profileDirectory,
        allowedProfileIds: ["gpt-image2-wan22-i2v-a14b-v1"],
        productionMode: true,
      }),
    ).rejects.toBeInstanceOf(ProfileConfigurationError);
  });

  it("rejects a negative Prompt component whose content hash was tampered", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "pi-video-profile-test-"),
    );
    try {
      const source = await readFile(
        path.join(profileDirectory, "fake-image2-video.v1.json"),
        "utf8",
      );
      const profile = JSON.parse(source) as {
        video: {
          negativePromptPolicy: {
            officialDefault: { sha256: string };
          };
        };
      };
      profile.video.negativePromptPolicy.officialDefault.sha256 = "0".repeat(
        64,
      );
      await writeFile(
        path.join(temporaryDirectory, "tampered.json"),
        JSON.stringify(profile),
        "utf8",
      );

      await expect(
        ProfileRegistry.load({ directory: temporaryDirectory }),
      ).rejects.toThrow(/mismatched officialDefault negative Prompt hash/u);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe("PlanCompiler", () => {
  it("compiles a deterministic-shape, zero-cost fake plan", async () => {
    const registry = await ProfileRegistry.load({
      directory: profileDirectory,
    });
    let ordinal = 0;
    const compiler = new PlanCompiler({
      now: () => new Date("2026-08-26T00:00:00.000Z"),
      idFactory: () => String(++ordinal),
    });

    const plan = compiler.compile(
      {
        brief: "A red fox takes one careful step through a quiet pine forest.",
        aspectRatio: "9:16",
        durationSeconds: 5,
        dryRun: true,
      },
      registry.getRequired("fake-image2-video-v1"),
    );

    expect(plan.pipelineProfileId).toBe("fake-image2-video-v1");
    expect(plan.frame).toMatchObject({ width: 720, height: 1280 });
    expect(plan.imageStage).toMatchObject({
      model: "fake-image-v1",
      candidateCount: 2,
      size: "720x1280",
    });
    expect(plan.videoStage).toMatchObject({
      adapterId: "fake-video-v1",
      allowFallback: false,
      durationSeconds: 5,
    });
    expect(plan.estimate).toMatchObject({
      estimatedOpenAICostUsd: 0,
      estimatedGpuSeconds: 0,
    });
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects more preview candidates than the profile exposes", async () => {
    const registry = await ProfileRegistry.load({
      directory: profileDirectory,
    });
    const compiler = new PlanCompiler();

    expect(() =>
      compiler.compile(
        { brief: "A product rotates.", previewCandidateCount: 3 },
        registry.getRequired("fake-image2-video-v1"),
      ),
    ).toThrowError(PlanCompilationError);
  });

  it("preserves the frozen Wan default and project constraints when appending user negatives", async () => {
    const registry = await ProfileRegistry.load({
      directory: profileDirectory,
    });
    const compiler = new PlanCompiler();
    const profile = registry.getRequired("fake-image2-video-v1");
    const base = compiler.compile({ brief: "A product rotates." }, profile);
    expect(base.negativePrompt.text).toBe(
      `${WAN22_OFFICIAL_NEGATIVE_PROMPT}, ${WAN_PROJECT_NEGATIVE_PROMPT}`,
    );
    expect(base.negativePrompt.source).toBe("compiler");
    expect(base.negativePrompt.mergePolicy).toBe("append-comma-v1");
    expect(base.negativePrompt.components).toEqual([
      {
        kind: "official_default",
        ...profile.profile.video.negativePromptPolicy.officialDefault,
      },
      {
        kind: "project_constraints",
        ...profile.profile.video.negativePromptPolicy.projectConstraints,
      },
    ]);
    expect(base.negativePrompt.sha256).toBe(
      sha256Hex(base.negativePrompt.text),
    );

    const userConstraint = "no blue highlights";
    const merged = compiler.compile(
      { brief: "A product rotates.", negativePrompt: userConstraint },
      profile,
    );
    expect(merged.negativePrompt.text).toBe(
      `${WAN22_OFFICIAL_NEGATIVE_PROMPT}, ${WAN_PROJECT_NEGATIVE_PROMPT}, ${userConstraint}`,
    );
    expect(merged.negativePrompt.source).toBe("compiler");
    expect(merged.negativePrompt.components.at(-1)).toEqual({
      kind: "user_append",
      text: userConstraint,
      sha256: sha256Hex(userConstraint),
      sourceId: "CreatePlanInput.negativePrompt",
    });
    expect(merged.negativePrompt.sha256).toBe(
      sha256Hex(merged.negativePrompt.text),
    );
  });

  it("rejects a whitespace-only user negative append", async () => {
    const registry = await ProfileRegistry.load({
      directory: profileDirectory,
    });
    const compiler = new PlanCompiler();

    expect(() =>
      compiler.compile(
        { brief: "A product rotates.", negativePrompt: "   \n  " },
        registry.getRequired("fake-image2-video-v1"),
      ),
    ).toThrowError(PlanCompilationError);
  });

  it("binds the pinned product knowledge snapshot into the Plan hash", async () => {
    const profiles = await ProfileRegistry.load({
      directory: profileDirectory,
    });
    const knowledge = await ProductKnowledgeRegistry.load({
      sourceDirectory: knowledgeSourceDirectory,
      manifestPath: knowledgeManifestPath,
    });
    const waitingSelection = {
      knowledgeBaseId: "lynxon-product-knowledge",
      policyId: "lynxon-video-content-policy-v1",
      qaIds: ["waiting-period"],
      assertions: [
        {
          claimId: "waiting-period-30-days",
          text: "延长保修服务设有30日等待期，等待期内发生的故障不予赔偿。",
        },
      ],
    } satisfies KnowledgeSelection;
    const repairSelection = {
      knowledgeBaseId: "lynxon-product-knowledge",
      policyId: "lynxon-video-content-policy-v1",
      qaIds: ["repair-sites"],
      assertions: [
        {
          claimId: "qualified-repair-sites",
          text: "车辆可送至所属品牌4S店或国家认证的具备二类（含）以上维修资质的维修站。",
        },
      ],
    } satisfies KnowledgeSelection;
    const compile = (selection: KnowledgeSelection) => {
      let ordinal = 0;
      return new PlanCompiler({
        now: () => new Date("2026-08-26T00:00:00.000Z"),
        idFactory: () => String(++ordinal),
      }).compile(
        { brief: "A grounded product explainer.", knowledge: selection },
        profiles.getRequired("fake-image2-video-v1"),
        { knowledgeBinding: knowledge.compileSelection(selection) },
      );
    };

    const waitingPlan = compile(waitingSelection);
    const repairPlan = compile(repairSelection);

    expect(waitingPlan.knowledgeBinding?.snapshot.revision).toBe(
      "4be08769b2e3459075490c7ab31924178ab44cd8",
    );
    expect(waitingPlan.knowledgeBinding?.bindingHash).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(waitingPlan.planId).toBe(repairPlan.planId);
    expect(waitingPlan.planHash).not.toBe(repairPlan.planHash);
  });
});
