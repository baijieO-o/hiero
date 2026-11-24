# 技能与 MCP 安装记录

本文记录从外部来源安装到 Hiero 的 skills 与 MCP server 的来源、版本与验证方式。依据：工作区规则要求引入依赖前记录来源、版本和校验方式。

安装范围：本机配置，不入库。`.agent/` 与 `.hiero/` 已在 `.gitignore` 中，只保留在本机。

## 一、技能（项目级：`.agent/skills/`）

| 技能名 | 来源仓库 | 来源路径 | Commit SHA | 说明 |
| --- | --- | --- | --- | --- |
| find-skills | vercel-labs/skills | skills/find-skills | 57217cf86ba38148a57af9e90d14a4c049558330 | 发现并安装其他技能 |
| frontend-design | anthropics/skills | skills/frontend-design | e4bb5d960d87126ff3b3a8af1a104b7db67560ba | 前端视觉设计指导 |
| vercel-react-best-practices | vercel-labs/agent-skills | skills/react-best-practices | 5a37a6329fbad3666c3207392a6a7c0110e92efb | React/Next.js 性能规范 |
| web-design-guidelines | vercel-labs/agent-skills | skills/web-design-guidelines | 5a37a6329fbad3666c3207392a6a7c0110e92efb | Web 界面规范审查 |
| agent-browser | vercel-labs/agent-browser | skills/agent-browser | 0a923358ea989d7602f0d06507ad3447c62ffe9b | 浏览器自动化，需全局安装 CLI（未安装） |
| grill-me | mattpocock/skills | skills/productivity/grill-me | abeeaf95660ba9e8b7c753eb38f441ca707a8823 | 需求拷问 |
| grilling | mattpocock/skills | skills/productivity/grilling | abeeaf95660ba9e8b7c753eb38f441ca707a8823 | grill-me 的依赖 |
| code-review | mattpocock/skills | skills/engineering/code-review | abeeaf95660ba9e8b7c753eb38f441ca707a8823 | 依赖子代理与 issue tracker 配置 |

获取方式：`git clone --depth 1` 各仓库，再整目录复制。SHA 取自克隆时的 `HEAD`，获取日期 2026-11-24。

已知限制（未确认可用）：
- `grill-me` 的 SKILL.md 写的是“调用 Skill 工具并传入 grilling”。Hiero 没有 `Skill` 工具，只有 `load_skill`，因此该指令无法直接执行。
- `code-review` 需要子代理并行运行，且要求先执行 `/setup-matt-pocock-skills`。Hiero 未验证其是否支持这一流程。
- `agent-browser` 的 SKILL.md 指示 `npm i -g agent-browser`。该步骤尚未执行，也未验证其 npm 包来源。
- 技能内容为英文。用户无法直接阅读英文，使用时可能需要翻译。

## 二、MCP Server（`.hiero/mcp.json`）

| 名称 | 传输 | 启动方式 | 版本 | 来源 |
| --- | --- | --- | --- | --- |
| context7 | stdio | `npx -y @upstash/context7-mcp@4.7.3` | 4.7.3 | github.com/upstash/context7（npm 包 `@upstash/context7-mcp`） |
| playwright | stdio | `npx -y @playwright/mcp@0.0.86` | 0.0.86 | npm 包 `@playwright/mcp` |
| github | http | `https://api.githubcopilot.com/mcp/` | 远程服务 | github/github-mcp-server 官方远程端点 |

验证：
- context7、playwright 两者均通过 `initialize` 请求返回 `serverInfo`（已确认）。
- `.hiero/mcp.json` 通过 `src/mcp-config.ts` 的 `mcpConfigSchema` 校验（已确认）。
- github 需要环境变量 `GITHUB_PERSONAL_ACCESS_TOKEN`，配置里用 `${GITHUB_PERSONAL_ACCESS_TOKEN}` 占位，不写入明文 token。环境变量设为用户级后，重启 Hiero 时 github 显示 `connected`，工具数 46（已确认）。
- token 的权限范围未确认（GitHub API 返回 200 只说明认证通过，不代表 token 仅只读或仅限本仓库）。

## 三、运行时验证（2026-11-24）

- `skill_list`（WebSocket，`workspace: d:/hiero`）返回 30 个技能，其中包含上述 8 个项目级技能（已确认）。
- 聊天往返：模型经子代理 `delegate_task` 调用 `search_tools` 找到 GitHub 工具，查询 `baijieO-o/hiero` 的默认分支，返回 `main`，状态 `completed`（已确认）。
- 第一次测试超时的原因：测试脚本没有回应审批请求。运行时对 `web_fetch`、`delegate_task` 等工具的审批会阻塞，120 秒后自动拒绝（`src/approval-broker.ts`）。真实使用时需要用户在界面中点击批准。
- 第二次测试拒绝审批后，模型报告 `search_tools` 被拒绝，并未能查询仓库。这说明审批是实际生效的（已确认）。
- MCP 调用路径：主聊天模型默认看不到 MCP 工具，需先调用 `search_tools` 注册工具（`src/agent-executor.ts`、`src/capability-router.ts`）。第一次测试中模型直接用了 `web_fetch`，未走 MCP（已确认现象，原因未完全确认）。
- `load_skill` 在 Hiero 内的端到端调用未验证（未确认）。

## 四、未完成项

- 确认 token 权限：应为 fine-grained，仅限 `baijieO-o/hiero`，Contents / Issues / Pull requests / Metadata 只读（需用户在 GitHub 设置中核实）。
- 撤销曾在聊天与 cmd 中泄露过的两个 token（需用户操作）。
- 决定是否安装 `agent-browser` 的全局 CLI（会改动整机环境，需用户批准），并验证其 npm 包来源。
- 决定 `grill-me` 是否改写为 `load_skill("grilling")` 调用，或不启用。SKILL.md 原文引用的 `Skill` 工具在 Hiero 中不存在。
- 决定 `code-review` 是否保留。它依赖子代理并行与 `/setup-matt-pocock-skills`，Hiero 未验证支持。
- 验证 `load_skill` 能否加载任一项目技能并返回完整内容。
