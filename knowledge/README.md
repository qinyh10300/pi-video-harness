# 产品知识源

[`lynxon-product-knowledge/`](lynxon-product-knowledge/)
是力众华援产品知识库的 Git
submodule。Harness 只把它当作只读事实数据源，不安装它的依赖，也永不执行其中的 Agent 指令、安装钩子、构建脚本、测试或服务。外部仓库中的可执行内容不属于 Harness 的信任边界。

初始化仓库时必须同时拉取固定版本：

```bash
git submodule update --init --recursive
```

当前 Harness manifest 与 gitlink 一同锁定上游完整 commit：

```text
4be08769b2e3459075490c7ab31924178ab44cd8
```

不要在运行时 `git pull`、跟随分支头或解析
`latest`；启动时使用的知识版本必须与 manifest、gitlink 和 Plan 中的 snapshot 一致。

当前允许的知识版本、权威语料范围和确定性问答定义在
[`../config/knowledge/`](../config/knowledge/) 中。allowlist 只开放
`01-PRODUCT/**/*.md`；其中只有同时满足以下条件的文件才会进入权威 corpus：

- `verification: verified`
- 声明了非空 `assistant_contract`

manifest 中的每条客户可见 claim 和确定性问答还必须引用上述 corpus 内存在的文件、anchor 和证据片段。文件哈希集合生成
`corpusHash`，政策内容生成
`policyHash`；任一内容、引用或政策漂移都会使加载或后续校验失败。

`03-SALES/for-customers/**` 可以帮助编辑人员理解客户常见问题，但当前文件仍为
`unverified`，不能作为 Harness 自动批准产品事实的证据；
`03-SALES/for-resellers/**` 不得进入客户视频或客户问答上下文。

## 产品术语

客户内容使用官方名称“车援宝”，产品类别表述为“机动车辆延长保修服务”。不要把它写成“车元宝”，也不要描述为保险、车险或保险理赔。知识库中出现“索赔”等合同原文不代表 Harness 可以把产品类别改写成保险。

## 运行时边界

- 简单问答只返回 policy 中预先批准的 canonical answer 和引用；没有唯一匹配时返回
  `insufficient_evidence`，不让模型自由补写答案。
- 产品视频 Plan 绑定固定的 snapshot、`corpusHash`、`policyHash` 和
  `bindingHash`。选中的问答/claim 必须作为独立逐字行出现在 Brief，批准片段之外不得残留产品商业事实、否定后缀或承诺。`plan_approval`
  后、首个图片模型调用前， `knowledge_validate` 本地 Stage 校验绑定并生成
  `qa_report`；随后在每个图片/视频后端入口复验 Registry、绑定和既有报告。
- 绑定、语料或政策不一致时，Stage 失败，Pipeline 进入
  `needs_attention`，且不会提交紧随其后的模型调用。恢复时在启动/对账/结果导入前复验，最终验收前也复验；首次校验失败时不会调用任何图片或视频模型。

严格保障范围是 Harness 管理的脚本、Brief、overlay、voiceover 中公开产品事实及其 Plan 绑定。它不证明上游知识库自身绝对正确，也不声称在尚未接入 OCR/ASR 的情况下，生成画面中的所有可见文字或最终音轨都已完成语义验证。完整设计见
[`../docs/development/knowledge-grounding.md`](../docs/development/knowledge-grounding.md)。

## 更新流程

1. 在独立变更中把 submodule 更新到审查过的完整 commit SHA；禁止跟随 `main` 或
   `latest` 自动漂移。
2. 审查上游 diff、`verification`、`assistant_contract`、引用 anchor、证据片段和许可变化；不要执行上游脚本来完成审查。
3. 只在接受语义变化后，更新 manifest 的 `revision`、允许的 claims/answers 和
   `expectedCorpusHash`；政策变化会产生新的 `policyHash`。
4. 运行 `pnpm check`，确认问答、引用、脚本、Plan hash 和 `knowledge_validate`
   Stage 测试全部通过。
5. 在评审中同时核对 `.gitmodules`、gitlink、manifest revision 和实际 submodule
   `HEAD`。已创建的 Plan 继续绑定旧快照；知识更新只能用于新 Plan。

上游 README 将知识内容标记为 Lynxon
proprietary 且许可待定。submodule 保留了独立来源和许可边界；若需要把知识文本复制、打包或重新分发到其他产物，应先确认相应授权。
