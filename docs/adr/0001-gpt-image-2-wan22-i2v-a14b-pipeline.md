# ADR-0001：GPT-Image-2 到 Wan2.2-I2V-A14B 的首帧驱动工作流

- 状态：已接受
- 日期：2026-08-25
- 实施状态：Phase A 离线基础已实现；Phase B–D 真实模型路径未完成
- 决策范围：首个可交付的图生视频垂直切片

## 当前实现边界

截至 2026-08-26，本 ADR 的领域建模和安全边界已在 Phase A 中落地：

- TypeScript contracts、版本化 Profile/哈希、Pipeline/StageRun/ApprovalGate；
- SQLite WAL、事务 Outbox、幂等、Artifact lineage 和恢复；
- 计划批准、选图、选视频预览、最终验收四个 Gate 的无网络 Fake E2E；
- `videoharnessd` HTTP API 和 Pi-compatible HTTP Client/三个工具定义；
- Gate/reroll/cancel continuation 和 Backend 提交意图持久化；故障注入覆盖 Gate
  commit、Backend result、Outbox
  complete 与本地产物写入边界，并验证重建 Orchestrator 后恢复到下一 Gate。

Phase A 的 Fake video 是 MIME `application/vnd.pi-video-harness.fake-video+json`
的确定性测试 payload，不是 MP4 也不是真实成片。GPT-Image-2 和 ComfyUI/A14B
Driver 都是无网络的 disabled placeholder；真实 Profile 标记为
`productionReady: false`，填入 Key 或 URL 不会启用远端请求。Pi 部分尚未完成正式 SDK 注册或可安装 Package 发布。这些实现界限没有改变下文已接受的真实模型决策。

## 背景

Pi Video
Harness 最初按本地 ComfyUI 与 Wan2.2 多模型调度进行设计。首个实际工作流现在明确为：先使用 GPT-Image-2 生成可确认的首帧，再使用用户指定的
`Wan2.2-I2V-A14B` 生成视频。

这一选择涉及两个必须显式处理的模型身份：

1. OpenAI API 中的 GPT-Image-2 图像生成与编辑模型；
2. Wan 官方发布的开源 `Wan2.2-I2V-A14B` 检查点。

阿里云百炼提供的托管模型 ID `wan2.2-i2v-plus`
没有被官方声明为开源 A14B 检查点的透明别名，且两者公开规格不同：开源 A14B 支持 480P/720P，默认 81 帧、16
fps；百炼 Plus 固定输出 5 秒、30
fps、480P/1080P。因此系统不能把二者视为同一模型或静默互相回退。

## 决策

### 1. 模型与部署

- 首帧模型使用 OpenAI Image API 的 `gpt-image-2`。
- 生产配置锁定快照
  `gpt-image-2-2026-04-21`，避免浮动别名升级造成未评估的行为变化。
- 视频模型使用精确的开源模型家族 `Wan2.2-I2V-A14B`。
- 视频执行面使用自托管 ComfyUI Worker，可运行在云 GPU 或经过验证的 DGX
  Spark 上。
- 首版采用 ComfyUI 官方原生 Wan2.2
  I2V 工作流和官方发布/重打包的 I2V 高噪声、低噪声模型文件。
- 不启用 GGUF、4-step LoRA、社区 Wrapper 或百炼 `wan2.2-i2v-plus` 自动回退。
- 如果以后接入
  `wan2.2-i2v-plus`，它必须使用独立模型 ID、能力清单、价格和验收基线。

### 2. 工作流形态

首版 Pipeline Profile ID 固定为
`gpt-image2-wan22-i2v-a14b-v1`；修改模型快照、模型资产或关键默认值时必须创建新的 Profile 版本，不能原地改变已运行 Pipeline 的语义。该 ID 目前只是为首版保留；Phase
C 冻结 checkpoint、精度配置、Workflow 和各自哈希之前，不得把它标记为可用于生产。

工作流是可暂停、可选择、可追溯的复合 Pipeline，而不是在一次视频提交前临时调用图片 API：

```text
创意 Brief
  -> 计划确认
  -> GPT-Image-2 首帧候选
  -> 图片 QA 与人工选图
  -> 首帧标准化
  -> Wan2.2-I2V-A14B 预览候选
  -> 视频 QA 与人工选择
  -> Wan2.2-I2V-A14B 720P 成片
  -> 后处理、最终 QA 与产物登记
```

Pipeline、Stage 与 Approval
Gate 分别建模。上游 Prompt 或首帧被修改后，已经生成的下游 Stage 必须标记为
`superseded`，不能继续晋级为成片。

### 3. 默认生成规格

- 默认画幅：16:9；首版同时支持 9:16。
- 1:1 在完成真实 A14B 工作流验证前不对外承诺。
- GPT-Image-2 首帧：2 个 `medium` 候选，PNG、opaque、sRGB、8-bit RGB。
- 横屏首帧：`1280x720`；竖屏首帧：`720x1280`。
- A14B 预览：同一模型、480P 面积档、2 个 seed。
- A14B 成片：720P 面积档、81 帧、16 fps、名义时长约 5 秒。
- 运行时 Prompt
  Extension 默认关闭；如需扩写，必须在计划阶段生成、展示并固定版本。

### 4. Prompt 契约

一个用户 Brief 必须编译成三份相互独立的 Prompt：

- `stillPrompt`：主体身份、环境、构图、景别、光照、色彩、静态风格和运动留白；
- `motionPrompt`：主体运动、环境次级运动、镜头运动、速度和连续性约束；
- `negativePrompt`：主要供 Wan 使用，约束身份漂移、畸变、重复主体、闪烁、跳切、文字和水印。

原始 Brief、自动编译版本和人工修改版本都必须独立保存、版本化和计算哈希。

### 5. 人工确认

默认启用以下人工 Gate：

1. 确认 Pipeline Plan；
2. 选择或修改 GPT-Image-2 首帧；
3. 选择 A14B 预览的动作与运镜方向；
4. 接受成片或发起明确的 reroll。

自动 QA 只负责硬校验、排序和风险提示，不能替代最终审美选择。

## 原因

- 用户明确要求使用 `Wan2.2-I2V-A14B`，因此模型身份优先于托管 API 的便利性。
- 当前仓库已经以 ComfyUI、白名单 Workflow、异步任务和 Artifact
  Manifest 为基础，自托管 A14B 与既有方向一致。
- 先确认首帧可显著减少昂贵视频生成阶段的构图浪费。
- 图片与视频 Prompt 分离可以避免静态外观描述和运动条件互相竞争。
- GPT-Image-2 能直接输出符合约束的 `1280x720` 与
  `720x1280`，无需先生成其他比例再隐式裁切。
- 全链路 Artifact lineage 能支持恢复、审计、成本统计和后续多镜头角色一致性。

## 被否决或延后的方案

### 将 `wan2.2-i2v-plus` 当作 A14B 云端别名

否决。公开规格和控制参数不同，且没有官方同权重声明。未来可以作为独立的托管商业后端接入。

### 使用 TI2V-5B 生成预览，再用 A14B 生成成片

首版否决。两个模型之间的运动与风格漂移会降低预览选择的可信度。预览和成片均使用 A14B，通过分辨率与候选数量控制资源。

### 使用 Responses API 完成单轮首帧生成

首版否决。Image
API 可以显式选择 GPT-Image-2、尺寸、质量和候选数量，更适合确定性的流水线契约。多轮交互式编辑仍可在未来单独评估。

### 单次调用自动完成图片和视频

否决。缺少人工 Gate、失败隔离和 Artifact
lineage，也容易在重试时重复计费或覆盖已批准资产。

## 影响

### 正向影响

- 模型身份、Prompt、输入帧、seed、Workflow 和输出可以完整追踪。
- 图片阶段与视频阶段可以独立重试和计费。
- 未来可以增加新的图片或视频后端，而不改变 Pipeline 领域模型。
- 可以对人物一致性、首帧保持度和视频时序质量建立独立基线。

### 成本与风险

- A14B 官方单卡参考需要至少约 80GB 显存；DGX Spark 的统一内存表现仍需实测。
- GPT-Image-2 是外部付费 API，需要处理组织验证、限流、审核、超时和不确定结果。
- 人工 Gate 增加交互步骤，但避免把低质量首帧直接放大为高成本视频。
- 480P 预览晋级到 720P 时，即使复用 seed，也不保证动作逐帧一致；预览只能用于选择方向。

## 后续工作

contracts、Fake Backend 与恢复测试已作为 Phase A 完成。后续按
[开发规格](../development/gpt-image-2-wan22-i2v-a14b.md) 进入 Phase
B–D：在密钥、低额度开关、远端对账与安全评审完成前不调用 GPT-Image-2；在 checkpoint/Workflow/精度配置和哈希冻结、硬件 smoke
test 完成前不调用 A14B。详细完成度见[实现状态](../development/implementation-status.md)。

## 参考资料

- [OpenAI GPT-Image-2 模型页](https://developers.openai.com/api/docs/models/gpt-image-2)
- [OpenAI 图像生成指南](https://developers.openai.com/api/docs/guides/image-generation)
- [Wan2.2 官方仓库](https://github.com/Wan-Video/Wan2.2)
- [ComfyUI 官方 Wan2.2 工作流](https://docs.comfy.org/tutorials/video/wan/wan2_2)
- [阿里云百炼视频模型目录](https://help.aliyun.com/zh/model-studio/video-generate-edit-model/)
