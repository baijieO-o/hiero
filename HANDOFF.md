# Hiero 交接文档（当前状态快照）

更新时间：2026-11-09。本文只描述**当前**状态。日期堆叠的历史已删除。

- 功能说明与配置：[docs/FEATURES.md](docs/FEATURES.md)
- 架构与实现状态：[ARCHITECTURE.md](ARCHITECTURE.md) 第 7 节
- 未实现与待决策事项：见下文第 5 节
- 未提交改动：本次工作区改动尚未 commit。提交前需用户确认，并需先跑完整 `npm test`。

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

- 后端测试：`npm test`（= `tsc && node --test dist/test/*.test.js`）。当前 59 个测试文件、256 个用例，串行运行。
- 类型检查：`npx tsc -p .`（不要传文件参数，TS5112）。
- 前端构建：`npm run build`（= `tsc && vite build`）。
- 构建需要 `NODE_OPTIONS=--max-old-space-size=4096`。测试挂起时，优先检查是否有未关闭的句柄（`runtime.close()` 应放在 `finally`）。

## 3. 当前能力（已验证或已有单元测试）

- **安全边界**：WebSocket 仅接受回环地址；浏览器 Origin 必须是 localhost / 127.0.0.1 / [::1]（`src/ws-guard.ts`）。
- **终端与 `cmd:` 验收的 Docker 沙箱**（`src/workspace-services.ts` `dockerRunArgs`）：`--network none`、`--read-only` 根文件系统、`--cap-drop=ALL`、资源限制。工作区以可写 bind mount 挂载到 `/workspace`。Docker 不可用时失败关闭，不回退宿主机 shell。**未在真实 Docker 中端到端验证。**
- **执行保护**（`src/agent-executor.ts`）：同一工具同一参数连续 3 次触发 `MOD-005` 熔断；超时触发 `MOD-006`。工具结果超过 8,000 字符时截断（头 70% + 尾 30%）。
- **上下文压缩**（`src/context-compactor.ts`）：超阈值时把旧历史压缩为摘要，保留首条用户消息原文（锚点）、未完成待办与精确路径，并保留最近 6 条原文。聊天路径由 `handleChatCompact` 驱动，固定预算 24,000 token。前端 `/compact` 与摘要分隔线已实现。
- **用户中断**：Stop 按钮发送 `chat_cancel`，后端中止模型请求，已生成的部分文本保存为助手消息。
- **MCP**：stdio / sse / http；`${VAR}` 占位符从环境变量展开，凭据不写入 `mcp.json`；预设（filesystem、GitHub、Postgres）默认禁用；管理 UI 已实现。
- **子代理**（`src/read-only-subagent.ts`）：`delegate_read`（只读）、`delegate_write`（含 `write_file`，经审批）、`delegate_task`（通用，可调用 MCP）。每轮并发与每聊天总数有上限，不允许嵌套。
- **Skill**：`load_skill` 按需读取完整 `SKILL.md`（`src/skill-tool.ts`）。
- **深层记忆**：第 0、1 层已实现；第 2 层为关键词检索，配置 `HIERO_EMBED_*` 后可加向量检索。
- **Trace 与成本**：每次聊天记录执行时间线，持久化到工作区 `.hiero/traces.jsonl`；会话累计 token 与估算成本（价格表自动拉取，缓存 24 小时）。
- **令牌用量**：模型网关记录 `usage`；价格估算为估算值。

## 4. 共享浏览器（部分完成，未提交）

- 「分享给智能体」为可移除的链接标签（`frontend/src/App.tsx`）。后端抓取页面正文（最多 3 页，仅公网 http/https，拒绝 localhost 与内网地址），见 `src/hiero-runtime.ts` 的 `sharedPagesContext`。
- 智能体专用浏览器（`src/browser-session.ts`，`playwright-core` 1.65.0，使用本机 Edge）：`browser_open`、`browser_snapshot`、`browser_screenshot`（仅返回元数据）、`browser_click`、`browser_type`、`headless_extract`。点击与输入需审批（非 auto 模式）。`HIERO_HEADLESS_CDP_URL` 可接入外部引擎。
- 测试：`test/browser-session.test.ts`。

未完成 / 未验证：
1. 审批弹窗未在聊天界面验证。
2. 截图对模型不可见（只返回元数据）。`image_url` 路径已在 `src/model-gateway.ts` 支持，但未接入。
3. Lightpanda 未验证（Windows 下载被拦截）。
4. 用户接管未实现（没有「接管」按钮或暂停 Agent 控制的机制）。
5. 子代理白名单未包含浏览器工具（`READ_ONLY_SUBAGENT_TOOLS` / `WRITE_SUBAGENT_TOOLS`）。
6. 「分享链接」未在浏览器中实测。

限制（设计如此）：浏览器不带用户登录态，不共享用户 DOM 或 Cookie。

## 5. 未实现 / 待决策

完整清单（17 项）与归属见 [files/doc-cleanup-plan.md](files/doc-cleanup-plan.md)。摘要：

- 交接文档的自动生成与自动恢复
- 沙箱与审批设置域（设置面板中尚无）
- 共享浏览器的截图反馈、用户接管、审批弹窗的端到端验证
- Skill 路由（按任务自动匹配）与 MCP 延迟加载
- 系统代理的自动构建
- 桌面化形态（已决定暂不做 Electron，保留网页版）
- 真实模型下的验证：8k 工具结果截断对任务成功率的影响、压缩锚点在真实模型上的效果、聊天路径是否需要锚点
- Docker 沙箱的端到端验证

## 6. 注意事项

- 聊天工作区 MCP 默认根目录随工作区（`defaultMcpConfig(root)`）。
- create-hiero 模板（`create-hiero/template/`）与主仓库同步，同步策略见 [docs/DEVELOPING.md](docs/DEVELOPING.md)。
- create-hiero 当前发布为 0.1.0，模板已同步但**未发布**，需用户确认。
- `write_file` 的效果为 `workspace` 且未标记 `irreversible`，单次调用不弹审批。
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
- 文档面板内容来源：`frontend/src/docs-content.ts`