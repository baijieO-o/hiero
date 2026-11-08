# Hiero 交接文档（精简版）

更新时间：2026-11-05
完整历史记录：会话目录 `files/HANDOFF-full.md`。

## 1. 项目

Hiero 是位于本机仓库根目录的个人 Agent 工作台。
- 后端：Node + TypeScript，WebSocket `ws://localhost:8080`
- 前端：React + Vite，`http://localhost:5173/`
- 核心：状态机（Plan / Exec / Verify / Handoff / Rewind）、工具网关、模型网关（令牌池）、MCP / Skill 路由、系统代理子进程

## 2. 运行与测试

```powershell
# 后端
cd <仓库根目录>; npx tsc -p .; node dist\src\server.js
# 前端
cd <仓库根目录>\frontend; npm run dev
# 一键启动
<仓库根目录>\launch-hiero.bat
```

- 后端测试：`npm test`（= `tsc && node --test dist/test/*.test.js`）
- 类型检查：`npx tsc -p .`（不要传文件参数，TS5112）
- 前端构建：`npm run build`（= `tsc && vite build`）

## 3. 已完成
- WebSocket 安全：仅接受回环地址连接；浏览器 Origin 必须是 localhost / 127.0.0.1 / [::1]（无 Origin 的非浏览器客户端允许）。实现：`src/ws-guard.ts`，测试 `test/ws-guard.test.ts`。默认地址仍为 `ws://localhost:8080`，可用前端环境变量 `VITE_HIERO_WS_URL` 覆盖。
- MCP 默认根目录随聊天工作区（`defaultMcpConfig(root)`），不再写死固定目录。
- MCP 传输：支持 stdio、sse、http（远程需 `url`，可选 `headers`）。`${VAR}` 占位符在连接时从环境变量展开，凭据不写入 `mcp.json`。
- MCP 预设（文件系统、GitHub、Postgres）：前端一键添加，默认禁用，需手动启用后保存。
- 令牌用量：模型网关记录 `usage`（流式请求带 `stream_options.include_usage`）；聊天回复显示模型调用次数、输入/输出 tokens、耗时。价格估算与成本未实现。
- 平台决策：保留网页版（Vite）为主平台，暂不做 Electron 桌面版。

- 执行保护（`src/agent-executor.ts`，测试 `test/exec-guards.test.ts`）：同一工具、同一参数连续调用 3 次触发 `MOD-005` 熔断；超过 `budget_envelope.max_time_ms` 触发 `MOD-006`。
- 用户中断（Stop）：前端生成中显示「停止」按钮，发送 `chat_cancel`；后端 `activeChats` 中对应的 AbortController 中止模型请求，返回 `CHAT_CANCELLED`，已生成的部分文本保存为助手消息。模型层 `MOD-007` 不重试、不轮换 token。实现：`src/hiero-runtime.ts`、`src/model-gateway.ts`，测试 `test/model-cancel.test.ts`。
- 本地 OpenAI-compatible 模型支持：Ollama/vLLM 可在 `HIERO_LLM_TOKENS` 为空时调用，不发送空 Authorization；README 与 `.env.example` 有 Qwen/Llama 示例。`npm test` 验证 60 项通过。
- 终端命令沙箱：尝试通过 Docker 运行命令，工作区只读挂载，网络禁用，容器根目录只读并设置资源限制；Docker 不可用时失败关闭，不回退宿主机 shell。实现位于 `src/workspace-services.ts`。
- 注：沙箱依赖本机 Docker 和 `node:22-alpine` 镜像。容器挂载目前为只读，终端不能在工作区写文件；未做 Docker 实际运行验证，仅完成 TypeScript 构建和 `npm test`（49 项通过）。此方案是纵深防护，不代替 WebSocket 认证/权限治理。
- 上述两项说明与示例已记录在 README / `.env.example` 中；HANDOFF 保持精简。
- 上下文压缩（`src/context-compactor.ts`，测试 `test/context-compactor.test.ts`）：`AgentExecutor` 每轮先估算 token，超过阈值（默认 0.8）且配置了压缩器时，把较早的历史交给小模型总结为 `[Compacted history]` 摘要，保留首条 system 消息与最近 6 条原文，并保证 tool_calls 与其结果不被拆开。未配置压缩器或摘要为空时，行为与原来一致（超阈值抛出 `HandoffRequiredError`）。小模型由环境变量 `HIERO_COMPACT_MODEL` 指定，未设置时使用主模型。聊天主循环（`runChat`）每次调用模型前估算 token，超过固定预算 24000（`CHAT_COMPACT_TOKENS`）时使用同一压缩器总结旧消息；聊天没有交接机制，因此只做压缩。`goal` 本身超出预算时压缩无法解决，仍会交接。

聊天界面的手动压缩：输入 `/compact` 或点击会话信息弹层中的"压缩对话"。摘要保存在前端会话上（`compactedSummary` / `compactedUpTo`），可见历史不变，之后的请求只发送"摘要 + 摘要之后的消息"，界面以"已压缩之前的对话"分隔线标记。会话信息弹层通过 `chat_usage` 消息显示上下文窗口用量（固定上限 128K，按约 4 字符/token 估算）。回溯到摘要覆盖范围之前时摘要会被清除。压缩失败时（例如模型令牌冷却中）会返回错误，不改变会话。前端切分逻辑在 `frontend/src/compaction.ts`，由 `test/compaction.test.ts` 覆盖多次压缩的索引计算。只配置一个令牌时，429 会冷却 60 秒，连续多轮对话与压缩容易触发 `MOD-003`，这属于限流而非压缩逻辑错误。

## 4. 未完成 / 待确认

- 最近提出、尚未实现的功能：
  1. Trace/Timeline（已实现基础版）：每次 Chat 请求在后端记录模型调用、工具调用、子代理调用、完成回复与错误（序号、类型、名称、起止耗时、成功/失败、结果摘要），通过 `CHAT_TRACE` 消息发给前端，挂在对应助手消息下的"执行时间线"中可折叠查看。trace 持久化：前端 `hiero-chat` 的 localStorage 中保存每条助手消息的 trace，同时后端在每次成功回复后把 trace 追加到工作区 `.hiero/traces.jsonl`（每行 `{request_id, saved_at, events}`，最多读取最近 50 条）。页面加载时通过 `chat_trace_history` 请求回取，给缺少 trace 的助手消息补回（按 `requestId` 匹配）。错误时 trace 不保存为消息（仅显示错误提示）。Plan/Exec（DAG）工作流的任务级事件通过 `DAG_TASK` 消息广播（每个任务 `running` → `completed`/`failed`，含 `task_id`、`read_only`、错误摘要），由 `createWorkflow` 的 `onDagTask` 接入；它不挂在聊天 trace 中，前端可选择性展示。未做：任务回放（逐帧）、按 token 的细粒度统计。
  2. Session Token 成本统计（已实现基础版）：每条助手回复显示估算成本，会话标题下显示累计 token 与成本。价格从 LiteLLM 公共价格表（`model_prices_and_context_window.json`）自动拉取，启动时加载，本地缓存 24 小时；拉取失败时回退到 `frontend/src/token-cost.ts` 内置的 4 个模型价格。按模型名最长前缀匹配，裸模型名优先于带 provider 前缀的条目。未知模型显示"未知"且不计入估算，人民币按固定汇率 7.2 换算。token 数来自模型 usage 字段，未做本地计数。未做：按天/按模型统计、实时流式成本。
 3. （已完成）MCP 管理 UI：设置面板结构化列表，含预设（filesystem、GitHub、Postgres）与自定义 stdio/sse/http 服务器。启用需二次确认；默认禁用；凭据键（token/secret/password/key/authorization 等）必须使用 \ 占位符，明文会被拦截；URL 不允许内嵌用户名密码，且只接受 http/https。高级模式可直接编辑 JSON。纯校验逻辑在 rontend/src/mcp-model.ts，测试在 	est/mcp-model.test.ts。
- 已完成：标准模式下 git 只读子命令禁止写文件/执行外部程序的参数，路径参数禁止指向工作区之外（保守检查：绝对路径、盘符、`~`、`..`）。
- 安全工作后续建议：MCP stdio 任意命令配置的授权边界；审批与命令执行的审计日志；标准模式的路径检查仅为字符串层面，不能防御符号链接。Docker 终端隔离不是对整个 Agent 的完整沙箱。
- 子代理（中心化，第一步）：聊天工具 `delegate_read`（只读，白名单 `read_file` / `list_dir` / `memory_recall`）与 `delegate_write`（白名单另含 `write_file`，写入仍经 `ToolGateway` 审批）。实现位于 `src/read-only-subagent.ts`，接入 `src/hiero-runtime.ts` 的 `runDelegatedTask`。子代理拥有独立 message 数组，白名单由代码强制，最多 4 轮，结果以摘要回传父级，共享 Stop 信号，不允许嵌套，且不能调用 `memory_remember` / `memory_append`。测试：`test/read-only-subagent.test.ts`。注意：`write_file` 的效果是 `workspace` 且未标记 `irreversible`，单次调用不弹审批。`delegate_write` / `delegate_task` 在非 auto 模式下，会在启动子代理前由操作员对整次委派审批（拒绝则返回错误）。
- 视觉与交互设置（设置面板「外观 / 动效 / 交互」，保存在 localStorage `hiero-preferences`）：渐变透明（`panelGradient`，面板背景从上到下渐隐）、高斯模糊强度（`panelBlur`，0–40px，作用于面板 `backdrop-filter`）、加载动画（`loaderStyle`：三点/旋转圈/脉冲条/无，作用于「思考中」指示器）、面板动画（`panelAnimation`：淡入/滑动/无）、动画速率（`animationSpeed`，0–3 倍，0 等同减少动效）、滚动条显示（`scrollbarVisibility`：始终/悬停/隐藏）、热边（`hotEdgeSidebar`，默认开：作用于全局左侧「快捷入口」栏，平时收成窄栏，鼠标贴近窗口左边缘 8px 内展开，离开后延迟 300ms 收起；手动点击 `«/»` 切换后，离开不再自动收起）。设置通过 `applyPreferenceTheme` 写入 CSS 变量与 `data-*` 属性，样式在 `style.css` 末尾附近。限制：热边与滚动条仅通过浏览器 DOM 状态验证；加载动画与面板动画未做视觉核对。对话面板内的历史侧栏不受热边影响，始终显示。
- 回复时间戳：每条 assistant 回复记录 `completedAt`（完成或中断时写入），悬停消息时在下方显示，离开或静止约 1.5s（`TIMESTAMP_IDLE_HIDE_MS`）后淡出。旧消息没有该字段，不显示。
- 回退与复制样式：用户消息上方显示 Copilot 风格的"还原检查点"按钮（居中横线 + 分叉图标，`.chat-checkpoint`），点击调用 `rewindConversation`。复制按钮改为图标（复制 / 对勾），不再显示文字。图标为 `App.tsx` 内的 `CopyIcon`、`CheckIcon`、`GitForkIcon`。
- 子代理设置（用户可配）：设置面板「子代理」区块，包含开关、最大轮数（1–10，默认 4）、结果长度上限（500–20000 字符，默认 4000），以及恢复默认值按钮。配置保存在前端 localStorage（键 `hiero-subagent`），随每条聊天消息以 `subagent` 字段发送；后端 `normalizeSubagentSettings` 负责默认值与钳制。关闭开关时 `delegate_read` 不会暴露给模型。限制：每轮最多子代理调用数（1–4，默认 2，超出的调用返回错误让模型改为串行）、每次聊天子代理调用总数（1–20，默认 6）。两者都在设置面板可调，并由 `normalizeSubagentSettings` 钳制。
- 前端 pending 卡住修复：WebSocket `onclose` / `onerror` 时若有进行中的请求，清除 pending 并提示「与后端的连接已断开，请重试」（`frontend/src/App.tsx`）。
- 状态持久化（基础版已实现）：后端用 `node:sqlite` 把任务与状态迁移写入 `~/.hiero/hiero.db`（表 `tasks`、`task_transitions`，代码见 `src/state-store.ts`）。进程重启时，上次仍为 `running` 的任务被标记为 `interrupted`，前端可通过 `task_history` 请求取回任务列表（`TASK_HISTORY` 响应）。未做：从中断点自动续跑（需要模型侧检查点与快照恢复）、前端展示任务列表、把聊天主存储迁入 SQLite（目前仍在浏览器 localStorage）、写文件快照的持久化（Rewind 仍只在内存）。
- DAG 计划（最小版，`src/plan-dag.ts`，测试 `test/plan-dag.test.ts`）：解析并校验 `{tasks:[{id,goal,depends_on,read_only}]}`（未知依赖、自引用、重复 id、环），按层调度；同层只读任务并行（默认上限 4），写任务串行。**已接入 Planner（opt-in）**：`AgentWorkflow` 新增 `useDagPlan`（默认关闭）与 `maxParallel`；开启时 Planner 会收到 `DAG_PLAN_INSTRUCTION` 并要求输出 DAG JSON，由 `execDag` 按层执行，依赖任务会拿到上游输出。JSON 解析或校验失败时回退到原线性 Exec，不报错。运行时 `createWorkflow`（`hiero-runtime.ts`）已开启该开关（`useDagPlan: true`）。
- 只读强制：`AgentExecutor.exec` 接收 `{ readOnly }` 选项，`execDag` 对 `read_only: true` 的任务传入该选项。只读模式下，只允许 `READ_ONLY_TOOL_NAMES`（`read_file` / `list_dir` / `memory_recall`）；其它工具调用不会执行，而是返回错误消息让模型自行调整。`read_only` 仍由模型自报，但误标只会让写任务失败，不会造成越权写入。回归测试：`test/exec-guards.test.ts`、`test/workflow-dag.test.ts`。
- 已知限制：verify 仍只在整体结束后执行一次；最终 `response` 取最后完成的任务；同一轮内的 `delegate_*` 子代理调用真并行执行（`Promise.all`），并发数受每轮 `maxConcurrent` 的配额限制（配额按调用顺序在并行前检查）；结果按原 `tool_call` 顺序写回。非委派工具仍在委派之后串行执行，以避免共享工作区的竞争。
- 自我纠错（`src/error-parser.ts`，测试 `test/error-parser.test.ts`）：`summarizeErrors` 从验证输出中提取核心报错（TypeScript/tsc、Python Traceback、Rust、GCC/Clang 风格），其余输出截断保留首尾。失败的 `cmd:` 检查带上 `errorSummary`；重试时 Plan 的 goal 附带上一次失败的详情。此前重试只告知失败的命令名，模型看不到报错。
- 限制：只在整个任务结束后的 Verify 才触发；解析器只提取信息，修复质量仍取决于模型；未覆盖的语言只能看到截断的原始输出。
- 通用子代理（`delegate_task`）：白名单为 `read_file` / `list_dir` / `write_file` / `memory_recall`，并可通过可选参数 `tools`（能力查询词）经 `CapabilityRouter` 发现并调用 MCP 外部工具。按用户决策，MCP 外部工具**不加审批**（与写子代理保持一致）。不允许嵌套，共享同一套轮数、并发与每次聊天上限。实现位于 `src/read-only-subagent.ts`（`DELEGATE_TASK_TOOL_DEFINITION`）与 `src/hiero-runtime.ts` 的 `runDelegatedTask`（`general` 模式）。测试：`test/read-only-subagent.test.ts`。
- 联网工具（`web_search` / `web_fetch`）：内置于主代理的工具网关，**需审批**（`networkAccess`）。`web_search` 使用 Brave Search API，需设置环境变量 `HIERO_BRAVE_API_KEY`，未设置时返回错误且不发请求。`web_fetch` 仅允许 http/https，拒绝内网、回环、链路本地地址，并对每一跳重定向做 DNS 与地址校验；超时 15 秒，响应上限 2 MB，正文上限 20000 字符。子代理白名单不含联网工具。已知限制：DNS 校验与实际请求之间存在 DNS rebinding 空窗，尚未 IP 固定。实现：`src/web-tools.ts`，测试 `test/web-tools.test.ts`（8 项）。
- 后续候选：① HITL 审批断点；② 上下文滚动摘要。
- 设置规格（决策）：子代理嵌套深度固定为 1（子代理不暴露 `delegate_*` 工具）；并发与总次数限制已在中心化第一步落地。热重载、日志与遥测、分层配置合并暂未实现，列为后续工作。
- MCP 未完成项：启动连接后台进行，首条消息可能早于工具连接完成；SSE / HTTP 传输已由 `test/mcp-remote.test.ts` 用本地 SDK 服务器做端到端验证（发现工具并调用）；未验证第三方托管的远程服务器。
- 来源未确认：Copilot 会话里的 `github-mcp-server-*` 工具并非由 Hiero 注入，本地 Copilot 配置中也未找到其定义。
- 聊天权限与上下文选择器：权限已接入网关，发送前可通过 `PermissionModePicker` 选择并查看每档的实际含义（`frontend/src/permission-mode.tsx`）；上下文仅记录。Mission Control 中提供任务卡（`frontend/src/task-card.tsx`）：启动前显示目标、权限、成功标准（仅 `cmd:` 会执行判定）与 token / 时间预算，需勾选确认；修改目标或权限会取消确认。缺口：聊天路径未接入任务卡；“自动”档无二次确认；终端命令固定为“标准”。
- 已决策（按最优解）：平台为网页版；MCP 预设默认禁用、凭据走环境变量；MCP 默认根目录随工作区。默认权限为“标准”（任务与聊天统一；标准模式只允许只读命令，外部动作需审批）。已决策（用户确认）：技能窗口读写策略为“读写都可用，但每次保存/删除技能都需审批”（由 `requireSkillApproval` 在 `src/hiero-runtime.ts` 强制，前端 `explainApproval` 有对应说明）；层 0 记忆写入边界为“仅在用户明确要求时写入”（系统提示与 `memory_append` 工具描述已收紧）；子代理写文件（delegate_write / delegate_task）在非 auto 模式下每次委派单独审批（用户确认：按次审批）；MCP 市场/管理 UI 选 C（预设 + 自定义 stdio/sse/http + 强制安全确认与凭据录入），已实现（见待办 3）。

## 5. 未验证

- 文件管理器新版（排序、筛选、预览、键盘导航）仅做了构建和页面渲染检查，未逐项点按验证
- 聊天工作区文件夹选择器：对话框已确认能弹出并在前台显示；选中后回填输入框、点取消保持原值，两项未在界面上确认（代码路径已核对）
- 工作区已统一：聊天、任务、文件管理器、终端共用同一个工作区（前端 `options.workspace`），后端按 `resolveChatWorkspace` 校验；无效路径报错，不再回落到 Hiero 根目录。UI 端到端尚未在界面上确认（WebSocket 层已验证）
- 删除对话的内联"确认删除/取消"流程
- Tile 上下文栏、关闭 Buffer
- 聊天端到端："列出工作区里有什么"在固定测试目录下的真实模型调用（需要 LLM，未验证）
- 子代理每次聊天上限的端到端检查（`maxPerChat` 生效）：两次尝试均返回 `MOD-003 No model token is currently available`。这是令牌冷却（`cooldownMs` 60 秒，属于可重试错误），不是 401。等待冷却后重试，请求成功返回，但模型没有调用任何委派工具（工具列表为空），且回复提示中文编码异常。因此端到端仍未被真实调用验证。下次检查应使用更明确的提示，并在脚本中用 UTF-8 发送。配额判定已抽为 `canDelegate`（`src/read-only-subagent.ts`）并有单元测试覆盖（当前 `npm test` 114 项通过）。
- 跳转面板的界面视觉效果（构建通过，未逐项检查）
- 系统主题（`system`）模式的浏览器表现
- `ApprovalModal`、`RollbackButton` 的手动验证
- 真实模型逐字流式效果
- 自定义背景上 35% 透明度下的文字可读性
- 调试控制台无法查看跨域 iframe（浏览器面板内嵌网页）

## 6. 注意事项

- 8080 端口残留：按 `Get-CimInstance Win32_Process` 的命令行找到 `server.js` 与 `npm-cli.js start` 的 PID 后结束。
- `Start-Process -WindowStyle Hidden` 启动的后端会在工具调用结束后被回收。
- 文件夹选择器的 PowerShell 残留进程（命令行含 `FolderBrowserDialog`）可能无法被脚本结束，需在任务管理器中手动结束。
- PowerShell 中用 `node -e` 传含引号的脚本容易出错，建议写入临时 `.mjs` 文件执行（import 需用 `file:///` 绝对 URL）。
- 独立脚本使用 `.env` 前需调用 `loadLocalLlmEnv()`。
- 改动后端后需 `npx tsc -p .` 并重启。
- 重启后端用 `Start-Process -FilePath "<node 可执行文件路径>" -ArgumentList "dist/src/server.js"`，`node` 不在 PATH 中。结束进程只用 `Stop-Process -Id`。
- `Get-NetTCPConnection` 在本机结果不准，判断端口占用看进程命令行与日志中的 `EADDRINUSE`。
- MCP 配置文件位于 `<仓库根目录>\.hiero\mcp.json`（相对于启动目录 `process.cwd()`）。手工编辑后需在设置面板点「保存并连接」或重启后端。
- 代码仓库：本地已 `git init`（分支 `main`，初始提交 `1a70f09`），尚未推送到 GitHub。本机无 GitHub 凭据，`gh` CLI 未安装。
- 前端 Monaco 的 "TextModel got disposed" 报错是既有问题，与当前改动无关。
- `.env` 含令牌，**不要把令牌值写入任何文档或提交**。

## 7. 关键文件

- `src/model-gateway.ts`：令牌池、重试、`parseModelResponse`
- `src/hiero-runtime.ts`：`onMessage`、`handleChat`、`createGateway`、`createWorkflow`
- `src/permission-policy.ts`、`src/approval-broker.ts`、`src/write-snapshots.ts`
- `src/skill-store.ts`、`src/memory-store.ts`、`src/workspace-services.ts`
- `frontend/src/App.tsx`、`frontend/src/settings.tsx`、`frontend/src/style.css`、`frontend/src/devtools.ts`

## 模型设置：自动获取上游模型（2026-11-04）

- 设置页「模型管理」新增「获取可用模型」按钮：后端通过 `model_list` 消息请求 `GET {Base URL}/models`（Bearer 认证，20 秒超时），返回去重排序后的模型 ID。
- 结果以表格显示（Model ID、Provider ID、操作）；「设为默认」只把 Model ID 填入表单，需点「保存」才写入 `.env`。
- 实现：`src/hiero-runtime.ts`（`fetchModelCatalog`、`handleModelList`）、`src/llm-env.ts`（`modelsEndpoint`）、`frontend/src/settings.tsx`（`ModelGatewayForm`）、`frontend/src/App.tsx`（`SettingsBuffer`）。测试 `test/model-catalog.test.ts`。
- 限制：仍是单网关；不支持 API 协议切换、自定义 headers，也不支持按模型配置上下文长度、温度等参数。
## 模型选择同步到对话框（2026-11-04）

- 设置页获取到的模型目录保存在浏览器 localStorage（键 hiero-model-catalog），对话框与任务控制台的模型下拉框都读取它（rontend/src/model-catalog-store.ts）。
- 「设为默认」写入 hiero-default-model，**只影响之后新建的会话**；已有会话保留自己的模型选择，可在对话框下拉框中切换。
- 发送消息时，所选模型随 chat 消息的 model 字段发送，后端按 preferred_model 调用。
- 模型目录和默认模型不写入后端 .env；.env 仍仅由设置页「保存」更新，两者不互通。
- 测试：`test/model-catalog-store.test.ts`。

## 交接状态（2026-11-04）

已完成：
- MCP 管理 UI、Markdown/思维导图渲染、代码块语言标识与复制
- SQLite 状态持久化（`src/state-store.ts`，数据库在 `~/.hiero/hiero.db`）
- 上下文压缩中间件、`/compact` 指令、会话信息弹层
- 设置页「获取可用模型」，模型目录同步到对话框与任务控制台

验证结果：后端 `npm test` 133/133 通过；前端 `tsc --noEmit` 通过；浏览器中切换模型后发送消息，`model` 字段正确。

- 失败分类（`src/error-parser.ts` 的 `classifyFailure`）：失败的 `cmd:` 验收归类为 `timeout` / `env` / `syntax` / `type` / `test` / `unknown`，附带指导文本，写入重试提示。基于正则，可能误判。测试：`test/error-parser.test.ts`、`test/verify-rewind.test.ts`。**审批更新（v0.2.2）**：`general` 模式下 `delegate_task` 需要审批（auto 模式跳过），推翻了此前不加审批的决策。

待处理：
1. 多次压缩的端到端验证未完成（单令牌冷却限制）。
2. 前后端压缩保留条数不一致：后端 keepRecent=6，前端 keepRecent=1，需统一。
3. 「设为默认」只影响新会话；模型目录与默认模型仅存浏览器 localStorage，未写入 `.env`。
4. 清理根目录调试日志（`.fe.*.log`、`.hiero-backend.*.log`、`.server.*.log`），需先停止服务。
5. 未决假设：压缩小模型默认使用主模型（可用 `HIERO_COMPACT_MODEL` 覆盖）；上下文上限固定为 128K。

启动方式：后端 `node dist/src/server.js`（ws://localhost:8080）；前端 `npx vite --port 5173 --strictPort`。

## 交接状态（2026-11-05）

已完成（均已提交到 `main`，最新提交 `1090025`）：
- 流式渲染：按块渐显/上滑（仅新增块）、光标结束淡出、自动滚动与「回到底部」按钮；缩进列表闪烁问题已修复（动画限定在 `.chat-block-enter` 下）。
- Markdown 扩展：数学公式（KaTeX，先从原始 Markdown 抽取公式，修复 `<br>` 与 `&lt;` 残留）、图片骨架屏、链接预览卡片、代码块逐行高亮/行号渐显/语言标签淡入/复制按钮。
- 长回复（约 4000 字符以上且无工具调用）自动保存为工作区 `.md` 文件。
- 断线重连：修复新发送的 `chat_attach` 早于 run 注册导致 `CHAT_UNKNOWN` 的问题（`sentOnSocket`）；重连时回放事件。
- `load_skill` 聊天工具：模型可按需读取 SKILL.md 正文。
- 错误码文档面板（右上角「文档」，23 条，8 组）；原生功能文档 `docs/FEATURES.md`（README 已链接）。
- 文件管理器：名称排序（数字感知、文件夹优先）、有界并发 stat、二进制检测、Home/End/PageUp/PageDown 导航。
- 底栏：时钟独立为 `Clock` 组件，命令框最小宽度 180px，窄屏隐藏 GPU。

未验证：
- `load_skill` 在真实模型上的调用。
- 文件管理器的键盘与焦点行为（浏览器内）。
- 底栏渲染次数减少（未用 React Profiler 测量）。
- 流式卡顿改善（未测量）。
- 错误码文档面板的视觉效果。
- `npm run build` 默认内存不足，需 `NODE_OPTIONS=--max-old-space-size=4096`。

未做 / 待确认：
- 底栏命令输入框不会发给 Agent，未知输入会被静默清空。
- 底栏缓冲区标签对同类缓冲区看起来相同。
- 底栏状态行离线时显示 `—`，没有明确的离线状态。

已评估并决定不做（代码前提不成立）：
- 在 `runtime-socket.ts` 与 store 之间加 rAF 缓冲层：聊天增量已经由 `queueDelta`/`flushDeltas` 按帧合并；空闲时 WebSocket 每 5 秒约 4 条消息；其他事件稀疏。
- Mermaid/Markmap 池化、Monaco 销毁重建、xterm 隐藏时暂停写入：代码里 Mermaid 是全局单例，Monaco 只有一个 DiffEditor 且懒加载，xterm 只有一个实例，没有对应的成本可省。

如需继续排查卡顿：用 React Profiler 在一次真实对话中测量流式期间的提交次数与耗时，重点看流式 Markdown 的重解析与 DOM 替换。

## 事件总线（统一 WebSocket）

- 后端 src/runtime-server.ts 的广播消息为扁平结构，并附带单调递增的 seq 字段（{...event, seq}）。点对点回复（send）不带 seq。
- 新连接会先收到 {type:'SNAPSHOT', payload:{seq, node}}，用于对齐当前状态节点。
- 前端 rontend/src/runtime-socket.ts 提供每个 URL 一个共享的 RuntimeSocket 单例：按类型引用计数订阅（'*' 表示全部），断线后指数退避重连（500ms 至 5s），并把 SNAPSHOT 分发给 onSnapshot。
- 已迁移到共享连接的消费者：App.tsx 的 connectRuntime（SNAPSHOT、STATE_CHANGE、VERIFY_RESULT、REWIND_RESULT、FILE_DIFF、HANDOFF_TRIGGERED）以及 devtools.ts 的运行时日志。
- 尚未迁移：聊天、设置、审批、回滚、MCP 等请求/响应流仍使用各自的连接。
- 缺口处理：前端发现 seq 跳变后发送 SNAPSHOT_REQUEST，后端回复新的 SNAPSHOT 完成重同步（测试见 test/runtime-server.test.ts）。断线期间的事件仍不回放。

## 当前状态（回归库与默认模型）

- 回归库：失败且带分类的 cmd: 验收项写入 .hiero/regressions.jsonl，重试时注入 Planner 上下文（src/regression-store.ts，测试 	est/regression-store.test.ts）。仅记录 cmd: 检查，不记录普通工具失败。
pm test 165/165 通过。
- 设为默认：settings.tsx 中的按钮会同时写入 .env 的 HIERO_LLM_MODEL。未在浏览器中实测：当前模型列表只有一个模型，按钮不会显示，无法触发。
- 浏览器验证：页面可加载，控制台无错误，右下角显示 CPU/MEM/GPU 与时间（GPU 显示 —，本机无读数）。未打开 Monaco diff 面板，因此 disposed 修复只是间接验证。
- 未解决：web_fetch 存在 DNS 重绑定缝隙（先检查 DNS，再由 fetch 二次解析）。

## 交接状态（2026-11-07：八项能力缺口）

- 自主性与断点恢复：每次工具调用前后写检查点（`src/agent-executor.ts`）；中断后按 `intent_id` 重放已完成的调用，不重复执行。Rewind 的文件快照持久化到工作区（`src/write-snapshots.ts`）。端到端断点续跑未验证。
- 逐步验证：`HIERO_STEP_VERIFY` 开启后，每步工具调用之后执行验证，不再只在任务结束时执行一次。
- 上下文管理：压缩保留条数前后端统一为 6 条（`src/context-compactor.ts` 的 `DEFAULT_KEEP_RECENT` 与 `frontend/src/compaction.ts` 的 `KEEP_RECENT_MESSAGES`），测试 `test/compaction.test.ts` 已按此重写。滚动摘要未做。
- 人机协作（HITL）：`src/tool-gateway.ts` 支持按配置的工具名设置断点，命中时触发审批；`auto` 模式跳过审批。
- 编辑体验：新增 `edit_file`（精确字符串替换，`src/basic-tools.ts`），与快照配合支持回滚。
- 代码理解：新增 `symbol_search`（`src/code-index.ts`），基于正则的符号级搜索，非语义索引。
- 沙箱：Docker 工作区挂载改为可写（`dockerRunArgs`，`src/workspace-services.ts`）。本机无 Docker，未做真实容器验证。
- 多模型与配置：`src/config.ts` 实现 JSON 分层配置（`~/.hiero/config.json` < 工作区 `.hiero/config.json` < 环境变量），模型网关支持按模型调参（`requestParams`）。配置 watcher 目前不监听工作区 `.hiero/config.json`，`logging.file` 不热加载。遥测见 `src/telemetry.ts`。
- 验证：串行 `node --test --test-concurrency=1 dist/test/*.test.js` 224/224 通过。并行运行偶发失败，应使用串行命令。
- 未完成：滚动摘要、真实 Docker 运行验证、检查点断点续跑的端到端测试。
- 模型默认值：代码中的默认模型名由 `gpt-5.6-luna` 替换为 `auto`（仓库公开，避免泄露私人配置）。
- 发布：npm 上 `hiero-agent` 最新为 0.2.1。仓库中 `v0.2.2` 标签已存在且指向 2026-11-04 的旧提交，因此本次发布版本号需先确认。

## 交接状态（2026-11-08）

- hiero-agent：GitHub 标签 v0.2.3（指向 581bfb0）与 npm latest 0.2.3 一致。v0.2.2 标签未动，仍指向旧提交。
- create-hiero 脚手架：已发布到 npm，latest 为 0.1.0，源码在 create-hiero/（提交 e4778e5）。用户可用 `npm create hiero` 或 `npx create-hiero` 在空目录生成完整项目（需要 Node 22+）。端到端验证已通过：生成后 launch-hiero.bat 存在，后端 build 与前端 tsc 均通过。
- 发布流程：publish.yml 由标签触发，使用 npm 信任发布（OIDC），npm CLI 需 >= 11.5.1，package.json 的 repository.url 必须与 GitHub 仓库一致。
- 注意：npm 对新包可能进入暂存（staged）状态，需要在网页批准；批准前重复 publish 会返回 E409。
- 已清理：App.tsx 默认工作区改为空、测试样例路径改为占位、Actions 升级到 checkout@v5 / setup-node@v5。
- 下一步建议：清理上述遗留；确认是否需要 create-hiero 的后续版本；补充真实 Docker 运行验证。
