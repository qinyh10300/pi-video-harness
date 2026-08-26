import { Type, type Static } from "@sinclair/typebox";

export const SupportedAspectRatioSchema = Type.Union(
  [Type.Literal("16:9"), Type.Literal("9:16")],
  { $id: "SupportedAspectRatio" },
);
export type SupportedAspectRatio = Static<typeof SupportedAspectRatioSchema>;

const CommonFrameFields = {
  mimeType: Type.Literal("image/png"),
  colorSpace: Type.Literal("srgb"),
  bitDepth: Type.Literal(8),
  channels: Type.Literal(3),
  alpha: Type.Literal(false),
  cropPolicy: Type.Literal("none"),
} as const;

export const CommonFrameSpecSchema = Type.Object(CommonFrameFields, {
  $id: "CommonFrameSpec",
  additionalProperties: false,
});
export type CommonFrameSpec = Static<typeof CommonFrameSpecSchema>;

export const LandscapeFrameSpecSchema = Type.Object(
  {
    ...CommonFrameFields,
    aspectRatio: Type.Literal("16:9"),
    width: Type.Literal(1280),
    height: Type.Literal(720),
  },
  { $id: "LandscapeFrameSpec", additionalProperties: false },
);
export type LandscapeFrameSpec = Static<typeof LandscapeFrameSpecSchema>;

export const PortraitFrameSpecSchema = Type.Object(
  {
    ...CommonFrameFields,
    aspectRatio: Type.Literal("9:16"),
    width: Type.Literal(720),
    height: Type.Literal(1280),
  },
  { $id: "PortraitFrameSpec", additionalProperties: false },
);
export type PortraitFrameSpec = Static<typeof PortraitFrameSpecSchema>;

/**
 * A discriminated union by design. Keeping the dimensions inside each branch
 * prevents a valid aspect-ratio literal from being paired with the other
 * orientation's dimensions.
 */
export const FrameSpecSchema = Type.Union(
  [LandscapeFrameSpecSchema, PortraitFrameSpecSchema],
  { $id: "FrameSpec" },
);
export type FrameSpec = Static<typeof FrameSpecSchema>;

export const ImageOutputSizeSchema = Type.Union(
  [Type.Literal("1280x720"), Type.Literal("720x1280")],
  { $id: "ImageOutputSize" },
);
export type ImageOutputSize = Static<typeof ImageOutputSizeSchema>;
