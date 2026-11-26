# Hiero 交接文档（当前状态快照）

更新时间：2026-11-10。本文只描述**当前**状态。日期堆叠的历史已删除。

- 功能说明与配置：[docs/FEATURES.md](docs/FEATURES.md)
- 架构与实现状态：[ARCHITECTURE.md](ARCHITECTURE.md) 第 7 节
- 未实现与待决策事项：见下文第 5 节
- 提交状态：最新提交为 `6379b81`（定时任务墙钟上限）及其之前的 19 个本地提交，尚未推送到 `origin/main`（`1cb88dc`）。推送前需用户确认。
- 手动冒烟验证步骤见 [docs/SMOKE-TEST.md](docs/SMOKE-TEST.md)；真实模型、真实文件读写与 Docker 运行均需按清单实测，文档本身不代表验证通过。

## 1. 项目

Hiero 是位于本机仓库根目录的个人 Agent 工作台。
- 后端：Node + TypeScript，WebSocket `ws://localhost:8080`
- 前端：React + Vite，`http://localhost:5173/`
- 核心：状态机（Plan / Exec / Verify / Handoff / Rewind）、工具网关、模型网关（令牌池）、MCP / Skill 路由、子代理、深层记忆

## 2. 运行与测试

```powershell
# 一键启动（后端 + 前端）
.\launch-hiero.bat
# 或分别启动
npm start                 # 后端
Set-Location frontend; npm run dev   # 前端
```

- 后端测试：`npm test`（= `tsc && node --test dist/test/*.test.js`）。当前 69 个测试文件、302 个用例，串行运行，约 40 秒。全量运行须用 `Get-ChildItem dist\test -Filter *.test.js` 展开文件列表（PowerShell 不展开通配符）。
- 类型检查：`npx tsc -p .`（不要传文件参数，TS5112）。
- 前端构建：`npm run build`（= `tsc && vite build`）。
- 构建需要 `NODE_OPTIONS=--max-old-space-size=4096`。测试挂起时，优先检查是否有未关闭的句柄（`runtime.close()` 应放在 `finally`）。

## 3. 当前能力（已验证或已有单元测试）

- **安全边界**：WebSocket 仅接受回环地址；浏览器 Origin 必须是 localhost / 127.0.0.1 / [::1]（`src/ws-guard.ts`）。
- **终端与 `cmd:` 验收的 Docker 沙箱**（`src/workspace-services.ts` `dockerRunArgs`）：`--network none`、`--read-only` 根文件系统、`--cap-drop=ALL`、资源限制。工作区以可写 bind mount 挂载到 `/workspace`。Docker 不可用时失败关闭，不回退宿主机 shell。**已在真实 Docker 中验证（Windows，Docker Desktop 29.9.3）**：经 `runCommand` 执行 `node -e` 写文件命令，退出码 0，输出 `sandbox-ok`，工作区文件正确写入；另验证根文件系统只读（`touch /etc/x` 报 Read-only file system）。注意：Docker Desktop 守护进程需先启动，否则失败关闭。
- **定时任务墙钟上限**（`src/hiero-runtime.ts`）：每次定时任务的 `handleMessage` 外层有 150 秒上限，超时写回 `failed` 并释放 `scheduleRunning`，避免挂起任务阻塞后续调度。只放弃等待，**不中断底层模型请求**（执行器与网关尚未接受 `AbortSignal`）。离线 e2e 见 `test/scheduled-e2e.test.ts`。\n- **执行保护**（`src/agent-executor.ts`）：同一工具同一参数连续 3 次触发 `MOD-005` 熔断；超时触发 `MOD-006`。工具结果超过 8,000 字符时截断（头 70% + 尾 30%）。
- **上下文压缩**（`src/context-compactor.ts`）：超阈值时把旧历史压缩为摘要，保留首条用户消息原文（锚点）、未完成待办与精确路径，并保留最近 6 条原文。聊天路径由 `handleChatCompact` 驱动，固定预算 24,000 token。前端 `/compact` 与摘要分隔线已实现。
- **模型协议**（`src/model-protocols.ts`，`src/model-gateway.ts`）：每个模型提供方可设 `protocol` 字段：`openai`（默认，Chat Completions）、`openai-responses`（Responses API）、`anthropic`（Messages API）、`gemini`（generateContent API）。四种协议均支持流式、工具调用、usage，并接入 `temperature` / `max_tokens` 参数。由 `test/model-protocols.test.ts`（15 例，mock HTTP 服务器）覆盖；**尚未在真实供应商上验证**，Gemini 与 Responses 的 SSE 字段以离线假设为准。`openai-responses` 作为独立协议值的命名待确认。
- **用户中断**：Stop 按钮发送 `chat_cancel`，后端中止模型请求，已生成的部分文本保存为助手消息。
- **MCP**：stdio / sse / http；`${VAR}` 占位符从环境变量展开，凭据不写入 `mcp.json`；预设（filesystem、GitHub、Postgres）默认禁用；管理 UI 已实现。
- **子代理**（`src/read-only-subagent.ts`）：`delegate_read`（只读）、`delegate_write`（含 `write_file`，经审批）、`delegate_task`（通用，可调用 MCP）。每轮并发与每聊天总数有上限，不允许嵌套。
- **Skill**：`load_skill` 按需读取完整 `SKILL.md`（`src/skill-tool.ts`）。
- **快照持久化**：`~/.hiero/write-snapshots.json` 在重启后保留；仅在没有 checkpoint 的新任务开始时清空（`src/hiero-runtime.ts`）。有回滚测试覆盖重启后回滚与跳过人工修改（`test/write-snapshots.test.ts`）。
- **失败反思**：验证失败与异常时写入 `.hiero/reflections.jsonl`（最近 5 条，单条截断 500 字符），下一次 Plan 时注入（`src/reflection-store.ts`、`src/agent-workflow.ts`）。
- **审批式技能沉淀**：仅在验证通过的任务后，从成功的 write_file/edit_file 生成候选，经 UI 审批后保存到 `<workspace>/.agent/skills/<name>/SKILL.md`（沿用现有项目技能目录，未采用 `.hiero/skills`），并记录来源任务（`src/skill-promotion.ts`）。审批超时 120 秒视为拒绝。
- **分支式重试（默认关闭）**：设置 `HIERO_BRANCH_WIDTH>1` 后，新任务并行运行 N 个候选，各在独立 git worktree（`.hiero/branches/`）与分支中执行；胜者（验证通过优先，其次步数少）提交后合并回主分支，冲突则放弃合并；结束后清理所有候选目录与分支（`src/branch-retry.ts`，`test/branch-retry.test.ts`）。定时任务、续跑、非 git 或无 HEAD 时回退单路径。候选的审批请求经 `createSerializedApprover` 排队，同一时间只弹出一个审批；已有离线端到端测试（`test/branch-retry-e2e.test.ts`，脚本化模型，校验分支路径确实多于单路径的模型调用，并检查候选分支与 worktree 已清理）；尚未在真实模型上验证；并行占用的 LLM 配额与 Docker 沙箱未解决。
- **深层记忆**：第 0、1 层已实现；第 2 层为关键词检索，配置 `HIERO_EMBED_*` 后可加向量检索。
- **Trace 与成本**：每次聊天记录执行时间线，持久化到工作区 `.hiero/traces.jsonl`；会话累计 token 与估算成本（价格表自动拉取，缓存 24 小时）。
- **令牌用量**：模型网关记录 `usage`；价格估算为估算值。

## 4. 共享浏览器（部分完成，未提交）

- 「分享给智能体」为可移除的链接标签（`frontend/src/App.tsx`）。后端抓取页面正文（最多 3 页，仅公网 http/https，拒绝 localhost 与内网地址），见 `src/hiero-runtime.ts` 的 `sharedPagesContext`。
- 智能体专用浏览器（`src/browser-session.ts`，`playwright-core` 1.65.0，使用本机 Edge）：`browser_open`、`browser_snapshot`、`browser_screenshot`（仅返回元数据）、`browser_click`、`browser_type`、`headless_extract`。点击与输入需审批（非 auto 模式）。`HIERO_HEADLESS_CDP_URL` 可接入外部引擎。
- 测试：`test/browser-session.test.ts`。

桌面版共享浏览器（第二步，已构建，未做端到端验证）：
- Electron 主进程（`electron/main.cjs`）开启 `remote-debugging-port`（默认 127.0.0.1:9333，`HIERO_SHARED_CDP_PORT` 可改）。webview 与智能体的 `shared` 模式通过 CDP 接入同一浏览器，共享页面与登录态。
- `browser_open` / `snapshot` / `screenshot` / `click` / `type` 的 `mode` 支持 `shared`；未启动桌面版时报错提示。
- 热插拔（cordis 4.0.0-rc.12，`src/hot-plug.ts`）：MCP 服务、技能、内置工具可在「技能管理」面板手动启停。MCP 启停写入 `.hiero/mcp.json`；技能与工具的停用项写入 `.hiero/hot-plug.json`（仅存停用名单，重启保持）。工具开关只影响新对话。
- 暂停：WebSocket 消息 `browser_agent_pause`，后端内存标志，暂停时拒绝 click / type（读取仍允许）。状态通过 `BROWSER_AGENT_STATE` 广播，面板有暂停/恢复按钮。
- 安全注意：CDP 端口绑定本机，但任何本机进程都能连接；shared 模式无请求拦截，导航后仅做 URL 公网校验。
- 「分享给智能体」仍只传 URL（后端抓取公网页面），不携带 webview 中已登录的页面内容。
- 标准浏览器的共享方式：不依赖桌面版，启动一个外部 Chrome/Edge 并开启 CDP，例如 `chrome.exe --remote-debugging-port=9333 --user-data-dir=<独立目录>`（Chrome 136+ 不允许对默认配置开启调试，必须用独立的 user-data-dir）。后端默认连接 `http://127.0.0.1:9333`，可用 `HIERO_SHARED_CDP_URL` 修改。未配置时的报错会提示这两种方式。
- `requirePage` 在 shared 模式下会自动接管当前共享页面，不需要先调用 `browser_open`。
- 已验证（直接调用方法，非模型工具调用）：读取共享页面快照；暂停时点击被拒绝；恢复后点击成功。

未完成 / 未验证：
1. 桌面版端到端验证（webview 目标是否出现在 `/json/list`，shared 模式读取同一页面）未做。
2. 模型通过工具调用操作 shared 页面的链路未做真实模型验证。前端暂停按钮的 UI 效果未在浏览器中验证。
2. 审批弹窗未在聊天界面验证。
2a. rea MCP（逆向分析工具，`.hiero/mcp.json`，已 gitignore）：rea-agents@6.8.0 要求 Node 22.23.4+/24.22.1+/26.12.1+，系统 Node 26.12.0 不满足，MCP 握手会超时。当前用 `.hiero/rea-runtime/`（内含 Node 22.23.5 与 rea-agents@6.8.0）启动，`McpToolClient.connect` 已验证可列出 229 个工具。多数逆向能力还需要 Ghidra / IDA / Hopper 等本地程序，尚未验证。
3. 截图对模型不可见（只返回元数据）。`image_url` 路径已在 `src/model-gateway.ts` 支持，但未接入。
4. Lightpanda 未验证（Windows 下载被拦截）。
5. 子代理白名单未包含浏览器工具（`READ_ONLY_SUBAGENT_TOOLS` / `WRITE_SUBAGENT_TOOLS`）。
6. 登录态共享未加显式同意步骤；目前 webview 持久分区内的 Cookie 即为共享。

## 5. 未实现 / 待决策

摘要（完整清单原为会话内临时文件，已不在仓库中）：

- 交接文档的自动生成与自动恢复
- 沙箱与审批设置域（设置面板中尚无）
- 共享浏览器的截图反馈、用户接管、审批弹窗的端到端验证
- Skill 路由（按任务自动匹配）与 MCP 延迟加载
- 系统代理的自动构建
- 桌面化形态（已决定暂不做 Electron，保留网页版）
- 真实模型下的验证：8k 工具结果截断对任务成功率的影响、压缩锚点在真实模型上的效果、聊天路径是否需要锚点
- Docker 沙箱的端到端验证（已在 `docker run` 层验证，经 Hiero 完整任务链路仍待验证）
- 分支式重试：候选并行是否会超出 LLM 配额与 Docker 沙箱负载（未决，可考虑改为顺序）；候选过程不向 UI 广播（只显示胜者结果，已确认）；候选审批已排队（已实现）

## 6. 注意事项

- 聊天工作区 MCP 默认根目录随工作区（`defaultMcpConfig(root)`）。
- create-hiero 模板（`create-hiero/template/`）与主仓库同步，同步策略见 [docs/DEVELOPING.md](docs/DEVELOPING.md)。
- create-hiero 当前发布为 0.1.0，模板已同步但**未发布**，需用户确认。
- `write_file` 的效果为 `workspace`，类别规则 `write` 默认为 `ask`，标准模式下需要审批；设为 `auto` 才免审批（`src/tool-category-policy.ts`）。
- 标准模式下 git 只读子命令的路径检查只做字符串层面，不能防御符号链接。
- 只配置一个令牌时，429 会冷却 60 秒，连续对话容易触发 `MOD-003`。这是限流，不是压缩逻辑错误。

## 7. 关键文件

- 后端入口：`src/server.ts`，运行时：`src/hiero-runtime.ts`
- 执行器与保护：`src/agent-executor.ts`
- 压缩：`src/context-compactor.ts`
- 沙箱：`src/workspace-services.ts`
- 子代理：`src/read-only-subagent.ts`
- 浏览器：`src/browser-session.ts`
- 前端压缩切分：`frontend/src/compaction.ts`
- 前端面板（从 `App.tsx` 拆出）：`workspace-request.ts`（工作区请求层）、`memory-panel.tsx`、`skills-panel.tsx`、`file-manager-panel.tsx`、`terminal-panel.tsx`、`task-list.tsx`。`App.tsx` 仍保留聊天面板、状态存储与审批弹窗。
- 聊天工具：`src/chat-tool-definitions.ts`（定义）、`src/chat-tool-gateway.ts`（网关）
- 文档面板内容来源：`frontend/src/docs-content.ts`
