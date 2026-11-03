# Hiero 交接文档（精简版）

更新时间：2026-11-02
完整历史记录：会话目录 `files/HANDOFF-full.md`。

## 1. 项目

Hiero 是位于 `D:\hiero` 的个人 Agent 工作台。
- 后端：Node + TypeScript，WebSocket `ws://localhost:8080`
- 前端：React + Vite，`http://localhost:5173/`
- 核心：状态机（Plan / Exec / Verify / Handoff / Rewind）、工具网关、模型网关（令牌池）、MCP / Skill 路由、系统代理子进程

## 2. 运行与测试

```powershell
# 后端
cd D:\hiero; npx tsc -p .; node dist\src\server.js
# 前端
cd D:\hiero\frontend; npm run dev
# 一键启动
D:\hiero\launch-hiero.bat
```

- 后端测试：`npm test`（= `tsc && node --test dist/test/*.test.js`）
- 类型检查：`npx tsc -p .`（不要传文件参数，TS5112）
- 前端构建：`npm run build`（= `tsc && vite build`）

## 3. 已完成
- WebSocket 安全：仅接受回环地址连接；浏览器 Origin 必须是 localhost / 127.0.0.1 / [::1]（无 Origin 的非浏览器客户端允许）。实现：`src/ws-guard.ts`，测试 `test/ws-guard.test.ts`。默认地址仍为 `ws://localhost:8080`，可用前端环境变量 `VITE_HIERO_WS_URL` 覆盖。
- MCP 默认根目录随聊天工作区（`defaultMcpConfig(root)`），不再写死 `D:\new`。
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

## 4. 未完成 / 待确认

- 最近提出、尚未实现的功能：
  1. Trace/Timeline（已实现基础版）：每次 Chat 请求在后端记录模型调用、工具调用、子代理调用、完成回复与错误（序号、类型、名称、起止耗时、成功/失败、结果摘要），通过 `CHAT_TRACE` 消息发给前端，挂在对应助手消息下的"执行时间线"中可折叠查看。trace 只保存在内存与当前页面状态中，不落盘，刷新或重启后丢失；错误时 trace 不保存为消息（仅显示错误提示）。未做：Plan/Exec 工作流的 trace、持久化、任务回放（逐帧）、按 token 的细粒度统计。
  2. Session Token 成本统计（已实现基础版）：每条助手回复显示估算成本，会话标题下显示累计 token 与成本。价格从 LiteLLM 公共价格表（`model_prices_and_context_window.json`）自动拉取，启动时加载，本地缓存 24 小时；拉取失败时回退到 `frontend/src/token-cost.ts` 内置的 4 个模型价格。按模型名最长前缀匹配，裸模型名优先于带 provider 前缀的条目。未知模型显示"未知"且不计入估算，人民币按固定汇率 7.2 换算。token 数来自模型 usage 字段，未做本地计数。未做：按天/按模型统计、实时流式成本。
  3. MCP Server 市场/管理 UI：一键配置 filesystem、GitHub、Postgres 等服务器；需处理官方包名、凭据、安全确认和 transport 支持。
- 已完成：标准模式下 git 只读子命令禁止写文件/执行外部程序的参数，路径参数禁止指向工作区之外（保守检查：绝对路径、盘符、`~`、`..`）。
- 安全工作后续建议：MCP stdio 任意命令配置的授权边界；审批与命令执行的审计日志；标准模式的路径检查仅为字符串层面，不能防御符号链接。Docker 终端隔离不是对整个 Agent 的完整沙箱。
- 子代理（中心化，第一步）：聊天工具 `delegate_read`（只读，白名单 `read_file` / `list_dir` / `memory_recall`）与 `delegate_write`（白名单另含 `write_file`，写入仍经 `ToolGateway` 审批）。实现位于 `src/read-only-subagent.ts`，接入 `src/hiero-runtime.ts` 的 `runDelegatedTask`。子代理拥有独立 message 数组，白名单由代码强制，最多 4 轮，结果以摘要回传父级，共享 Stop 信号，不允许嵌套，且不能调用 `memory_remember` / `memory_append`。测试：`test/read-only-subagent.test.ts`。注意：`write_file` 的效果是 `workspace` 且未标记 `irreversible`，因此在 standard 模式下子代理写文件**不会**弹审批（与主 Agent 一致）；strict 模式下同样不弹。若要子代理写入也需审批，需要给 `write_file` 或子代理写入路径加审批规则，这是待决策项。
- 视觉与交互设置（设置面板「外观 / 动效 / 交互」，保存在 localStorage `hiero-preferences`）：渐变透明（`panelGradient`，面板背景从上到下渐隐）、高斯模糊强度（`panelBlur`，0–40px，作用于面板 `backdrop-filter`）、加载动画（`loaderStyle`：三点/旋转圈/脉冲条/无，作用于「思考中」指示器）、面板动画（`panelAnimation`：淡入/滑动/无）、动画速率（`animationSpeed`，0–3 倍，0 等同减少动效）、滚动条显示（`scrollbarVisibility`：始终/悬停/隐藏）、热边（`hotEdgeSidebar`，默认开：作用于全局左侧「快捷入口」栏，平时收成窄栏，鼠标贴近窗口左边缘 8px 内展开，离开后延迟 300ms 收起；手动点击 `«/»` 切换后，离开不再自动收起）。设置通过 `applyPreferenceTheme` 写入 CSS 变量与 `data-*` 属性，样式在 `style.css` 末尾附近。限制：热边与滚动条仅通过浏览器 DOM 状态验证；加载动画与面板动画未做视觉核对。对话面板内的历史侧栏不受热边影响，始终显示。
- 回复时间戳：每条 assistant 回复记录 `completedAt`（完成或中断时写入），悬停消息时在下方显示，离开或静止约 1.5s（`TIMESTAMP_IDLE_HIDE_MS`）后淡出。旧消息没有该字段，不显示。
- 回退与复制样式：用户消息上方显示 Copilot 风格的"还原检查点"按钮（居中横线 + 分叉图标，`.chat-checkpoint`），点击调用 `rewindConversation`。复制按钮改为图标（复制 / 对勾），不再显示文字。图标为 `App.tsx` 内的 `CopyIcon`、`CheckIcon`、`GitForkIcon`。
- 子代理设置（用户可配）：设置面板「子代理」区块，包含开关、最大轮数（1–10，默认 4）、结果长度上限（500–20000 字符，默认 4000），以及恢复默认值按钮。配置保存在前端 localStorage（键 `hiero-subagent`），随每条聊天消息以 `subagent` 字段发送；后端 `normalizeSubagentSettings` 负责默认值与钳制。关闭开关时 `delegate_read` 不会暴露给模型。限制：每轮最多子代理调用数（1–4，默认 2，超出的调用返回错误让模型改为串行）、每次聊天子代理调用总数（1–20，默认 6）。两者都在设置面板可调，并由 `normalizeSubagentSettings` 钳制。
- 前端 pending 卡住修复：WebSocket `onclose` / `onerror` 时若有进行中的请求，清除 pending 并提示「与后端的连接已断开，请重试」（`frontend/src/App.tsx`）。
- 后续候选：① HITL 审批断点；② 上下文滚动摘要；③ 通用子代理（需审批机制配合，未确认）。
- 设置规格（决策）：子代理嵌套深度固定为 1（子代理不暴露 `delegate_*` 工具）；并发与总次数限制已在中心化第一步落地。热重载、日志与遥测、分层配置合并暂未实现，列为后续工作。
- MCP 未完成项：启动连接后台进行，首条消息可能早于工具连接完成；SSE / HTTP 传输已由 `test/mcp-remote.test.ts` 用本地 SDK 服务器做端到端验证（发现工具并调用）；未验证第三方托管的远程服务器。
- 来源未确认：Copilot 会话里的 `github-mcp-server-*` 工具并非由 Hiero 注入，本地 Copilot 配置中也未找到其定义。
- 聊天权限与上下文选择器：权限已接入网关，发送前可通过 `PermissionModePicker` 选择并查看每档的实际含义（`frontend/src/permission-mode.tsx`）；上下文仅记录。Mission Control 中提供任务卡（`frontend/src/task-card.tsx`）：启动前显示目标、权限、成功标准（仅 `cmd:` 会执行判定）与 token / 时间预算，需勾选确认；修改目标或权限会取消确认。缺口：聊天路径未接入任务卡；“自动”档无二次确认；终端命令固定为“标准”。
- 已决策（按最优解）：平台为网页版；MCP 预设默认禁用、凭据走环境变量；MCP 默认根目录随工作区。默认权限为“标准”（任务与聊天统一；标准模式只允许只读命令，外部动作需审批）。仍待决策：技能窗口读写策略；层 0 记忆写入边界。

## 5. 未验证

- 文件管理器新版（排序、筛选、预览、键盘导航）仅做了构建和页面渲染检查，未逐项点按验证
- 聊天工作区文件夹选择器：对话框已确认能弹出并在前台显示；选中后回填输入框、点取消保持原值，两项未在界面上确认（代码路径已核对）
- 工作区已统一：聊天、任务、文件管理器、终端共用同一个工作区（前端 `options.workspace`），后端按 `resolveChatWorkspace` 校验；无效路径报错，不再回落到 Hiero 根目录。UI 端到端尚未在界面上确认（WebSocket 层已验证）
- 删除对话的内联"确认删除/取消"流程
- Tile 上下文栏、关闭 Buffer
- 聊天端到端："列出工作区里有什么"在 `D:\new` 下的真实模型调用（需要 LLM，未验证）
- 子代理每次聊天上限的端到端检查（`maxPerChat` 生效）：两次尝试均返回 `MOD-003 No model token is currently available`。这是令牌冷却（`cooldownMs` 60 秒，属于可重试错误），不是 401。等待冷却后重试，请求成功返回，但模型没有调用任何委派工具（工具列表为空），且回复提示中文编码异常。因此端到端仍未被真实调用验证。下次检查应使用更明确的提示，并在脚本中用 UTF-8 发送。配额判定已抽为 `canDelegate`（`src/read-only-subagent.ts`）并有单元测试覆盖（`npm test` 68 项通过）。
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
- 重启后端用 `Start-Process -FilePath "D:\baiji\node.exe" -ArgumentList "dist/src/server.js"`，`node` 不在 PATH 中。结束进程只用 `Stop-Process -Id`。
- `Get-NetTCPConnection` 在本机结果不准，判断端口占用看进程命令行与日志中的 `EADDRINUSE`。
- MCP 配置文件位于 `D:\hiero\.hiero\mcp.json`（相对于启动目录 `process.cwd()`）。手工编辑后需在设置面板点「保存并连接」或重启后端。
- 代码仓库：本地已 `git init`（分支 `main`，初始提交 `1a70f09`），尚未推送到 GitHub。本机无 GitHub 凭据，`gh` CLI 未安装。
- 前端 Monaco 的 "TextModel got disposed" 报错是既有问题，与当前改动无关。
- `.env` 含令牌，**不要把令牌值写入任何文档或提交**。

## 7. 关键文件

- `src/model-gateway.ts`：令牌池、重试、`parseModelResponse`
- `src/hiero-runtime.ts`：`onMessage`、`handleChat`、`createGateway`、`createWorkflow`
- `src/permission-policy.ts`、`src/approval-broker.ts`、`src/write-snapshots.ts`
- `src/skill-store.ts`、`src/memory-store.ts`、`src/workspace-services.ts`
- `frontend/src/App.tsx`、`frontend/src/settings.tsx`、`frontend/src/style.css`、`frontend/src/devtools.ts`
