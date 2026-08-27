import { Type, type Static } from "@sinclair/typebox";

import {
  ContractValidationError,
  IdentifierSchema,
  NonEmptyStringSchema,
  parseContract,
} from "./common.js";
import { SupportedAspectRatioSchema } from "./frame.js";
import {
  KnowledgeSelectionSchema,
  type KnowledgeSelection,
} from "./knowledge.js";
import { DurationSecondsSchema } from "./request.js";

export const VideoScriptIdSchema = Type.String({
  $id: "VideoScriptId",
  minLength: 1,
  maxLength: 128,
  pattern: "^[a-z0-9][a-z0-9-]*$",
});
export type VideoScriptId = Static<typeof VideoScriptIdSchema>;

export const VideoScriptOverlaySchema = Type.Object(
  {
    headline: NonEmptyStringSchema,
    subline: Type.Optional(NonEmptyStringSchema),
    footnote: Type.Optional(NonEmptyStringSchema),
  },
  { $id: "VideoScriptOverlay", additionalProperties: false },
);
export type VideoScriptOverlay = Static<typeof VideoScriptOverlaySchema>;

export const VideoScriptShotSchema = Type.Object(
  {
    shotId: VideoScriptIdSchema,
    startSeconds: Type.Integer({ minimum: 0 }),
    durationSeconds: DurationSecondsSchema,
    purpose: NonEmptyStringSchema,
    brief: NonEmptyStringSchema,
    stillPrompt: NonEmptyStringSchema,
    motionPrompt: NonEmptyStringSchema,
    negativePrompt: NonEmptyStringSchema,
    overlay: VideoScriptOverlaySchema,
    voiceover: NonEmptyStringSchema,
    emotion: NonEmptyStringSchema,
    knowledgeQaIds: Type.Array(IdentifierSchema, { maxItems: 64 }),
    knowledgeClaimIds: Type.Array(IdentifierSchema, { maxItems: 64 }),
  },
  { $id: "VideoScriptShot", additionalProperties: false },
);
export type VideoScriptShot = Static<typeof VideoScriptShotSchema>;

export const VideoScriptSchema = Type.Object(
  {
    schemaVersion: Type.Literal("2"),
    scriptId: VideoScriptIdSchema,
    scriptVersion: Type.Integer({ minimum: 1 }),
    title: NonEmptyStringSchema,
    product: Type.Object(
      {
        name: NonEmptyStringSchema,
        category: NonEmptyStringSchema,
        positioning: NonEmptyStringSchema,
      },
      { additionalProperties: false },
    ),
    format: Type.Object(
      {
        aspectRatio: SupportedAspectRatioSchema,
        targetDurationSeconds: Type.Integer({
          minimum: 5,
          maximum: 60,
          multipleOf: 5,
        }),
        language: NonEmptyStringSchema,
      },
      { additionalProperties: false },
    ),
    creative: Type.Object(
      {
        audience: NonEmptyStringSchema,
        tone: NonEmptyStringSchema,
        visualStyle: NonEmptyStringSchema,
        storyArc: Type.Array(NonEmptyStringSchema, { minItems: 2 }),
      },
      { additionalProperties: false },
    ),
    continuity: Type.Object(
      {
        protagonist: Type.Object(
          {
            ageYears: Type.Integer({ minimum: 18 }),
            description: NonEmptyStringSchema,
            wardrobe: NonEmptyStringSchema,
            emotionArc: Type.Array(NonEmptyStringSchema, { minItems: 2 }),
          },
          { additionalProperties: false },
        ),
        vehicle: NonEmptyStringSchema,
        setting: NonEmptyStringSchema,
        constraints: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
    compliance: Type.Object(
      {
        requiredDisclaimer: NonEmptyStringSchema,
        forbiddenClaims: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
    knowledge: KnowledgeSelectionSchema,
    shots: Type.Array(VideoScriptShotSchema, {
      minItems: 1,
      maxItems: 12,
    }),
  },
  { $id: "VideoScript", additionalProperties: false },
);
export type VideoScript = Static<typeof VideoScriptSchema>;

const collectKnowledgeSelectionIssues = (
  knowledge: KnowledgeSelection,
  issues: string[],
): {
  readonly qaIds: ReadonlySet<string>;
  readonly claimIds: ReadonlySet<string>;
} => {
  if (knowledge.qaIds.length === 0 && knowledge.assertions.length === 0) {
    issues.push(
      "/knowledge: must select at least one approved QA or claim for a video script",
    );
  }
  const qaIds = new Set<string>();
  knowledge.qaIds.forEach((qaId, index) => {
    if (qaIds.has(qaId)) {
      issues.push(`/knowledge/qaIds/${index}: duplicate QA ID '${qaId}'`);
    }
    qaIds.add(qaId);
  });

  const claimIds = new Set<string>();
  knowledge.assertions.forEach(({ claimId }, index) => {
    if (claimIds.has(claimId)) {
      issues.push(
        `/knowledge/assertions/${index}/claimId: duplicate claim ID '${claimId}'`,
      );
    }
    claimIds.add(claimId);
  });
  return { qaIds, claimIds };
};

const collectWhitespaceIssues = (
  value: unknown,
  pointer: string,
  issues: string[],
): void => {
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      issues.push(`${pointer || "/"}: must contain non-whitespace text`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectWhitespaceIssues(entry, `${pointer}/${index}`, issues),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      collectWhitespaceIssues(entry, `${pointer}/${key}`, issues);
    }
  }
};

export const assertVideoScriptSemantics = (script: VideoScript): void => {
  const issues: string[] = [];
  collectWhitespaceIssues(script, "", issues);
  const selectedKnowledge = collectKnowledgeSelectionIssues(
    script.knowledge,
    issues,
  );

  const shotIds = new Set<string>();
  const usedQaIds = new Set<string>();
  const usedClaimIds = new Set<string>();
  let expectedStartSeconds = 0;
  script.shots.forEach((shot, index) => {
    if (shotIds.has(shot.shotId)) {
      issues.push(`/shots/${index}/shotId: duplicate shot ID '${shot.shotId}'`);
    }
    shotIds.add(shot.shotId);
    if (
      shot.knowledgeQaIds.length === 0 &&
      shot.knowledgeClaimIds.length === 0
    ) {
      issues.push(
        `/shots/${index}: must select at least one approved QA or claim`,
      );
    }
    const shotQaIds = new Set<string>();
    shot.knowledgeQaIds.forEach((qaId, qaIndex) => {
      if (shotQaIds.has(qaId)) {
        issues.push(
          `/shots/${index}/knowledgeQaIds/${qaIndex}: duplicate QA ID '${qaId}'`,
        );
      }
      shotQaIds.add(qaId);
      usedQaIds.add(qaId);
      if (!selectedKnowledge.qaIds.has(qaId)) {
        issues.push(
          `/shots/${index}/knowledgeQaIds/${qaIndex}: QA ID '${qaId}' is not selected by /knowledge/qaIds`,
        );
      }
    });
    const shotClaimIds = new Set<string>();
    shot.knowledgeClaimIds.forEach((claimId, claimIndex) => {
      if (shotClaimIds.has(claimId)) {
        issues.push(
          `/shots/${index}/knowledgeClaimIds/${claimIndex}: duplicate claim ID '${claimId}'`,
        );
      }
      shotClaimIds.add(claimId);
      usedClaimIds.add(claimId);
      if (!selectedKnowledge.claimIds.has(claimId)) {
        issues.push(
          `/shots/${index}/knowledgeClaimIds/${claimIndex}: claim ID '${claimId}' is not selected by /knowledge/assertions`,
        );
      }
    });
    if (shot.startSeconds !== expectedStartSeconds) {
      issues.push(
        `/shots/${index}/startSeconds: must start at ${expectedStartSeconds} seconds`,
      );
    }
    expectedStartSeconds += shot.durationSeconds;
  });

  for (const qaId of selectedKnowledge.qaIds) {
    if (!usedQaIds.has(qaId)) {
      issues.push(`/knowledge/qaIds: QA ID '${qaId}' is not used by any shot`);
    }
  }
  for (const claimId of selectedKnowledge.claimIds) {
    if (!usedClaimIds.has(claimId)) {
      issues.push(
        `/knowledge/assertions: claim ID '${claimId}' is not used by any shot`,
      );
    }
  }

  if (expectedStartSeconds !== script.format.targetDurationSeconds) {
    issues.push(
      `/format/targetDurationSeconds: timeline is ${expectedStartSeconds} seconds but target is ${script.format.targetDurationSeconds}`,
    );
  }
  if (issues.length > 0) {
    throw new ContractValidationError("VideoScript", issues);
  }
};

export const parseVideoScript = (value: unknown): VideoScript => {
  const script = parseContract(VideoScriptSchema, value, "VideoScript");
  assertVideoScriptSemantics(script);
  return script;
};
