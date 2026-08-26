import { Type, type Static } from "@sinclair/typebox";

import {
  IdentifierSchema,
  NonEmptyStringSchema,
  Sha256Schema,
} from "./common.js";

export const ARTIFACT_KINDS = [
  "reference_image",
  "image_candidate",
  "image_selected",
  "image_final",
  "wan_input_frame",
  "video_preview",
  "video_raw",
  "video_final",
  "poster",
  "thumbnail",
  "qa_report",
  "manifest",
] as const;

export const ArtifactKindSchema = Type.Union(
  ARTIFACT_KINDS.map((value) => Type.Literal(value)),
  { $id: "ArtifactKind" },
);
export type ArtifactKind = Static<typeof ArtifactKindSchema>;

export const ArtifactDescriptorSchema = Type.Object(
  {
    artifactId: IdentifierSchema,
    pipelineId: IdentifierSchema,
    stageId: IdentifierSchema,
    runId: IdentifierSchema,
    kind: ArtifactKindSchema,
    mimeType: NonEmptyStringSchema,
    sha256: Sha256Schema,
    sizeBytes: Type.Integer({ minimum: 0 }),
    width: Type.Optional(Type.Integer({ minimum: 1 })),
    height: Type.Optional(Type.Integer({ minimum: 1 })),
    durationSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    frameRate: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    frameCount: Type.Optional(Type.Integer({ minimum: 1 })),
    storagePath: NonEmptyStringSchema,
    modelId: Type.Optional(NonEmptyStringSchema),
    modelRevision: Type.Optional(NonEmptyStringSchema),
    backendRequestId: Type.Optional(NonEmptyStringSchema),
    /**
     * Canonical non-negative decimal generation seed. This is explicit
     * lineage data; consumers must never infer it from an Artifact ID.
     */
    seed: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 20,
        pattern: "^(0|[1-9][0-9]*)$",
      }),
    ),
    promptIds: Type.Array(IdentifierSchema, { uniqueItems: true }),
    qaReportArtifactId: Type.Optional(IdentifierSchema),
  },
  { $id: "ArtifactDescriptor", additionalProperties: false },
);
export type ArtifactDescriptor = Static<typeof ArtifactDescriptorSchema>;

export const ARTIFACT_RELATIONS = [
  "generated_from",
  "selected_from",
  "refined_from",
  "normalized_from",
  "promoted_from",
  "derived_from",
] as const;

export const ArtifactRelationKindSchema = Type.Union(
  ARTIFACT_RELATIONS.map((value) => Type.Literal(value)),
  { $id: "ArtifactRelationKind" },
);
export type ArtifactRelationKind = Static<typeof ArtifactRelationKindSchema>;

export const ArtifactRelationSchema = Type.Object(
  {
    parentArtifactId: IdentifierSchema,
    childArtifactId: IdentifierSchema,
    relation: ArtifactRelationKindSchema,
  },
  { $id: "ArtifactRelation", additionalProperties: false },
);
export type ArtifactRelation = Static<typeof ArtifactRelationSchema>;
