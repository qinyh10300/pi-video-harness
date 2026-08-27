import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  FakeImageBackend,
  FakeVideoBackend,
  type FakeBackendResultMetadata,
  type FakeImageCommand,
  type FakeVideoCommand,
} from "@pi-video-harness/backend-fake";
import type {
  ArtifactDescriptor,
  BackendJobRef,
  RunContext,
} from "@pi-video-harness/contracts";
import { SqliteCoreStore } from "@pi-video-harness/core";
import { ProductKnowledgeRegistry } from "@pi-video-harness/knowledge";
import { LocalArtifactStore } from "@pi-video-harness/media";

import { PipelineOrchestrator } from "./orchestrator.js";
import { ProfileRegistry } from "./profile-registry.js";

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
const groundedScenePrefix = "写实旅行场景，成年车主在安全停车区查看手机。";
const faultReportingQuestion = "车辆发生故障后应该怎样报修？";
const faultReportingAnswer =
  "车辆发生故障后，应先联系Lynxon，并在车辆抵达合规维修机构后按指引报修；未经允许不要拆解维修。";
const repairSitesQuestion = "车辆可以送到哪里维修？";
const repairSitesAnswer =
  "车辆可送至所属品牌4S店或国家认证的具备二类（含）以上维修资质的维修站。";

const groundedBrief = (...approvedFragments: readonly string[]): string =>
  [groundedScenePrefix, ...approvedFragments].join("\n");

const stores: SqliteCoreStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const makeHarness = async (
  defaultProfileId = "fake-image2-video-v1",
  backends?: {
    image?: FakeImageBackend;
    video?: FakeVideoBackend;
    knowledgeRegistry?: ProductKnowledgeRegistry;
    afterSubmissionIntentPersisted?: () => void | Promise<void>;
    afterGateContinuationPersisted?: () => void | Promise<void>;
    afterCancelContinuationPersisted?: () => void | Promise<void>;
    afterBackendResultReceived?: () => void | Promise<void>;
    afterBackendRunPersisted?: () => void | Promise<void>;
    afterLocalArtifactPersisted?: (intent: {
      kind: string;
    }) => void | Promise<void>;
    now?: () => Date;
  },
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "video-harness-e2e-"));
  const now = backends?.now ?? (() => new Date("2026-08-26T00:00:00.000Z"));
  const store = new SqliteCoreStore(path.join(directory, "state.sqlite"), {
    clock: now,
  });
  stores.push(store);
  const profiles = await ProfileRegistry.load({ directory: profileDirectory });
  let ordinal = 0;
  const artifactStore = new LocalArtifactStore({
    rootDirectory: path.join(directory, "artifacts"),
    now,
    syncWrites: false,
  });
  const orchestrator = new PipelineOrchestrator({
    store,
    profiles,
    defaultProfileId,
    artifactStore,
    now,
    idFactory: () => String(++ordinal),
    ...(backends?.image === undefined
      ? {}
      : { fakeImageBackend: backends.image }),
    ...(backends?.video === undefined
      ? {}
      : { fakeVideoBackend: backends.video }),
    ...(backends?.knowledgeRegistry === undefined
      ? {}
      : { knowledgeRegistry: backends.knowledgeRegistry }),
    ...(backends?.afterSubmissionIntentPersisted === undefined
      ? {}
      : {
          afterSubmissionIntentPersisted:
            backends.afterSubmissionIntentPersisted,
        }),
    ...(backends?.afterGateContinuationPersisted === undefined
      ? {}
      : {
          afterGateContinuationPersisted:
            backends.afterGateContinuationPersisted,
        }),
    ...(backends?.afterCancelContinuationPersisted === undefined
      ? {}
      : {
          afterCancelContinuationPersisted:
            backends.afterCancelContinuationPersisted,
        }),
    ...(backends?.afterBackendResultReceived === undefined
      ? {}
      : { afterBackendResultReceived: backends.afterBackendResultReceived }),
    ...(backends?.afterBackendRunPersisted === undefined
      ? {}
      : { afterBackendRunPersisted: backends.afterBackendRunPersisted }),
    ...(backends?.afterLocalArtifactPersisted === undefined
      ? {}
      : { afterLocalArtifactPersisted: backends.afterLocalArtifactPersisted }),
  });
  return { directory, store, profiles, artifactStore, orchestrator };
};

const openGate = (
  snapshot: ReturnType<PipelineOrchestrator["getPipeline"]>,
) => {
  const gate = snapshot.gates.find((candidate) => candidate.status === "open");
  expect(gate).toBeDefined();
  return gate!;
};

const transformVideoArtifacts = (
  backend: FakeVideoBackend,
  transform: (artifact: ArtifactDescriptor) => ArtifactDescriptor,
): void => {
  const originalWait = backend.waitUntilTerminal.bind(backend);
  backend.waitUntilTerminal = async (ref) => {
    const job = await originalWait(ref);
    if (job.result === undefined) return job;
    const idMap = new Map<string, string>();
    const artifacts = job.result.artifacts.map((artifact) => {
      const transformed = transform(artifact);
      idMap.set(artifact.artifactId, transformed.artifactId);
      return transformed;
    });
    const metadata = job.result.metadata as FakeBackendResultMetadata;
    const payloads = metadata.payloads.map((payload) => ({
      ...payload,
      artifactId: idMap.get(payload.artifactId) ?? payload.artifactId,
    }));
    return {
      ...job,
      result: {
        ...job.result,
        artifacts,
        metadata: { ...metadata, payloads },
      },
    };
  };
};

describe("PipelineOrchestrator offline E2E", () => {
  it("validates pinned product knowledge before the first model stage", async () => {
    let imageStarts = 0;
    const image = new FakeImageBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") imageStarts += 1;
      },
    });
    const knowledgeRegistry = await ProductKnowledgeRegistry.load({
      sourceDirectory: knowledgeSourceDirectory,
      manifestPath: knowledgeManifestPath,
    });
    const { orchestrator } = await makeHarness("fake-image2-video-v1", {
      image,
      knowledgeRegistry,
    });

    await expect(
      orchestrator.createPlan({
        brief: "车援宝支持全国任意维修厂直接维修。",
      }),
    ).rejects.toMatchObject({ code: "workflow_incompatible" });
    await expect(
      orchestrator.createPlan({
        brief:
          "介绍车\u034f延\u034f保：它是保\u034f险，任何毛病都免\u034f费处理。",
      }),
    ).rejects.toMatchObject({ code: "workflow_incompatible" });

    const plan = await orchestrator.createPlan({
      brief: groundedBrief(
        faultReportingQuestion,
        faultReportingAnswer,
        repairSitesQuestion,
        repairSitesAnswer,
      ),
      knowledge: {
        knowledgeBaseId: "lynxon-product-knowledge",
        policyId: "lynxon-video-content-policy-v1",
        qaIds: ["fault-reporting", "repair-sites"],
        assertions: [
          {
            claimId: "contact-before-repair",
            text: faultReportingAnswer,
          },
          {
            claimId: "qualified-repair-sites",
            text: repairSitesAnswer,
          },
        ],
      },
    });
    let snapshot = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "grounded-pipeline",
    });

    expect(imageStarts).toBe(0);
    expect(
      snapshot.stages.some((stage) => stage.kind === "knowledge_validate"),
    ).toBe(false);

    const gate = openGate(snapshot);
    snapshot = await orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "approve-grounded-plan",
      },
    );

    const knowledgeStage = snapshot.stages.find(
      (stage) => stage.kind === "knowledge_validate",
    );
    expect(knowledgeStage).toMatchObject({ status: "completed" });
    const report = snapshot.artifacts.find(
      (artifact) =>
        artifact.stageId === knowledgeStage?.stageId &&
        artifact.kind === "qa_report",
    );
    expect(report).toBeDefined();
    const reportBody = JSON.parse(
      (
        await orchestrator.readArtifactContent(
          snapshot.pipeline.pipelineId,
          report!.artifactId,
        )
      ).toString("utf8"),
    ) as Record<string, unknown>;
    expect(reportBody).toMatchObject({
      status: "passed",
      bindingHash: plan.knowledgeBinding?.bindingHash,
      snapshot: {
        revision: "4be08769b2e3459075490c7ab31924178ab44cd8",
      },
    });
    expect(imageStarts).toBe(1);
    let selectionGate = openGate(snapshot);
    expect(selectionGate.kind).toBe("image_selection");
    snapshot = await orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      selectionGate.gateId,
      {
        action: "select",
        selectedArtifactId: selectionGate.candidateArtifactIds[0]!,
        expectedPipelineVersion: selectionGate.expectedPipelineVersion,
        idempotencyKey: "select-grounded-image",
      },
    );
    selectionGate = openGate(snapshot);
    expect(selectionGate.kind).toBe("video_selection");
    snapshot = await orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      selectionGate.gateId,
      {
        action: "select",
        selectedArtifactId: selectionGate.candidateArtifactIds[0]!,
        expectedPipelineVersion: selectionGate.expectedPipelineVersion,
        idempotencyKey: "select-grounded-video",
      },
    );
    expect(openGate(snapshot).kind).toBe("final_acceptance");
    const manifest = snapshot.artifacts.find(
      (artifact) => artifact.kind === "manifest",
    );
    expect(manifest).toBeDefined();
    const manifestBody = JSON.parse(
      (
        await orchestrator.readArtifactContent(
          snapshot.pipeline.pipelineId,
          manifest!.artifactId,
        )
      ).toString("utf8"),
    ) as {
      plan: { knowledgeBinding?: { bindingHash: string } };
      artifacts: Array<{ artifactId: string }>;
    };
    expect(manifestBody.plan.knowledgeBinding?.bindingHash).toBe(
      plan.knowledgeBinding?.bindingHash,
    );
    expect(manifestBody.artifacts).toContainEqual({
      artifactId: report!.artifactId,
      kind: "qa_report",
      sha256: report!.sha256,
      sizeBytes: report!.sizeBytes,
    });
  });

  it("rejects unsupported insurance and absolute repair promises despite a valid knowledge selection", async () => {
    const knowledgeRegistry = await ProductKnowledgeRegistry.load({
      sourceDirectory: knowledgeSourceDirectory,
      manifestPath: knowledgeManifestPath,
    });
    const { orchestrator } = await makeHarness("fake-image2-video-v1", {
      knowledgeRegistry,
    });

    await expect(
      orchestrator.createPlan({
        brief: groundedBrief(
          faultReportingQuestion,
          faultReportingAnswer,
          "车援宝是保险，任何故障都百分百免费修。",
        ),
        knowledge: {
          knowledgeBaseId: "lynxon-product-knowledge",
          policyId: "lynxon-video-content-policy-v1",
          qaIds: ["fault-reporting"],
          assertions: [],
        },
      }),
    ).rejects.toMatchObject({ code: "workflow_incompatible" });

    await expect(
      orchestrator.createPlan({
        brief: groundedBrief(
          repairSitesQuestion,
          `${repairSitesAnswer}这个说法完全是假的。`,
        ),
        knowledge: {
          knowledgeBaseId: "lynxon-product-knowledge",
          policyId: "lynxon-video-content-policy-v1",
          qaIds: ["repair-sites"],
          assertions: [],
        },
      }),
    ).rejects.toMatchObject({ code: "workflow_incompatible" });

    await expect(
      orchestrator.createPlan({
        brief: groundedBrief(
          faultReportingQuestion,
          faultReportingAnswer,
          "这个方案等车出毛病之后再加入也照样管。",
        ),
        knowledge: {
          knowledgeBaseId: "lynxon-product-knowledge",
          policyId: "lynxon-video-content-policy-v1",
          qaIds: ["fault-reporting"],
          assertions: [],
        },
      }),
    ).rejects.toMatchObject({ code: "workflow_incompatible" });
  });

  it("fails closed before model execution when an approved knowledge snapshot is unavailable", async () => {
    let imageStarts = 0;
    const image = new FakeImageBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") imageStarts += 1;
      },
    });
    const knowledgeRegistry = await ProductKnowledgeRegistry.load({
      sourceDirectory: knowledgeSourceDirectory,
      manifestPath: knowledgeManifestPath,
    });
    const { store, profiles, artifactStore, orchestrator } = await makeHarness(
      "fake-image2-video-v1",
      { image, knowledgeRegistry },
    );
    const plan = await orchestrator.createPlan({
      brief: groundedBrief(faultReportingQuestion, faultReportingAnswer),
      knowledge: {
        knowledgeBaseId: "lynxon-product-knowledge",
        policyId: "lynxon-video-content-policy-v1",
        qaIds: ["fault-reporting"],
        assertions: [
          {
            claimId: "contact-before-repair",
            text: faultReportingAnswer,
          },
        ],
      },
    });
    const draft = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "missing-knowledge-pipeline",
    });
    const gate = openGate(draft);
    let ordinal = 0;
    const restarted = new PipelineOrchestrator({
      store,
      profiles,
      artifactStore,
      fakeImageBackend: image,
      idFactory: () => `restart-${++ordinal}`,
    });

    await expect(
      restarted.decideGate(draft.pipeline.pipelineId, gate.gateId, {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "approve-without-knowledge",
      }),
    ).rejects.toMatchObject({ code: "workflow_incompatible" });

    const failed = restarted.getPipeline(draft.pipeline.pipelineId);
    expect(failed.pipeline.status).toBe("needs_attention");
    expect(
      failed.stages.find((stage) => stage.kind === "knowledge_validate"),
    ).toMatchObject({ status: "failed" });
    expect(imageStarts).toBe(0);
  });

  it("revalidates the pinned binding before later video model stages", async () => {
    let videoStarts = 0;
    const video = new FakeVideoBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") videoStarts += 1;
      },
    });
    const knowledgeRegistry = await ProductKnowledgeRegistry.load({
      sourceDirectory: knowledgeSourceDirectory,
      manifestPath: knowledgeManifestPath,
    });
    const { store, profiles, artifactStore, orchestrator } = await makeHarness(
      "fake-image2-video-v1",
      { video, knowledgeRegistry },
    );
    const plan = await orchestrator.createPlan({
      brief: groundedBrief(repairSitesQuestion, repairSitesAnswer),
      knowledge: {
        knowledgeBaseId: "lynxon-product-knowledge",
        policyId: "lynxon-video-content-policy-v1",
        qaIds: ["repair-sites"],
        assertions: [
          {
            claimId: "qualified-repair-sites",
            text: repairSitesAnswer,
          },
        ],
      },
    });
    let snapshot = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "later-stage-knowledge-pipeline",
    });
    let gate = openGate(snapshot);
    snapshot = await orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "approve-later-stage-plan",
      },
    );
    gate = openGate(snapshot);
    expect(gate.kind).toBe("image_selection");

    let ordinal = 0;
    const restarted = new PipelineOrchestrator({
      store,
      profiles,
      artifactStore,
      fakeVideoBackend: video,
      idFactory: () => `video-restart-${++ordinal}`,
    });
    await expect(
      restarted.decideGate(snapshot.pipeline.pipelineId, gate.gateId, {
        action: "select",
        selectedArtifactId: gate.candidateArtifactIds[0]!,
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "select-image-without-knowledge",
      }),
    ).rejects.toMatchObject({ code: "workflow_incompatible" });

    expect(
      restarted.getPipeline(snapshot.pipeline.pipelineId).pipeline.status,
    ).toBe("needs_attention");
    expect(videoStarts).toBe(0);
  });

  it("blocks a recovered image submission before provider start when its knowledge report is missing", async () => {
    let imageStarts = 0;
    const image = new FakeImageBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") imageStarts += 1;
      },
    });
    const knowledgeRegistry = await ProductKnowledgeRegistry.load({
      sourceDirectory: knowledgeSourceDirectory,
      manifestPath: knowledgeManifestPath,
    });
    let crash = true;
    const harness = await makeHarness("fake-image2-video-v1", {
      image,
      knowledgeRegistry,
      afterSubmissionIntentPersisted: () => {
        if (!crash) return;
        crash = false;
        throw new Error("crash after grounded image intent");
      },
    });
    const plan = await harness.orchestrator.createPlan({
      brief: groundedBrief(faultReportingQuestion, faultReportingAnswer),
      knowledge: {
        knowledgeBaseId: "lynxon-product-knowledge",
        policyId: "lynxon-video-content-policy-v1",
        qaIds: ["fault-reporting"],
        assertions: [],
      },
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "grounded-image-recovery-pipeline",
    });
    const gate = openGate(snapshot);
    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "grounded-image-recovery-approval",
        },
      ),
    ).rejects.toThrow("crash after grounded image intent");
    expect(imageStarts).toBe(0);

    snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    const report = snapshot.artifacts.find(
      (artifact) =>
        artifact.kind === "qa_report" &&
        snapshot.stages.find((stage) => stage.stageId === artifact.stageId)
          ?.kind === "knowledge_validate",
    )!;
    const continuation = harness.store.outbox.getByDeduplicationKey(
      `gate-continuation:${gate.gateId}`,
    )!;
    expect(continuation.status).toBe("claimed");
    harness.store.outbox.complete(
      continuation.outboxId,
      continuation.leaseOwner!,
      { simulatedParentSettlement: true },
    );
    await unlink(await harness.artifactStore.pathFor(report.storagePath));

    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
      knowledgeRegistry,
      fakeImageBackend: image,
      fakeVideoBackend: new FakeVideoBackend(),
      workerId: "grounded-image-recovery-worker",
    });
    expect(await restarted.recover()).toEqual({ processed: 1, pending: 0 });
    snapshot = restarted.getPipeline(snapshot.pipeline.pipelineId);
    const imageStage = snapshot.stages.find(
      (stage) => stage.kind === "image_preview",
    );
    expect(imageStarts).toBe(0);
    expect(snapshot.pipeline.status).toBe("needs_attention");
    expect(imageStage?.status).toBe("failed");
    expect(
      snapshot.runs.find((run) => run.stageId === imageStage?.stageId)?.status,
    ).toBe("failed");
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
  });

  it("blocks a recovered final-video submission before provider start when its knowledge report is missing", async () => {
    let videoStarts = 0;
    const video = new FakeVideoBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") videoStarts += 1;
      },
    });
    const knowledgeRegistry = await ProductKnowledgeRegistry.load({
      sourceDirectory: knowledgeSourceDirectory,
      manifestPath: knowledgeManifestPath,
    });
    let crashNextSubmission = false;
    const harness = await makeHarness("fake-image2-video-v1", {
      video,
      knowledgeRegistry,
      afterSubmissionIntentPersisted: () => {
        if (!crashNextSubmission) return;
        crashNextSubmission = false;
        throw new Error("crash after grounded final-video intent");
      },
    });
    const plan = await harness.orchestrator.createPlan({
      brief: groundedBrief(repairSitesQuestion, repairSitesAnswer),
      knowledge: {
        knowledgeBaseId: "lynxon-product-knowledge",
        policyId: "lynxon-video-content-policy-v1",
        qaIds: ["repair-sites"],
        assertions: [],
      },
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "grounded-final-recovery-pipeline",
    });
    let gate = openGate(snapshot);
    snapshot = await harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "grounded-final-recovery-approval",
      },
    );
    gate = openGate(snapshot);
    snapshot = await harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "select",
        selectedArtifactId: gate.candidateArtifactIds[0]!,
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "grounded-final-recovery-image",
      },
    );
    gate = openGate(snapshot);
    expect(gate.kind).toBe("video_selection");
    const startsBeforeFinal = videoStarts;
    crashNextSubmission = true;
    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "select",
          selectedArtifactId: gate.candidateArtifactIds[0]!,
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "grounded-final-recovery-video",
        },
      ),
    ).rejects.toThrow("crash after grounded final-video intent");
    expect(videoStarts).toBe(startsBeforeFinal);

    snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    const report = snapshot.artifacts.find(
      (artifact) =>
        artifact.kind === "qa_report" &&
        snapshot.stages.find((stage) => stage.stageId === artifact.stageId)
          ?.kind === "knowledge_validate",
    )!;
    const continuation = harness.store.outbox.getByDeduplicationKey(
      `gate-continuation:${gate.gateId}`,
    )!;
    expect(continuation.status).toBe("claimed");
    harness.store.outbox.complete(
      continuation.outboxId,
      continuation.leaseOwner!,
      { simulatedParentSettlement: true },
    );
    await unlink(await harness.artifactStore.pathFor(report.storagePath));

    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
      knowledgeRegistry,
      fakeImageBackend: new FakeImageBackend(),
      fakeVideoBackend: video,
      workerId: "grounded-final-recovery-worker",
    });
    expect(await restarted.recover()).toEqual({ processed: 1, pending: 0 });
    snapshot = restarted.getPipeline(snapshot.pipeline.pipelineId);
    const finalStage = snapshot.stages.find(
      (stage) => stage.kind === "video_final",
    );
    expect(videoStarts).toBe(startsBeforeFinal);
    expect(snapshot.pipeline.status).toBe("needs_attention");
    expect(finalStage?.status).toBe("failed");
    expect(
      snapshot.runs.find((run) => run.stageId === finalStage?.stageId)?.status,
    ).toBe("failed");
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
  });

  it("revalidates the knowledge binding and report before final acceptance", async () => {
    const knowledgeRegistry = await ProductKnowledgeRegistry.load({
      sourceDirectory: knowledgeSourceDirectory,
      manifestPath: knowledgeManifestPath,
    });
    const harness = await makeHarness("fake-image2-video-v1", {
      knowledgeRegistry,
    });
    const plan = await harness.orchestrator.createPlan({
      brief: groundedBrief(faultReportingQuestion, faultReportingAnswer),
      knowledge: {
        knowledgeBaseId: "lynxon-product-knowledge",
        policyId: "lynxon-video-content-policy-v1",
        qaIds: ["fault-reporting"],
        assertions: [],
      },
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "grounded-final-acceptance-pipeline",
    });
    let gate = openGate(snapshot);
    snapshot = await harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "grounded-final-acceptance-plan",
      },
    );
    gate = openGate(snapshot);
    snapshot = await harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "select",
        selectedArtifactId: gate.candidateArtifactIds[0]!,
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "grounded-final-acceptance-image",
      },
    );
    gate = openGate(snapshot);
    snapshot = await harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "select",
        selectedArtifactId: gate.candidateArtifactIds[0]!,
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "grounded-final-acceptance-video",
      },
    );
    gate = openGate(snapshot);
    expect(gate.kind).toBe("final_acceptance");
    const report = snapshot.artifacts.find(
      (artifact) =>
        artifact.kind === "qa_report" &&
        snapshot.stages.find((stage) => stage.stageId === artifact.stageId)
          ?.kind === "knowledge_validate",
    )!;
    await unlink(await harness.artifactStore.pathFor(report.storagePath));

    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "grounded-final-acceptance-decision",
        },
      ),
    ).rejects.toMatchObject({ code: "missing_asset" });

    snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    expect(snapshot.pipeline.status).toBe("needs_attention");
    expect(snapshot.pipeline.status).not.toBe("completed");
    expect(harness.store.artifacts.isSuperseded(report.artifactId)).toBe(true);
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
  });

  it("completes all approval gates with no network or provider calls", async () => {
    let imageStarts = 0;
    let videoStarts = 0;
    const image = new FakeImageBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") imageStarts += 1;
      },
    });
    const video = new FakeVideoBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") videoStarts += 1;
      },
    });
    const { orchestrator, store } = await makeHarness("fake-image2-video-v1", {
      image,
      video,
    });

    const plan = await orchestrator.createPlan({
      brief: "A red fox takes one measured step in a quiet pine forest.",
      aspectRatio: "16:9",
      durationSeconds: 5,
      dryRun: true,
      idempotencyKey: "plan-e2e",
    });
    let snapshot = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "pipeline-e2e",
    });

    expect(snapshot.pipeline.status).toBe("awaiting_approval");
    expect(openGate(snapshot).kind).toBe("plan_approval");
    expect(imageStarts).toBe(0);
    expect(videoStarts).toBe(0);

    let gate = openGate(snapshot);
    snapshot = await orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "approve-plan",
      },
    );
    gate = openGate(snapshot);
    expect(gate.kind).toBe("image_selection");
    expect(gate.candidateArtifactIds).toHaveLength(2);
    expect(imageStarts).toBe(1);
    expect(videoStarts).toBe(0);

    snapshot = await orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "select",
        selectedArtifactId: gate.candidateArtifactIds[0]!,
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "select-image",
      },
    );
    gate = openGate(snapshot);
    expect(gate.kind).toBe("video_selection");
    expect(gate.candidateArtifactIds).toHaveLength(2);
    expect(videoStarts).toBe(2);

    snapshot = await orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "select",
        selectedArtifactId: gate.candidateArtifactIds[0]!,
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "select-video",
      },
    );
    gate = openGate(snapshot);
    expect(gate.kind).toBe("final_acceptance");
    expect(videoStarts).toBe(3);
    expect(snapshot.artifacts.some((item) => item.kind === "manifest")).toBe(
      true,
    );
    expect(
      snapshot.artifacts.find((item) => item.kind === "video_final")?.mimeType,
    ).toBe("application/vnd.pi-video-harness.fake-video+json");

    snapshot = await orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "approve-final",
      },
    );
    expect(snapshot.pipeline.status).toBe("completed");
    expect(snapshot.pipeline.approvedPlanHash).toBe(plan.planHash);
    expect(
      snapshot.stages.filter((item) => item.kind === "video_preview"),
    ).toHaveLength(1);
    const previewStage = snapshot.stages.find(
      (item) => item.kind === "video_preview",
    )!;
    expect(
      snapshot.runs.filter((run) => run.stageId === previewStage.stageId),
    ).toHaveLength(2);
    expect(store.outbox.listUnfinished()).toHaveLength(0);
    expect(store.recovery.listApprovalInvariantViolations()).toHaveLength(0);
  });

  it("replays top-level plan and pipeline idempotency without new model runs", async () => {
    let imageStarts = 0;
    const image = new FakeImageBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") imageStarts += 1;
      },
    });
    const { orchestrator } = await makeHarness("fake-image2-video-v1", {
      image,
    });
    const input = {
      brief: "A ceramic cup remains still on a wooden table.",
      idempotencyKey: "same-plan",
    };
    const firstPlan = await orchestrator.createPlan(input);
    const secondPlan = await orchestrator.createPlan(input);
    expect(secondPlan.planId).toBe(firstPlan.planId);

    const request = {
      planId: firstPlan.planId,
      expectedPlanHash: firstPlan.planHash,
      idempotencyKey: "same-pipeline",
    };
    const firstPipeline = await orchestrator.createPipeline(request);
    const secondPipeline = await orchestrator.createPipeline(request);
    expect(secondPipeline.pipeline.pipelineId).toBe(
      firstPipeline.pipeline.pipelineId,
    );
    expect(imageStarts).toBe(0);
    expect(
      secondPipeline.gates.filter((gate) => gate.kind === "plan_approval"),
    ).toHaveLength(1);
  });

  it("blocks the reserved real profile after plan approval", async () => {
    let imageStarts = 0;
    const image = new FakeImageBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") imageStarts += 1;
      },
    });
    const { orchestrator } = await makeHarness("gpt-image2-wan22-i2v-a14b-v1", {
      image,
    });
    const plan = await orchestrator.createPlan({ brief: "A runner pauses." });
    let snapshot = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "disabled-real-pipeline",
    });
    const gate = openGate(snapshot);

    snapshot = await orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "disabled-real-approval",
      },
    );

    expect(snapshot.pipeline.status).toBe("needs_attention");
    expect(imageStarts).toBe(0);
    expect(
      snapshot.stages.some((stage) => stage.kind === "image_preview"),
    ).toBe(false);
  });

  it("creates a new candidate batch on explicit image reroll", async () => {
    const { orchestrator } = await makeHarness();
    const plan = await orchestrator.createPlan({ brief: "A blue kite rises." });
    let snapshot = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "reroll-pipeline",
    });
    let gate = openGate(snapshot);
    snapshot = await orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "reroll-plan-approval",
      },
    );
    gate = openGate(snapshot);
    const originalCandidates = [...gate.candidateArtifactIds];
    const imageStage = snapshot.stages.find(
      (stage) => stage.kind === "image_preview" && stage.status === "completed",
    )!;

    snapshot = await orchestrator.reroll(snapshot.pipeline.pipelineId, {
      stageId: imageStage.stageId,
      expectedPipelineVersion: snapshot.pipeline.version,
      idempotencyKey: "image-reroll-1",
    });

    gate = openGate(snapshot);
    expect(gate.kind).toBe("image_selection");
    expect(gate.candidateArtifactIds).not.toEqual(originalCandidates);
    expect(
      snapshot.stages.filter((stage) => stage.kind === "image_preview"),
    ).toHaveLength(2);
    expect(
      snapshot.gates.some(
        (candidate) =>
          candidate.kind === "image_selection" &&
          candidate.status === "superseded",
      ),
    ).toBe(true);
  });

  it("recovers a crash after durable submission intent without losing the gate", async () => {
    let injectCrash = true;
    let recoveredImageStarts = 0;
    const harness = await makeHarness("fake-image2-video-v1", {
      afterSubmissionIntentPersisted: () => {
        if (injectCrash) {
          injectCrash = false;
          throw new Error("simulated process crash");
        }
      },
    });
    const plan = await harness.orchestrator.createPlan({
      brief: "A lantern sways once in a quiet room.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "crash-pipeline",
    });
    const gate = openGate(snapshot);

    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "crash-plan-approval",
        },
      ),
    ).rejects.toThrow("simulated process crash");
    expect(harness.store.outbox.listUnfinished()).toHaveLength(2);
    const interruptedStage = harness.store.stages
      .listForPipeline(snapshot.pipeline.pipelineId)
      .find((stage) => stage.kind === "image_preview");
    expect(interruptedStage).toBeDefined();
    expect(
      harness.store.runs
        .listForPipeline(snapshot.pipeline.pipelineId)
        .find((run) => run.stageId === interruptedStage?.stageId)?.status,
    ).toBe("submitting");

    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
      defaultProfileId: "fake-image2-video-v1",
      fakeImageBackend: new FakeImageBackend({
        faultInjector: ({ operation }) => {
          if (operation === "start") recoveredImageStarts += 1;
        },
      }),
      fakeVideoBackend: new FakeVideoBackend(),
    });
    const recovery = await restarted.recover();

    expect(recovery.pending).toBe(0);
    expect(recovery.processed).toBeGreaterThanOrEqual(1);
    expect(recovery.processed).toBeLessThanOrEqual(2);
    expect(recoveredImageStarts).toBe(1);
    snapshot = restarted.getPipeline(snapshot.pipeline.pipelineId);
    expect(openGate(snapshot).kind).toBe("image_selection");
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
    expect(
      harness.store.recovery.listApprovalInvariantViolations(),
    ).toHaveLength(0);
  });

  it("recovers a crash after a Gate decision commit before any model starts", async () => {
    let imageStarts = 0;
    let crash = true;
    const image = new FakeImageBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") imageStarts += 1;
      },
    });
    const harness = await makeHarness("fake-image2-video-v1", {
      image,
      afterGateContinuationPersisted: () => {
        if (crash) {
          crash = false;
          throw new Error("crash after gate commit");
        }
      },
    });
    const plan = await harness.orchestrator.createPlan({
      brief: "A paper boat drifts beneath a bridge.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "gate-crash-pipeline",
    });
    const gate = openGate(snapshot);

    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "gate-crash-decision",
        },
      ),
    ).rejects.toThrow("crash after gate commit");
    expect(imageStarts).toBe(0);
    expect(harness.store.outbox.listUnfinished()).toHaveLength(1);

    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
      fakeImageBackend: image,
      fakeVideoBackend: new FakeVideoBackend(),
    });
    expect(await restarted.recover()).toEqual({ processed: 1, pending: 0 });
    snapshot = restarted.getPipeline(snapshot.pipeline.pipelineId);
    expect(openGate(snapshot).kind).toBe("image_selection");
    expect(imageStarts).toBe(1);
  });

  it("recovers a checkpointed backend result without restarting a new driver instance", async () => {
    let originalImageStarts = 0;
    let crash = true;
    const image = new FakeImageBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") originalImageStarts += 1;
      },
    });
    const harness = await makeHarness("fake-image2-video-v1", {
      image,
      afterBackendResultReceived: () => {
        if (crash) {
          crash = false;
          throw new Error("crash after backend result");
        }
      },
    });
    const plan = await harness.orchestrator.createPlan({
      brief: "A glass marble rolls once across slate.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "result-crash-pipeline",
    });
    const gate = openGate(snapshot);
    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "result-crash-decision",
        },
      ),
    ).rejects.toThrow("crash after backend result");
    expect(originalImageStarts).toBe(1);

    let restartedImageStarts = 0;
    let restartedReconciliations = 0;
    const restartedImage = new FakeImageBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") restartedImageStarts += 1;
        if (operation === "reconcile") restartedReconciliations += 1;
      },
    });

    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
      fakeImageBackend: restartedImage,
      fakeVideoBackend: new FakeVideoBackend(),
    });
    await restarted.recover();
    snapshot = restarted.getPipeline(snapshot.pipeline.pipelineId);
    expect(openGate(snapshot).kind).toBe("image_selection");
    expect(originalImageStarts).toBe(1);
    expect(restartedImageStarts).toBe(0);
    expect(restartedReconciliations).toBe(0);
  });

  it("reconciles instead of discarding a paid result when checkpoint persistence fails once", async () => {
    let imageStarts = 0;
    let imageReconciliations = 0;
    const image = new FakeImageBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") imageStarts += 1;
        if (operation === "reconcile") imageReconciliations += 1;
      },
    });
    const harness = await makeHarness("fake-image2-video-v1", { image });
    const plan = await harness.orchestrator.createPlan({
      brief: "A copper coin spins once on a stone table.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "checkpoint-eio-pipeline",
    });

    const originalCheckpoint = harness.store.outbox.checkpoint.bind(
      harness.store.outbox,
    );
    let failCheckpoint = true;
    Object.defineProperty(harness.store.outbox, "checkpoint", {
      configurable: true,
      value: (...args: Parameters<typeof originalCheckpoint>) => {
        if (failCheckpoint) {
          failCheckpoint = false;
          throw Object.assign(new Error("checkpoint EIO"), { code: "EIO" });
        }
        return originalCheckpoint(...args);
      },
    });

    const gate = openGate(snapshot);
    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "checkpoint-eio-plan",
        },
      ),
    ).rejects.toThrow("checkpoint EIO");
    snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    expect(snapshot.pipeline.status).toBe("running");
    expect(snapshot.artifacts).toHaveLength(0);
    expect(imageStarts).toBe(1);

    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
      fakeImageBackend: image,
      fakeVideoBackend: new FakeVideoBackend(),
    });
    await restarted.recover();
    snapshot = restarted.getPipeline(snapshot.pipeline.pipelineId);
    expect(openGate(snapshot).kind).toBe("image_selection");
    expect(imageStarts).toBe(1);
    expect(imageReconciliations).toBe(1);
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
  });

  it.each(["run-complete", "outbox-complete", "completion-event"] as const)(
    "replays a checkpoint after one local %s persistence failure",
    async (failurePoint) => {
      let imageStarts = 0;
      let imageReconciliations = 0;
      const image = new FakeImageBackend({
        faultInjector: ({ operation }) => {
          if (operation === "start") imageStarts += 1;
          if (operation === "reconcile") imageReconciliations += 1;
        },
      });
      const harness = await makeHarness("fake-image2-video-v1", { image });
      const plan = await harness.orchestrator.createPlan({
        brief: "A blue glass bead rolls through one pool of light.",
      });
      let snapshot = await harness.orchestrator.createPipeline({
        planId: plan.planId,
        expectedPlanHash: plan.planHash,
        idempotencyKey: `settlement-${failurePoint}-pipeline`,
      });

      let failOnce = true;
      if (failurePoint === "run-complete") {
        const originalTransition = harness.store.runs.transition.bind(
          harness.store.runs,
        );
        Object.defineProperty(harness.store.runs, "transition", {
          configurable: true,
          value: (...args: Parameters<typeof originalTransition>) => {
            if (failOnce && args[1] === "completed") {
              failOnce = false;
              throw Object.assign(new Error("run complete EIO"), {
                code: "EIO",
              });
            }
            return originalTransition(...args);
          },
        });
      } else if (failurePoint === "outbox-complete") {
        const originalComplete = harness.store.outbox.complete.bind(
          harness.store.outbox,
        );
        Object.defineProperty(harness.store.outbox, "complete", {
          configurable: true,
          value: (...args: Parameters<typeof originalComplete>) => {
            const outbox = harness.store.outbox.get(args[0]);
            if (failOnce && outbox?.topic === "backend.start") {
              failOnce = false;
              throw Object.assign(new Error("outbox complete EIO"), {
                code: "EIO",
              });
            }
            return originalComplete(...args);
          },
        });
      } else {
        const originalAppend = harness.store.events.append.bind(
          harness.store.events,
        );
        Object.defineProperty(harness.store.events, "append", {
          configurable: true,
          value: (...args: Parameters<typeof originalAppend>) => {
            if (failOnce && args[0].eventType === "stage.run_completed") {
              failOnce = false;
              throw Object.assign(new Error("completion event EIO"), {
                code: "EIO",
              });
            }
            return originalAppend(...args);
          },
        });
      }

      const gate = openGate(snapshot);
      await expect(
        harness.orchestrator.decideGate(
          snapshot.pipeline.pipelineId,
          gate.gateId,
          {
            action: "approve",
            expectedPipelineVersion: gate.expectedPipelineVersion,
            idempotencyKey: `settlement-${failurePoint}-plan`,
          },
        ),
      ).rejects.toThrow("EIO");

      snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
      const imageStage = snapshot.stages.find(
        (stage) => stage.kind === "image_preview",
      )!;
      const imageRun = snapshot.runs.find(
        (run) => run.stageId === imageStage.stageId,
      )!;
      expect(snapshot.pipeline.status).toBe("running");
      expect(imageStage.status).toBe("active");
      expect(imageRun.status).not.toBe("failed");
      expect(imageRun.outputArtifactIds).toHaveLength(2);
      expect(
        imageRun.outputArtifactIds.every(
          (artifactId) => !harness.store.artifacts.isSuperseded(artifactId),
        ),
      ).toBe(true);
      expect(imageStarts).toBe(1);

      const restarted = new PipelineOrchestrator({
        store: harness.store,
        profiles: harness.profiles,
        artifactStore: harness.artifactStore,
        fakeImageBackend: image,
        fakeVideoBackend: new FakeVideoBackend(),
      });
      await restarted.recover();
      snapshot = restarted.getPipeline(snapshot.pipeline.pipelineId);
      expect(openGate(snapshot).kind).toBe("image_selection");
      expect(imageStarts).toBe(1);
      expect(imageReconciliations).toBe(0);
      expect(
        harness.store.events
          .list({ runId: imageRun.runId, limit: 100 })
          .filter((event) => event.eventType === "stage.run_completed"),
      ).toHaveLength(1);
      expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
    },
  );

  it("replays a checkpoint after a transient Artifact Store batch-write failure", async () => {
    let imageStarts = 0;
    const image = new FakeImageBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") imageStarts += 1;
      },
    });
    const harness = await makeHarness("fake-image2-video-v1", { image });
    const plan = await harness.orchestrator.createPlan({
      brief: "Two paper lanterns hang above a quiet lane.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "artifact-eio-pipeline",
    });

    const originalWrite = harness.artifactStore.writeArtifact.bind(
      harness.artifactStore,
    );
    let candidateWrites = 0;
    let failSecondCandidate = true;
    Object.defineProperty(harness.artifactStore, "writeArtifact", {
      configurable: true,
      value: (...args: Parameters<typeof originalWrite>) => {
        if (args[0].includes("/image_candidate/")) {
          candidateWrites += 1;
          if (candidateWrites === 2 && failSecondCandidate) {
            failSecondCandidate = false;
            throw Object.assign(new Error("artifact write EIO"), {
              code: "EIO",
            });
          }
        }
        return originalWrite(...args);
      },
    });

    const gate = openGate(snapshot);
    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "artifact-eio-plan",
        },
      ),
    ).rejects.toThrow("artifact write EIO");

    snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    const imageStage = snapshot.stages.find(
      (stage) => stage.kind === "image_preview",
    )!;
    const imageRun = snapshot.runs.find(
      (run) => run.stageId === imageStage.stageId,
    )!;
    expect(snapshot.pipeline.status).toBe("running");
    expect(imageRun.status).toBe("postprocessing");
    expect(imageRun.outputArtifactIds).toHaveLength(1);
    expect(
      harness.store.artifacts.isSuperseded(imageRun.outputArtifactIds[0]!),
    ).toBe(false);
    expect(imageStarts).toBe(1);

    let restartedStarts = 0;
    let restartedReconciliations = 0;
    const restartedImage = new FakeImageBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") restartedStarts += 1;
        if (operation === "reconcile") restartedReconciliations += 1;
      },
    });
    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
      fakeImageBackend: restartedImage,
      fakeVideoBackend: new FakeVideoBackend(),
    });
    await restarted.recover();
    snapshot = restarted.getPipeline(snapshot.pipeline.pipelineId);
    expect(openGate(snapshot).kind).toBe("image_selection");
    expect(openGate(snapshot).candidateArtifactIds).toHaveLength(2);
    expect(imageStarts).toBe(1);
    expect(restartedStarts).toBe(0);
    expect(restartedReconciliations).toBe(0);
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
  });

  it("resumes the logical Stage when its backend outbox already completed", async () => {
    let imageStarts = 0;
    let crash = true;
    const image = new FakeImageBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") imageStarts += 1;
      },
    });
    const harness = await makeHarness("fake-image2-video-v1", {
      image,
      afterBackendRunPersisted: () => {
        if (crash) {
          crash = false;
          throw new Error("crash after backend commit");
        }
      },
    });
    const plan = await harness.orchestrator.createPlan({
      brief: "A moth settles on a dark window.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "stage-crash-pipeline",
    });
    const gate = openGate(snapshot);
    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "stage-crash-decision",
        },
      ),
    ).rejects.toThrow("crash after backend commit");
    snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    expect(
      snapshot.stages.find((stage) => stage.kind === "image_preview")?.status,
    ).toBe("active");
    expect(
      snapshot.runs.find(
        (run) =>
          run.stageId ===
          snapshot.stages.find((stage) => stage.kind === "image_preview")
            ?.stageId,
      )?.status,
    ).toBe("completed");

    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
      fakeImageBackend: new FakeImageBackend(),
      fakeVideoBackend: new FakeVideoBackend(),
    });
    await restarted.recover();
    snapshot = restarted.getPipeline(snapshot.pipeline.pipelineId);
    expect(openGate(snapshot).kind).toBe("image_selection");
    expect(imageStarts).toBe(1);
  });

  it("resumes an interrupted local Artifact Stage without rewriting output", async () => {
    let crash = true;
    const harness = await makeHarness("fake-image2-video-v1", {
      afterLocalArtifactPersisted: ({ kind }) => {
        if (kind === "qa_report" && crash) {
          crash = false;
          throw new Error("crash after local artifact");
        }
      },
    });
    const plan = await harness.orchestrator.createPlan({
      brief: "A fern uncurls in soft morning light.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "local-crash-pipeline",
    });
    const gate = openGate(snapshot);
    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "local-crash-decision",
        },
      ),
    ).rejects.toThrow("crash after local artifact");
    snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    expect(
      snapshot.stages.find((stage) => stage.kind === "image_validate")?.status,
    ).toBe("active");
    expect(
      snapshot.artifacts.filter((artifact) => artifact.kind === "qa_report"),
    ).toHaveLength(1);

    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
      fakeImageBackend: new FakeImageBackend(),
      fakeVideoBackend: new FakeVideoBackend(),
    });
    await restarted.recover();
    snapshot = restarted.getPipeline(snapshot.pipeline.pipelineId);
    expect(openGate(snapshot).kind).toBe("image_selection");
    expect(
      snapshot.artifacts.filter((artifact) => artifact.kind === "qa_report"),
    ).toHaveLength(1);
  });

  it("settles a selected local Artifact that disappears before copying", async () => {
    const harness = await makeHarness();
    const plan = await harness.orchestrator.createPlan({
      brief: "A single soap bubble rises past a charcoal wall.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "missing-candidate-pipeline",
    });
    let gate = openGate(snapshot);
    snapshot = await harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "missing-candidate-plan",
      },
    );
    gate = openGate(snapshot);
    const selectedArtifactId = gate.candidateArtifactIds[0]!;
    const selected = snapshot.artifacts.find(
      (artifact) => artifact.artifactId === selectedArtifactId,
    )!;
    await unlink(await harness.artifactStore.pathFor(selected.storagePath));

    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "select",
          selectedArtifactId,
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "missing-candidate-select",
        },
      ),
    ).rejects.toMatchObject({ code: "missing_asset" });

    snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    const failedStage = snapshot.stages.find(
      (stage) => stage.kind === "image_final",
    );
    expect(snapshot.pipeline.status).toBe("needs_attention");
    expect(failedStage?.status).toBe("failed");
    expect(
      snapshot.runs.find((run) => run.stageId === failedStage?.stageId)?.status,
    ).toBe("failed");
    expect(
      snapshot.gates.some((candidate) => candidate.status === "open"),
    ).toBe(false);
    expect(harness.store.artifacts.isSuperseded(selectedArtifactId)).toBe(true);
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);

    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
    });
    expect(await restarted.recover()).toEqual({ processed: 0, pending: 0 });
    expect(
      restarted.getPipeline(snapshot.pipeline.pipelineId).pipeline.status,
    ).toBe("needs_attention");
  });

  it("classifies a corrupted selected Artifact as decode_failed", async () => {
    const harness = await makeHarness();
    const plan = await harness.orchestrator.createPlan({
      brief: "A blue bead rolls along a pale wooden groove.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "corrupt-candidate-pipeline",
    });
    let gate = openGate(snapshot);
    snapshot = await harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "corrupt-candidate-plan",
      },
    );
    gate = openGate(snapshot);
    const selectedArtifactId = gate.candidateArtifactIds[0]!;
    const selected = snapshot.artifacts.find(
      (artifact) => artifact.artifactId === selectedArtifactId,
    )!;
    await writeFile(
      await harness.artifactStore.pathFor(selected.storagePath),
      "corrupted",
    );

    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "select",
          selectedArtifactId,
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "corrupt-candidate-select",
        },
      ),
    ).rejects.toMatchObject({ code: "decode_failed" });
    snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    expect(snapshot.pipeline.status).toBe("needs_attention");
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
  });

  it("isolates a missing local output during startup recovery", async () => {
    let crash = true;
    const harness = await makeHarness("fake-image2-video-v1", {
      afterLocalArtifactPersisted: ({ kind }) => {
        if (kind === "qa_report" && crash) {
          crash = false;
          throw new Error("crash before local output completion");
        }
      },
    });
    const plan = await harness.orchestrator.createPlan({
      brief: "A small paper boat drifts once across a dark basin.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "missing-local-output-pipeline",
    });
    const gate = openGate(snapshot);
    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "missing-local-output-plan",
        },
      ),
    ).rejects.toThrow("crash before local output completion");
    snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    const report = snapshot.artifacts.find(
      (artifact) => artifact.kind === "qa_report",
    )!;
    await unlink(await harness.artifactStore.pathFor(report.storagePath));
    expect(harness.store.outbox.listUnfinished()).toHaveLength(1);

    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
    });
    expect(await restarted.recover()).toEqual({ processed: 1, pending: 0 });
    snapshot = restarted.getPipeline(snapshot.pipeline.pipelineId);
    const failedStage = snapshot.stages.find(
      (stage) => stage.kind === "image_validate",
    );
    expect(snapshot.pipeline.status).toBe("needs_attention");
    expect(failedStage?.status).toBe("failed");
    expect(
      snapshot.runs.find((run) => run.stageId === failedStage?.stageId)?.status,
    ).toBe("failed");
    expect(harness.store.artifacts.isSuperseded(report.artifactId)).toBe(true);
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
  });

  it("resumes one durable reroll ordinal instead of allocating another", async () => {
    let crashOnSubmission = false;
    const harness = await makeHarness("fake-image2-video-v1", {
      afterSubmissionIntentPersisted: () => {
        if (crashOnSubmission) {
          crashOnSubmission = false;
          throw new Error("crash during reroll");
        }
      },
    });
    const plan = await harness.orchestrator.createPlan({
      brief: "A white flag moves once in a light breeze.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "reroll-recovery-pipeline",
    });
    let gate = openGate(snapshot);
    snapshot = await harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "reroll-recovery-plan",
      },
    );
    const source = snapshot.stages.find(
      (stage) => stage.kind === "image_preview" && stage.status === "completed",
    )!;
    crashOnSubmission = true;
    await expect(
      harness.orchestrator.reroll(snapshot.pipeline.pipelineId, {
        stageId: source.stageId,
        expectedPipelineVersion: snapshot.pipeline.version,
        idempotencyKey: "durable-reroll",
      }),
    ).rejects.toThrow("crash during reroll");

    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
      fakeImageBackend: new FakeImageBackend(),
      fakeVideoBackend: new FakeVideoBackend(),
    });
    await restarted.recover();
    snapshot = restarted.getPipeline(snapshot.pipeline.pipelineId);
    gate = openGate(snapshot);
    expect(gate.kind).toBe("image_selection");
    expect(
      snapshot.stages.filter((stage) => stage.kind === "image_preview"),
    ).toHaveLength(2);
    expect(
      harness.store.idempotency.get(
        `pipeline-reroll:${snapshot.pipeline.pipelineId}`,
        "durable-reroll",
      )?.status,
    ).toBe("completed");
  });

  it("preserves final ancestry and uses the input frame for poster lineage", async () => {
    const { orchestrator, store } = await makeHarness();
    const plan = await orchestrator.createPlan({
      brief: "A red ribbon lifts gently from a table.",
    });
    let snapshot = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "lineage-pipeline",
    });
    for (;;) {
      const gate = openGate(snapshot);
      const value =
        gate.kind === "image_selection" || gate.kind === "video_selection"
          ? {
              action: "select" as const,
              selectedArtifactId: gate.candidateArtifactIds[0]!,
              expectedPipelineVersion: gate.expectedPipelineVersion,
              idempotencyKey: `lineage-${gate.kind}`,
            }
          : {
              action: "approve" as const,
              expectedPipelineVersion: gate.expectedPipelineVersion,
              idempotencyKey: `lineage-${gate.kind}`,
            };
      snapshot = await orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        value,
      );
      if (snapshot.pipeline.status === "completed") break;
    }
    const final = snapshot.artifacts.find(
      (artifact) => artifact.kind === "video_final",
    )!;
    const ancestorKinds = new Set(
      store.artifacts
        .ancestors(final.artifactId)
        .map((artifact) => artifact.kind),
    );
    expect(ancestorKinds).toContain("wan_input_frame");
    expect(ancestorKinds).toContain("image_candidate");
    const frame = snapshot.artifacts.find(
      (artifact) => artifact.kind === "wan_input_frame",
    )!;
    const raw = snapshot.artifacts.find(
      (artifact) => artifact.kind === "video_raw",
    )!;
    const poster = snapshot.artifacts.find(
      (artifact) => artifact.kind === "poster",
    )!;
    const posterParents = store.artifacts.listRelations(
      poster.artifactId,
      "parents",
    );
    expect(
      posterParents.some(
        (relation) => relation.parentArtifactId === frame.artifactId,
      ),
    ).toBe(true);
    expect(
      posterParents.some(
        (relation) => relation.parentArtifactId === raw.artifactId,
      ),
    ).toBe(false);
  });

  it("rejects reference assets before a Gate can approve unsupported work", async () => {
    const { orchestrator } = await makeHarness();
    await expect(
      orchestrator.createPlan({
        brief: "A portrait remains still.",
        referenceAssetIds: ["asset-without-ingestion"],
      }),
    ).rejects.toMatchObject({ code: "missing_asset" });
  });

  it("persists cancellation as an idempotent durable continuation", async () => {
    const { orchestrator, store } = await makeHarness();
    const plan = await orchestrator.createPlan({
      brief: "A closed book rests on a desk.",
    });
    let snapshot = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "cancel-pipeline",
    });
    const request = {
      idempotencyKey: "cancel-once",
      reason: "No longer needed",
    };
    snapshot = await orchestrator.cancelPipeline(
      snapshot.pipeline.pipelineId,
      request,
    );
    expect(snapshot.pipeline.status).toBe("cancelled");
    expect(snapshot.gates.every((gate) => gate.status === "superseded")).toBe(
      true,
    );
    const replay = await orchestrator.cancelPipeline(
      snapshot.pipeline.pipelineId,
      request,
    );
    expect(replay.pipeline.status).toBe("cancelled");
    expect(store.outbox.listUnfinished()).toHaveLength(0);
    expect(
      store.idempotency.get(
        `pipeline-cancel:${snapshot.pipeline.pipelineId}`,
        "cancel-once",
      )?.status,
    ).toBe("completed");
  });

  it("cancels a durable backend intent before provider start", async () => {
    let enterIntent!: () => void;
    let releaseIntent!: () => void;
    const intentEntered = new Promise<void>((resolve) => {
      enterIntent = resolve;
    });
    const intentBlocked = new Promise<void>((resolve) => {
      releaseIntent = resolve;
    });
    let imageStarts = 0;
    const image = new FakeImageBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") imageStarts += 1;
      },
    });
    const harness = await makeHarness("fake-image2-video-v1", {
      image,
      afterSubmissionIntentPersisted: async () => {
        enterIntent();
        await intentBlocked;
      },
    });
    const plan = await harness.orchestrator.createPlan({
      brief: "A wooden top waits motionless on a clean table.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "cancel-pending-pipeline",
    });
    const gate = openGate(snapshot);
    const approving = harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "cancel-pending-plan",
      },
    );
    await intentEntered;

    try {
      snapshot = await harness.orchestrator.cancelPipeline(
        snapshot.pipeline.pipelineId,
        {
          idempotencyKey: "cancel-pending-request",
          reason: "cancel before provider start",
        },
      );
      expect(snapshot.pipeline.status).toBe("cancelled");
    } finally {
      releaseIntent();
    }

    snapshot = await approving;
    expect(snapshot.pipeline.status).toBe("cancelled");
    expect(imageStarts).toBe(0);
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
  });

  it("reports an in-flight start without a backend reference as outcome_unknown on cancellation", async () => {
    let enterStart!: () => void;
    let releaseStart!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      enterStart = resolve;
    });
    const startBlocked = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let imageStarts = 0;
    const image = new FakeImageBackend({
      faultInjector: async ({ operation }) => {
        if (operation !== "start") return;
        imageStarts += 1;
        if (imageStarts === 1) {
          enterStart();
          await startBlocked;
        }
      },
    });
    const harness = await makeHarness("fake-image2-video-v1", { image });
    const plan = await harness.orchestrator.createPlan({
      brief: "A brass spinner begins one slow rotation.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "cancel-inflight-pipeline",
    });
    const gate = openGate(snapshot);
    const approving = harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "cancel-inflight-plan",
      },
    );
    await startEntered;

    let cancellationSnapshot: typeof snapshot | undefined;
    try {
      cancellationSnapshot = await harness.orchestrator.cancelPipeline(
        snapshot.pipeline.pipelineId,
        {
          idempotencyKey: "cancel-inflight-request",
          reason: "cancel during provider start",
        },
      );
    } finally {
      releaseStart();
    }

    await expect(approving).rejects.toMatchObject({
      code: "image_generation_ambiguous",
    });
    expect(cancellationSnapshot).toBeDefined();
    const uncertainRun = cancellationSnapshot!.runs.find(
      (run) =>
        cancellationSnapshot!.stages.find(
          (stage) => stage.stageId === run.stageId,
        )?.kind === "image_preview",
    );
    expect(cancellationSnapshot!.pipeline.status).toBe("needs_attention");
    expect(uncertainRun?.status).toBe("outcome_unknown");
    expect(uncertainRun?.backendRef).toBeUndefined();
    snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    expect(snapshot.pipeline.status).toBe("needs_attention");
    expect(imageStarts).toBe(1);
    expect(snapshot.artifacts).toHaveLength(0);
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
  });

  it("persists a video job reference returned after cancellation and settles recovery", async () => {
    let enterStart!: () => void;
    let releaseStart!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      enterStart = resolve;
    });
    const startBlocked = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let startCalls = 0;
    let returnedRef: BackendJobRef | undefined;
    const video = new FakeVideoBackend({
      faultInjector: async ({ operation }) => {
        if (operation !== "start") return;
        startCalls += 1;
        if (startCalls === 1) {
          enterStart();
          await startBlocked;
        }
      },
    });
    const originalStart = video.start.bind(video);
    video.start = async (command, context) => {
      const result = await originalStart(command, context);
      if (result.kind === "submitted") returnedRef = result.ref;
      return result;
    };
    const harness = await makeHarness("fake-image2-video-v1", { video });
    const plan = await harness.orchestrator.createPlan({
      brief: "A glass marble begins rolling, then the request is cancelled.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "cancel-video-start-pipeline",
    });
    let gate = openGate(snapshot);
    snapshot = await harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "cancel-video-start-plan",
      },
    );
    gate = openGate(snapshot);
    const selectingImage = harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "select",
        selectedArtifactId: gate.candidateArtifactIds[0]!,
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "cancel-video-start-image",
      },
    );
    await startEntered;

    try {
      snapshot = await harness.orchestrator.cancelPipeline(
        snapshot.pipeline.pipelineId,
        {
          idempotencyKey: "cancel-video-start-request",
          reason: "cancel while video provider.start is in flight",
        },
      );
      expect(snapshot.pipeline.status).toBe("needs_attention");
    } finally {
      releaseStart();
    }

    await expect(selectingImage).rejects.toMatchObject({
      code: "backend_timeout",
    });
    snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    const videoStage = snapshot.stages.find(
      (stage) => stage.kind === "video_preview",
    );
    expect(videoStage).toMatchObject({
      status: "failed",
      currentOutputArtifactIds: [],
    });
    expect(videoStage?.activeRunId).toBeUndefined();
    const videoRun = snapshot.runs.find(
      (run) => run.stageId === videoStage?.stageId,
    );
    expect(returnedRef).toBeDefined();
    expect(videoRun).toMatchObject({
      status: "outcome_unknown",
      backendRef: returnedRef,
    });
    expect(
      snapshot.gates.some((candidate) => candidate.status === "open"),
    ).toBe(false);
    expect(
      snapshot.artifacts.some(
        (artifact) =>
          artifact.kind === "video_preview" &&
          harness.store.artifacts.isSuperseded(artifact.artifactId) === false,
      ),
    ).toBe(false);
    const submissionKey = harness.store.runs.metadata(
      videoRun!.runId,
    ).submissionKey;
    expect(
      harness.store.outbox.getByDeduplicationKey(submissionKey),
    ).toMatchObject({ status: "dead", lastError: "outcome_unknown" });
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
    expect(await harness.orchestrator.recover()).toEqual({
      processed: 0,
      pending: 0,
    });
    expect(startCalls).toBe(1);
  });

  it("persists a pending reconciliation reference returned after cancellation", async () => {
    let enterIntent!: () => void;
    let releaseIntent!: () => void;
    const intentEntered = new Promise<void>((resolve) => {
      enterIntent = resolve;
    });
    const intentBlocked = new Promise<void>((resolve) => {
      releaseIntent = resolve;
    });
    let blockNextIntent = false;
    const video = new FakeVideoBackend();
    const harness = await makeHarness("fake-image2-video-v1", {
      video,
      afterSubmissionIntentPersisted: async () => {
        if (!blockNextIntent) return;
        blockNextIntent = false;
        enterIntent();
        await intentBlocked;
      },
    });
    const plan = await harness.orchestrator.createPlan({
      brief: "A reconciliation returns its job reference during cancellation.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "reconcile-cancel-pipeline",
    });
    let gate = openGate(snapshot);
    snapshot = await harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "reconcile-cancel-plan",
      },
    );
    gate = openGate(snapshot);
    blockNextIntent = true;
    const selectingImage = harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "select",
        selectedArtifactId: gate.candidateArtifactIds[0]!,
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "reconcile-cancel-image",
      },
    );
    await intentEntered;

    const inFlight = harness.orchestrator.getPipeline(
      snapshot.pipeline.pipelineId,
    );
    const videoStage = inFlight.stages.find(
      (stage) => stage.kind === "video_preview",
    )!;
    const videoRun = inFlight.runs.find(
      (run) => run.stageId === videoStage.stageId,
    )!;
    const submissionKey = harness.store.runs.metadata(
      videoRun.runId,
    ).submissionKey;
    const submission = harness.store.outbox.getByDeduplicationKey<{
      command: FakeVideoCommand;
      context: RunContext;
    }>(submissionKey)!;
    const started = await video.start(
      submission.payload.command,
      submission.payload.context,
    );
    expect(started.kind).toBe("submitted");
    const returnedRef = started.kind === "submitted" ? started.ref : undefined;

    let enterReconcile!: () => void;
    let releaseReconcile!: () => void;
    const reconcileEntered = new Promise<void>((resolve) => {
      enterReconcile = resolve;
    });
    const reconcileBlocked = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    video.reconcile = async () => {
      enterReconcile();
      await reconcileBlocked;
      return { kind: "pending", ref: returnedRef! };
    };

    const imageGateContinuation = harness.store.outbox.getByDeduplicationKey(
      `gate-continuation:${gate.gateId}`,
    )!;
    expect(imageGateContinuation.status).toBe("claimed");
    harness.store.outbox.complete(
      imageGateContinuation.outboxId,
      imageGateContinuation.leaseOwner!,
      { testSettlement: true },
    );
    const firstClaim = harness.store.outbox.claimById(submission.outboxId, {
      workerId: "simulated-crashed-worker",
    });
    expect(firstClaim?.attemptCount).toBe(1);
    harness.store.outbox.requeueClaimedForRecovery();

    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
      fakeImageBackend: new FakeImageBackend(),
      fakeVideoBackend: video,
      workerId: "reconcile-race-worker",
    });
    const recovering = restarted.recover();
    await reconcileEntered;
    try {
      snapshot = await restarted.cancelPipeline(snapshot.pipeline.pipelineId, {
        idempotencyKey: "reconcile-cancel-request",
        reason: "cancel while reconcile is in flight",
      });
      expect(snapshot.pipeline.status).toBe("needs_attention");
    } finally {
      releaseReconcile();
    }

    expect(await recovering).toEqual({ processed: 1, pending: 0 });
    releaseIntent();
    await expect(selectingImage).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    snapshot = restarted.getPipeline(snapshot.pipeline.pipelineId);
    const settledStage = snapshot.stages.find(
      (stage) => stage.stageId === videoStage.stageId,
    );
    const settledRun = snapshot.runs.find(
      (run) => run.runId === videoRun.runId,
    );
    expect(settledStage).toMatchObject({
      status: "failed",
      currentOutputArtifactIds: [],
    });
    expect(settledStage?.activeRunId).toBeUndefined();
    expect(settledRun).toMatchObject({
      status: "outcome_unknown",
      backendRef: returnedRef,
    });
    expect(
      harness.store.outbox.getByDeduplicationKey(submissionKey),
    ).toMatchObject({ status: "dead", lastError: "outcome_unknown" });
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
    expect(await restarted.recover()).toEqual({ processed: 0, pending: 0 });
  });

  it("settles the outer workflow when a backend outcome needs attention", async () => {
    const image = new FakeImageBackend({ unknownOutcome: true });
    const harness = await makeHarness("fake-image2-video-v1", { image });
    const plan = await harness.orchestrator.createPlan({
      brief: "A pendulum moves behind frosted glass.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "unknown-pipeline",
    });
    const gate = openGate(snapshot);
    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "unknown-decision",
        },
      ),
    ).rejects.toMatchObject({ code: "image_generation_ambiguous" });
    snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    expect(snapshot.pipeline.status).toBe("needs_attention");
    expect(snapshot.runs.some((run) => run.status === "outcome_unknown")).toBe(
      true,
    );
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);

    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
      fakeImageBackend: image,
      fakeVideoBackend: new FakeVideoBackend(),
    });
    expect(await restarted.recover()).toEqual({ processed: 0, pending: 0 });
    expect(
      restarted.getPipeline(snapshot.pipeline.pipelineId).pipeline.status,
    ).toBe("needs_attention");
  });

  it("keeps backend diagnostic text out of public pipeline errors", async () => {
    const privateDiagnostic =
      "Provider response for customer@example.com contained private internals";
    const image = new FakeImageBackend({
      terminalError: {
        code: "backend_unavailable",
        message: privateDiagnostic,
        retryDisposition: "limited",
        details: { responseBody: "private provider response" },
      },
    });
    const harness = await makeHarness("fake-image2-video-v1", { image });
    const plan = await harness.orchestrator.createPlan({
      brief: "A sealed envelope rests on a desk.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "private-backend-error-pipeline",
    });
    const gate = openGate(snapshot);

    let publicError: unknown;
    try {
      await harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "private-backend-error-decision",
        },
      );
    } catch (error) {
      publicError = error;
    }
    expect(publicError).toMatchObject({
      code: "backend_unavailable",
      message: "Backend execution failed",
    });
    expect(String(publicError)).not.toContain(privateDiagnostic);

    snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    expect(snapshot.pipeline.status).toBe("failed");
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
  });

  it("coalesces concurrent replay of the same Gate decision", async () => {
    const image = new FakeImageBackend({ delayMs: 10 });
    const { orchestrator } = await makeHarness("fake-image2-video-v1", {
      image,
    });
    const plan = await orchestrator.createPlan({
      brief: "A tiny wheel makes one slow turn.",
    });
    const initial = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "concurrent-pipeline",
    });
    const gate = openGate(initial);
    const request = {
      action: "approve" as const,
      expectedPipelineVersion: gate.expectedPipelineVersion,
      idempotencyKey: "same-concurrent-decision",
    };
    const results = await Promise.all([
      orchestrator.decideGate(
        initial.pipeline.pipelineId,
        gate.gateId,
        request,
      ),
      orchestrator.decideGate(
        initial.pipeline.pipelineId,
        gate.gateId,
        request,
      ),
    ]);
    expect(results).toHaveLength(2);
    const settled = orchestrator.getPipeline(initial.pipeline.pipelineId);
    expect(openGate(settled).kind).toBe("image_selection");
    expect(
      settled.stages.filter((stage) => stage.kind === "image_preview"),
    ).toHaveLength(1);
  });

  it("coalesces an idempotent Gate replay after its lease timestamp expires", async () => {
    let currentTime = new Date("2026-08-26T00:00:00.000Z");
    let enterStart!: () => void;
    let releaseStart!: () => void;
    const startEntered = new Promise<void>((resolve) => {
      enterStart = resolve;
    });
    const startBlocked = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let imageStarts = 0;
    const image = new FakeImageBackend({
      faultInjector: async ({ operation }) => {
        if (operation !== "start") return;
        imageStarts += 1;
        if (imageStarts === 1) {
          enterStart();
          await startBlocked;
        }
      },
    });
    const { orchestrator, store } = await makeHarness("fake-image2-video-v1", {
      image,
      now: () => new Date(currentTime),
    });
    const plan = await orchestrator.createPlan({
      brief: "A pendulum crosses the center of a quiet clock face.",
    });
    const initial = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "expired-lease-pipeline",
    });
    const gate = openGate(initial);
    const request = {
      action: "approve" as const,
      expectedPipelineVersion: gate.expectedPipelineVersion,
      idempotencyKey: "expired-lease-decision",
    };
    const first = orchestrator.decideGate(
      initial.pipeline.pipelineId,
      gate.gateId,
      request,
    );
    await startEntered;

    currentTime = new Date("2026-08-26T00:00:31.000Z");
    const replay = orchestrator.decideGate(
      initial.pipeline.pipelineId,
      gate.gateId,
      request,
    );
    await Promise.resolve();
    expect(imageStarts).toBe(1);
    expect(
      store.outbox.listUnfinished().map((message) => message.attemptCount),
    ).toEqual([1, 1]);

    releaseStart();
    const results = await Promise.all([first, replay]);
    expect(results).toHaveLength(2);
    expect(imageStarts).toBe(1);
    const settled = orchestrator.getPipeline(initial.pipeline.pipelineId);
    expect(openGate(settled).kind).toBe("image_selection");
    expect(store.outbox.listUnfinished()).toHaveLength(0);
  });

  it("rejects a new reroll while a decided Gate continuation is still running", async () => {
    let enterBlockedResult!: () => void;
    let releaseBlockedResult!: () => void;
    const blockedResultEntered = new Promise<void>((resolve) => {
      enterBlockedResult = resolve;
    });
    const blockedResult = new Promise<void>((resolve) => {
      releaseBlockedResult = resolve;
    });
    let blockNextResult = false;
    const { orchestrator } = await makeHarness("fake-image2-video-v1", {
      afterBackendResultReceived: async () => {
        if (!blockNextResult) return;
        blockNextResult = false;
        enterBlockedResult();
        await blockedResult;
      },
    });
    const plan = await orchestrator.createPlan({
      brief: "A paper pinwheel turns once beside a still window.",
    });
    let snapshot = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "reroll-race-pipeline",
    });
    let gate = openGate(snapshot);
    snapshot = await orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "reroll-race-plan",
      },
    );
    gate = openGate(snapshot);
    snapshot = await orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "select",
        selectedArtifactId: gate.candidateArtifactIds[0]!,
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "reroll-race-image",
      },
    );
    gate = openGate(snapshot);
    const source = snapshot.stages.find(
      (stage) => stage.kind === "video_preview" && stage.status === "completed",
    );
    expect(source).toBeDefined();

    blockNextResult = true;
    const finishing = orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "select",
        selectedArtifactId: gate.candidateArtifactIds[0]!,
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "reroll-race-video",
      },
    );
    await blockedResultEntered;
    try {
      const inFlight = orchestrator.getPipeline(snapshot.pipeline.pipelineId);
      expect(inFlight.pipeline.status).toBe("running");
      await expect(
        orchestrator.reroll(snapshot.pipeline.pipelineId, {
          stageId: source!.stageId,
          expectedPipelineVersion: inFlight.pipeline.version,
          idempotencyKey: "reroll-during-final",
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    } finally {
      releaseBlockedResult();
    }

    snapshot = await finishing;
    expect(openGate(snapshot).kind).toBe("final_acceptance");
    expect(snapshot.pipeline.status).toBe("awaiting_approval");
  });

  it("fails closed before importing a backend result with no required artifacts", async () => {
    const image = new FakeImageBackend();
    const validStart = image.start.bind(image);
    image.start = async (command, context) => {
      const started = await validStart(command, context);
      if (started.kind !== "completed") return started;
      return {
        kind: "completed",
        result: { ...started.result, artifacts: [] },
      };
    };
    const { orchestrator, store } = await makeHarness("fake-image2-video-v1", {
      image,
    });
    const plan = await orchestrator.createPlan({
      brief: "A silver bead rolls across a black table.",
    });
    let snapshot = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "empty-result-pipeline",
    });
    const gate = openGate(snapshot);

    await expect(
      orchestrator.decideGate(snapshot.pipeline.pipelineId, gate.gateId, {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "empty-result-plan",
      }),
    ).rejects.toMatchObject({ code: "image_quality_gate_failed" });

    snapshot = orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    expect(snapshot.pipeline.status).toBe("failed");
    const failedStage = snapshot.stages.find(
      (stage) => stage.kind === "image_preview",
    );
    expect(failedStage?.status).toBe("failed");
    expect(
      snapshot.runs.find((run) => run.stageId === failedStage?.stageId)?.status,
    ).toBe("failed");
    expect(snapshot.artifacts).toHaveLength(0);
    expect(store.outbox.listUnfinished()).toHaveLength(0);
    expect(await orchestrator.recover()).toEqual({ processed: 0, pending: 0 });
  });

  it.each(["missing", "mismatched"] as const)(
    "fails closed when a video result has a %s explicit seed",
    async (seedFault) => {
      const video = new FakeVideoBackend();
      transformVideoArtifacts(video, (artifact) => {
        if (seedFault === "missing") {
          const { seed: _seed, ...withoutSeed } = artifact;
          return withoutSeed;
        }
        return {
          ...artifact,
          seed: String(BigInt(artifact.seed!) + 1n),
        };
      });
      const harness = await makeHarness("fake-image2-video-v1", { video });
      const plan = await harness.orchestrator.createPlan({
        brief: `A seed-${seedFault} video result must fail before selection.`,
      });
      let snapshot = await harness.orchestrator.createPipeline({
        planId: plan.planId,
        expectedPlanHash: plan.planHash,
        idempotencyKey: `seed-${seedFault}-pipeline`,
      });
      let gate = openGate(snapshot);
      snapshot = await harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: `seed-${seedFault}-plan`,
        },
      );
      gate = openGate(snapshot);

      await expect(
        harness.orchestrator.decideGate(
          snapshot.pipeline.pipelineId,
          gate.gateId,
          {
            action: "select",
            selectedArtifactId: gate.candidateArtifactIds[0]!,
            expectedPipelineVersion: gate.expectedPipelineVersion,
            idempotencyKey: `seed-${seedFault}-image`,
          },
        ),
      ).rejects.toMatchObject({ code: "video_quality_gate_failed" });

      snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
      expect(snapshot.pipeline.status).toBe("failed");
      expect(
        snapshot.gates.some(
          (candidate) =>
            candidate.kind === "video_selection" && candidate.status === "open",
        ),
      ).toBe(false);
      expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
      expect(await harness.orchestrator.recover()).toEqual({
        processed: 0,
        pending: 0,
      });
    },
  );

  it("uses the explicit seed when video Artifact IDs are opaque", async () => {
    const video = new FakeVideoBackend();
    let opaqueOrdinal = 0;
    transformVideoArtifacts(video, (artifact) => ({
      ...artifact,
      artifactId: `opaque-video-artifact-${++opaqueOrdinal}`,
    }));
    const harness = await makeHarness("fake-image2-video-v1", { video });
    const plan = await harness.orchestrator.createPlan({
      brief: "An opaque preview identifier retains explicit seed lineage.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "opaque-seed-pipeline",
    });
    let gate = openGate(snapshot);
    snapshot = await harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "opaque-seed-plan",
      },
    );
    gate = openGate(snapshot);
    snapshot = await harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "select",
        selectedArtifactId: gate.candidateArtifactIds[0]!,
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "opaque-seed-image",
      },
    );
    gate = openGate(snapshot);
    expect(gate.kind).toBe("video_selection");
    const selectedPreview = snapshot.artifacts.find(
      (artifact) => artifact.artifactId === gate.candidateArtifactIds[0],
    );
    expect(selectedPreview).toMatchObject({
      artifactId: expect.stringMatching(/^opaque-video-artifact-/u),
      seed: expect.stringMatching(/^\d+$/u),
    });
    expect(selectedPreview?.artifactId).not.toContain("-seed-");

    snapshot = await harness.orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "select",
        selectedArtifactId: selectedPreview!.artifactId,
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "opaque-seed-video",
      },
    );
    expect(openGate(snapshot).kind).toBe("final_acceptance");
    expect(
      snapshot.artifacts.find((artifact) => artifact.kind === "video_final")
        ?.seed,
    ).toBe(selectedPreview?.seed);
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
  });

  it("fails closed before importing backend artifacts of the wrong kind", async () => {
    const image = new FakeImageBackend();
    const validStart = image.start.bind(image);
    image.start = async (command, context) => {
      const started = await validStart(command, context);
      if (started.kind !== "completed") return started;
      return {
        kind: "completed",
        result: {
          ...started.result,
          artifacts: started.result.artifacts.map((artifact) => ({
            ...artifact,
            kind: "poster" as const,
          })),
        },
      };
    };
    const { orchestrator, store } = await makeHarness("fake-image2-video-v1", {
      image,
    });
    const plan = await orchestrator.createPlan({
      brief: "A glass prism remains centered in frame.",
    });
    let snapshot = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "wrong-kind-pipeline",
    });
    const gate = openGate(snapshot);

    await expect(
      orchestrator.decideGate(snapshot.pipeline.pipelineId, gate.gateId, {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "wrong-kind-plan",
      }),
    ).rejects.toMatchObject({ code: "image_quality_gate_failed" });
    snapshot = orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    expect(snapshot.pipeline.status).toBe("failed");
    expect(snapshot.artifacts).toHaveLength(0);
    expect(store.outbox.listUnfinished()).toHaveLength(0);
  });

  it("supersedes an already imported batch member when a later member fails", async () => {
    const image = new FakeImageBackend();
    const validStart = image.start.bind(image);
    image.start = async (command, context) => {
      const started = await validStart(command, context);
      if (started.kind !== "completed") return started;
      const metadata = started.result.metadata as {
        readonly payloads: readonly unknown[];
        readonly [key: string]: unknown;
      };
      return {
        kind: "completed",
        result: {
          ...started.result,
          metadata: {
            ...metadata,
            // Keep both valid descriptors so contract validation succeeds,
            // then fail while importing the second member of the batch.
            payloads: metadata.payloads.slice(0, 1),
          },
        },
      };
    };
    const { orchestrator, store } = await makeHarness("fake-image2-video-v1", {
      image,
    });
    const plan = await orchestrator.createPlan({
      brief: "Two amber marbles rest on a linen cloth.",
    });
    let snapshot = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "partial-batch-pipeline",
    });
    const gate = openGate(snapshot);

    await expect(
      orchestrator.decideGate(snapshot.pipeline.pipelineId, gate.gateId, {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "partial-batch-plan",
      }),
    ).rejects.toMatchObject({ code: "decode_failed" });

    snapshot = orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    const failedStage = snapshot.stages.find(
      (stage) => stage.kind === "image_preview",
    )!;
    const failedRun = snapshot.runs.find(
      (run) => run.stageId === failedStage.stageId,
    )!;
    expect(snapshot.pipeline.status).toBe("failed");
    expect(failedStage.status).toBe("failed");
    expect(failedRun.status).toBe("failed");
    expect(failedRun.outputArtifactIds).toHaveLength(1);
    expect(failedStage.currentOutputArtifactIds).toHaveLength(0);
    expect(store.artifacts.isSuperseded(failedRun.outputArtifactIds[0]!)).toBe(
      true,
    );
    expect(
      snapshot.gates.filter((candidate) => candidate.status === "open"),
    ).toHaveLength(0);
    expect(store.outbox.listUnfinished()).toHaveLength(0);
    expect(await orchestrator.recover()).toEqual({ processed: 0, pending: 0 });
  });

  it("rejects foreign backend Artifact correlation before it can pollute another Pipeline", async () => {
    let foreignTarget:
      | { pipelineId: string; stageId: string; runId: string }
      | undefined;
    const image = new FakeImageBackend();
    const validStart = image.start.bind(image);
    image.start = async (command, context) => {
      const started = await validStart(command, context);
      if (started.kind !== "completed" || foreignTarget === undefined) {
        return started;
      }
      return {
        kind: "completed",
        result: {
          ...started.result,
          artifacts: started.result.artifacts.map((artifact) => ({
            ...artifact,
            ...foreignTarget,
          })),
        },
      };
    };
    const { orchestrator, store } = await makeHarness("fake-image2-video-v1", {
      image,
    });

    const firstPlan = await orchestrator.createPlan({
      brief: "A white cube turns once.",
    });
    let first = await orchestrator.createPipeline({
      planId: firstPlan.planId,
      expectedPlanHash: firstPlan.planHash,
      idempotencyKey: "correlation-first-pipeline",
    });
    let gate = openGate(first);
    first = await orchestrator.decideGate(
      first.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "correlation-first-plan",
      },
    );
    const firstImageStage = first.stages.find(
      (stage) => stage.kind === "image_preview",
    )!;
    const firstImageRun = first.runs.find(
      (run) => run.stageId === firstImageStage.stageId,
    )!;
    const firstArtifactCount = first.artifacts.length;
    foreignTarget = {
      pipelineId: first.pipeline.pipelineId,
      stageId: firstImageStage.stageId,
      runId: firstImageRun.runId,
    };

    const secondPlan = await orchestrator.createPlan({
      brief: "A black sphere turns once.",
    });
    let second = await orchestrator.createPipeline({
      planId: secondPlan.planId,
      expectedPlanHash: secondPlan.planHash,
      idempotencyKey: "correlation-second-pipeline",
    });
    gate = openGate(second);
    await expect(
      orchestrator.decideGate(second.pipeline.pipelineId, gate.gateId, {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "correlation-second-plan",
      }),
    ).rejects.toMatchObject({ code: "image_quality_gate_failed" });

    first = orchestrator.getPipeline(first.pipeline.pipelineId);
    second = orchestrator.getPipeline(second.pipeline.pipelineId);
    expect(first.artifacts).toHaveLength(firstArtifactCount);
    expect(second.pipeline.status).toBe("failed");
    expect(second.artifacts).toHaveLength(0);
    expect(store.outbox.listUnfinished()).toHaveLength(0);
  });

  it("does not resubmit an ambiguous attempt when a runtime driver omits reconciliation", async () => {
    let startCalls = 0;
    const image = new FakeImageBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") startCalls += 1;
      },
    });
    Object.defineProperty(image, "reconcile", {
      configurable: true,
      value: undefined,
    });
    let crash = true;
    const harness = await makeHarness("fake-image2-video-v1", {
      image,
      afterSubmissionIntentPersisted: () => {
        if (crash) {
          crash = false;
          throw new Error("crash before backend dispatch");
        }
      },
    });
    const plan = await harness.orchestrator.createPlan({
      brief: "A brass key slides across a desk.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "no-reconcile-pipeline",
    });
    const gate = openGate(snapshot);
    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "no-reconcile-plan",
        },
      ),
    ).rejects.toThrow("crash before backend dispatch");

    const child = harness.store.outbox
      .listUnfinished()
      .find((message) => message.topic === "backend.start")!;
    const claimed = harness.store.outbox.claimById<{
      command: FakeImageCommand;
      context: RunContext;
    }>(child.outboxId, { workerId: "crashed-worker" })!;
    await image.start(claimed.payload.command, claimed.payload.context);
    expect(startCalls).toBe(1);

    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
      fakeImageBackend: image,
      fakeVideoBackend: new FakeVideoBackend(),
    });
    await restarted.recover();
    snapshot = restarted.getPipeline(snapshot.pipeline.pipelineId);
    expect(startCalls).toBe(1);
    expect(snapshot.pipeline.status).toBe("needs_attention");
    const ambiguousStage = snapshot.stages.find(
      (stage) => stage.kind === "image_preview",
    );
    expect(
      snapshot.runs.find((run) => run.stageId === ambiguousStage?.stageId)
        ?.status,
    ).toBe("outcome_unknown");
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
  });

  it("fences a cancelled local copy before any downstream video submission", async () => {
    let blockImageCopy = false;
    let copyPersisted!: () => void;
    let releaseCopy!: () => void;
    const copyPersistedPromise = new Promise<void>((resolve) => {
      copyPersisted = resolve;
    });
    const copyBlocked = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    let videoStarts = 0;
    const video = new FakeVideoBackend({
      faultInjector: ({ operation }) => {
        if (operation === "start") videoStarts += 1;
      },
    });
    const { orchestrator, store } = await makeHarness("fake-image2-video-v1", {
      video,
      afterLocalArtifactPersisted: async ({ kind }) => {
        if (!blockImageCopy || kind !== "image_selected") return;
        blockImageCopy = false;
        copyPersisted();
        await copyBlocked;
      },
    });
    const plan = await orchestrator.createPlan({
      brief: "A folded paper crane lifts one wing.",
    });
    let snapshot = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "local-cancel-pipeline",
    });
    let gate = openGate(snapshot);
    snapshot = await orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "local-cancel-plan",
      },
    );
    gate = openGate(snapshot);
    blockImageCopy = true;
    const selecting = orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "select",
        selectedArtifactId: gate.candidateArtifactIds[0]!,
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "local-cancel-image",
      },
    );
    await copyPersistedPromise;
    const cancelled = await orchestrator.cancelPipeline(
      snapshot.pipeline.pipelineId,
      { idempotencyKey: "local-cancel-request" },
    );
    expect(cancelled.pipeline.status).toBe("cancelled");
    releaseCopy();
    await expect(selecting).rejects.toMatchObject({ code: "cancelled" });

    snapshot = orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    const lateImage = snapshot.artifacts.find(
      (artifact) => artifact.kind === "image_selected",
    );
    expect(lateImage).toBeDefined();
    expect(store.artifacts.isSuperseded(lateImage!.artifactId)).toBe(true);
    expect(videoStarts).toBe(0);
    expect(
      snapshot.stages.some(
        (stage) =>
          stage.kind === "frame_normalize" || stage.kind === "video_preview",
      ),
    ).toBe(false);
    expect(store.outbox.listUnfinished()).toHaveLength(0);
    expect(await orchestrator.recover()).toEqual({ processed: 0, pending: 0 });
  });

  it("replays an old Gate continuation as a no-op after its downstream Gate opened", async () => {
    let videoStarts = 0;
    const { orchestrator, store } = await makeHarness("fake-image2-video-v1", {
      video: new FakeVideoBackend({
        faultInjector: ({ operation }) => {
          if (operation === "start") videoStarts += 1;
        },
      }),
    });
    const plan = await orchestrator.createPlan({
      brief: "A small wheel rotates once on a clean axle.",
    });
    let snapshot = await orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "old-gate-pipeline",
    });
    let gate = openGate(snapshot);
    snapshot = await orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "approve",
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "old-gate-plan",
      },
    );
    gate = openGate(snapshot);
    const imageGateId = gate.gateId;
    snapshot = await orchestrator.decideGate(
      snapshot.pipeline.pipelineId,
      gate.gateId,
      {
        action: "select",
        selectedArtifactId: gate.candidateArtifactIds[0]!,
        expectedPipelineVersion: gate.expectedPipelineVersion,
        idempotencyKey: "old-gate-image",
      },
    );
    expect(openGate(snapshot).kind).toBe("video_selection");
    expect(videoStarts).toBe(2);
    store.outbox.enqueue({
      topic: "workflow.continue",
      aggregateType: "gate",
      aggregateId: imageGateId,
      deduplicationKey: `test-old-gate:${imageGateId}`,
      payload: {
        schemaVersion: 1,
        kind: "workflow.gate",
        pipelineId: snapshot.pipeline.pipelineId,
        gateId: imageGateId,
      },
    });

    expect(await orchestrator.recover()).toEqual({ processed: 1, pending: 0 });
    snapshot = orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    expect(openGate(snapshot).kind).toBe("video_selection");
    expect(videoStarts).toBe(2);
    expect(store.outbox.listUnfinished()).toHaveLength(0);
  });

  it("honors a persisted cancellation before recovery can start an older backend intent", async () => {
    let crashSubmission = true;
    let crashCancellation = true;
    let imageStarts = 0;
    const harness = await makeHarness("fake-image2-video-v1", {
      image: new FakeImageBackend({
        faultInjector: ({ operation }) => {
          if (operation === "start") imageStarts += 1;
        },
      }),
      afterSubmissionIntentPersisted: () => {
        if (crashSubmission) {
          crashSubmission = false;
          throw new Error("crash after backend intent");
        }
      },
      afterCancelContinuationPersisted: () => {
        if (crashCancellation) {
          crashCancellation = false;
          throw new Error("crash after cancellation intent");
        }
      },
    });
    const plan = await harness.orchestrator.createPlan({
      brief: "A red switch moves from left to right.",
    });
    let snapshot = await harness.orchestrator.createPipeline({
      planId: plan.planId,
      expectedPlanHash: plan.planHash,
      idempotencyKey: "cancel-recovery-pipeline",
    });
    const gate = openGate(snapshot);
    await expect(
      harness.orchestrator.decideGate(
        snapshot.pipeline.pipelineId,
        gate.gateId,
        {
          action: "approve",
          expectedPipelineVersion: gate.expectedPipelineVersion,
          idempotencyKey: "cancel-recovery-plan",
        },
      ),
    ).rejects.toThrow("crash after backend intent");
    await expect(
      harness.orchestrator.cancelPipeline(snapshot.pipeline.pipelineId, {
        idempotencyKey: "cancel-recovery-request",
      }),
    ).rejects.toThrow("crash after cancellation intent");
    snapshot = harness.orchestrator.getPipeline(snapshot.pipeline.pipelineId);
    expect(snapshot.pipeline.status).toBe("cancelling");
    expect(imageStarts).toBe(0);

    const restarted = new PipelineOrchestrator({
      store: harness.store,
      profiles: harness.profiles,
      artifactStore: harness.artifactStore,
      fakeImageBackend: new FakeImageBackend({
        faultInjector: ({ operation }) => {
          if (operation === "start") imageStarts += 1;
        },
      }),
      fakeVideoBackend: new FakeVideoBackend(),
    });
    const recovery = await restarted.recover();
    snapshot = restarted.getPipeline(snapshot.pipeline.pipelineId);
    expect(recovery.pending).toBe(0);
    expect(snapshot.pipeline.status).toBe("cancelled");
    expect(imageStarts).toBe(0);
    expect(snapshot.artifacts).toHaveLength(0);
    expect(harness.store.outbox.listUnfinished()).toHaveLength(0);
  });
});
