import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseCreatePlanInput } from "@pi-video-harness/contracts";
import { ProductKnowledgeRegistry } from "@pi-video-harness/knowledge";

import { createPlanInputsForVideoScript } from "./video-script-input.js";
import {
  VideoScriptConfigurationError,
  VideoScriptRegistry,
} from "./video-script-registry.js";

const scriptDirectory = fileURLToPath(
  new URL("../../../config/video-scripts", import.meta.url),
);
const scriptFile = path.join(
  scriptDirectory,
  "car-warranty",
  "car-warranty-female-travel-breakdown.v1.json",
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

const readCheckedInScript = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(scriptFile, "utf8")) as Record<string, unknown>;

const loadKnowledgeRegistry = (): Promise<ProductKnowledgeRegistry> =>
  ProductKnowledgeRegistry.load({
    sourceDirectory: knowledgeSourceDirectory,
    manifestPath: knowledgeManifestPath,
  });

describe("VideoScriptRegistry", () => {
  it("recursively loads the checked-in catalog with a stable identity", async () => {
    const registry = await VideoScriptRegistry.load({
      directory: scriptDirectory,
    });
    const entry = registry.getRequired(
      "car-warranty-female-travel-breakdown",
      1,
    );

    expect(registry.list()).toHaveLength(1);
    expect(entry.scriptHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.script)).toBe(true);
    expect(Object.isFrozen(entry.script.shots)).toBe(true);
    expect(() => Object.assign(entry.script, { title: "mutated" })).toThrow(
      TypeError,
    );
    expect(entry.script.format).toMatchObject({
      aspectRatio: "9:16",
      targetDurationSeconds: 15,
    });
    expect(entry.script).toMatchObject({
      schemaVersion: "2",
      product: {
        name: "车援宝",
        category: "机动车辆延长保修服务",
      },
    });
    expect(entry.script.knowledge.qaIds).toEqual([
      "fault-reporting",
      "repair-sites",
    ]);
    expect(
      entry.script.knowledge.assertions.map(({ claimId }) => claimId),
    ).toEqual([
      "waiting-period-30-days",
      "existing-fault-not-covered",
      "contact-before-repair",
      "qualified-repair-sites",
    ]);
    const scriptText = JSON.stringify(entry.script);
    expect(scriptText).not.toContain("她现有的车险");
    expect(scriptText).not.toContain("第三方车延保");
    expect(scriptText).not.toContain("申请就近维修支持");
    expect(scriptText).not.toContain("签约满30日");
    expect(entry.script.shots[0]!.overlay.headline).toBe(
      "生效后等待期已满30日",
    );
    expect(entry.script.shots.map((shot) => shot.startSeconds)).toEqual([
      0, 5, 10,
    ]);
  });

  it("maps every shot to an existing five-second plan input", async () => {
    const registry = await VideoScriptRegistry.load({
      directory: scriptDirectory,
    });
    const { script } = registry.getRequired(
      "car-warranty-female-travel-breakdown",
      1,
    );
    const knowledgeRegistry = await loadKnowledgeRegistry();
    const shots = createPlanInputsForVideoScript(script, {
      knowledgeRegistry,
      dryRun: true,
      idempotencyKeyPrefix: "campaign-2026-08",
      referenceAssetIds: ["character-reference", "vehicle-reference"],
    });

    expect(shots).toHaveLength(3);
    for (const [index, shot] of shots.entries()) {
      expect(() => parseCreatePlanInput(shot.input)).not.toThrow();
      expect(shot.input).toMatchObject({
        aspectRatio: "9:16",
        durationSeconds: 5,
        dryRun: true,
        referenceAssetIds: ["character-reference", "vehicle-reference"],
      });
      expect(shot.input.knowledge).toEqual({
        knowledgeBaseId: script.knowledge.knowledgeBaseId,
        policyId: script.knowledge.policyId,
        qaIds: script.shots[index]!.knowledgeQaIds,
        assertions: script.shots[index]!.knowledgeClaimIds.map((claimId) =>
          script.knowledge.assertions.find(
            (assertion) => assertion.claimId === claimId,
          ),
        ),
      });
      expect(shot.input.idempotencyKey).toContain(`:shot-0${index + 1}`);
      expect(shot.assembly.knowledgeBinding.bindingHash).toMatch(
        /^[a-f0-9]{64}$/u,
      );
      expect(shot.assembly.knowledgeBinding.snapshot.revision).toBe(
        "4be08769b2e3459075490c7ab31924178ab44cd8",
      );
      for (const claim of shot.assembly.knowledgeBinding.claims) {
        expect(shot.input.brief).toContain(claim.approvedText);
      }
      for (const answer of shot.assembly.knowledgeBinding.answers) {
        expect(shot.input.brief).toContain(answer.canonicalQuestion);
        expect(shot.input.brief).toContain(answer.canonicalAnswer);
      }
      expect(() =>
        knowledgeRegistry.validateGroundedContent(
          shot.assembly.knowledgeBinding,
          {
            brief: shot.input.brief,
            ...(shot.input.stillPrompt === undefined
              ? {}
              : { stillPrompt: shot.input.stillPrompt }),
            ...(shot.input.motionPrompt === undefined
              ? {}
              : { motionPrompt: shot.input.motionPrompt }),
            ...(shot.input.negativePrompt === undefined
              ? {}
              : { negativePrompt: shot.input.negativePrompt }),
          },
        ),
      ).not.toThrow();
      expect(shot.input.brief).not.toContain(script.product.positioning);
      for (const forbiddenClaim of script.compliance.forbiddenClaims) {
        expect(shot.input.brief).not.toContain(forbiddenClaim);
      }
    }
    expect(shots[0]!.input.stillPrompt).toContain(
      script.continuity.protagonist.wardrobe,
    );
    expect(shots[0]!.input.stillPrompt).toContain(script.creative.visualStyle);
    expect(shots[0]!.input.stillPrompt).toContain(script.continuity.vehicle);
    expect(shots[2]!.assembly).toMatchObject({
      startSeconds: 10,
      durationSeconds: 5,
      voiceover: script.shots[2]!.voiceover,
      requiredDisclaimer: script.compliance.requiredDisclaimer,
    });
    expect(shots[2]!.assembly.overlay.headline).toBe(
      "问：车辆可以送到哪里维修？",
    );
    expect(shots[1]!.assembly.overlay.subline).toContain("应先联系Lynxon");
    const productProcessConstraint = script.continuity.constraints.at(-1)!;
    expect(shots[1]!.input.stillPrompt).not.toContain(productProcessConstraint);
    expect(shots[1]!.input.motionPrompt).not.toContain(
      productProcessConstraint,
    );
  });

  it("rejects a script assertion that changes the approved knowledge text", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "pi-video-script-test-"),
    );
    try {
      const script = (await readCheckedInScript()) as {
        knowledge: {
          assertions: Array<{ claimId: string; text: string }>;
        };
      } & Record<string, unknown>;
      script.knowledge.assertions[0]!.text =
        "延长保修服务没有等待期，故障可立即处理。";
      await writeFile(
        path.join(
          temporaryDirectory,
          "car-warranty-female-travel-breakdown.v1.json",
        ),
        JSON.stringify(script),
        "utf8",
      );
      const registry = await VideoScriptRegistry.load({
        directory: temporaryDirectory,
      });
      const knowledgeRegistry = await loadKnowledgeRegistry();

      expect(() =>
        createPlanInputsForVideoScript(
          registry.getRequired("car-warranty-female-travel-breakdown", 1)
            .script,
          { knowledgeRegistry },
        ),
      ).toThrow(/must exactly match its approved text/u);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects public voiceover that does not render its bound claim verbatim", async () => {
    const registry = await VideoScriptRegistry.load({
      directory: scriptDirectory,
    });
    const knowledgeRegistry = await loadKnowledgeRegistry();
    const script = structuredClone(
      registry.getRequired("car-warranty-female-travel-breakdown", 1).script,
    );
    script.shots[1]!.overlay.subline =
      "答：任何维修厂都可以直接处理，不需要先联系。";
    script.shots[1]!.voiceover = "发生故障后，任何维修厂都可以直接处理。";

    expect(() =>
      createPlanInputsForVideoScript(script, { knowledgeRegistry }),
    ).toThrow(
      /public text must include approved claim 'contact-before-repair'/u,
    );
  });

  it("rejects an extra public product statement even when bound facts are present", async () => {
    const registry = await VideoScriptRegistry.load({
      directory: scriptDirectory,
    });
    const knowledgeRegistry = await loadKnowledgeRegistry();
    const script = structuredClone(
      registry.getRequired("car-warranty-female-travel-breakdown", 1).script,
    );
    script.shots[1]!.overlay.footnote = "全国任何维修厂都可以直接处理。";

    expect(() =>
      createPlanInputsForVideoScript(script, { knowledgeRegistry }),
    ).toThrow(/contains an unsupported product statement/u);
  });

  it("rejects after-fault enrollment synonyms across every public and Brief surface", async () => {
    const registry = await VideoScriptRegistry.load({
      directory: scriptDirectory,
    });
    const knowledgeRegistry = await loadKnowledgeRegistry();
    const original = registry.getRequired(
      "car-warranty-female-travel-breakdown",
      1,
    ).script;
    const cases: ReadonlyArray<{
      readonly pointer: string;
      readonly mutate: (script: typeof original) => void;
    }> = [
      {
        pointer: "/shots/shot-01/brief",
        mutate: (script) => {
          script.shots[0]!.brief += "坏了后再办也能处理。";
        },
      },
      {
        pointer: "/shots/shot-01/overlay/subline",
        mutate: (script) => {
          script.shots[0]!.overlay.subline = "坏了后再办也能处理。";
        },
      },
      {
        pointer: "/shots/shot-01/voiceover",
        mutate: (script) => {
          script.shots[0]!.voiceover += "坏了后再办也能处理。";
        },
      },
      {
        pointer: "/compliance/requiredDisclaimer",
        mutate: (script) => {
          script.compliance.requiredDisclaimer += "坏了后再办也能处理。";
        },
      },
      {
        pointer: "/shots/shot-01/negativePrompt",
        mutate: (script) => {
          script.shots[0]!.negativePrompt += "，坏了后再办也能处理";
        },
      },
    ];

    for (const testCase of cases) {
      const script = structuredClone(original);
      testCase.mutate(script);

      expect(() =>
        createPlanInputsForVideoScript(script, { knowledgeRegistry }),
      ).toThrow(
        /contains an unsupported product statement|public text must include approved claim/u,
      );
    }
  });

  it("rejects a contradictory suffix after an otherwise approved public claim", async () => {
    const registry = await VideoScriptRegistry.load({
      directory: scriptDirectory,
    });
    const knowledgeRegistry = await loadKnowledgeRegistry();
    const script = structuredClone(
      registry.getRequired("car-warranty-female-travel-breakdown", 1).script,
    );
    script.shots[0]!.voiceover += "不过坏了后再办也能处理。";

    expect(() =>
      createPlanInputsForVideoScript(script, { knowledgeRegistry }),
    ).toThrow(/public text must include approved claim/u);
  });

  it("rejects invisible-character and cross-surface public claim bypasses", async () => {
    const registry = await VideoScriptRegistry.load({
      directory: scriptDirectory,
    });
    const knowledgeRegistry = await loadKnowledgeRegistry();
    const original = registry.getRequired(
      "car-warranty-female-travel-breakdown",
      1,
    ).script;

    const invisible = structuredClone(original);
    invisible.shots[1]!.voiceover +=
      "坏\u200b了\u034f后\u200b再\u034f办\u200b也\u034f能\u200b处\u034f理。";
    expect(() =>
      createPlanInputsForVideoScript(invisible, { knowledgeRegistry }),
    ).toThrow(
      /contains an unsupported product statement|public text must include approved claim/u,
    );

    const split = structuredClone(original);
    split.shots[0]!.overlay.headline += "，坏了后";
    split.shots[0]!.overlay.subline = "再买也能处理";
    expect(() =>
      createPlanInputsForVideoScript(split, { knowledgeRegistry }),
    ).toThrow(
      /combined public text contains an unsupported product statement/u,
    );
  });

  it("requires the approved disclaimer boilerplate", async () => {
    const registry = await VideoScriptRegistry.load({
      directory: scriptDirectory,
    });
    const knowledgeRegistry = await loadKnowledgeRegistry();
    const script = structuredClone(
      registry.getRequired("car-warranty-female-travel-breakdown", 1).script,
    );
    script.compliance.requiredDisclaimer = "精彩内容";

    expect(() =>
      createPlanInputsForVideoScript(script, { knowledgeRegistry }),
    ).toThrow(/requiredDisclaimer must contain only the approved disclaimer/u);
  });

  it("rejects a file name that disagrees with the script identity", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "pi-video-script-test-"),
    );
    try {
      await writeFile(
        path.join(temporaryDirectory, "wrong-name.v1.json"),
        JSON.stringify(await readCheckedInScript()),
        "utf8",
      );

      await expect(
        VideoScriptRegistry.load({ directory: temporaryDirectory }),
      ).rejects.toThrow(/must be named/u);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects timeline gaps", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "pi-video-script-test-"),
    );
    try {
      const script = (await readCheckedInScript()) as {
        shots: Array<{ startSeconds: number }>;
      } & Record<string, unknown>;
      script.shots[1]!.startSeconds = 6;
      await writeFile(
        path.join(
          temporaryDirectory,
          "car-warranty-female-travel-breakdown.v1.json",
        ),
        JSON.stringify(script),
        "utf8",
      );

      await expect(
        VideoScriptRegistry.load({ directory: temporaryDirectory }),
      ).rejects.toThrow(/must start at 5 seconds/u);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects duplicate shot IDs", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "pi-video-script-test-"),
    );
    try {
      const script = (await readCheckedInScript()) as {
        shots: Array<{ shotId: string }>;
      } & Record<string, unknown>;
      script.shots[1]!.shotId = script.shots[0]!.shotId;
      await writeFile(
        path.join(
          temporaryDirectory,
          "car-warranty-female-travel-breakdown.v1.json",
        ),
        JSON.stringify(script),
        "utf8",
      );

      await expect(
        VideoScriptRegistry.load({ directory: temporaryDirectory }),
      ).rejects.toThrow(/duplicate shot ID 'shot-01'/u);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("keeps multiple script versions explicit and path-ordered", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "pi-video-script-test-"),
    );
    try {
      const versionOne = await readCheckedInScript();
      const versionTwo = {
        ...versionOne,
        scriptVersion: 2,
        title: "Version two",
      };
      const earlierPath = path.join(temporaryDirectory, "a", "nested");
      const laterPath = path.join(temporaryDirectory, "z");
      await mkdir(earlierPath, { recursive: true });
      await mkdir(laterPath);
      await writeFile(
        path.join(earlierPath, "car-warranty-female-travel-breakdown.v2.json"),
        JSON.stringify(versionTwo),
        "utf8",
      );
      await writeFile(
        path.join(laterPath, "car-warranty-female-travel-breakdown.v1.json"),
        JSON.stringify(versionOne),
        "utf8",
      );

      const registry = await VideoScriptRegistry.load({
        directory: temporaryDirectory,
      });

      expect(
        registry.getRequired("car-warranty-female-travel-breakdown", 1).script
          .scriptVersion,
      ).toBe(1);
      expect(
        registry.getRequired("car-warranty-female-travel-breakdown", 2).script
          .scriptVersion,
      ).toBe(2);
      expect(
        registry.list().map((entry) => entry.script.scriptVersion),
      ).toEqual([2, 1]);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rejects duplicate script ID and version across nested folders", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "pi-video-script-test-"),
    );
    try {
      const serialized = JSON.stringify(await readCheckedInScript());
      for (const folder of ["a", "b"]) {
        const nested = path.join(temporaryDirectory, folder);
        await mkdir(nested);
        await writeFile(
          path.join(nested, "car-warranty-female-travel-breakdown.v1.json"),
          serialized,
          "utf8",
        );
      }

      await expect(
        VideoScriptRegistry.load({ directory: temporaryDirectory }),
      ).rejects.toBeInstanceOf(VideoScriptConfigurationError);
      await expect(
        VideoScriptRegistry.load({ directory: temporaryDirectory }),
      ).rejects.toThrow(/Duplicate video script/u);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
