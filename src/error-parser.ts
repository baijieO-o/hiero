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
