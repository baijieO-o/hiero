/** A single diagnostic extracted from verification output. */
export interface ParsedError {
  file?: string;
  line?: number;
  message: string;
}

export interface ErrorSummary {
  /** Name of the format that matched, or `raw` when nothing specific was recognised. */
  format: string;
  errors: ParsedError[];
  /** Human-readable text ready to include in a model prompt. */
  text: string;
}

const MAX_ERRORS = 10;
const MAX_RAW_CHARS = 1500;

/** TypeScript / tsc: `src/a.ts(12,5): error TS2322: ...` */
const TSC = /^(?<file>[^\s()]+)\((?<line>\d+)(?:,\d+)?\):\s*error\s+(?<code>TS\d+):\s*(?<message>.+)$/;
/** GCC / Clang / Go / ESLint-style: `src/a.c:12:5: error: ...` (also matches `file:line: error:` forms). */
const GNU = /^(?<file>[^\s:]+):(?<line>\d+)(?::\d+)?:\s*(?:fatal\s+)?error:\s*(?<message>.+)$/i;
/** Python traceback frame: `  File "x.py", line 12, in f` */
const PY_FRAME = /^\s*File "(?<file>[^"]+)", line (?<line>\d+)/;
/** Python final exception line: `ValueError: bad`, `pkg.mod.Error: msg`, or bare `KeyError` */
const PY_EXC = /^(?<type>[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning)?)(?::\s*(?<message>.*))?$/;
/** Rust: `error[E0308]: mismatched types` followed by ` --> src/main.rs:4:5` */
const RUST_HEAD = /^error(?:\[[A-Z0-9]+\])?:\s*(?<message>.+)$/;
const RUST_LOC = /^\s*-->\s*(?<file>[^\s:]+):(?<line>\d+)/;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.4));
  return `${head}\n...[truncated ${text.length - max} chars]...\n${tail}`;
}

function parseTypeScript(lines: string[]): ParsedError[] {
  const errors: ParsedError[] = [];
  for (const line of lines) {
    const match = TSC.exec(line.trim());
    if (match?.groups) errors.push({ file: match.groups.file ?? '', line: Number(match.groups.line), message: `${match.groups.code}: ${match.groups.message}` });
  }
  return errors;
}

function parseGnu(lines: string[]): ParsedError[] {
  const errors: ParsedError[] = [];
  for (const line of lines) {
    const match = GNU.exec(line.trim());
    if (match?.groups) errors.push({ file: match.groups.file ?? '', line: Number(match.groups.line), message: match.groups.message ?? '' });
  }
  return errors;
}

function parseRust(lines: string[]): ParsedError[] {
  const errors: ParsedError[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const head = RUST_HEAD.exec(lines[index]?.trim() ?? '');
    if (!head?.groups) continue;
    const message = head.groups.message ?? '';
    const loc = lines.slice(index + 1, index + 4).map((next) => RUST_LOC.exec(next)).find((match) => match !== null);
    errors.push(loc?.groups ? { file: loc.groups.file ?? '', line: Number(loc.groups.line), message } : { message });
  }
  return errors;
}

/**
 * Python traceback: the last `File` frame is the innermost failing location, and the final non-indented
 * line is the exception. Chained tracebacks yield one entry per exception.
 */
function parsePython(lines: string[]): ParsedError[] {
  const errors: ParsedError[] = [];
  let lastFrame: { file: string; line: number } | undefined;
  let inTraceback = false;
  for (const raw of lines) {
    if (raw.startsWith('Traceback (most recent call last)')) {
      inTraceback = true;
      lastFrame = undefined;
      continue;
    }
    if (!inTraceback) continue;
    const frame = PY_FRAME.exec(raw);
    if (frame?.groups) {
      lastFrame = { file: frame.groups.file ?? '', line: Number(frame.groups.line) };
      continue;
    }
    if (raw.length === 0 || /^\s/.test(raw)) continue;
    const exc = PY_EXC.exec(raw.trim());
    if (exc?.groups) {
      const message = `${exc.groups.type}${exc.groups.message ? `: ${exc.groups.message}` : ''}`;
      errors.push(lastFrame ? { file: lastFrame.file, line: lastFrame.line, message } : { message });
      inTraceback = false;
    }
  }
  return errors;
}

export type FailureKind = 'syntax' | 'type' | 'test_assertion' | 'timeout' | 'environment' | 'unknown';

export interface FailureClassification {
  kind: FailureKind;
  /** Concrete corrective instruction for the planner, scoped to this kind of failure. */
  guidance: string;
}

const GUIDANCE: Record<FailureKind, string> = {
  syntax: '语法错误：先修正报错行附近的语法（括号、分号、缩进、未闭合的字符串），不要改动无关逻辑。',
  type: '类型错误：按报错的类型不匹配修正签名或调用处，不要用 any 或类型断言绕过。',
  test_assertion: '测试断言失败：根据期望值与实际值修正实现代码。禁止修改测试文件或验收命令来让它通过。',
  timeout: '命令超时：检查是否存在死循环、等待输入或过慢的操作，缩小范围后重试。',
  environment: '环境缺失：确认依赖、命令或文件是否存在，补齐后再验证；不要用替代方案绕开验收命令。',
  unknown: '未识别的失败：先阅读完整输出定位原因，再做最小修改。',
};

const TEST_FAILURE = /\b(AssertionError|expect\(|FAIL\b|FAILED\b|assert\b|Expected:|Received:|expected .* but got)/i;
const SYNTAX_FAILURE = /\b(SyntaxError|Unexpected token|unexpected indent|IndentationError|parse error|unterminated)/i;
const TYPE_FAILURE = /\b(TypeError|TS\d{4}|mismatched types|incompatible type|E0308|cannot assign)/i;
const ENV_FAILURE = /\b(command not found|not recognized as an internal|No such file or directory|ModuleNotFoundError|Cannot find module|ERR_MODULE_NOT_FOUND|Permission denied|docker: )/i;

/**
 * Buckets a failed verification into a kind the planner can act on. Timeouts are decided by the caller,
 * because only the process runner knows whether it killed the command.
 */
export function classifyFailure(output: string, timedOut = false): FailureClassification {
  let kind: FailureKind = 'unknown';
  if (timedOut) kind = 'timeout';
  else if (ENV_FAILURE.test(output)) kind = 'environment';
  else if (SYNTAX_FAILURE.test(output)) kind = 'syntax';
  else if (TYPE_FAILURE.test(output)) kind = 'type';
  else if (TEST_FAILURE.test(output)) kind = 'test_assertion';
  return { kind, guidance: GUIDANCE[kind] };
}

/**
 * Extracts the core diagnostics from command output so a retry prompt carries the actual error instead of
 * only the failing command name. Recognises tsc, Python tracebacks, Rust and GCC/Clang/Go-style `error:` lines.
 * Anything else is returned as truncated raw output.
 */
export function summarizeErrors(output: string): ErrorSummary {
  const lines = output.split(/\r?\n/);
  const parsers: Array<[string, (lines: string[]) => ParsedError[]]> = [
    ['typescript', parseTypeScript],
    ['python', parsePython],
    ['rust', parseRust],
    ['gnu', parseGnu],
  ];
  for (const [format, parse] of parsers) {
    const errors = parse(lines);
    if (errors.length > 0) {
      const shown = errors.slice(0, MAX_ERRORS);
      const body = shown.map((error) => (error.file ? `${error.file}${error.line ? `:${error.line}` : ''}: ${error.message}` : error.message)).join('\n');
      const more = errors.length > shown.length ? `\n...and ${errors.length - shown.length} more` : '';
      return { format, errors, text: `${body}${more}` };
    }
  }
  const trimmed = output.trim();
  return { format: 'raw', errors: [], text: trimmed ? truncate(trimmed, MAX_RAW_CHARS) : '(no output)' };
}
