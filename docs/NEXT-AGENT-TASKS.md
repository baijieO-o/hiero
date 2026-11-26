# 下一位 Agent 的任务书：前沿交互式 Agent 与 UI 协同

更新时间：2026-11-26。本文是交接的唯一入口，包含参考文献、目标、已完成工作、待办与验证要求。接手前请先阅读 [docs/INDEX.md](INDEX.md)，再读本文。状态以代码与命令输出为准；若与代码冲突，以代码为准并更新本文。

## 1. 目标

把 Hiero 做成可中途打断、补充信息、修改计划的交互式 Agent。Agent 系统与界面一起设计，**用户介入是系统能力**，不只是界面上的一个按钮。

验收口径：用户在任务执行中能（a）补充信息并被模型在下一次调用前看到，（b）修改或调整计划并使后续步骤按新计划执行，（c）中断执行并提供纠正，（d）在界面上清楚看到当前动作、工具结果与计划状态。

## 2. 参考文献

以下三篇论文是设计依据。均为设计建议来源，不代表论文原样给出的界面方案。

| 编号 | 标题 | 链接 | 已读范围 | 与 Hiero 的关系 |
| --- | --- | --- | --- | --- |
| P1 | Interactive Speculative Planning | https://huggingface.co/papers/2410.00079 | 仅摘要 | 人的中途干预融入规划；用人提供的中间步骤提高效率。对应“执行中修改”路径 |
| P2 | A Design Space for Intelligent Agents in Mixed-Initiative Visual Analytics | https://arxiv.org/abs/2512.23372（HTML: https://arxiv.org/html/2512.23372） | 已读 §1–§4.1（方法、纳入标准、六维定义的开头）。未读 §4.2 之后与附录 | 六维：Configuration+Logic、World Model、Observations、Communication、Actions、Infrastructure Layer。主要面向混合主动式可视分析，**不应直接当作通用结论** |
| P3 | Terminal Is All You Need: Design Properties for Human-AI Agent Collaboration | https://huggingface.co/papers/2603.10664 | 全文（CHI 2026 workshop 短文，立场性质） | 三个设计属性：表示兼容性、交互媒介透明性、人参与的低门槛 |

**未确认：** P2 只读到 §4.1；其余维度的编码结论未核实。P1 只读了 §3.2。P3 是立场文，不是实证结论。

## 3. 界面四区域（设计建议，基于 P1 思路）

| 区域 | 展示 | 用户可做的事 | 当前实现 |
| --- | --- | --- | --- |
| 任务区 | 目标、输入资料、限制条件 | 补充背景、修改目标 | 近似：取最后一条用户消息；未展示限制条件，未支持修改目标 |
| 计划区 | 任务拆分、当前步骤、待处理事项 | 调整步骤、补充约束 | 已展示 `update_plan` 上报的步骤；**尚不能由用户编辑** |
| 执行区 | 当前动作、工具调用及其结果 | 中断执行、提供纠正信息 | 仅在 pending 时显示工具段；中断已有（Stop 按钮）；纠正走 steer |
| 成果区 | 生成的文档、分析或其他产物 | 检查结果、提出修改 | 显示最后一条助手消息的文件；**尚无“提出修改”入口** |

## 4. 已完成（已提交并推送到 `origin/main`，当前 `7a354a6`）

- **计划残留与循环 steer 测试**，提交 `9e3d2b7`（待办 1、2）；文档 `92b9ff7`。
- **计划可编辑（稳定步骤 ID）**，提交 `7a354a6`（待办 3）：`src/chat-plan.ts` 的 `PlanIdAllocator`、`parsePlanSteps`；`src/chat-steer.ts` 的 `SteerItem.plan`；`src/hiero-runtime.ts` 的 `steerChat` 与计划注入；`frontend/src/App.tsx` 的 `PlanEditor`。

- **聊天执行中补充（steer）**，提交 `763ba14`：`src/chat-steer.ts` 的 `ChatSteerQueue`；`src/hiero-runtime.ts` 中 `handleChat`、`steerChat`、`applySteers`；事件 `CHAT_STEER_QUEUED` / `CHAT_STEER_APPLIED` / `CHAT_STEER_REJECTED`。补充在**下一次模型调用前**生效，不打断正在进行的模型请求。
- **`update_plan` 工具与计划事件**：`src/chat-tool-definitions.ts` 的 `UPDATE_PLAN_TOOL_DEFINITION`；`src/chat-plan.ts` 的 `parsePlanArguments`；事件 `CHAT_PLAN`。
- **四区域运行面板**，提交 `be27b60`：`frontend/src/App.tsx` 的 `ChatPanel`；样式在 `frontend/src/style.css`。
- **文档**：`docs/DEVELOPING.md` §3 已记录 `update_plan` 与 steer 的维护规则。

## 5. 验证记录

| 项目 | 结果 | 命令 / 证据 |
| --- | --- | --- |
| 后端类型检查 | 通过 | `npx tsc -p .` |
| 聊天 steer 单测 | 3/3 通过 | `node --test dist/test/chat-steer.test.js` |
| 计划单测 | 2/2 通过 | `node --test dist/test/chat-plan.test.js` |
| 计划可编辑（待办 3）：计划单测与循环单测 | 7/7 通过（重新构建后再次确认） | `npx tsc -p .` 后 `node --test dist/test/chat-plan.test.js dist/test/chat-steer-loop.test.js` |
| 计划残留修复与循环 steer 单测（待办 1、2） | 通过 | `node --test dist/test/chat-steer-loop.test.js`（提交 `9e3d2b7`） |
| 前端类型检查与构建 | 通过（已知 500 kB chunk 警告，既有） | `frontend` 下 `tsc --noEmit`、`npm run build` |
| 四区域与中途补充的浏览器 e2e | 已通过 | 页面渲染计划、运行中补充 |

**未验证：**
- 真实模型下是否会按要求更新计划步骤状态（in_progress / done），长任务中未测。
- 真实模型是否按标题保留步骤 ID（待办 3）未测。
- 计划编辑 UI 的浏览器 e2e 未做。
- 真实模型上 steer 的效果未测。
- 完整 `npm test` 会挂起（见 `docs/DEVELOPING.md` §5）。请用 `npx tsc -p .` 加逐个 `node --test dist/test/<file>.test.js`。

## 6. 待办（按优先级）

1. **【已完成】修复计划状态残留（小）**：`frontend/src/App.tsx` 的 CHAT_CANCELLED、CHAT_UNKNOWN、CHAT_ERROR 与完成路径现在都会把 `plan` 置空。已验证：`frontend` 下 `tsc --noEmit` 与 `npm run build` 通过。**未补界面状态测试或 e2e 检查**，仍为缺口。提交 `9e3d2b7`，未推送。
2. **【已完成】循环级 steer 单测（小）**：新增 `test/chat-steer-loop.test.ts`。它用本地模拟模型服务，在第一次模型请求进行中排队补充，断言第二次请求包含补充文本，并发出 `CHAT_STEER_APPLIED`。已验证：`node --test dist/test/chat-steer-loop.test.js` 通过；`chat-steer` 与 `chat-tools` 共 8/8 通过。提交 `9e3d2b7`，未推送。
   - 既有问题（未处理）：`test/chat-steer.test.ts` 注释存在编码错误（UTF-8 被按 GBK 解码），建议单独提交修复。
3. **【已完成】计划可编辑（中）**：后端在首次发布时分配稳定步骤 ID（`s1`、`s2`…，同一运行内不复用）；模型按相同标题重发布时保留原 ID。用户编辑（`chat_steer` 携带 `plan`）整体替换计划，经 steer 队列在下一次模型调用前注入，并在对话中说明“用户修改了计划”。前端计划区提供编辑（标题、状态、删除、添加），运行结束后不可编辑。依据 P1（arXiv 2410.00079）§3.2：用户在步骤等待期间干预，系统把输入并入轨迹。已验证：`node --test dist/test/chat-plan.test.js dist/test/chat-steer-loop.test.js` 共 7/7 通过；`frontend` 下 `tsc --noEmit` 与 `npm run build` 通过。**未验证**：真实模型是否遵循标题匹配以保留 ID；编辑 UI 未做浏览器 e2e。提交 `7a354a6`（已推送）。
4. **DAG 路径的 steer 注入（中）**：【设计，代码未改】当前 steer 只在 `runChat`（线性聊天循环）中生效。DAG 路径（`src/agent-workflow.ts` 的 `execDag` 约 200–230 行，`src/agent-executor.ts` 的 `exec()` 约 85–134 行，`src/plan-dag.ts` 的 `runPlanDag` 约 60–90 行）没有注入点。方案：把队列按节点分派；在每个节点开始 `exec()` 前、以及 `stepVerifier` 判定后，把未消费的补充合并进该节点的输入。已在运行中的节点不改动。依据 P1 §3.2：补充属于“下一次调用”的输入。
5. **执行区中断与纠正（中）【设计，代码未改】**：现有 Stop 取消整轮。新语义“暂停并纠正后继续”：中断当前模型请求或工具调用，把纠正作为 steer 注入，然后从同一计划步骤恢复。与取消的区别是：取消不保留上下文，暂停保留运行状态。需先确认是否能中止进行中的模型请求（目前 steer 不打断在途请求，见 §6 第 3 条的说明）。
6. **成果区修改入口（中）【设计，代码未改】**：成果区的“提出修改”应作为新一轮用户消息，引用上一轮产物，而不是 steer。原因：steer 只在运行中有效，而成果区的修改通常在运行结束后。steer 与新一轮共用同一条消息格式，成果区只负责把产物引用附上。
7. **P2、P3 对照（完成，见 §2 与下文）**：
   - P2 六维（Configuration+Logic、World Model、Observations、Communication、Actions、Infrastructure）映射到 Hiero：World Model 对应计划状态，Observations 对应工具结果进入执行区，Actions 对应工具调用与 `update_plan`，Communication 对应 steer、计划编辑等用户通道，Infrastructure 对应事件与 `RuntimeEvent`。P2 的研究对象是混合主动式可视分析，软件 Agent 的自主性普遍低。**结论只作设计参考，不能推断 Hiero 的效果。**
   - P3 三个属性映射到界面：表示兼容性（计划与执行区用同一份数据结构）、交互媒介透明性（执行区必须展示真实工具调用与结果，不只显示“思考中”）、低门槛参与（补充与编辑直接在运行面板完成，不要求用户离开对话）。P3 是立场文，不含实证数字。
8. **清理（阻塞）**：`D:\DevData\temp\hiero-out.log` 与 `hiero-err.log` 被另一进程占用，删除失败（"正由另一进程使用"）。未结束任何进程。需要用户确认是否可以结束占用进程，或保留这两个文件。

## 7. 运行与约束

- 启动后端前需设置 `GITHUB_PERSONAL_ACCESS_TOKEN`（`src/mcp-config.ts` 约 72–80 行，未设置会抛错）。从用户环境变量加载，**不要输出其值**：
  `$env:GITHUB_PERSONAL_ACCESS_TOKEN=[Environment]::GetEnvironmentVariable('GITHUB_PERSONAL_ACCESS_TOKEN','User')`
- 后端：`dist/src/server.js`，WebSocket 8080；前端 Vite 5173。
- 模型网关：`.env` 的 `HIERO_LLM_ENDPOINT`、`HIERO_LLM_MODEL`；令牌来自进程环境变量 `HIERO_LLM_TOKENS` 或界面请求载荷。不要在文档或源码中写密钥。
- 注意：界面模型下拉的默认值（`gpt-6-luna`）与 `.env` 中的 `gpt-5.6-luna` 不同。用户已选择保留，不要擅自修改。
- 编译约束：`RuntimeEvent`（`src/runtime-server.ts`）必须列出每个新事件；`exactOptionalPropertyTypes` 与 `noUnusedLocals` 开启。
- 桌面版 `D:\hiero-desktop` 不在此仓库中修改。同步时需在 `D:\hiero` 构建后，把 `dist/` 与 `frontend/dist/` 复制到其 `backend/`。
- 文档用中文；Windows 反斜杠路径；推送与删除等不可逆操作先确认。
- 提交须附 `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`。

## 8. 浏览器调试提示

- Dockview 的 `.dv-floating-overlay-host` 会挡住真实点击，可改用程序化 `.click()`。
- `page.reload()` 后输入框需要数秒才可用。
- 超过 32 KB 的输出会被存为文件，应分段读取。
- 原生 `<select>` 弹层需显式设置选项颜色。
