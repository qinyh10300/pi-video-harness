import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
  parseKnowledgeBinding,
  parseKnowledgeQueryInput,
  parseKnowledgeSelection,
  type KnowledgeAnswer,
  type KnowledgeBinding,
  type KnowledgeCitation,
  type KnowledgeClaim,
  type KnowledgeQueryInput,
  type KnowledgeQueryResult,
  type KnowledgeSelection,
  type KnowledgeSnapshotRef,
} from "@pi-video-harness/contracts";

import {
  canonicalJson,
  canonicalJsonSha256,
  compareCodeUnits,
  deepFreeze,
  sha256Hex,
} from "./internal.js";
import {
  KnowledgeManifestError,
  manifestPolicyHash,
  parseProductKnowledgeManifest,
  type ProductKnowledgeManifest,
} from "./manifest.js";

const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_GROUNDING_DEPTH = 12;
const MAX_GROUNDING_NODES = 10_000;
const MAX_GROUNDING_STRING_CHARACTERS = 32_768;
const MAX_GROUNDING_TOTAL_CHARACTERS = 262_144;

export interface ProductKnowledgeRegistryOptions {
  readonly sourceDirectory: string;
  readonly manifestPath: string;
}

export interface GroundedPlanContent {
  readonly brief: string;
  readonly stillPrompt?: string;
  readonly motionPrompt?: string;
  readonly negativePrompt?: string;
}

export interface KnowledgeCorpusEntry {
  readonly path: string;
  readonly sha256: string;
  readonly assistantContract: string;
}

export interface ProductKnowledgeSnapshot {
  readonly knowledgeBaseId: string;
  readonly policyId: string;
  readonly ref: KnowledgeSnapshotRef;
  readonly corpusEntries: readonly KnowledgeCorpusEntry[];
  readonly protectedTerms: readonly string[];
}

interface LoadedCorpusDocument extends KnowledgeCorpusEntry {
  readonly content: string;
}

interface ResolvedAnswer {
  readonly contract: KnowledgeAnswer;
  readonly matchAnyAllTerms: readonly (readonly string[])[];
  readonly normalizedQuestion: string;
}

export class ProductKnowledgeConfigurationError extends Error {
  readonly code = "invalid_product_knowledge" as const;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ProductKnowledgeConfigurationError";
  }
}

export class ProductKnowledgePolicyError extends Error {
  readonly code = "product_knowledge_policy_violation" as const;

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ProductKnowledgePolicyError";
  }
}

const asConfigurationError = (message: string, cause: unknown): Error =>
  cause instanceof ProductKnowledgeConfigurationError
    ? cause
    : new ProductKnowledgeConfigurationError(message, { cause });

const isPathWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};

const relativePosixPath = (root: string, candidate: string): string =>
  path.relative(root, candidate).split(path.sep).join("/");

const assertNotSymbolicLink = async (
  entryPath: string,
  label: string,
): Promise<void> => {
  const stats = await lstat(entryPath);
  if (stats.isSymbolicLink()) {
    throw new ProductKnowledgeConfigurationError(
      `${label} must not be a symbolic link`,
    );
  }
};

const readManifest = async (
  manifestPath: string,
): Promise<ProductKnowledgeManifest> => {
  if (path.extname(manifestPath) !== ".json") {
    throw new ProductKnowledgeConfigurationError(
      "Product knowledge manifest must be a .json file",
    );
  }
  await assertNotSymbolicLink(manifestPath, "Product knowledge manifest");
  const stats = await lstat(manifestPath);
  if (!stats.isFile() || stats.size > MAX_MANIFEST_BYTES) {
    throw new ProductKnowledgeConfigurationError(
      `Product knowledge manifest must be a regular file no larger than ${MAX_MANIFEST_BYTES} bytes`,
    );
  }
  const bytes = await readFile(manifestPath);
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new ProductKnowledgeConfigurationError(
      `Product knowledge manifest exceeds ${MAX_MANIFEST_BYTES} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (cause) {
    throw new ProductKnowledgeConfigurationError(
      "Product knowledge manifest is not valid UTF-8 JSON",
      { cause },
    );
  }
  try {
    return parseProductKnowledgeManifest(parsed);
  } catch (cause) {
    if (cause instanceof KnowledgeManifestError) {
      throw new ProductKnowledgeConfigurationError(cause.message, { cause });
    }
    throw cause;
  }
};

interface FrontmatterSelection {
  readonly verification: string | undefined;
  readonly assistantContract: string | undefined;
}

const unquoteScalar = (value: string): string => {
  const trimmed = value.replace(/\s+#.*$/u, "").trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const selectFrontmatter = (content: string): FrontmatterSelection => {
  const lines = content.split(/\r?\n/u);
  if (lines[0] !== "---") {
    return { verification: undefined, assistantContract: undefined };
  }
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex < 0) {
    return { verification: undefined, assistantContract: undefined };
  }
  let verification: string | undefined;
  let assistantContract: string | undefined;
  for (const line of lines.slice(1, closingIndex)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = unquoteScalar(line.slice(separator + 1));
    if (key === "verification") verification = value;
    if (key === "assistant_contract") assistantContract = value;
  }
  return { verification, assistantContract };
};

const discoverMarkdownFiles = async (
  sourceRoot: string,
  manifest: ProductKnowledgeManifest,
): Promise<readonly string[]> => {
  const discovered: string[] = [];
  let totalBytes = 0;

  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => compareCodeUnits(left.name, right.name),
    );
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = relativePosixPath(sourceRoot, entryPath);
      if (entry.name !== entry.name.normalize("NFC")) {
        throw new ProductKnowledgeConfigurationError(
          `Knowledge corpus path '${relativePath}' is not NFC-normalized`,
        );
      }
      if (entry.isSymbolicLink()) {
        throw new ProductKnowledgeConfigurationError(
          `Knowledge corpus must not contain symbolic link '${relativePath}'`,
        );
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new ProductKnowledgeConfigurationError(
          `Knowledge corpus contains unsupported entry '${relativePath}'`,
        );
      }
      if (!entry.name.endsWith(".md")) {
        throw new ProductKnowledgeConfigurationError(
          `Knowledge corpus contains unknown file '${relativePath}'`,
        );
      }
      const stats = await lstat(entryPath);
      if (stats.size > manifest.source.maxSourceFileBytes) {
        throw new ProductKnowledgeConfigurationError(
          `Knowledge source '${relativePath}' exceeds ${manifest.source.maxSourceFileBytes} bytes`,
        );
      }
      totalBytes += stats.size;
      if (totalBytes > manifest.source.maxCorpusBytes) {
        throw new ProductKnowledgeConfigurationError(
          `Knowledge corpus exceeds ${manifest.source.maxCorpusBytes} bytes`,
        );
      }
      discovered.push(entryPath);
      if (discovered.length > manifest.source.maxCorpusFiles) {
        throw new ProductKnowledgeConfigurationError(
          `Knowledge corpus exceeds ${manifest.source.maxCorpusFiles} files`,
        );
      }
    }
  };

  await visit(sourceRoot);
  return discovered;
};

const loadCorpus = async (
  sourceDirectory: string,
  manifest: ProductKnowledgeManifest,
): Promise<readonly LoadedCorpusDocument[]> => {
  await assertNotSymbolicLink(sourceDirectory, "Knowledge source directory");
  const sourceStats = await lstat(sourceDirectory);
  if (!sourceStats.isDirectory()) {
    throw new ProductKnowledgeConfigurationError(
      "Knowledge source directory is not a directory",
    );
  }
  const sourceRoot = path.resolve(
    sourceDirectory,
    manifest.source.authoritativeRoot,
  );
  if (!isPathWithin(sourceDirectory, sourceRoot)) {
    throw new ProductKnowledgeConfigurationError(
      "Knowledge authoritative root escapes the source directory",
    );
  }
  await assertNotSymbolicLink(sourceRoot, "Knowledge authoritative root");
  const canonicalSourceRoot = await realpath(sourceRoot);
  const sourcePaths = await discoverMarkdownFiles(sourceRoot, manifest);
  const selected: LoadedCorpusDocument[] = [];

  for (const sourcePath of sourcePaths) {
    const canonicalSourcePath = await realpath(sourcePath);
    if (!isPathWithin(canonicalSourceRoot, canonicalSourcePath)) {
      throw new ProductKnowledgeConfigurationError(
        `Knowledge source '${relativePosixPath(sourceRoot, sourcePath)}' escapes the authoritative root`,
      );
    }
    const bytes = await readFile(sourcePath);
    if (bytes.byteLength > manifest.source.maxSourceFileBytes) {
      throw new ProductKnowledgeConfigurationError(
        `Knowledge source '${relativePosixPath(sourceRoot, sourcePath)}' exceeds ${manifest.source.maxSourceFileBytes} bytes`,
      );
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new ProductKnowledgeConfigurationError(
        `Knowledge source '${relativePosixPath(sourceRoot, sourcePath)}' is not valid UTF-8`,
        { cause },
      );
    }
    if (content.includes("\0")) {
      throw new ProductKnowledgeConfigurationError(
        `Knowledge source '${relativePosixPath(sourceRoot, sourcePath)}' contains NUL`,
      );
    }
    const frontmatter = selectFrontmatter(content);
    if (
      frontmatter.verification !== "verified" ||
      frontmatter.assistantContract === undefined ||
      frontmatter.assistantContract.length === 0
    ) {
      continue;
    }
    const relativePath = `${manifest.source.authoritativeRoot}/${relativePosixPath(sourceRoot, sourcePath)}`;
    selected.push({
      path: relativePath,
      sha256: sha256Hex(bytes),
      assistantContract: frontmatter.assistantContract,
      content,
    });
  }

  if (selected.length === 0) {
    throw new ProductKnowledgeConfigurationError(
      "No verified assistant-contract knowledge sources were loaded",
    );
  }
  selected.sort((left, right) => compareCodeUnits(left.path, right.path));
  const corpusHash = canonicalJsonSha256(
    selected.map(({ path: sourcePath, sha256 }) => ({
      path: sourcePath,
      sha256,
    })),
  );
  if (corpusHash !== manifest.source.expectedCorpusHash) {
    throw new ProductKnowledgeConfigurationError(
      `Knowledge corpus hash mismatch: expected ${manifest.source.expectedCorpusHash}, received ${corpusHash}`,
    );
  }
  return selected;
};

const assertSafeCitationPath = (
  citationPath: string,
  authoritativeRoot: string,
): void => {
  if (
    citationPath.includes("\0") ||
    citationPath.includes("\\") ||
    path.posix.isAbsolute(citationPath) ||
    citationPath !== path.posix.normalize(citationPath) ||
    citationPath !== citationPath.normalize("NFC") ||
    citationPath
      .split("/")
      .some(
        (segment) => segment === "" || segment === "." || segment === "..",
      ) ||
    !citationPath.startsWith(`${authoritativeRoot}/`)
  ) {
    throw new ProductKnowledgeConfigurationError(
      `Citation path '${citationPath}' is not a safe authoritative path`,
    );
  }
};

const resolveCitations = (
  manifest: ProductKnowledgeManifest,
  documents: ReadonlyMap<string, LoadedCorpusDocument>,
): ReadonlyMap<string, KnowledgeCitation> => {
  const citations = new Map<string, KnowledgeCitation>();
  for (const citation of manifest.policy.citations) {
    assertSafeCitationPath(citation.path, manifest.source.authoritativeRoot);
    const document = documents.get(citation.path);
    if (document === undefined) {
      throw new ProductKnowledgeConfigurationError(
        `Citation '${citation.citationId}' does not reference the verified authoritative corpus`,
      );
    }
    if (!document.content.includes(citation.anchor)) {
      throw new ProductKnowledgeConfigurationError(
        `Citation '${citation.citationId}' anchor '${citation.anchor}' does not exist`,
      );
    }
    if (!document.content.includes(citation.evidenceExcerpt)) {
      throw new ProductKnowledgeConfigurationError(
        `Citation '${citation.citationId}' evidence excerpt does not exist`,
      );
    }
    citations.set(
      citation.citationId,
      deepFreeze({
        ...citation,
        sourceSha256: document.sha256,
      }),
    );
  }
  return citations;
};

const resolveCitationIds = (
  citationIds: readonly string[],
  citations: ReadonlyMap<string, KnowledgeCitation>,
): KnowledgeCitation[] =>
  citationIds.map((citationId) => {
    const citation = citations.get(citationId);
    if (citation === undefined) {
      throw new ProductKnowledgeConfigurationError(
        `Unknown citation '${citationId}'`,
      );
    }
    return citation;
  });

const normalizeQuestionText = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\s\p{P}\p{S}]+/gu, "");

const normalizePolicyText = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{C}\p{M}]/gu, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");

const GROUNDED_CONTENT_FORBIDDEN_TERMS = [
  "保险",
  "车险",
  "承保",
  "投保",
  "保单",
  "原厂质保",
  "厂家质保",
  "延保",
  "延长保修",
  "故障保障",
  "车辆保障",
  "保障服务",
  "方案",
  "服务",
  "等待期",
  "合同",
  "签约",
  "购买",
  "办理",
  "开通",
  "加入",
  "续保",
  "更新",
  "加购",
  "生效",
  "处理",
  "赔偿",
  "赔付",
  "理赔",
  "报销",
  "全保",
  "全赔",
  "包赔",
  "免费",
  "免单",
  "零费用",
  "不花钱",
  "不用花钱",
  "一分钱不花",
  "百分百",
  "100%",
  "必然",
  "保证",
  "任何故障",
  "所有故障",
  "无条件",
  "无限制",
  "任意维修",
  "随便维修",
  "追溯保障",
  "补买",
  "补签",
  "立即生效",
  "马上生效",
  "即时生效",
  "秒批",
  "秒修",
  "秒赔",
  "照样管",
  "假的",
  "虚假",
  "不是真的",
  "不属实",
  "不可信",
  "胡说",
  "瞎编",
  "作废",
  "完全相反",
  "仅供娱乐",
  "无需理会",
  "报修",
  "4s店",
  "维修站",
  "二类",
] as const;

const hasExactGroundedLine = (
  lines: ReadonlySet<string>,
  fragment: string,
  prefixes: readonly string[],
): boolean => prefixes.some((prefix) => lines.has(`${prefix}${fragment}`));

const groundedContentStrings = (
  content: GroundedPlanContent,
): readonly (readonly [string, string])[] => {
  const entries: Array<readonly [string, string]> = [["brief", content.brief]];
  if (content.stillPrompt !== undefined) {
    entries.push(["stillPrompt", content.stillPrompt]);
  }
  if (content.motionPrompt !== undefined) {
    entries.push(["motionPrompt", content.motionPrompt]);
  }
  if (content.negativePrompt !== undefined) {
    entries.push(["negativePrompt", content.negativePrompt]);
  }
  return entries;
};

const resolveAnswers = (
  manifest: ProductKnowledgeManifest,
  citations: ReadonlyMap<string, KnowledgeCitation>,
): ReadonlyMap<string, ResolvedAnswer> =>
  new Map(
    manifest.policy.answers.map((answer) => {
      const contract = deepFreeze({
        qaId: answer.qaId,
        canonicalQuestion: answer.canonicalQuestion,
        canonicalAnswer: answer.canonicalAnswer,
        citations: resolveCitationIds(answer.citationIds, citations),
      });
      return [
        answer.qaId,
        deepFreeze({
          contract,
          normalizedQuestion: normalizeQuestionText(answer.canonicalQuestion),
          matchAnyAllTerms: answer.matchAnyAllTerms.map((terms) =>
            terms.map(normalizeQuestionText),
          ),
        }),
      ];
    }),
  );

const resolveClaims = (
  manifest: ProductKnowledgeManifest,
  citations: ReadonlyMap<string, KnowledgeCitation>,
): ReadonlyMap<string, KnowledgeClaim> =>
  new Map(
    manifest.policy.claims.map((claim) => [
      claim.claimId,
      deepFreeze({
        claimId: claim.claimId,
        approvedText: claim.approvedText,
        citations: resolveCitationIds(claim.citationIds, citations),
      }),
    ]),
  );

const isAnswerMatch = (question: string, answer: ResolvedAnswer): boolean =>
  question === answer.normalizedQuestion ||
  answer.matchAnyAllTerms.some((terms) =>
    terms.every((term) => question.includes(term)),
  );

const bindingPayload = (
  snapshot: KnowledgeSnapshotRef,
  answers: KnowledgeAnswer[],
  claims: KnowledgeClaim[],
): Omit<KnowledgeBinding, "bindingHash"> => ({ snapshot, answers, claims });

export class ProductKnowledgeRegistry {
  readonly #manifest: ProductKnowledgeManifest;
  readonly #answers: ReadonlyMap<string, ResolvedAnswer>;
  readonly #claims: ReadonlyMap<string, KnowledgeClaim>;
  readonly #normalizedProtectedTerms: readonly string[];
  readonly snapshot: ProductKnowledgeSnapshot;

  private constructor(
    manifest: ProductKnowledgeManifest,
    answers: ReadonlyMap<string, ResolvedAnswer>,
    claims: ReadonlyMap<string, KnowledgeClaim>,
    snapshot: ProductKnowledgeSnapshot,
  ) {
    this.#manifest = manifest;
    this.#answers = answers;
    this.#claims = claims;
    this.#normalizedProtectedTerms = manifest.policy.protectedTerms.map(
      (term) => term.normalize("NFKC").toLocaleLowerCase("en-US"),
    );
    this.snapshot = snapshot;
  }

  static async load(
    options: ProductKnowledgeRegistryOptions,
  ): Promise<ProductKnowledgeRegistry> {
    const sourceDirectory = path.resolve(options.sourceDirectory);
    const manifestPath = path.resolve(options.manifestPath);
    try {
      const manifest = await readManifest(manifestPath);
      const corpus = await loadCorpus(sourceDirectory, manifest);
      const documents = new Map(corpus.map((entry) => [entry.path, entry]));
      const citations = resolveCitations(manifest, documents);
      const answers = resolveAnswers(manifest, citations);
      const claims = resolveClaims(manifest, citations);
      const ref: KnowledgeSnapshotRef = deepFreeze({
        knowledgeBaseId: manifest.knowledgeBaseId,
        policyId: manifest.policy.policyId,
        repoUrl: manifest.source.repositoryUrl,
        revision: manifest.source.revision,
        corpusHash: manifest.source.expectedCorpusHash,
        policyHash: manifestPolicyHash(manifest),
      });
      const snapshot = deepFreeze({
        knowledgeBaseId: manifest.knowledgeBaseId,
        policyId: manifest.policy.policyId,
        ref,
        corpusEntries: corpus.map(({ content: _content, ...entry }) => entry),
        protectedTerms: [...manifest.policy.protectedTerms],
      });
      return new ProductKnowledgeRegistry(manifest, answers, claims, snapshot);
    } catch (cause) {
      throw asConfigurationError(
        "Unable to load the pinned product knowledge snapshot",
        cause,
      );
    }
  }

  query(input: KnowledgeQueryInput): KnowledgeQueryResult {
    const query = parseKnowledgeQueryInput(input);
    this.#assertPolicyIdentity(query.knowledgeBaseId, query.policyId);
    const normalizedQuestion = normalizeQuestionText(query.question);
    const matches = [...this.#answers.values()].filter((answer) =>
      isAnswerMatch(normalizedQuestion, answer),
    );
    if (matches.length === 1) {
      return deepFreeze({
        status: "answered",
        answer: matches[0]!.contract,
        snapshot: this.snapshot.ref,
      });
    }
    return deepFreeze({
      status: "insufficient_evidence",
      reason:
        matches.length === 0
          ? "no_approved_answer"
          : "ambiguous_approved_answers",
      snapshot: this.snapshot.ref,
    });
  }

  compileSelection(selection: KnowledgeSelection): KnowledgeBinding {
    const parsed = parseKnowledgeSelection(selection);
    this.#assertPolicyIdentity(parsed.knowledgeBaseId, parsed.policyId);
    if (parsed.qaIds.length === 0 && parsed.assertions.length === 0) {
      throw new ProductKnowledgePolicyError(
        "Knowledge selection must select at least one approved answer or claim",
      );
    }
    if (new Set(parsed.qaIds).size !== parsed.qaIds.length) {
      throw new ProductKnowledgePolicyError(
        "Knowledge selection must not contain duplicate QA IDs",
      );
    }
    const claimIds = parsed.assertions.map(({ claimId }) => claimId);
    if (new Set(claimIds).size !== claimIds.length) {
      throw new ProductKnowledgePolicyError(
        "Knowledge selection must not contain duplicate claim IDs",
      );
    }
    const answers = parsed.qaIds.map((qaId) => {
      const answer = this.#answers.get(qaId);
      if (answer === undefined) {
        throw new ProductKnowledgePolicyError(`Unknown QA ID '${qaId}'`);
      }
      return answer.contract;
    });
    const claims = parsed.assertions.map(({ claimId, text }) => {
      const claim = this.#claims.get(claimId);
      if (claim === undefined) {
        throw new ProductKnowledgePolicyError(`Unknown claim ID '${claimId}'`);
      }
      if (text !== claim.approvedText) {
        throw new ProductKnowledgePolicyError(
          `Assertion '${claimId}' must exactly match its approved text`,
        );
      }
      return claim;
    });
    const payload = bindingPayload(this.snapshot.ref, answers, claims);
    return deepFreeze({
      ...payload,
      bindingHash: canonicalJsonSha256(payload),
    });
  }

  validateBinding(value: unknown): KnowledgeBinding {
    let binding: KnowledgeBinding;
    try {
      binding = parseKnowledgeBinding(value);
    } catch (cause) {
      throw new ProductKnowledgePolicyError(
        "Knowledge binding does not satisfy the closed contract",
        { cause },
      );
    }
    const payload = bindingPayload(
      binding.snapshot,
      binding.answers,
      binding.claims,
    );
    if (canonicalJsonSha256(payload) !== binding.bindingHash) {
      throw new ProductKnowledgePolicyError(
        "Knowledge binding hash does not match its contents",
      );
    }
    const expected = this.compileSelection({
      knowledgeBaseId: this.snapshot.knowledgeBaseId,
      policyId: this.snapshot.policyId,
      qaIds: binding.answers.map(({ qaId }) => qaId),
      assertions: binding.claims.map(({ claimId, approvedText }) => ({
        claimId,
        text: approvedText,
      })),
    });
    if (canonicalJson(binding) !== canonicalJson(expected)) {
      throw new ProductKnowledgePolicyError(
        "Knowledge binding does not match the current snapshot and policy",
      );
    }
    return expected;
  }

  /**
   * Enforces the closed grounded-content lane used before Plan compilation and
   * again before every model submission. Selected facts must be present in the
   * Brief verbatim. Once those exact fragments are removed, product identity,
   * commercial promises, eligibility/process language, and absolute outcomes
   * are forbidden in caller-controlled text. Creative text can therefore
   * describe the people, vehicle, setting, breakdown, and emotion, while all
   * product facts remain byte-for-byte policy output.
   */
  validateGroundedContent(
    value: unknown,
    content: GroundedPlanContent,
  ): KnowledgeBinding {
    const binding = this.validateBinding(value);
    const strings = groundedContentStrings(content);
    for (const [field, text] of strings) {
      if (
        typeof text !== "string" ||
        text.trim().length === 0 ||
        text.length > MAX_GROUNDING_STRING_CHARACTERS
      ) {
        throw new ProductKnowledgePolicyError(
          `Grounded content field '${field}' must be non-empty and no longer than ${MAX_GROUNDING_STRING_CHARACTERS} characters`,
        );
      }
    }

    const briefLines = new Set(
      content.brief.split(/\r?\n/u).map((line) => line.trim()),
    );
    const selectedFragments = new Set<string>();
    for (const claim of binding.claims) {
      selectedFragments.add(claim.approvedText);
      if (
        !hasExactGroundedLine(briefLines, claim.approvedText, [
          "",
          `- [${claim.claimId}] `,
        ])
      ) {
        throw new ProductKnowledgePolicyError(
          `Grounded Brief must render approved claim '${claim.claimId}' as an isolated verbatim line`,
        );
      }
    }
    for (const answer of binding.answers) {
      selectedFragments.add(answer.canonicalQuestion);
      selectedFragments.add(answer.canonicalAnswer);
      const hasQuestion = hasExactGroundedLine(
        briefLines,
        answer.canonicalQuestion,
        ["", "问：", `- [${answer.qaId}] 问：`],
      );
      const hasAnswer = hasExactGroundedLine(
        briefLines,
        answer.canonicalAnswer,
        ["", "答："],
      );
      if (!hasQuestion || !hasAnswer) {
        throw new ProductKnowledgePolicyError(
          `Grounded Brief must render approved Q&A '${answer.qaId}' as isolated verbatim lines`,
        );
      }
    }

    const allApprovedFragments = new Map<string, string>();
    for (const answer of this.#answers.values()) {
      allApprovedFragments.set(
        answer.contract.canonicalQuestion,
        `Q&A '${answer.contract.qaId}' question`,
      );
      allApprovedFragments.set(
        answer.contract.canonicalAnswer,
        `Q&A '${answer.contract.qaId}' answer`,
      );
    }
    for (const claim of this.#claims.values()) {
      allApprovedFragments.set(claim.approvedText, `claim '${claim.claimId}'`);
    }
    for (const [fragment, label] of allApprovedFragments) {
      if (
        !selectedFragments.has(fragment) &&
        strings.some(([, text]) => text.includes(fragment))
      ) {
        throw new ProductKnowledgePolicyError(
          `Grounded content uses unselected approved ${label}`,
        );
      }
    }

    const normalizedSelectedFragments = [...selectedFragments]
      .map(normalizePolicyText)
      .filter((fragment) => fragment.length > 0)
      .sort((left, right) => right.length - left.length);
    const normalizedForbiddenTerms = [
      ...this.#normalizedProtectedTerms.map(normalizePolicyText),
      ...GROUNDED_CONTENT_FORBIDDEN_TERMS.map(normalizePolicyText),
    ].filter(
      (term, index, terms) => term.length > 0 && terms.indexOf(term) === index,
    );

    for (const [field, text] of strings) {
      let residual = normalizePolicyText(text);
      for (const fragment of normalizedSelectedFragments) {
        residual = residual.replaceAll(fragment, "");
      }
      const forbidden = normalizedForbiddenTerms.find((term) =>
        residual.includes(term),
      );
      if (forbidden !== undefined) {
        throw new ProductKnowledgePolicyError(
          `Grounded content field '${field}' contains product language outside the exact approved binding`,
        );
      }
      if (
        /(?:故障|坏了|抛锚|出问题|出险).{0,24}(?:后|再).{0,24}(?:办|买|购|签|开通|加入|投)/u.test(
          residual,
        ) ||
        /(?:全|任何|所有|无论).{0,20}(?:故障|维修|费用)/u.test(residual) ||
        /(?:故障|维修|费用).{0,20}(?:全|都|免|赔|报销|承担)/u.test(residual)
      ) {
        throw new ProductKnowledgePolicyError(
          `Grounded content field '${field}' contains an unsupported product outcome or timing claim`,
        );
      }
    }
    return binding;
  }

  /**
   * Conservative trigger for requiring a KnowledgeSelection. It only detects
   * protected product terms; it is not proof of semantic consistency.
   */
  requiresGrounding(value: unknown): boolean {
    let visitedNodes = 0;
    let visitedCharacters = 0;
    const seen = new Set<object>();

    const visit = (entry: unknown, depth: number): boolean => {
      visitedNodes += 1;
      if (visitedNodes > MAX_GROUNDING_NODES) return true;
      if (typeof entry === "string") {
        visitedCharacters += entry.length;
        const normalized = normalizePolicyText(entry);
        if (
          this.#normalizedProtectedTerms.some((term) =>
            normalized.includes(normalizePolicyText(term)),
          )
        ) {
          return true;
        }
        if (
          /(?:车辆|汽车|机动车).{0,16}(?:故障|维修).{0,16}(?:保障|保修|保固|服务)/u.test(
            normalized,
          ) ||
          /(?:保障|保修|保固|服务).{0,16}(?:车辆|汽车|机动车).{0,16}(?:故障|维修)/u.test(
            normalized,
          )
        ) {
          return true;
        }
        return (
          entry.length > MAX_GROUNDING_STRING_CHARACTERS ||
          visitedCharacters > MAX_GROUNDING_TOTAL_CHARACTERS
        );
      }
      if (entry === null || typeof entry !== "object") return false;
      if (depth >= MAX_GROUNDING_DEPTH || seen.has(entry)) return true;
      seen.add(entry);
      try {
        if (Array.isArray(entry)) {
          return entry.some((child) => visit(child, depth + 1));
        }
        return Object.values(entry as Record<string, unknown>).some((child) =>
          visit(child, depth + 1),
        );
      } finally {
        seen.delete(entry);
      }
    };

    return visit(value, 0);
  }

  #assertPolicyIdentity(knowledgeBaseId: string, policyId: string): void {
    if (knowledgeBaseId !== this.#manifest.knowledgeBaseId) {
      throw new ProductKnowledgePolicyError(
        `Unknown knowledge base '${knowledgeBaseId}'`,
      );
    }
    if (policyId !== this.#manifest.policy.policyId) {
      throw new ProductKnowledgePolicyError(`Unknown policy '${policyId}'`);
    }
  }
}
