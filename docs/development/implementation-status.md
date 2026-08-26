# 实现状态

- 更新日期：2026-08-26
- 当前可运行阶段：Phase A（离线 Fake Pipeline）
- 默认 Profile：`fake-image2-video-v1`
- 真实 Profile：`gpt-image2-wan22-i2v-a14b-v1`（禁用）

## 结论

Phase A 已完成并可在本机运行。它可以从 Brief 创建计划，创建 draft
Pipeline，然后依次经过 `plan_approval`、`image_selection`、 `video_selection` 和
`final_acceptance` 四个 Gate。整个流程只使用确定性 Fake
Backends，不访问付费 API、ComfyUI 或 GPU。

Fake video 的 MIME 是
`application/vnd.pi-video-harness.fake-video+json`；它是测试专用 JSON
payload，不是 MP4、不可播放，也不代表真实成片质量。

## 完成度

| 阶段                      | 状态   | 已有/待办                                                                                                                                                                                  |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Phase A：离线基础         | 已完成 | contracts、版本化 Profile/哈希、SQLite WAL、幂等、Outbox、Pipeline/StageRun/Gate、Artifact lineage、四 Gate Fake E2E、HTTP API、Pi-compatible Client/工具定义、取消/reroll、crash recovery |
| Phase B：GPT-Image-2      | 未完成 | 只有固定 `gpt-image-2-2026-04-21` 命令契约和 disabled Driver；OpenAI SDK、真实生成/编辑、usage、base64 导入、远端对账和费用保护待办                                                        |
| Phase C：A14B             | 未完成 | 只有 `wan22-i2v-a14b`/禁止回退契约和 disabled Driver；checkpoint/精度/Workflow 哈希、ComfyUI HTTP/WebSocket、queue/history、480P/720P 和硬件基线待办                                       |
| Phase D：真实质量与 Pi UX | 未完成 | 完整 PNG 解码/颜色管理、ffmpeg/ffprobe、H.264 MP4/poster/thumbnail、Golden Set、正式 Pi SDK 注册、审批卡片和可安装 Package 待办                                                            |

## 已验证内容

- SQLite 使用 WAL，数据库、状态、事件、Gate 和 Outbox 持久化；
- 相同计划/Pipeline/Gate 幂等请求不创建重复运行；
- Fake image 候选是一个 batch，Fake video 预览按 seed 创建独立运行；
- 四个 Gate 都使用 `expectedPipelineVersion` 和幂等键；
- 显式 reroll 会创建新候选并 supersede 旧 Gate/下游当前性；
- Gate、reroll 和 cancel 的下游 continuation 与用户决定一起持久化；
- crash-injection 已覆盖 Gate 决定提交后、Backend 提交意图后、Backend 返回后、Backend
  Outbox 完成后和本地 Artifact descriptor 提交后；
- Backend 返回值在导入产物前持久化 checkpoint；恢复优先使用 checkpoint，否则才调用
  `reconcile`。同一进程还会合并租约跨期的同一 Outbox 执行，避免重复提交；
- `BackendDriver.reconcile`
  是持久化 Backend 的强制契约；旧尝试无法权威对账时进入
  `outcome_unknown`，绝不会因缺少远端引用或返回 `not_found` 而自动再次提交；
- Backend 结果在写文件前校验数量、种类、MIME、模型、尺寸、Prompt
  lineage 及 Pipeline/Stage/Run 关联。载荷缺失、完整性不符等确定性批量导入失败会把已写入项只保留为 Run 历史，并原子移出 Stage 的当前输出集合；
- checkpoint、Artifact
  Store 或 SQLite 的本地瞬时持久化失败不会被误报为模型失败：有 checkpoint 时直接回放，没有 checkpoint 但供应商可能已受理时先
  `reconcile`。Run 完成、Backend Outbox 完成和 `stage.run_completed`
  事件在同一个 SQLite 事务中提交；
- 本地输入缺失与哈希损坏分别收敛为 `missing_asset` 和
  `decode_failed`，相关 StageRun/Artifact/Gate 被确定性结算，重启不会留下 pending/active 悬挂状态；
- reroll 的进行中幂等记录绑定固定 ordinal，不会在恢复时分配新批次；稳定状态之外拒绝并发 reroll，取消会先隔离尚未提交的 Backend
  intent，对提交结果不明的运行标记 `outcome_unknown` 而不伪装成已取消；
- Pipeline 取消状态会阻断旧 Gate continuation、旧 Backend
  intent 和本地后处理继续发布；与取消并发到达的迟到产物仍可审计，但一律标记为
  `superseded`；
- Wan negative
  Prompt 由固定提交的官方默认值、版本化项目约束和可选用户追加组成；Plan 持久化组件来源、版本、组件哈希、合并策略及最终哈希；
- 后端输出与 Stage 输入建立 `generated_from`，最终视频 ancestry 可回溯
  `wan_input_frame` 和首帧候选；poster/thumbnail 从输入帧派生；
- 真实 Profile 批准后进入 `needs_attention`，不启动 Fake 或其他模型作为回退；
- HTTP 提供 health、capabilities、plan、pipeline、事件长轮询、Gate、reroll、cancel 和 artifacts 接口；`POST /v1/assets`
  尚未实现；
- HTTP Client 和 `video_generate`、`video_job`、`video_capabilities`
  工具定义已有测试，但这不等于正式 Pi SDK 注册。

验证命令：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
```

## 安全开关与已知限制

- `videoharnessd` 默认监听 `127.0.0.1:8787`，可用 `VIDEOHARNESS_AUTH_TOKEN`
  开启所有 API 的 Bearer 鉴权；
- `VIDEOHARNESS_ENABLE_CLOUD_IMAGE` 默认为 `false`，真实 Profile 为
  `productionReady: false`；
- `DisabledOpenAIImageDriver` 和 `DisabledComfyUIDriver`
  不导入供应商 SDK，不发起 HTTP/WebSocket。即使填入 Key 或 ComfyUI
  URL 也不会启用真实生成；
- 默认媒体深度 Inspector 返回
  `not_configured`，不会把文件头检查冒充为完整解码或 ffmpeg 硬门禁；
- `POST /v1/assets` 和 Prompt revision/resume API 尚未实现；非空
  `referenceAssetIds` 会在计划落库前被拒绝，`request_changes`
  当前只把 Pipeline 安全停在 `needs_attention`；
- 立即回收旧 Outbox
  lease 的启动恢复仅适用于当前单服务进程；未来多进程 Worker 必须增加 leader/lease 协调；
- Fake Backend 可以证明 result checkpoint 回放和 reconcile-first
  fallback 路径；真实 OpenAI/ComfyUI Adapter 仍必须实现供应商侧 submission
  key 幂等和远端 job 对账；
- 未配鉴权的开发服务不应暴露到公网；真实密钥不得写入 Git、日志、manifest 或 fixture。

最小本机启动和 curl 四 Gate 流程见项目 [README](../../README.md)。
