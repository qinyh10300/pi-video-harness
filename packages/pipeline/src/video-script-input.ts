import {
  parseCreatePlanInput,
  parseVideoScript,
  type CreatePlanInput,
  type KnowledgeBinding,
  type KnowledgeSelection,
  type VideoScript,
  type VideoScriptOverlay,
  type VideoScriptShot,
} from "@pi-video-harness/contracts";
import type { ProductKnowledgeRegistry } from "@pi-video-harness/knowledge";

export interface VideoScriptInputOptions {
  readonly knowledgeRegistry: ProductKnowledgeRegistry;
  readonly dryRun?: boolean;
  readonly imageCandidateCount?: number;
  readonly previewCandidateCount?: number;
  readonly referenceAssetIds?: readonly string[];
  readonly idempotencyKeyPrefix?: string;
}

export interface VideoScriptShotInput {
  readonly scriptId: string;
  readonly scriptVersion: number;
  readonly shotId: string;
  readonly assembly: {
    readonly startSeconds: number;
    readonly durationSeconds: 5;
    readonly overlay: VideoScriptOverlay;
    readonly voiceover: string;
    readonly requiredDisclaimer: string;
    readonly knowledgeBinding: KnowledgeBinding;
  };
  readonly input: CreatePlanInput;
}

const selectShotKnowledge = (
  script: VideoScript,
  shot: VideoScriptShot,
): KnowledgeSelection => {
  const assertionsById = new Map(
    script.knowledge.assertions.map((assertion) => [
      assertion.claimId,
      assertion,
    ]),
  );
  return {
    knowledgeBaseId: script.knowledge.knowledgeBaseId,
    policyId: script.knowledge.policyId,
    qaIds: [...shot.knowledgeQaIds],
    assertions: shot.knowledgeClaimIds.map((claimId) => {
      const assertion = assertionsById.get(claimId);
      if (assertion === undefined) {
        throw new Error(
          `Shot '${shot.shotId}' references unselected knowledge claim '${claimId}'`,
        );
      }
      return { ...assertion };
    }),
  };
};

const formatGroundedBrief = (binding: KnowledgeBinding): string => {
  const claims = binding.claims.map(
    ({ claimId, approvedText }) => `- [${claimId}] ${approvedText}`,
  );
  const answers = binding.answers.map(
    ({ qaId, canonicalQuestion, canonicalAnswer }) =>
      `- [${qaId}] 问：${canonicalQuestion}\n  答：${canonicalAnswer}`,
  );
  return [
    "权威产品事实（只能逐字使用，不得自行扩写）：",
    ...(claims.length === 0 ? ["- 本镜头无已授权产品事实"] : claims),
    "权威产品问答（问题和回答只能逐字使用）：",
    ...(answers.length === 0 ? ["- 本镜头无已授权产品问答"] : answers),
  ].join("\n");
};

interface GuardedTextSurface {
  readonly pointer: string;
  readonly value: string;
}

const NON_FACTUAL_PUBLIC_BOILERPLATE = [
  "本片为情景演绎",
  "具体信息以实际产品说明和合同条款为准",
  "权威问答来自固定版本产品知识库",
  "公开产品事实仅采用知识绑定中的逐字批准文本",
] as const;

const CONTEXTUAL_TEXT_BY_CLAIM_ID: Readonly<Record<string, readonly string[]>> =
  {
    // This is a state of the fictional contract in the story, not a rewrite of
    // the policy. The normative 30-day rule still has to render verbatim.
    "waiting-period-30-days": ["生效后等待期已满30日"],
  };

const PRODUCT_FACT_SIGNAL =
  /车援宝|车元宝|车延保|汽车延保|延保|保修|lynxon|等待期|合同|签约|购买|办理|开通|生效|保障|部件|除外责任|适用车辆|服务流程|处理结果|热线|客服|救援|拖车|赔偿|赔付|理赔|报销|报修|费用|维修机构|维修站|4s|二类|承保|投保|保单|保险|质保|原厂保修|全车全保|免费维修|全额承担|全额赔/iu;

const UNSUPPORTED_PRODUCT_SEMANTICS = [
  /(?:坏(?:了|掉)?|故障|抛锚|出问题|失灵|趴窝).{0,12}(?:后|之后|以后|再|临时|才)?.{0,12}(?:买|购买|办|办理|补办|签|签约|投保|续保|更新|加购).{0,18}(?:也|仍|还|照样)?.{0,8}(?:能|可以|可)?.{0,8}(?:处理|维修|修|赔|报销|保障|生效|管)/u,
  /(?:买|购买|办|办理|补办|签|签约|投保|续保|更新|加购).{0,18}(?:也|仍|还|照样)?.{0,8}(?:能|可以|可)?.{0,8}(?:处理|维修|修|赔|报销|保障|生效|管).{0,18}(?:刚才|已经|本次|这次|此前).{0,8}(?:坏|故障|抛锚|问题)/u,
  /(?:任何|随便).{0,8}(?:维修厂|维修站|修理厂).{0,12}(?:都|也)?.{0,8}(?:能|可以|可|直接)?.{0,8}(?:处理|维修|修)/u,
  /(?:不用|无需|不必).{0,12}(?:联系|报修)|(?:先|直接|擅自).{0,6}(?:拆|修|维修).{0,8}(?:再|之后|以后).{0,6}(?:联系|报|报修)/u,
] as const;

const normalizeGuardText = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{C}\p{M}]/gu, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");

const approvedTextAtoms = (binding: KnowledgeBinding): readonly string[] => {
  const atoms = new Set<string>(NON_FACTUAL_PUBLIC_BOILERPLATE);
  for (const claim of binding.claims) {
    atoms.add(claim.approvedText);
    for (const contextualText of CONTEXTUAL_TEXT_BY_CLAIM_ID[claim.claimId] ??
      []) {
      atoms.add(contextualText);
    }
  }
  for (const answer of binding.answers) {
    atoms.add(answer.canonicalQuestion);
    atoms.add(answer.canonicalAnswer);
  }
  return [...atoms].sort((left, right) => right.length - left.length);
};

const unsupportedResidual = (
  value: string,
  binding: KnowledgeBinding,
): string => {
  let residual = normalizeGuardText(value);
  for (const atom of approvedTextAtoms(binding)) {
    residual = residual.replaceAll(normalizeGuardText(atom), "");
  }
  return residual;
};

const isExactPublicRendering = (value: string, fragment: string): boolean => {
  const normalizedValue = normalizeGuardText(value);
  return [fragment, `问：${fragment}`, `答：${fragment}`]
    .map(normalizeGuardText)
    .includes(normalizedValue);
};

const publicTextSurfaces = (
  script: VideoScript,
  shot: VideoScriptShot,
): readonly GuardedTextSurface[] => [
  {
    pointer: "/compliance/requiredDisclaimer",
    value: script.compliance.requiredDisclaimer,
  },
  {
    pointer: `/shots/${shot.shotId}/overlay/headline`,
    value: shot.overlay.headline,
  },
  ...(shot.overlay.subline === undefined
    ? []
    : [
        {
          pointer: `/shots/${shot.shotId}/overlay/subline`,
          value: shot.overlay.subline,
        },
      ]),
  ...(shot.overlay.footnote === undefined
    ? []
    : [
        {
          pointer: `/shots/${shot.shotId}/overlay/footnote`,
          value: shot.overlay.footnote,
        },
      ]),
  { pointer: `/shots/${shot.shotId}/voiceover`, value: shot.voiceover },
];

const briefAndPromptSurfaces = (
  script: VideoScript,
  shot: VideoScriptShot,
): readonly GuardedTextSurface[] => [
  { pointer: "/title", value: script.title },
  { pointer: "/product/positioning", value: script.product.positioning },
  { pointer: "/creative/visualStyle", value: script.creative.visualStyle },
  { pointer: `/shots/${shot.shotId}/brief`, value: shot.brief },
  { pointer: `/shots/${shot.shotId}/stillPrompt`, value: shot.stillPrompt },
  { pointer: `/shots/${shot.shotId}/motionPrompt`, value: shot.motionPrompt },
  {
    pointer: `/shots/${shot.shotId}/negativePrompt`,
    value: shot.negativePrompt,
  },
];

const narrativeSurfaces = (
  script: VideoScript,
  shot: VideoScriptShot,
): readonly GuardedTextSurface[] => [
  { pointer: "/product/name", value: script.product.name },
  { pointer: "/product/category", value: script.product.category },
  ...script.creative.storyArc.map((value, index) => ({
    pointer: `/creative/storyArc/${index}`,
    value,
  })),
  ...script.continuity.constraints.map((value, index) => ({
    pointer: `/continuity/constraints/${index}`,
    value,
  })),
  { pointer: `/shots/${shot.shotId}/purpose`, value: shot.purpose },
  { pointer: `/shots/${shot.shotId}/emotion`, value: shot.emotion },
];

const assertGroundedPublicText = (
  script: VideoScript,
  shot: VideoScriptShot,
  binding: KnowledgeBinding,
): void => {
  const publicSurfaces = publicTextSurfaces(script, shot);
  const publicValues = publicSurfaces.map(({ value }) => value);
  for (const claim of binding.claims) {
    if (
      !publicValues.some((value) =>
        isExactPublicRendering(value, claim.approvedText),
      )
    ) {
      throw new Error(
        `Shot '${shot.shotId}' public text must include approved claim '${claim.claimId}' verbatim`,
      );
    }
  }
  for (const answer of binding.answers) {
    if (
      !publicValues.some((value) =>
        isExactPublicRendering(value, answer.canonicalQuestion),
      ) ||
      !publicValues.some((value) =>
        isExactPublicRendering(value, answer.canonicalAnswer),
      )
    ) {
      throw new Error(
        `Shot '${shot.shotId}' public text must include approved Q&A '${answer.qaId}' verbatim`,
      );
    }
  }

  const strictSurfaces = [
    ...publicSurfaces,
    ...briefAndPromptSurfaces(script, shot),
  ];
  const unsupported = (value: string): boolean =>
    PRODUCT_FACT_SIGNAL.test(value) ||
    UNSUPPORTED_PRODUCT_SEMANTICS.some((pattern) => pattern.test(value));
  for (const surface of strictSurfaces) {
    const residual = unsupportedResidual(surface.value, binding);
    if (unsupported(residual)) {
      throw new Error(
        `Shot '${shot.shotId}' field '${surface.pointer}' contains an unsupported product statement`,
      );
    }
  }

  const combinedPublicResidual = publicSurfaces
    .map((surface) => unsupportedResidual(surface.value, binding))
    .join("");
  if (unsupported(combinedPublicResidual)) {
    throw new Error(
      `Shot '${shot.shotId}' combined public text contains an unsupported product statement`,
    );
  }

  const disclaimer = script.compliance.requiredDisclaimer;
  if (
    !NON_FACTUAL_PUBLIC_BOILERPLATE.slice(0, 2).every((atom) =>
      normalizeGuardText(disclaimer).includes(normalizeGuardText(atom)),
    ) ||
    unsupportedResidual(disclaimer, binding).length !== 0
  ) {
    throw new Error(
      `Shot '${shot.shotId}' requiredDisclaimer must contain only the approved disclaimer boilerplate and selected facts`,
    );
  }

  for (const surface of narrativeSurfaces(script, shot)) {
    if (
      UNSUPPORTED_PRODUCT_SEMANTICS.some((pattern) =>
        pattern.test(normalizeGuardText(surface.value)),
      )
    ) {
      throw new Error(
        `Shot '${shot.shotId}' field '${surface.pointer}' contains an unsupported product statement`,
      );
    }
  }
};

export const createPlanInputsForVideoScript = (
  script: VideoScript,
  options: VideoScriptInputOptions,
): readonly VideoScriptShotInput[] => {
  const validatedScript = parseVideoScript(script);
  const sharedVisualContext = [
    `统一视觉风格：${validatedScript.creative.visualStyle}`,
    `固定主角：${validatedScript.continuity.protagonist.description}`,
    `固定服装：${validatedScript.continuity.protagonist.wardrobe}`,
    `固定车辆：${validatedScript.continuity.vehicle}`,
    `固定场景：${validatedScript.continuity.setting}`,
  ].join("\n");

  return validatedScript.shots.map((shot) => {
    const knowledge = selectShotKnowledge(validatedScript, shot);
    const knowledgeBinding =
      options.knowledgeRegistry.compileSelection(knowledge);
    assertGroundedPublicText(validatedScript, shot, knowledgeBinding);
    const brief = [
      `[${validatedScript.title} / ${shot.shotId}] ${shot.brief}`,
      `视觉风格：${validatedScript.creative.visualStyle}`,
      formatGroundedBrief(knowledgeBinding),
    ].join("\n");
    const stillPrompt = `${shot.stillPrompt}\n${sharedVisualContext}`;
    const motionPrompt = `${shot.motionPrompt}\n目标情绪：${shot.emotion}\n${sharedVisualContext}`;
    options.knowledgeRegistry.validateGroundedContent(knowledgeBinding, {
      brief,
      stillPrompt,
      motionPrompt,
      negativePrompt: shot.negativePrompt,
    });
    const input = parseCreatePlanInput({
      brief,
      stillPrompt,
      motionPrompt,
      negativePrompt: shot.negativePrompt,
      aspectRatio: validatedScript.format.aspectRatio,
      durationSeconds: shot.durationSeconds,
      knowledge,
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      ...(options.imageCandidateCount === undefined
        ? {}
        : { imageCandidateCount: options.imageCandidateCount }),
      ...(options.previewCandidateCount === undefined
        ? {}
        : { previewCandidateCount: options.previewCandidateCount }),
      ...(options.referenceAssetIds === undefined
        ? {}
        : { referenceAssetIds: [...options.referenceAssetIds] }),
      ...(options.idempotencyKeyPrefix === undefined
        ? {}
        : {
            idempotencyKey: `${options.idempotencyKeyPrefix}:${validatedScript.scriptId}:v${validatedScript.scriptVersion}:${shot.shotId}`,
          }),
    });
    return {
      scriptId: validatedScript.scriptId,
      scriptVersion: validatedScript.scriptVersion,
      shotId: shot.shotId,
      assembly: {
        startSeconds: shot.startSeconds,
        durationSeconds: shot.durationSeconds,
        overlay: { ...shot.overlay },
        voiceover: shot.voiceover,
        requiredDisclaimer: validatedScript.compliance.requiredDisclaimer,
        knowledgeBinding,
      },
      input,
    };
  });
};
