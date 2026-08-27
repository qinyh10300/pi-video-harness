# 视频脚本目录

这里保存可版本化、可校验的多镜头创意脚本。脚本只描述创意与每个 5 秒镜头，不改变当前 Pipeline 的单镜头执行模型；调用方应使用
`createPlanInputsForVideoScript` 将脚本按顺序展开为多个
`CreatePlanInput`，再逐镜头生成和组装。当前格式为
`schemaVersion: "2"`；产品事实必须先经过固定版本知识库绑定。

## 目录与命名

```text
config/video-scripts/
  <产品或活动>/
    <scriptId>.v<scriptVersion>.json
```

- `schemaVersion` 是文件格式版本，只有契约发生破坏性变化时才升级。
- `scriptVersion`
  是脚本内容版本。发布后不覆盖旧文件；修改内容时复制为新版本并递增数字。
- `scriptId` 使用小写英文、数字和连字符，文件名必须与内部 ID 和版本完全一致。
- 产品目录可以继续分层；Registry 会递归扫描 `.json`，并按规范化路径稳定排序。
- 不允许软链接，也不允许重复的 `(scriptId, scriptVersion)`。

## 镜头约束

- 当前运行时每个镜头固定为 5 秒；`startSeconds` 必须从 0 开始连续排列。
- 所有镜头时长总和必须等于 `format.targetDurationSeconds`。
- 同一脚本版本内 `shotId` 必须唯一。
- 精确中文应放在 `overlay`
  中由后期添加；生成 Prompt 里的手机或屏幕只保留干净 UI 框架，避免模型生成乱码。
- 人物连续性、车辆连续性、广告合规边界和禁止承诺应分别写入 `continuity` 与
  `compliance`，不要只埋在某一个镜头 Prompt 中。
- 展开 Plan 时只把视觉风格、主角、服装、车辆和场景加入共享视觉上下文；
  `continuity.constraints`
  仍用于脚本审计，但不会整体复制到模型 Prompt，避免其中的产品流程或禁止话术重新进入 caller-controlled
  model text。
- 多镜头使用同一人物或车辆时，应通过
  `createPlanInputsForVideoScript(..., { knowledgeRegistry, referenceAssetIds })`
  向每个镜头传入同一组已审核参考图；文字连续性约束不能替代视觉参考。
- 车援宝必须称为“机动车辆延长保修服务”，不得描述为机动车保险、原厂质保或厂家官方服务。
- 不得暗示故障发生后临时签约即可追溯处理本次故障。涉及时间线时，用“生效后设置30日等待期”说明规则，用“生效后等待期已满30日”描述本次故事状态；不得回避既有故障限制。

## 知识绑定

- 根级 `knowledge` 是必填的
  `KnowledgeSelection`，只保存固定知识库与策略 ID、问答 ID，以及与策略文本逐字一致的断言。
- 每个镜头必须显式提供 `knowledgeQaIds` 和
  `knowledgeClaimIds`；引用只能来自根级选择，同一数组不允许重复。
- 脚本中的 `compliance`
  只负责免责声明和禁止表达，不能用自由编写的“允许声明”授权产品事实。
- 展开镜头时必须传入已经加载并校验过的
  `ProductKnowledgeRegistry`。每个镜头会按最小选择编译独立
  `KnowledgeBinding`，其权威声明、问答、引用、快照与绑定哈希会进入 Brief 和 assembly。
- 问答的提问与回答应逐字采用 binding 中的 `canonicalQuestion` 与
  `canonicalAnswer`；产品事实应逐字采用 `approvedText`，不要自行扩写或改写。
- 被镜头引用的每条 Claim 与 QA 必须在 `overlay` / `voiceover`
  的独立字段中逐字出现；这些公开字段出现额外的产品事实信号时会拒绝展开，不能用“先放一条正确引用、再追加矛盾话术”的方式绕过。
- `requiredDisclaimer`、全部 overlay 字段和 voiceover 都经过同一公开文本防护；即使句子不含品牌名，像“坏了后再办也能处理”这样的同义时间/结果承诺也会失败。
- 公开字段在逐字段校验后还会规范化并合并扫描，不能通过零宽/组合字符拆词，也不能把一句矛盾话术拆到 headline、subline 或 footnote；`requiredDisclaimer`
  必须保留批准的情景演绎与以实际条款为准模板。
- Plan 的 Brief 只由中性的标题/镜头描述、视觉风格和 `formatGroundedBrief`
  的逐字批准片段组成；`product.positioning` 与 `compliance.forbiddenClaims`
  不注入 Brief。still/motion/negative
  Prompt 也不得携带 caller-controlled 产品或商业事实。
- 每个展开后的 Brief、still Prompt、motion Prompt 和 negative Prompt 都会再通过
  `ProductKnowledgeRegistry.validateGroundedContent`。选中的 Q&A/Claim 原文缺失、未选中的批准事实出现，或残留产品/商业术语时，Plan 输入不会产生。

## 选择与复现

运行时应显式保存并选择
`scriptId + scriptVersion + scriptHash`，不要隐式选择“最新版本”。这样同一活动重跑时不会因目录中新增版本而发生内容漂移。

当前示例：

- `car-warranty/car-warranty-female-travel-breakdown.v1.json`：15 秒、9:16、3 个镜头，以“生效后等待期已满30日”交代故事时间，描述成年女车主自驾途中遇到机械故障，随后展示车援宝知识库绑定的逐字权威问答。
