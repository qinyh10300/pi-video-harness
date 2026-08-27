import { describe, expect, it } from "vitest";

import { ContractValidationError } from "./common.js";
import { parseVideoScript } from "./video-script.js";

const validScript = () => ({
  schemaVersion: "2",
  scriptId: "roadside-relief",
  scriptVersion: 1,
  title: "Roadside relief",
  product: {
    name: "Extended vehicle service",
    category: "vehicle-service-contract",
    positioning: "Contract-based repair support after the factory warranty.",
  },
  format: {
    aspectRatio: "9:16",
    targetDurationSeconds: 10,
    language: "en-US",
  },
  creative: {
    audience: "Adult vehicle owners",
    tone: "Realistic",
    visualStyle: "Photorealistic commercial",
    storyArc: ["A breakdown creates tension.", "Support brings relief."],
  },
  continuity: {
    protagonist: {
      ageYears: 30,
      description: "One clearly adult driver.",
      wardrobe: "The same opaque outfit in every shot.",
      emotionArc: ["Concerned", "Relieved"],
    },
    vehicle: "The same unbranded blue SUV.",
    setting: "The same roadside pull-off.",
    constraints: ["Preserve identity and lighting."],
  },
  compliance: {
    requiredDisclaimer: "Coverage and service are subject to the contract.",
    forbiddenClaims: ["Never promise that every repair is free."],
  },
  knowledge: {
    knowledgeBaseId: "vehicle-product-knowledge",
    policyId: "video-policy-v1",
    qaIds: ["fault-reporting", "repair-sites"],
    assertions: [
      {
        claimId: "contact-before-repair",
        text: "Contact the service provider before repair.",
      },
      {
        claimId: "qualified-repair-sites",
        text: "Use a qualified repair site.",
      },
    ],
  },
  shots: [
    {
      shotId: "shot-01",
      startSeconds: 0,
      durationSeconds: 5,
      purpose: "Introduce the breakdown.",
      brief: "The vehicle stops safely.",
      stillPrompt: "A parked SUV and its adult driver.",
      motionPrompt: "The driver steps out and looks concerned.",
      negativePrompt: "unsafe driving, text distortion",
      overlay: { headline: "Unexpected breakdown" },
      voiceover: "The trip suddenly stops.",
      emotion: "Concerned but controlled.",
      knowledgeQaIds: ["fault-reporting"],
      knowledgeClaimIds: ["contact-before-repair"],
    },
    {
      shotId: "shot-02",
      startSeconds: 5,
      durationSeconds: 5,
      purpose: "Resolve the tension.",
      brief: "The service request is received.",
      stillPrompt: "The same driver beside the same SUV.",
      motionPrompt: "Her shoulders relax as support is arranged.",
      negativePrompt: "instant repair, free repair claim",
      overlay: { headline: "Support requested" },
      voiceover: "Nearby support can be requested under the contract.",
      emotion: "Visible relief.",
      knowledgeQaIds: ["repair-sites"],
      knowledgeClaimIds: ["qualified-repair-sites"],
    },
  ],
});

describe("VideoScript", () => {
  it("parses a closed, versioned multi-shot script", () => {
    const script = parseVideoScript(validScript());

    expect(script.scriptId).toBe("roadside-relief");
    expect(script.shots).toHaveLength(2);
  });

  it("rejects unknown properties", () => {
    expect(() =>
      parseVideoScript({ ...validScript(), unreviewedClaim: "always covered" }),
    ).toThrowError(ContractValidationError);
  });

  it("requires the protagonist to be an adult", () => {
    const script = validScript();
    script.continuity.protagonist.ageYears = 17;

    expect(() => parseVideoScript(script)).toThrow(/ageYears/u);
  });

  it("rejects whitespace-only creative and compliance text", () => {
    const script = validScript();
    script.shots[0]!.stillPrompt = " \n ";
    script.compliance.requiredDisclaimer = "   ";

    expect(() => parseVideoScript(script)).toThrow(
      /stillPrompt: must contain non-whitespace text/u,
    );
    expect(() => parseVideoScript(script)).toThrow(
      /requiredDisclaimer: must contain non-whitespace text/u,
    );
  });

  it("rejects duplicate shot IDs and timeline gaps at the parser boundary", () => {
    const script = validScript();
    script.shots[1]!.shotId = script.shots[0]!.shotId;
    script.shots[1]!.startSeconds = 6;

    expect(() => parseVideoScript(script)).toThrow(
      /duplicate shot ID 'shot-01'/u,
    );
    expect(() => parseVideoScript(script)).toThrow(/must start at 5 seconds/u);
  });

  it("rejects shot knowledge references that are absent from the root selection", () => {
    const script = validScript();
    script.shots[0]!.knowledgeQaIds = ["unknown-answer"];
    script.shots[1]!.knowledgeClaimIds = ["unknown-claim"];

    expect(() => parseVideoScript(script)).toThrow(
      /QA ID 'unknown-answer' is not selected/u,
    );
    expect(() => parseVideoScript(script)).toThrow(
      /claim ID 'unknown-claim' is not selected/u,
    );
  });

  it("rejects duplicate knowledge selectors at the root and shot boundaries", () => {
    const script = validScript();
    script.knowledge.qaIds = ["fault-reporting", "fault-reporting"];
    script.knowledge.assertions = [
      script.knowledge.assertions[0]!,
      script.knowledge.assertions[0]!,
    ];
    script.shots[0]!.knowledgeQaIds = ["fault-reporting", "fault-reporting"];
    script.shots[0]!.knowledgeClaimIds = [
      "contact-before-repair",
      "contact-before-repair",
    ];

    expect(() => parseVideoScript(script)).toThrow(
      /duplicate QA ID 'fault-reporting'/u,
    );
    expect(() => parseVideoScript(script)).toThrow(
      /duplicate claim ID 'contact-before-repair'/u,
    );
  });

  it("requires effective knowledge grounding for the script and every shot", () => {
    const script = validScript();
    script.knowledge.qaIds = [];
    script.knowledge.assertions = [];
    script.shots.forEach((shot) => {
      shot.knowledgeQaIds = [];
      shot.knowledgeClaimIds = [];
    });

    expect(() => parseVideoScript(script)).toThrow(
      /must select at least one approved QA or claim for a video script/u,
    );
    expect(() => parseVideoScript(script)).toThrow(
      /shots\/0: must select at least one approved QA or claim/u,
    );
  });

  it("rejects root knowledge selectors that no shot uses", () => {
    const script = validScript();
    script.knowledge.qaIds.push("unused-answer");
    script.knowledge.assertions.push({
      claimId: "unused-claim",
      text: "Unused approved claim.",
    });

    expect(() => parseVideoScript(script)).toThrow(
      /QA ID 'unused-answer' is not used by any shot/u,
    );
    expect(() => parseVideoScript(script)).toThrow(
      /claim ID 'unused-claim' is not used by any shot/u,
    );
  });
});
