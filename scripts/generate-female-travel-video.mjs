#!/usr/bin/env node

/**
 * Generate the three source stills and three 5-second video clips for the
 * checked-in female travel-breakdown script.
 *
 * This runner deliberately stops before subtitles, TTS, and concatenation.
 * Its state file contains only resumable, non-secret metadata: model names,
 * file hashes, DashScope task IDs/statuses, and relative output paths. API
 * keys and signed result URLs are never written to disk or logged.
 *
 * Runtime requirements:
 *   - Node.js 24+
 *   - ffmpeg and ffprobe on PATH
 *   - OPENAI_API_KEY for the stills stage
 *   - DASHSCOPE_API_KEY for the videos stage
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SCRIPT_PATH = join(
  REPO_ROOT,
  "config/video-scripts/car-warranty/car-warranty-female-travel-breakdown.v1.json",
);
const DEFAULT_OUTPUT_ROOT = join(REPO_ROOT, "data/generated");

const OPENAI_IMAGE_MODEL = "gpt-image-2-2026-04-21";
const OPENAI_GENERATIONS_URL = "https://api.openai.com/v1/images/generations";
const OPENAI_EDITS_URL = "https://api.openai.com/v1/images/edits";
const OPENAI_SOURCE_SIZE = "1152x2048";

const DASHSCOPE_VIDEO_MODEL = "wan2.2-i2v-plus";
const DASHSCOPE_COMPATIBLE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const VIDEO_CONCURRENCY = 2;
const WAN_PROMPT_LIMIT = 800;
const WAN_NEGATIVE_PROMPT_LIMIT = 500;
const MAX_WAN_INPUT_BYTES = 10 * 1024 * 1024;

const NORMALIZED_WIDTH = 1080;
const NORMALIZED_HEIGHT = 1920;
const EXPECTED_SHOT_SECONDS = 5;

let temporaryFileCounter = 0;
let stopRequested = false;

process.once("SIGINT", () => {
  stopRequested = true;
  console.error(
    "\n收到中断信号；当前已保存的图片和任务 ID 可在下次运行时继续使用。",
  );
});

class ApiError extends Error {
  constructor(message, { code, httpStatus, requestId } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.requestId = requestId;
  }
}

class WanTerminalError extends Error {
  constructor(shotId, status, code, message) {
    super(
      `${shotId} 的百炼任务已进入终态 ${status}${code ? ` (${code})` : ""}${
        message ? `：${message}` : ""
      }`,
    );
    this.name = "WanTerminalError";
    this.shotId = shotId;
    this.status = status;
    this.code = code;
  }
}

function usage() {
  return `
生成美女车主自驾故障短片的三个首帧和三个 5 秒视频片段。

用法：
  node --env-file-if-exists=.env scripts/generate-female-travel-video.mjs [选项]

选项：
  --script <path>          视频脚本 JSON（默认使用仓库内美女车主脚本）
  --output-dir <path>      输出目录（默认 data/generated/<scriptId>-v<version>）
  --stage <all|images|videos>
                           all：图片后视频；images：只生成首帧；videos：用已有首帧生成视频
  --poll-interval <秒>     百炼轮询间隔，默认 15 秒
  --poll-timeout <分钟>    单个百炼任务轮询上限，默认 30 分钟
  --retry-failed           对 FAILED/CANCELED/UNKNOWN 的旧任务重新付费提交
  --plan                   只检查脚本并显示计划，不创建目录、不调用 API
  --help                   显示帮助

说明：
  - OpenAI 生成 shot-01；shot-02/03 使用 shot-01 作高保真编辑参考。
  - gpt-image-2 会自动以高保真处理编辑输入，所以不能显式传 input_fidelity。
  - wan2.2-i2v-plus 固定生成 5 秒无声视频；三段任务最多 2 个并发。
  - 本 CLI 不做字幕、TTS 或最终拼接，这些属于后续独立阶段。
`;
}

function parseArgs(argv) {
  const options = {
    scriptPath: DEFAULT_SCRIPT_PATH,
    outputDir: undefined,
    stage: "all",
    pollIntervalMs: 15_000,
    pollTimeoutMs: 30 * 60_000,
    retryFailed: false,
    planOnly: false,
  };

  const requireValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} 缺少参数值。`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }

    if (argument === "--script") {
      options.scriptPath = resolve(requireValue(index, argument));
      index += 1;
      continue;
    }

    if (argument === "--output-dir") {
      options.outputDir = resolve(requireValue(index, argument));
      index += 1;
      continue;
    }

    if (argument === "--stage") {
      options.stage = requireValue(index, argument);
      index += 1;
      continue;
    }

    if (argument === "--poll-interval") {
      options.pollIntervalMs =
        parsePositiveNumber(requireValue(index, argument), argument) * 1_000;
      index += 1;
      continue;
    }

    if (argument === "--poll-timeout") {
      options.pollTimeoutMs =
        parsePositiveNumber(requireValue(index, argument), argument) * 60_000;
      index += 1;
      continue;
    }

    if (argument === "--retry-failed") {
      options.retryFailed = true;
      continue;
    }

    if (argument === "--plan") {
      options.planOnly = true;
      continue;
    }

    throw new Error(`未知参数：${argument}`);
  }

  if (!new Set(["all", "images", "videos"]).has(options.stage)) {
    throw new Error(
      `--stage 只支持 all、images 或 videos，收到：${options.stage}`,
    );
  }

  return options;
}

function parsePositiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} 必须是正数，收到：${value}`);
  }
  return parsed;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} 必须是非空字符串。`);
  }
}

function validateScript(script) {
  if (!script || typeof script !== "object") {
    throw new Error("视频脚本必须是 JSON 对象。");
  }

  assertString(script.scriptId, "scriptId");
  if (!Number.isInteger(script.scriptVersion) || script.scriptVersion < 1) {
    throw new Error("scriptVersion 必须是正整数。");
  }

  if (script.format?.aspectRatio !== "9:16") {
    throw new Error(
      `本 CLI 只接受 9:16 脚本，收到：${script.format?.aspectRatio ?? "未设置"}`,
    );
  }

  if (script.format?.targetDurationSeconds !== 15) {
    throw new Error(
      `本 CLI 只接受 15 秒脚本，收到：${script.format?.targetDurationSeconds ?? "未设置"}`,
    );
  }

  if (!Array.isArray(script.shots) || script.shots.length !== 3) {
    throw new Error(
      `本 CLI 需要恰好 3 个镜头，收到：${script.shots?.length ?? 0}`,
    );
  }

  const shotIds = new Set();
  for (const [index, shot] of script.shots.entries()) {
    assertString(shot?.shotId, `shots[${index}].shotId`);
    assertString(shot?.stillPrompt, `${shot.shotId}.stillPrompt`);
    assertString(shot?.motionPrompt, `${shot.shotId}.motionPrompt`);
    assertString(shot?.negativePrompt, `${shot.shotId}.negativePrompt`);
    if (shot.durationSeconds !== EXPECTED_SHOT_SECONDS) {
      throw new Error(
        `${shot.shotId} 必须为 5 秒，收到：${shot.durationSeconds}`,
      );
    }
    if (shotIds.has(shot.shotId)) {
      throw new Error(`镜头 ID 重复：${shot.shotId}`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(shot.shotId)) {
      throw new Error(`镜头 ID 含不安全字符：${shot.shotId}`);
    }
    shotIds.add(shot.shotId);
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function toRepoDisplayPath(path) {
  const repositoryRelative = relative(REPO_ROOT, path);
  if (!repositoryRelative.startsWith("..") && !isAbsolute(repositoryRelative)) {
    return repositoryRelative || ".";
  }
  return path;
}

function toOutputRelativePath(outputDir, path) {
  const outputRelative = relative(outputDir, path);
  if (outputRelative.startsWith("..") || isAbsolute(outputRelative)) {
    throw new Error(`状态文件只能记录输出目录内的路径：${path}`);
  }
  return outputRelative;
}

function truncateCharacters(value, maximum) {
  return Array.from(value).slice(0, maximum).join("");
}

function buildStillPrompt(script, shot, shotIndex) {
  const globalConstraints = Array.isArray(script.continuity?.constraints)
    ? script.continuity.constraints.join("；")
    : "";

  if (shotIndex === 0) {
    return [
      shot.stillPrompt,
      "这是三镜头广告短片的主参考帧。主角明确为30岁成年人。画面不要生成任何文字、商标、车牌或水印。",
      globalConstraints,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [
    "把随附的第一镜头图片作为不可替换的角色与场景连续性参考。",
    "必须保留完全相同的成年女性脸部身份、自然皮肤纹理、身材比例、深棕色长卷发、珍珠耳钉、香槟米色不透明过膝连衣裙；同时保留完全相同的深海军蓝SUV、山间停车区、傍晚暖金色光向与写实摄影质感。不要把参考图当作简单风格参考，也不要改变人物身份或服装。",
    `将构图和动作重排为以下新镜头起始帧：${shot.stillPrompt}`,
    "画面不要生成任何文字、商标、车牌或水印；手机只保留可供后期叠字的干净UI框架。",
    globalConstraints,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildWanPrompt(script, shot) {
  const style = script.creative?.visualStyle ?? "电影级写实商业短片";
  const continuity =
    "保持首帧人物脸部、身材、服装、发型、车辆、环境和光线不变；动作连续真实；单一连续镜头；无字幕无水印。";
  return truncateCharacters(
    `${style}。${continuity}${shot.motionPrompt}`,
    WAN_PROMPT_LIMIT,
  );
}

function buildWanNegativePrompt(shot) {
  return truncateCharacters(shot.negativePrompt, WAN_NEGATIVE_PROMPT_LIMIT);
}

function deterministicSeed(scriptHash, shotId) {
  const digest = createHash("sha256")
    .update(`${scriptHash}:${shotId}`)
    .digest();
  return digest.readUInt32BE(0) & 0x7fffffff;
}

function createInitialState(script, scriptPath, scriptHash) {
  return {
    schemaVersion: 1,
    jobId: `${script.scriptId}.v${script.scriptVersion}`,
    source: {
      scriptPath: toRepoDisplayPath(scriptPath),
      scriptSha256: scriptHash,
    },
    models: {
      stills: OPENAI_IMAGE_MODEL,
      videos: DASHSCOPE_VIDEO_MODEL,
    },
    specification: {
      aspectRatio: "9:16",
      targetDurationSeconds: 15,
      shotCount: 3,
      shotDurationSeconds: EXPECTED_SHOT_SECONDS,
      videoResolution: "1080P",
      videoConcurrency: VIDEO_CONCURRENCY,
    },
    stills: {},
    videos: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function loadOrCreateState(statePath, script, scriptPath, scriptHash) {
  try {
    const state = JSON.parse(await readFile(statePath, "utf8"));
    if (state.schemaVersion !== 1) {
      throw new Error(`不支持的状态文件版本：${state.schemaVersion}`);
    }
    if (state.source?.scriptSha256 !== scriptHash) {
      throw new Error(
        `脚本内容已变化，但输出目录中存在旧状态。请改用新的 --output-dir，避免混用素材。\n状态文件：${statePath}`,
      );
    }
    if (
      state.models?.stills !== OPENAI_IMAGE_MODEL ||
      state.models?.videos !== DASHSCOPE_VIDEO_MODEL
    ) {
      throw new Error(`状态文件的模型配置与当前 CLI 不一致：${statePath}`);
    }
    state.stills ??= {};
    state.videos ??= {};
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return createInitialState(script, scriptPath, scriptHash);
    }
    throw error;
  }
}

function createStateWriter(statePath, state) {
  let writeQueue = Promise.resolve();

  return function persistState() {
    state.updatedAt = new Date().toISOString();
    const snapshot = `${JSON.stringify(state, null, 2)}\n`;
    writeQueue = writeQueue.then(async () => {
      const temporaryPath = `${statePath}.tmp.${process.pid}.${temporaryFileCounter++}`;
      await writeFile(temporaryPath, snapshot, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, statePath);
    });
    return writeQueue;
  };
}

async function fileMetadata(path) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0) {
    throw new Error(`文件不存在或为空：${path}`);
  }
  const contents = await readFile(path);
  return {
    bytes: metadata.size,
    sha256: sha256(contents),
  };
}

async function isNonEmptyFile(path) {
  try {
    const metadata = await stat(path);
    return metadata.isFile() && metadata.size > 0;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function writeBufferAtomically(path, buffer) {
  const temporaryPath = `${path}.tmp.${process.pid}.${temporaryFileCounter++}`;
  try {
    await writeFile(temporaryPath, buffer, { mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function runCommand(command, arguments_, { captureStdout = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      if (error.code === "ENOENT") {
        rejectPromise(new Error(`缺少运行依赖：${command} 不在 PATH 中。`));
        return;
      }
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      rejectPromise(
        new Error(
          `${command} 执行失败${signal ? `（信号 ${signal}）` : `（退出码 ${code}）`}${
            stderr.trim() ? `：${stderr.trim().slice(0, 1_000)}` : ""
          }`,
        ),
      );
    });
  });
}

async function normalizeToVerticalJpeg(sourcePath, destinationPath) {
  const temporaryPath = `${destinationPath}.tmp.${process.pid}.${temporaryFileCounter++}.jpg`;
  try {
    await runCommand("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      sourcePath,
      "-vf",
      `scale=${NORMALIZED_WIDTH}:${NORMALIZED_HEIGHT}:force_original_aspect_ratio=increase,crop=${NORMALIZED_WIDTH}:${NORMALIZED_HEIGHT},setsar=1`,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      "-map_metadata",
      "-1",
      temporaryPath,
    ]);
    await rename(temporaryPath, destinationPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }

  await verifyStill(destinationPath);
}

async function verifyStill(path) {
  const stdout = await runCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height",
      "-of",
      "json",
      path,
    ],
    { captureStdout: true },
  );
  const details = JSON.parse(stdout);
  const stream = details.streams?.[0];
  if (
    stream?.codec_name !== "mjpeg" ||
    stream.width !== NORMALIZED_WIDTH ||
    stream.height !== NORMALIZED_HEIGHT
  ) {
    throw new Error(
      `首帧规格不正确：${path}（codec=${stream?.codec_name}, ${stream?.width}x${stream?.height}）`,
    );
  }
}

async function verifyVideo(path) {
  const stdout = await runCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,duration:format=duration",
      "-of",
      "json",
      path,
    ],
    { captureStdout: true },
  );
  const details = JSON.parse(stdout);
  const stream = details.streams?.[0];
  const duration = Number(stream?.duration ?? details.format?.duration);
  if (!stream || !Number.isFinite(duration) || duration < 4 || duration > 6.5) {
    throw new Error(
      `视频片段规格异常：${path}（duration=${Number.isFinite(duration) ? duration : "unknown"}）`,
    );
  }
  return {
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    durationSeconds: duration,
  };
}

function requireEnvironmentVariable(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `缺少环境变量 ${name}。密钥应放在 .env 中，并通过 Node --env-file 加载。`,
    );
  }
  return value;
}

function throwIfInterrupted() {
  if (stopRequested) {
    throw new Error("任务已按用户中断；重新运行相同命令即可从已保存状态继续。");
  }
}

function safeApiMessage(payload) {
  const code = typeof payload?.code === "string" ? payload.code : undefined;
  const message =
    typeof payload?.message === "string" ? payload.message : undefined;
  const nestedCode =
    typeof payload?.error?.code === "string" ? payload.error.code : undefined;
  const nestedMessage =
    typeof payload?.error?.message === "string"
      ? payload.error.message
      : undefined;
  return {
    code: code ?? nestedCode,
    message: truncateCharacters(
      message ?? nestedMessage ?? "未返回错误详情",
      500,
    ),
  };
}

async function fetchJson(url, init, { label, timeoutMs }) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ApiError(`${label} 网络请求失败：${error.message}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      `${label} 返回了无法解析的响应（HTTP ${response.status}）。`,
      {
        httpStatus: response.status,
        requestId: response.headers.get("x-request-id") ?? undefined,
      },
    );
  }

  if (!response.ok) {
    const details = safeApiMessage(payload);
    throw new ApiError(
      `${label} 失败（HTTP ${response.status}${details.code ? `, ${details.code}` : ""}）：${details.message}`,
      {
        code: details.code,
        httpStatus: response.status,
        requestId:
          response.headers.get("x-request-id") ??
          payload?.request_id ??
          payload?.error?.request_id,
      },
    );
  }

  return {
    payload,
    requestId: response.headers.get("x-request-id") ?? payload?.request_id,
  };
}

function decodeOpenAIImage(payload, label) {
  const encoded = payload?.data?.[0]?.b64_json;
  if (typeof encoded !== "string" || encoded === "") {
    throw new ApiError(`${label} 成功响应中没有 data[0].b64_json。`);
  }
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length < 4) {
    throw new ApiError(`${label} 返回了空图片。`);
  }
  return buffer;
}

async function generateFirstStill(apiKey, prompt) {
  const { payload, requestId } = await fetchJson(
    OPENAI_GENERATIONS_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_IMAGE_MODEL,
        prompt,
        n: 1,
        size: OPENAI_SOURCE_SIZE,
        quality: "high",
        output_format: "jpeg",
        output_compression: 92,
        background: "opaque",
      }),
    },
    { label: "OpenAI 首帧生成", timeoutMs: 20 * 60_000 },
  );
  return { buffer: decodeOpenAIImage(payload, "OpenAI 首帧生成"), requestId };
}

async function editStillFromReference(apiKey, referencePath, prompt, shotId) {
  const referenceBuffer = await readFile(referencePath);
  const form = new FormData();
  form.set("model", OPENAI_IMAGE_MODEL);
  form.set("prompt", prompt);
  form.set("size", OPENAI_SOURCE_SIZE);
  form.set("quality", "high");
  form.set("output_format", "jpeg");
  form.set("output_compression", "92");
  form.set("background", "opaque");
  form.append(
    "image[]",
    new Blob([referenceBuffer], { type: "image/jpeg" }),
    basename(referencePath),
  );

  // gpt-image-2 always processes image inputs at high fidelity. Its API
  // explicitly rejects an input_fidelity override, so none is sent here.
  const { payload, requestId } = await fetchJson(
    OPENAI_EDITS_URL,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    },
    { label: `OpenAI ${shotId} 高保真编辑`, timeoutMs: 20 * 60_000 },
  );
  return {
    buffer: decodeOpenAIImage(payload, `OpenAI ${shotId} 高保真编辑`),
    requestId,
  };
}

async function selectSourceImagePath(sourceImagesDir, shotId) {
  const candidates = [
    join(sourceImagesDir, `${shotId}-source.jpeg`),
    join(sourceImagesDir, `${shotId}-source.jpg`),
    join(sourceImagesDir, `${shotId}-source.webp`),
    join(sourceImagesDir, `${shotId}-source.png`),
  ];
  for (const candidate of candidates) {
    if (await isNonEmptyFile(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

async function ensureStill({
  apiKey,
  outputDir,
  persistState,
  script,
  shot,
  shotIndex,
  sourceImagesDir,
  state,
  stillsDir,
}) {
  const rawPath = await selectSourceImagePath(sourceImagesDir, shot.shotId);
  const normalizedPath = join(stillsDir, `${shot.shotId}.jpg`);
  const stateEntry = (state.stills[shot.shotId] ??= {});

  if (await isNonEmptyFile(normalizedPath)) {
    await verifyStill(normalizedPath);
    const metadata = await fileMetadata(normalizedPath);
    Object.assign(stateEntry, {
      status: "ready",
      path: toOutputRelativePath(outputDir, normalizedPath),
      bytes: metadata.bytes,
      sha256: metadata.sha256,
      completedAt: stateEntry.completedAt ?? new Date().toISOString(),
    });
    await persistState();
    console.log(`[images] ${shot.shotId} 已存在，跳过 API。`);
    return normalizedPath;
  }

  if (!(await isNonEmptyFile(rawPath))) {
    if (!apiKey) {
      throw new Error(
        `${shot.shotId} 尚未生成；当前阶段需要 OPENAI_API_KEY。请用 --stage images 或 --stage all 先生成首帧。`,
      );
    }

    throwIfInterrupted();

    console.log(
      shotIndex === 0
        ? `[images] 正在用 ${OPENAI_IMAGE_MODEL} 生成 ${shot.shotId} 主参考帧……`
        : `[images] 正在以 shot-01 为高保真参考编辑 ${shot.shotId}……`,
    );

    const result =
      shotIndex === 0
        ? await generateFirstStill(
            apiKey,
            buildStillPrompt(script, shot, shotIndex),
          )
        : await editStillFromReference(
            apiKey,
            join(stillsDir, `${script.shots[0].shotId}.jpg`),
            buildStillPrompt(script, shot, shotIndex),
            shot.shotId,
          );

    await writeBufferAtomically(rawPath, result.buffer);
    const rawMetadata = await fileMetadata(rawPath);
    Object.assign(stateEntry, {
      status: "generated",
      rawPath: toOutputRelativePath(outputDir, rawPath),
      rawBytes: rawMetadata.bytes,
      rawSha256: rawMetadata.sha256,
      openaiRequestId: result.requestId,
      generatedAt: new Date().toISOString(),
    });
    await persistState();
  } else {
    console.log(`[images] ${shot.shotId} 原始图已存在，从本地继续规格化。`);
  }

  console.log(`[images] 正在把 ${shot.shotId} 规格化为 1080x1920 JPEG……`);
  await normalizeToVerticalJpeg(rawPath, normalizedPath);
  const metadata = await fileMetadata(normalizedPath);
  Object.assign(stateEntry, {
    status: "ready",
    path: toOutputRelativePath(outputDir, normalizedPath),
    bytes: metadata.bytes,
    sha256: metadata.sha256,
    completedAt: new Date().toISOString(),
  });
  await persistState();
  return normalizedPath;
}

async function submitWanTask(apiKey, script, scriptHash, shot, stillPath) {
  throwIfInterrupted();
  const still = await readFile(stillPath);
  if (still.length > MAX_WAN_INPUT_BYTES) {
    throw new Error(
      `${shot.shotId} 首帧为 ${(still.length / 1024 / 1024).toFixed(2)} MB，超过 wan2.2 的 10 MB 限制。`,
    );
  }

  const { payload, requestId } = await fetchJson(
    `${DASHSCOPE_COMPATIBLE_BASE_URL}/services/aigc/video-generation/video-synthesis`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
      },
      body: JSON.stringify({
        model: DASHSCOPE_VIDEO_MODEL,
        input: {
          prompt: buildWanPrompt(script, shot),
          negative_prompt: buildWanNegativePrompt(shot),
          img_url: `data:image/jpeg;base64,${still.toString("base64")}`,
        },
        parameters: {
          resolution: "1080P",
          prompt_extend: true,
          watermark: false,
          seed: deterministicSeed(scriptHash, shot.shotId),
        },
      }),
    },
    { label: `百炼 ${shot.shotId} 任务提交`, timeoutMs: 2 * 60_000 },
  );

  const taskId = payload?.output?.task_id;
  if (typeof taskId !== "string" || taskId === "") {
    throw new ApiError(`百炼 ${shot.shotId} 成功响应中没有 output.task_id。`, {
      requestId,
    });
  }

  return {
    taskId,
    taskStatus: payload.output.task_status ?? "PENDING",
    requestId,
  };
}

async function queryWanTask(apiKey, taskId, shotId) {
  const { payload, requestId } = await fetchJson(
    `${DASHSCOPE_COMPATIBLE_BASE_URL}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    { label: `百炼 ${shotId} 任务查询`, timeoutMs: 60_000 },
  );
  return { output: payload?.output ?? {}, requestId };
}

async function downloadVideo(url, destinationPath, shotId) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`百炼 ${shotId} 返回了无效的视频 URL。`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`百炼 ${shotId} 返回了非 HTTPS 视频 URL，已拒绝下载。`);
  }

  const temporaryPath = `${destinationPath}.tmp.${process.pid}.${temporaryFileCounter++}.mp4`;
  try {
    const response = await fetch(parsed, {
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporaryPath, { mode: 0o600 }),
    );
    await rename(temporaryPath, destinationPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw new Error(`下载 ${shotId} 视频失败：${error.message}`);
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function pollAndDownloadWanTask({
  apiKey,
  clipPath,
  options,
  outputDir,
  persistState,
  shot,
  stateEntry,
}) {
  const deadline = Date.now() + options.pollTimeoutMs;
  let lastLoggedStatus;

  while (Date.now() < deadline) {
    if (stopRequested) {
      throw new Error(
        "任务已按用户中断；重新运行相同命令即可从已保存的 task_id 继续轮询。",
      );
    }

    const { output, requestId } = await queryWanTask(
      apiKey,
      stateEntry.taskId,
      shot.shotId,
    );
    const status = output.task_status ?? "UNKNOWN";
    stateEntry.taskStatus = status;
    stateEntry.lastQueryRequestId = requestId;
    stateEntry.lastCheckedAt = new Date().toISOString();
    await persistState();

    if (lastLoggedStatus !== status) {
      console.log(`[videos] ${shot.shotId}：${status}`);
      lastLoggedStatus = status;
    }

    if (status === "SUCCEEDED") {
      if (typeof output.video_url !== "string" || output.video_url === "") {
        throw new ApiError(
          `百炼 ${shot.shotId} 状态成功，但没有返回 output.video_url。`,
        );
      }
      console.log(`[videos] ${shot.shotId} 已生成，立即下载临时结果链接……`);
      await downloadVideo(output.video_url, clipPath, shot.shotId);
      const media = await verifyVideo(clipPath);
      const metadata = await fileMetadata(clipPath);
      Object.assign(stateEntry, {
        taskStatus: "SUCCEEDED",
        status: "downloaded",
        path: toOutputRelativePath(outputDir, clipPath),
        bytes: metadata.bytes,
        sha256: metadata.sha256,
        media,
        downloadedAt: new Date().toISOString(),
      });
      await persistState();
      return clipPath;
    }

    if (new Set(["FAILED", "CANCELED", "UNKNOWN"]).has(status)) {
      stateEntry.status = "terminal";
      stateEntry.errorCode =
        typeof output.code === "string" ? output.code : undefined;
      await persistState();
      throw new WanTerminalError(
        shot.shotId,
        status,
        stateEntry.errorCode,
        typeof output.message === "string"
          ? truncateCharacters(output.message, 500)
          : undefined,
      );
    }

    await sleep(options.pollIntervalMs);
  }

  throw new Error(
    `${shot.shotId} 轮询超过 ${Math.round(options.pollTimeoutMs / 60_000)} 分钟；task_id 已保存，重新运行即可继续。`,
  );
}

function archiveAndClearTerminalTask(stateEntry) {
  stateEntry.previousTasks ??= [];
  stateEntry.previousTasks.push({
    taskId: stateEntry.taskId,
    taskStatus: stateEntry.taskStatus,
    errorCode: stateEntry.errorCode,
    archivedAt: new Date().toISOString(),
  });
  delete stateEntry.taskId;
  delete stateEntry.taskStatus;
  delete stateEntry.errorCode;
  delete stateEntry.status;
  delete stateEntry.submitRequestId;
  delete stateEntry.submittedAt;
}

async function ensureVideoClip(context, allowRetry = true) {
  const {
    apiKey,
    clipsDir,
    options,
    outputDir,
    persistState,
    script,
    scriptHash,
    shot,
    state,
    stillPath,
  } = context;
  const clipPath = join(clipsDir, `${shot.shotId}.mp4`);
  const stateEntry = (state.videos[shot.shotId] ??= {});

  if (await isNonEmptyFile(clipPath)) {
    const media = await verifyVideo(clipPath);
    const metadata = await fileMetadata(clipPath);
    Object.assign(stateEntry, {
      taskStatus: "SUCCEEDED",
      status: "downloaded",
      path: toOutputRelativePath(outputDir, clipPath),
      bytes: metadata.bytes,
      sha256: metadata.sha256,
      media,
      downloadedAt: stateEntry.downloadedAt ?? new Date().toISOString(),
    });
    await persistState();
    console.log(`[videos] ${shot.shotId} 片段已存在，跳过 API。`);
    return clipPath;
  }

  if (
    stateEntry.taskId &&
    new Set(["FAILED", "CANCELED", "UNKNOWN"]).has(stateEntry.taskStatus)
  ) {
    if (!options.retryFailed) {
      throw new WanTerminalError(
        shot.shotId,
        stateEntry.taskStatus,
        stateEntry.errorCode,
        "如需重新付费提交，请显式添加 --retry-failed。",
      );
    }
    archiveAndClearTerminalTask(stateEntry);
    await persistState();
  }

  if (!stateEntry.taskId) {
    console.log(
      `[videos] 正在提交 ${shot.shotId}：${DASHSCOPE_VIDEO_MODEL} / 1080P / 固定 5 秒……`,
    );
    const submitted = await submitWanTask(
      apiKey,
      script,
      scriptHash,
      shot,
      stillPath,
    );
    Object.assign(stateEntry, {
      status: "submitted",
      taskId: submitted.taskId,
      taskStatus: submitted.taskStatus,
      submitRequestId: submitted.requestId,
      submittedAt: new Date().toISOString(),
    });
    // Save the task ID before the first poll so an interrupted run will not
    // accidentally create a duplicate billable task.
    await persistState();
  } else {
    console.log(`[videos] ${shot.shotId} 恢复已有任务 ${stateEntry.taskId}。`);
  }

  try {
    return await pollAndDownloadWanTask({
      apiKey,
      clipPath,
      options,
      outputDir,
      persistState,
      shot,
      stateEntry,
    });
  } catch (error) {
    if (
      error instanceof WanTerminalError &&
      options.retryFailed &&
      allowRetry
    ) {
      console.warn(
        `[videos] ${shot.shotId} 旧任务失败，按 --retry-failed 重新提交一次。`,
      );
      archiveAndClearTerminalTask(stateEntry);
      await persistState();
      return ensureVideoClip(context, false);
    }
    throw error;
  }
}

async function mapWithConcurrency(items, concurrency, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await operation(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

async function loadScript(path) {
  let raw;
  try {
    raw = await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`找不到视频脚本：${path}`);
    }
    throw error;
  }

  let script;
  try {
    script = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error(`视频脚本不是有效 JSON：${path}（${error.message}）`);
  }
  validateScript(script);
  return { raw, script };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { raw: scriptRaw, script } = await loadScript(options.scriptPath);
  const scriptHash = sha256(scriptRaw);
  const outputDir =
    options.outputDir ??
    join(DEFAULT_OUTPUT_ROOT, `${script.scriptId}-v${script.scriptVersion}`);
  const sourceImagesDir = join(outputDir, "images");
  const stillsDir = join(outputDir, "frames");
  const clipsDir = join(outputDir, "clips");
  const statePath = join(outputDir, "state.json");

  console.log(`脚本：${toRepoDisplayPath(options.scriptPath)}`);
  console.log(`模型：${OPENAI_IMAGE_MODEL} -> ${DASHSCOPE_VIDEO_MODEL}`);
  console.log(
    `规格：9:16，3 × 5 秒，1080P，无声片段，视频并发 ${VIDEO_CONCURRENCY}`,
  );
  console.log(`输出：${outputDir}`);

  if (options.planOnly) {
    console.log("计划检查通过；--plan 未创建文件，也未调用 API。");
    return;
  }

  await mkdir(sourceImagesDir, { recursive: true, mode: 0o700 });
  await mkdir(stillsDir, { recursive: true, mode: 0o700 });
  await mkdir(clipsDir, { recursive: true, mode: 0o700 });

  const state = await loadOrCreateState(
    statePath,
    script,
    options.scriptPath,
    scriptHash,
  );
  const persistState = createStateWriter(statePath, state);
  await persistState();

  const stillPaths = new Map();
  if (options.stage === "all" || options.stage === "images") {
    const missingStill = await Promise.all(
      script.shots.map(async (shot) => {
        const normalizedPath = join(stillsDir, `${shot.shotId}.jpg`);
        const sourcePath = await selectSourceImagePath(
          sourceImagesDir,
          shot.shotId,
        );
        return (
          !(await isNonEmptyFile(normalizedPath)) &&
          !(await isNonEmptyFile(sourcePath))
        );
      }),
    );
    const openAiApiKey = missingStill.some(Boolean)
      ? requireEnvironmentVariable("OPENAI_API_KEY")
      : undefined;

    for (const [shotIndex, shot] of script.shots.entries()) {
      const stillPath = await ensureStill({
        apiKey: openAiApiKey,
        outputDir,
        persistState,
        script,
        shot,
        shotIndex,
        sourceImagesDir,
        state,
        stillsDir,
      });
      stillPaths.set(shot.shotId, stillPath);
    }
  }

  if (options.stage === "images") {
    console.log(`首帧阶段完成：${stillsDir}`);
    return;
  }

  for (const shot of script.shots) {
    const stillPath = join(stillsDir, `${shot.shotId}.jpg`);
    if (!(await isNonEmptyFile(stillPath))) {
      throw new Error(
        `${shot.shotId} 缺少 9:16 首帧：${stillPath}\n请先运行 --stage images。`,
      );
    }
    await verifyStill(stillPath);
    stillPaths.set(shot.shotId, stillPath);
  }

  const missingClip = await Promise.all(
    script.shots.map(
      async (shot) =>
        !(await isNonEmptyFile(join(clipsDir, `${shot.shotId}.mp4`))),
    ),
  );
  const dashscopeApiKey = missingClip.some(Boolean)
    ? requireEnvironmentVariable("DASHSCOPE_API_KEY")
    : undefined;

  await mapWithConcurrency(script.shots, VIDEO_CONCURRENCY, async (shot) =>
    ensureVideoClip({
      apiKey: dashscopeApiKey,
      clipsDir,
      options,
      outputDir,
      persistState,
      script,
      scriptHash,
      shot,
      state,
      stillPath: stillPaths.get(shot.shotId),
    }),
  );

  console.log(`三个 5 秒视频片段已下载并校验：${clipsDir}`);
  console.log("字幕、TTS 与 15 秒拼接尚未执行；它们被保留为独立后期阶段。");
}

main().catch((error) => {
  console.error(`生成失败：${error.message}`);
  if (error.requestId) {
    console.error(`请求 ID：${error.requestId}`);
  }
  process.exitCode = 1;
});
