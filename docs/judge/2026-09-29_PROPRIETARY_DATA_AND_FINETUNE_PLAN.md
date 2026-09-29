# 收集专有数据、微调 Qwen 以超过 Kev 的计划（2026-09-29）

> 状态：**计划**，尚未实施。第 2 节的数据闭环需要新代码。
> 相关：[为什么选择 Kev](2026-09-29_WHY_KEV.md) · [Kev 的训练数据](2026-09-29_KEV_TRAINING_DATA.md) · [`docs/EVAL.md`](../EVAL.md)

## 0. 核心判断

- **Kev 本身就是 Qwen + LoRA。** "微调 Qwen 超过 Kev" 的正确做法是**从 Kev 的 checkpoint 出发**（`--init_from`），用我们自己的标注数据继续训练，而不是从裸 Qwen 从头开始。
- Kev 记录过一个反例：从裸 Qwen 基座微调，在 Kev 自己的评测集上从 0.84 掉到 0.33；同样的数据加 `--init_from`，保持 0.83，并在新领域达到 0.88。
- **"超过 Kev" 只在我们自己的问题分布上成立**，这也正是产品需要的。通用知识类任务不会因此变好。
- **瓶颈是可信的标签**，不是训练。Kev-4B 一次训练在 H100 上约 1 美元。

## 1. 已有的验证

用 5 个开源 agent 安全基准（InjecAgent、AgentDojo、ASB、ToolEmu、tau-bench）的 1,183 条训练记录微调 Kev-0.8B（2 个 epoch，Mac 上 39 分钟）。在从未见过的 AgentDojo 测试集上（数字来自 [`docs/EVAL.md`](../EVAL.md) 的生成块）：

| AUROC | Kev-4B 原版 | Kev-0.8B 微调后 |
|---|---|---|
| instruction_override | 0.792 | **0.973** |
| goal_deviation | 0.541 | **0.961** |

**保留意见：**
- 标签从基准自带的 ground truth 推出，没有人工复核；
- 测试集中负样本的低权限文本是构造的，正样本是录制的，存在"风格捷径"风险；
- 因此拟合出的校准只记录、未启用。

小模型加领域数据已经在我们的问题上超过大一号的原版。下一步是用真实数据把这个结论变得可信。

## 2. 数据闭环

### 2.1 已有的部分

每次判断，系统都会把 snapshot 写入数据库：judge 视图文本（已脱敏）、问题、模型回答、`judge_source`。**输入已经齐全，缺的是标签。**

库里已有 `labels` 表（`server/storage/migrations/0001_init.sql`），`evidence_class` 支持 `benchmark_ground_truth_derived` / `heuristic_derived` / `human_reviewed`，但**目前没有代码写入它**。

### 2.2 需要新增

- `POST /v1/labels`：写入标签，记录来源和 `evidence_class`；
- 审核队列 UI：展示待标注的 snapshot 和问题，审核人给出答案；
- 导出脚本：把 snapshot 与标签 join 成 Kev 训练格式 JSONL，附数据集哈希和切分信息；
- 主动学习采样规则（见 2.3 第 5 条）。

### 2.3 标签来源（可信度从高到低）

1. **人工复核。** gate 模式下被 HOLD / REVIEW 的调用，审核人批准或拒绝即产生一条 `human_reviewed` 标签。
2. **事后结果。**
   - outcome 回读（S5 场景）的成功 / 失败 → `claim_support`、`claim_asserts_completion`；
   - 撤销、拒付、客户投诉、安全事件 → 回溯标注正样本。
3. **沙盒红队。** 在自己的工具和数据上运行注入、越权、错误收款人等场景，标签由场景定义决定。相当于 Kev 的 `hard-v1`，但用的是我们的工具和措辞。
4. **教师模型标注。** 两个开源大模型一致才保留，再人工抽检（Kev 在 CFPB 上的做法）。标为非 `human_reviewed`，只进训练集，不进测试集。
5. **主动学习。** 优先把最有信息量的样本送去人工：
   - Kev 概率在 0.3 到 0.7 之间；
   - 硬规则与 judge 结论冲突；
   - 原版与微调版结论不同。

### 2.4 规模

- Kev 的经验：400 条增益在噪声里，1,000 条左右开始可测，5,000 条真实数据带来约 10 个点。
- 目标：**每个 rubric 问题至少几百正样本 + 几百负样本**。
- `payee_relation` 和 `claim_support` 目前完全没有数据，优先补齐。

### 2.5 合规

- 数据先经过现有脱敏流程再入库；
- 按租户隔离，训练前取得租户同意；
- 规定保留期限；
- 密钥、`.env` 内容永远不进训练集。

## 3. 训练

```bash
uv run python -m kev.train --data ours-train.jsonl \
  --base Qwen/Qwen3.5-4B-Base --init_from jaredpalmer/kev-4b \
  --replay 2000 --lr 2e-5 --epochs 1 --out runs/ft-kev-4b-<date>
```

- `--init_from`：保留 Kev 已学到的判别能力，再叠加我们的领域。
- `--replay`：混入 Kev 原训练数据，防止遗忘。
- 学习率 2e-5，1 到 2 个 epoch（与本项目 [`eval/finetune/finetune.sh`](../../eval/finetune/finetune.sh) 一致）。
- **尺寸：** gate 模式用 0.8B（有延迟预算）；shadow 模式可用 4B 或 9B。
- 训练后在校准集上拟合温度。

## 4. 评估：怎样才算"超过 Kev"

- **测试集冻结、只读一次。** 按时间和租户 / 工具切分，不按随机行切分；只放 `human_reviewed` 标签。
- **对比对象：** 原版 Kev-0.8B、Kev-4B；有 key 时加 TypeSafe Jev；保留 B0 规则基线。
- **指标：**
  - AUROC；
  - 策略工作点上的召回率与误报率；
  - Brier / ECE；
  - gate 模式下的 p95 延迟（必须在 400 ms judge 预算内）。
- **防退化：** 在 Kev 的公开评测集（`transfer-v4`）上确认没有明显下降；沿用本项目的 shortcut audit。
- **所有数字由脚本从预测文件生成，并有漂移测试**，不手写进文档。

## 5. 上线顺序

1. 新模型在 shadow 模式下与原版并行运行、对照记录；
2. 达到第 4 节标准后，启用在本部署自有标签上拟合的校准；
3. 最后才进入 gate 模式。

## 6. 下一步（待确认后实施）

1. `POST /v1/labels` 与审核队列 UI；
2. 主动学习采样；
3. 导出 Kev 训练格式 JSONL 的脚本（带数据集哈希与切分）；
4. 积累到每个问题数百条标签后，执行第 3、4 节。
