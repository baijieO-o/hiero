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

- 令牌池、模型网关（重试、错误分类）；聊天报错 MOD-002 已修复（上游返回 `null` 字段）
- 设置：模型与网关（写入 `.env`）、保存状态反馈、偏好面板（主题、字号、快捷键等）、外观（背景图、透明度、文字色、液态玻璃）
- 窗口化布局（Dockview）、对话（流式、Markdown、工具调用步骤、回退到此处）
- 工作区面板：浏览器、终端（一次性执行，无 PTY）、文件管理器（可排序、筛选、预览、键盘导航）、调试控制台
- 聊天工作区：无效路径报错 `工作区不存在或不是文件夹`；「…」按钮调用原生文件夹对话框（`pickFolder`，`src/workspace-services.ts`，PowerShell + FolderBrowserDialog，带置顶所属窗口）
- 技能管理窗口（143 个去重技能，项目 / 用户 / 通用 / Codex 四个 scope）
- 记忆系统：第 0/1 层（`~/.hiero/memory.md`、`<ws>/.agent/memory.md`）与第 2 层关键词检索的深层记忆
- 沙箱与审批：严格 / 标准 / 自动三种模式、审批面板、路径边界（realpath）、写入快照回退（`RBK-006`）

## 4. 未完成 / 待确认

- 设置规格未实现：MCP 服务管理、子代理限制、热重载与生效时机、日志与遥测、分层配置合并
- 聊天权限与上下文选择器：仅部分生效（权限已接入网关，上下文仅记录）
- 待决策：
  1. 网页版还是 Electron 桌面版
  2. 设置规格的分阶段顺序
  3. 技能窗口读写策略（当前默认可读写）
  4. 默认权限是否从「严格」改为「标准」
  5. 层 0 记忆的模型写入边界（准则 2 的张力）
  6. MCP 方向（未确定前不开始）

## 5. 未验证

- 文件管理器新版（排序、筛选、预览、键盘导航）仅做了构建和页面渲染检查，未逐项点按验证
- 聊天工作区文件夹选择器：对话框已确认能弹出并在前台显示；选中后回填输入框、点取消保持原值，两项未在界面上确认（代码路径已核对）
- 工作区已统一：聊天、任务、文件管理器、终端共用同一个工作区（前端 `options.workspace`），后端按 `resolveChatWorkspace` 校验；无效路径报错，不再回落到 Hiero 根目录。UI 端到端尚未在界面上确认（WebSocket 层已验证）
- 删除对话的内联"确认删除/取消"流程
- Tile 上下文栏、关闭 Buffer
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
- 前端 Monaco 的 "TextModel got disposed" 报错是既有问题，与当前改动无关。
- `.env` 含令牌，**不要把令牌值写入任何文档或提交**。

## 7. 关键文件

- `src/model-gateway.ts`：令牌池、重试、`parseModelResponse`
- `src/hiero-runtime.ts`：`onMessage`、`handleChat`、`createGateway`、`createWorkflow`
- `src/permission-policy.ts`、`src/approval-broker.ts`、`src/write-snapshots.ts`
- `src/skill-store.ts`、`src/memory-store.ts`、`src/workspace-services.ts`
- `frontend/src/App.tsx`、`frontend/src/settings.tsx`、`frontend/src/style.css`、`frontend/src/devtools.ts`
