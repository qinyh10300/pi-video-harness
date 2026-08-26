import { Type, type Static } from "@sinclair/typebox";

import {
  IdentifierSchema,
  NonEmptyStringSchema,
  Sha256Schema,
} from "./common.js";

export const ShotSizeSchema = Type.Union(
  [
    Type.Literal("close_up"),
    Type.Literal("medium"),
    Type.Literal("full"),
    Type.Literal("wide"),
  ],
  { $id: "ShotSize" },
);
export type ShotSize = Static<typeof ShotSizeSchema>;

const StringListSchema = Type.Array(NonEmptyStringSchema, {
  uniqueItems: true,
});

export const ShotSpecSchema = Type.Object(
  {
    subject: NonEmptyStringSchema,
    identityConstraints: Type.Optional(StringListSchema),
    wardrobe: Type.Optional(NonEmptyStringSchema),
    environment: NonEmptyStringSchema,
    composition: NonEmptyStringSchema,
    shotSize: ShotSizeSchema,
    cameraAngle: Type.Optional(NonEmptyStringSchema),
    lens: Type.Optional(NonEmptyStringSchema),
    lighting: Type.Optional(NonEmptyStringSchema),
    colorPalette: Type.Optional(NonEmptyStringSchema),
    style: Type.Optional(NonEmptyStringSchema),
    initialPose: NonEmptyStringSchema,
    subjectMotion: NonEmptyStringSchema,
    secondaryMotion: Type.Optional(NonEmptyStringSchema),
    cameraMotion: Type.Optional(NonEmptyStringSchema),
    continuityConstraints: Type.Optional(StringListSchema),
    forbiddenElements: Type.Optional(StringListSchema),
  },
  { $id: "ShotSpec", additionalProperties: false },
);
export type ShotSpec = Static<typeof ShotSpecSchema>;

export const PromptKindSchema = Type.Union(
  [Type.Literal("still"), Type.Literal("motion"), Type.Literal("negative")],
  { $id: "PromptKind" },
);
export type PromptKind = Static<typeof PromptKindSchema>;

export const PromptSourceSchema = Type.Union(
  [Type.Literal("user"), Type.Literal("compiler"), Type.Literal("user_edit")],
  { $id: "PromptSource" },
);
export type PromptSource = Static<typeof PromptSourceSchema>;

const VersionedPromptCommonFields = {
  promptId: IdentifierSchema,
  version: Type.Integer({ minimum: 1 }),
  text: NonEmptyStringSchema,
  source: PromptSourceSchema,
  parentPromptId: Type.Optional(IdentifierSchema),
  sha256: Sha256Schema,
} as const;

export const StillPromptSchema = Type.Object(
  { ...VersionedPromptCommonFields, kind: Type.Literal("still") },
  { $id: "StillPrompt", additionalProperties: false },
);
export type StillPrompt = Static<typeof StillPromptSchema>;

export const MotionPromptSchema = Type.Object(
  { ...VersionedPromptCommonFields, kind: Type.Literal("motion") },
  { $id: "MotionPrompt", additionalProperties: false },
);
export type MotionPrompt = Static<typeof MotionPromptSchema>;

export const NegativePromptComponentKindSchema = Type.Union(
  [
    Type.Literal("official_default"),
    Type.Literal("project_constraints"),
    Type.Literal("user_append"),
  ],
  { $id: "NegativePromptComponentKind" },
);
export type NegativePromptComponentKind = Static<
  typeof NegativePromptComponentKindSchema
>;

const NegativePromptComponentCommonFields = {
  text: NonEmptyStringSchema,
  sha256: Sha256Schema,
  sourceId: NonEmptyStringSchema,
  sourceRevision: Type.Optional(NonEmptyStringSchema),
} as const;

export const OfficialDefaultNegativePromptComponentSchema = Type.Object(
  {
    ...NegativePromptComponentCommonFields,
    kind: Type.Literal("official_default"),
  },
  {
    $id: "OfficialDefaultNegativePromptComponent",
    additionalProperties: false,
  },
);

export const ProjectConstraintsNegativePromptComponentSchema = Type.Object(
  {
    ...NegativePromptComponentCommonFields,
    kind: Type.Literal("project_constraints"),
  },
  {
    $id: "ProjectConstraintsNegativePromptComponent",
    additionalProperties: false,
  },
);

export const UserAppendNegativePromptComponentSchema = Type.Object(
  {
    ...NegativePromptComponentCommonFields,
    kind: Type.Literal("user_append"),
  },
  { $id: "UserAppendNegativePromptComponent", additionalProperties: false },
);

export const NegativePromptComponentSchema = Type.Union(
  [
    OfficialDefaultNegativePromptComponentSchema,
    ProjectConstraintsNegativePromptComponentSchema,
    UserAppendNegativePromptComponentSchema,
  ],
  { $id: "NegativePromptComponent" },
);
export type NegativePromptComponent = Static<
  typeof NegativePromptComponentSchema
>;

export const NegativePromptSchema = Type.Object(
  {
    ...VersionedPromptCommonFields,
    kind: Type.Literal("negative"),
    mergePolicy: Type.Literal("append-comma-v1"),
    components: Type.Union([
      Type.Tuple([
        OfficialDefaultNegativePromptComponentSchema,
        ProjectConstraintsNegativePromptComponentSchema,
      ]),
      Type.Tuple([
        OfficialDefaultNegativePromptComponentSchema,
        ProjectConstraintsNegativePromptComponentSchema,
        UserAppendNegativePromptComponentSchema,
      ]),
    ]),
  },
  { $id: "NegativePrompt", additionalProperties: false },
);
export type NegativePrompt = Static<typeof NegativePromptSchema>;

export const VersionedPromptSchema = Type.Union(
  [StillPromptSchema, MotionPromptSchema, NegativePromptSchema],
  { $id: "VersionedPrompt", additionalProperties: false },
);
export type VersionedPrompt = Static<typeof VersionedPromptSchema>;
