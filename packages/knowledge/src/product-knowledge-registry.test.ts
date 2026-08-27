import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  LYNXON_KNOWLEDGE_REPOSITORY_URL,
  LYNXON_KNOWLEDGE_REVISION,
  ProductKnowledgeConfigurationError,
  ProductKnowledgePolicyError,
  ProductKnowledgeRegistry,
} from "./index.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceDirectory = path.join(
  repositoryRoot,
  "knowledge/lynxon-product-knowledge",
);
const manifestPath = path.join(
  repositoryRoot,
  "config/knowledge/lynxon-product-knowledge.v1.json",
);
const EXPECTED_CORPUS_HASH =
  "87f0f29cc9dd521974c7135e6688012e0a5ac957522fbec9ed164d546576e3b6";

const temporaryDirectories: string[] = [];

interface Fixture {
  readonly root: string;
  readonly sourceDirectory: string;
  readonly manifestPath: string;
}

const createFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "video-harness-knowledge-"),
  );
  temporaryDirectories.push(root);
  const fixtureSource = path.join(root, "source");
  const fixtureManifest = path.join(root, "manifest.json");
  await mkdir(fixtureSource, { recursive: true });
  await cp(
    path.join(sourceDirectory, "01-PRODUCT"),
    path.join(fixtureSource, "01-PRODUCT"),
    { recursive: true, verbatimSymlinks: true },
  );
  await cp(manifestPath, fixtureManifest);
  return {
    root,
    sourceDirectory: fixtureSource,
    manifestPath: fixtureManifest,
  };
};

const mutateManifest = async (
  fixture: Fixture,
  mutate: (manifest: Record<string, any>) => void,
): Promise<void> => {
  const manifest = JSON.parse(
    await readFile(fixture.manifestPath, "utf8"),
  ) as Record<string, any>;
  mutate(manifest);
  await writeFile(fixture.manifestPath, JSON.stringify(manifest), "utf8");
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ProductKnowledgeRegistry", () => {
  it("loads the pinned authoritative corpus with stable hashes", async () => {
    const first = await ProductKnowledgeRegistry.load({
      sourceDirectory,
      manifestPath,
    });
    const second = await ProductKnowledgeRegistry.load({
      sourceDirectory,
      manifestPath,
    });

    expect(first.snapshot.ref).toEqual(second.snapshot.ref);
    expect(first.snapshot.ref).toMatchObject({
      knowledgeBaseId: "lynxon-product-knowledge",
      policyId: "lynxon-video-content-policy-v1",
      repoUrl: LYNXON_KNOWLEDGE_REPOSITORY_URL,
      revision: LYNXON_KNOWLEDGE_REVISION,
      corpusHash: EXPECTED_CORPUS_HASH,
    });
    expect(first.snapshot.ref.policyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.snapshot.corpusEntries).toHaveLength(23);
    expect(
      first.snapshot.corpusEntries.every((entry) =>
        entry.path.startsWith("01-PRODUCT/"),
      ),
    ).toBe(true);
  });

  it("answers only deterministic approved questions and refuses weak evidence", async () => {
    const registry = await ProductKnowledgeRegistry.load({
      sourceDirectory,
      manifestPath,
    });
    const identity = {
      knowledgeBaseId: registry.snapshot.knowledgeBaseId,
      policyId: registry.snapshot.policyId,
    };

    const answered = registry.query({
      ...identity,
      question: "车延保的等待期是多久？",
    });
    expect(answered.status).toBe("answered");
    if (answered.status === "answered") {
      expect(answered.answer.qaId).toBe("waiting-period");
      expect(answered.answer.canonicalAnswer).toBe(
        "延长保修服务设有30日等待期，等待期内发生的故障不予赔偿。",
      );
      expect(answered.answer.citations[0]?.path).toBe(
        "01-PRODUCT/_通用条款/等待期.md",
      );
    }

    expect(
      registry.query({ ...identity, question: "这辆车适合什么旅游路线？" }),
    ).toMatchObject({
      status: "insufficient_evidence",
      reason: "no_approved_answer",
    });
    expect(
      registry.query({
        ...identity,
        question: "故障后怎么报修，应该去哪里维修？",
      }),
    ).toMatchObject({
      status: "insufficient_evidence",
      reason: "ambiguous_approved_answers",
    });
  });

  it("compiles exact approved assertions and validates the full binding", async () => {
    const registry = await ProductKnowledgeRegistry.load({
      sourceDirectory,
      manifestPath,
    });
    const selection = {
      knowledgeBaseId: registry.snapshot.knowledgeBaseId,
      policyId: registry.snapshot.policyId,
      qaIds: ["fault-reporting"],
      assertions: [
        {
          claimId: "qualified-repair-sites",
          text: "车辆可送至所属品牌4S店或国家认证的具备二类（含）以上维修资质的维修站。",
        },
      ],
    };
    const binding = registry.compileSelection(selection);

    expect(binding.snapshot.knowledgeBaseId).toBe(selection.knowledgeBaseId);
    expect(binding.answers[0]?.qaId).toBe("fault-reporting");
    expect(binding.claims[0]?.claimId).toBe("qualified-repair-sites");
    expect(binding.bindingHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(registry.validateBinding(binding)).toEqual(binding);

    expect(() =>
      registry.compileSelection({
        ...selection,
        assertions: [
          {
            claimId: "qualified-repair-sites",
            text: "任何维修店都可以。",
          },
        ],
      }),
    ).toThrow(ProductKnowledgePolicyError);

    expect(() =>
      registry.compileSelection({
        knowledgeBaseId: registry.snapshot.knowledgeBaseId,
        policyId: registry.snapshot.policyId,
        qaIds: [],
        assertions: [],
      }),
    ).toThrow(/at least one approved answer or claim/u);

    expect(() =>
      registry.validateBinding({
        ...binding,
        claims: binding.claims.map((claim) => ({
          ...claim,
          approvedText: `${claim.approvedText}（被篡改）`,
        })),
      }),
    ).toThrow(ProductKnowledgePolicyError);
  });

  it("allows only selected verbatim facts in grounded Plan content", async () => {
    const registry = await ProductKnowledgeRegistry.load({
      sourceDirectory,
      manifestPath,
    });
    const binding = registry.compileSelection({
      knowledgeBaseId: registry.snapshot.knowledgeBaseId,
      policyId: registry.snapshot.policyId,
      qaIds: ["fault-reporting"],
      assertions: [
        {
          claimId: "qualified-repair-sites",
          text: "车辆可送至所属品牌4S店或国家认证的具备二类（含）以上维修资质的维修站。",
        },
      ],
    });
    const approvedBrief = [
      "写实旅行场景，成年车主在安全停车区查看手机。",
      "车辆发生故障后应该怎样报修？",
      "车辆发生故障后，应先联系Lynxon，并在车辆抵达合规维修机构后按指引报修；未经允许不要拆解维修。",
      "车辆可送至所属品牌4S店或国家认证的具备二类（含）以上维修资质的维修站。",
    ].join("\n");

    expect(
      registry.validateGroundedContent(binding, {
        brief: approvedBrief,
        stillPrompt: "电影级写实画面，车辆已安全停稳，主角神情焦急。",
        motionPrompt: "她查看手机，随后肩膀放松，表情逐渐舒展。",
      }),
    ).toEqual(binding);

    expect(() =>
      registry.validateGroundedContent(binding, {
        brief: `${approvedBrief}\n车援宝是保险，任何故障都百分百免费修。`,
      }),
    ).toThrow(
      /outside the exact approved binding|unsupported product outcome/u,
    );
    expect(() =>
      registry.validateGroundedContent(binding, {
        brief: approvedBrief,
        motionPrompt: "车坏了后再办也能处理。",
      }),
    ).toThrow(
      /outside the exact approved binding|unsupported product outcome or timing claim/u,
    );
    expect(() =>
      registry.validateGroundedContent(binding, {
        brief: `${approvedBrief}\n这个方案等车出毛病之后再加入也照样管。`,
      }),
    ).toThrow(/outside the exact approved binding/u);
    expect(() =>
      registry.validateGroundedContent(binding, {
        brief: approvedBrief.replace(
          "车辆可送至所属品牌4S店或国家认证的具备二类（含）以上维修资质的维修站。",
          "车辆可送至所属品牌4S店或国家认证的具备二类（含）以上维修资质的维修站。这个说法完全是假的。",
        ),
      }),
    ).toThrow(/isolated verbatim line/u);
    expect(() =>
      registry.validateGroundedContent(binding, {
        brief: approvedBrief.replace(
          "车辆发生故障后应该怎样报修？",
          "规范问答",
        ),
      }),
    ).toThrow(/must render approved Q&A/u);
    expect(() =>
      registry.validateGroundedContent(binding, {
        brief: `${approvedBrief}\n延长保修服务设有30日等待期，等待期内发生的故障不予赔偿。`,
      }),
    ).toThrow(/unselected approved/u);
  });

  it("deep-freezes snapshots, answers, claims, and bindings", async () => {
    const registry = await ProductKnowledgeRegistry.load({
      sourceDirectory,
      manifestPath,
    });
    const answer = registry.query({
      knowledgeBaseId: registry.snapshot.knowledgeBaseId,
      policyId: registry.snapshot.policyId,
      question: "车辆能去4S店维修吗？",
    });
    const binding = registry.compileSelection({
      knowledgeBaseId: registry.snapshot.knowledgeBaseId,
      policyId: registry.snapshot.policyId,
      qaIds: ["repair-sites"],
      assertions: [],
    });

    expect(Object.isFrozen(registry.snapshot)).toBe(true);
    expect(Object.isFrozen(registry.snapshot.ref)).toBe(true);
    expect(Object.isFrozen(registry.snapshot.corpusEntries)).toBe(true);
    expect(Object.isFrozen(registry.snapshot.corpusEntries[0])).toBe(true);
    expect(Object.isFrozen(answer)).toBe(true);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.answers[0]?.citations)).toBe(true);
  });

  it("uses protected terms as a bounded grounding trigger", async () => {
    const registry = await ProductKnowledgeRegistry.load({
      sourceDirectory,
      manifestPath,
    });

    expect(registry.requiresGrounding({ brief: "真实公路旅行故事" })).toBe(
      false,
    );
    expect(
      registry.requiresGrounding({ brief: "介绍车援宝的30日等待期" }),
    ).toBe(true);
    expect(registry.requiresGrounding({ brief: "LYNXON服务说明" })).toBe(true);
    expect(
      registry.requiresGrounding({
        brief: "力\u200b众的车辆故障保障服务，坏了再办也能全免",
      }),
    ).toBe(true);
    expect(
      registry.requiresGrounding({ brief: "机动车维修故障保障方案" }),
    ).toBe(true);
    expect(
      registry.requiresGrounding({
        brief:
          "介绍车\u034f延\u034f保：它是保\u034f险，任何毛病都免\u034f费处理。",
      }),
    ).toBe(true);
    expect(registry.requiresGrounding({ 车延保: "键名不参与扫描" })).toBe(
      false,
    );
    expect(registry.requiresGrounding("x".repeat(32_769))).toBe(true);

    let deeplyNested: unknown = "普通内容";
    for (let index = 0; index < 13; index += 1) {
      deeplyNested = { value: deeplyNested };
    }
    expect(registry.requiresGrounding(deeplyNested)).toBe(true);
  });

  it("fails closed when authoritative corpus content changes", async () => {
    const fixture = await createFixture();
    await appendFile(
      path.join(fixture.sourceDirectory, "01-PRODUCT/_通用条款/等待期.md"),
      "\n篡改内容\n",
      "utf8",
    );

    await expect(ProductKnowledgeRegistry.load(fixture)).rejects.toThrow(
      /corpus hash mismatch/u,
    );
  });

  it("fails closed when the manifest revision changes", async () => {
    const fixture = await createFixture();
    await mutateManifest(fixture, (manifest) => {
      manifest.source.revision = "0".repeat(40);
    });

    await expect(ProductKnowledgeRegistry.load(fixture)).rejects.toThrow(
      /pinned full revision/u,
    );
  });

  it.each([
    [
      "non-authoritative path",
      (manifest: Record<string, any>) => {
        manifest.policy.citations[0].path =
          "03-SALES/for-customers/faq/投保与凭证.md";
      },
      /safe authoritative path/u,
    ],
    [
      "missing anchor",
      (manifest: Record<string, any>) => {
        manifest.policy.citations[0].anchor = "^does-not-exist";
      },
      /anchor.+does not exist/u,
    ],
    [
      "missing evidence excerpt",
      (manifest: Record<string, any>) => {
        manifest.policy.citations[0].evidenceExcerpt = "不存在的证据";
      },
      /evidence excerpt does not exist/u,
    ],
  ])("rejects a citation with %s", async (_label, mutate, expected) => {
    const fixture = await createFixture();
    await mutateManifest(fixture, mutate);

    await expect(ProductKnowledgeRegistry.load(fixture)).rejects.toThrow(
      expected,
    );
  });

  it("rejects symbolic links and unknown files in the authoritative tree", async () => {
    const symlinkFixture = await createFixture();
    await symlink(
      path.join(
        symlinkFixture.sourceDirectory,
        "01-PRODUCT/_通用条款/等待期.md",
      ),
      path.join(symlinkFixture.sourceDirectory, "01-PRODUCT/linked.md"),
    );
    await expect(ProductKnowledgeRegistry.load(symlinkFixture)).rejects.toThrow(
      /symbolic link/u,
    );

    const unknownFixture = await createFixture();
    await writeFile(
      path.join(unknownFixture.sourceDirectory, "01-PRODUCT/unknown.txt"),
      "unknown",
      "utf8",
    );
    await expect(ProductKnowledgeRegistry.load(unknownFixture)).rejects.toThrow(
      /unknown file/u,
    );
  });

  it("rejects an oversized Markdown file before it can enter the corpus", async () => {
    const fixture = await createFixture();
    await writeFile(
      path.join(fixture.sourceDirectory, "01-PRODUCT/oversized.md"),
      "x".repeat(262_145),
      "utf8",
    );

    await expect(ProductKnowledgeRegistry.load(fixture)).rejects.toThrow(
      /exceeds 262144 bytes/u,
    );
  });

  it("wraps load failures in a stable configuration error", async () => {
    await expect(
      ProductKnowledgeRegistry.load({
        sourceDirectory: path.join(sourceDirectory, "missing"),
        manifestPath,
      }),
    ).rejects.toBeInstanceOf(ProductKnowledgeConfigurationError);
  });
});
