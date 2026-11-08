# 基于 Hiero 开发

本文面向想扩展 Hiero 的开发者。架构总览见 [ARCHITECTURE.md](../ARCHITECTURE.md)，功能清单见 [FEATURES.md](FEATURES.md)。

## 1. 环境与测试

```bash
npm install
npm test            # 后端测试（node --test），同时重新构建 dist/
npm run build       # 后端 + 前端构建
cd frontend && npm run build
```

修改后端代码后需要 `npm test` 或 `npm run build`，再重启服务（`npm start`）。

## 2. 添加一个工具（最常见的扩展方式）

工具通过 `ToolGateway` 注册。每个工具是一个 `RegisteredTool`：

```ts
interface RegisteredTool<TInput, TResult> {
  name: string;
  inputSchema: ZodSchema<TInput>;   // 输入先经 Zod 校验，非法输入直接拒绝
  execute(input: TInput): Promise<TResult> | TResult;
  effect?: 'read' | 'workspace' | 'external';
  irreversible?: boolean;
  networkAccess?: boolean;
}
```

完整示例见 [examples/custom-tool/word-count-tool.ts](../examples/custom-tool/word-count-tool.ts)，对应测试见 [test/custom-tool-example.test.ts](../test/custom-tool-example.test.ts)。

### 审批规则（由 `ToolGateway.execute` 强制执行）

| 工具属性 | 非自动模式下是否需要审批 |
| --- | --- |
| `networkAccess: true` | 需要 |
| `irreversible: true` 且 `effect` 为 `external`（或未设置） | 需要 |
| `irreversible: true` 且处于 `strict` 模式 | 需要 |
| 命中断点 | 需要 |
| `auto` 模式 | 不需要 |

注意：`effect` 未设置时按 `external` 处理。因此不可逆的工具若未声明 `effect`，会一律需要审批。

建议：只读工具用 `effect: 'read'`；修改工作区文件用 `'workspace'`；访问外部系统用 `'external'` 并按实际情况设置 `irreversible`、`networkAccess`。

### 路径安全

涉及工作区路径时，使用 `resolveWorkspacePath`（位于 [src/basic-tools.ts](../src/basic-tools.ts)）。它会拒绝绝对路径、`..` 越界和符号链接逃逸。不要直接拼接字符串。

### 注册位置

目前工具在运行时装配处手动注册，参考 [src/hiero-runtime.ts](../src/hiero-runtime.ts) 中的工具装配部分。这一步还没有插件式的自动发现，需要改动源码。

## 3. 其他扩展点

- **Skill**：可复用的任务说明，由 Skill 系统加载，适合不需要写代码的能力扩展。
- **MCP 服务器**：在设置的「MCP 服务器」分类中配置。通过 `registerMcpTool` 接入的工具默认视为 `external` 且不可逆，因此默认需要审批。
- **前端设置**：`frontend/src/settings.tsx` 中的 `PREFERENCE_SCHEMA` 定义设置项。加 `advanced: true` 可将字段收入「高级设置」折叠区。新增键会由 `merge` 自动填充默认值，旧的本地存储数据不会失效。
- **主题**：支持预设、自定义色板、JSON 导入导出和自定义 CSS，见设置的「外观」分类。

## 4. 脚手架

`create-hiero/` 会复制 `template/` 并安装依赖。它尚未与当前代码逐项核对，使用前请先确认其可用性。

## 5. 提交前检查

- `npm test` 通过
- 新工具有对应测试，覆盖正常路径和越界路径
- 前端改动运行 `cd frontend && npm run build`
