import type { DocEntry } from './docs-model';
import { ERROR_DOCS } from './error-code-docs';

// Repo docs are read at build time, so the in-app docs never drift from the files.
// HANDOFF.md (development history) and .hiero/ (session records) are deliberately not listed.
const repoDocs = import.meta.glob(['../../README.md', '../../docs/*.md', '../../ARCHITECTURE.md'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// ARCHITECTURE.md sections 11 (open decisions) and 12 (external analysis under review) are internal working notes.
const ARCHITECTURE_PUBLIC_END = '\n## 11. 待决策';

function sourceOf(path: string): string {
  const key = Object.keys(repoDocs).find((k) => k.endsWith(path));
  if (!key) throw new Error(`Doc source not bundled: ${path}`);
  return repoDocs[key];
}

/** README contains the maintainer's personal contact line, which is not shipped in the in-app copy. */
function stripPrivateLines(source: string): string {
  return source.split('\n').filter((line) => !/@163\.com|@qq\.com|@gmail\.com/i.test(line)).join('\n');
}

function architectureSource(): string {
  const full = sourceOf('ARCHITECTURE.md');
  const cut = full.indexOf(ARCHITECTURE_PUBLIC_END);
  return cut >= 0 ? full.slice(0, cut).trimEnd() + '\n' : full;
}

function errorCodeSource(): string {
  const lines: string[] = ['# 错误码', '', '错误码与常见报错原因。级别：blocker 阻断任务；degradation 降级但可继续；warning 提示注意。', ''];
  for (const group of ERROR_DOCS) {
    lines.push(`## ${group.group}`, '');
    lines.push('| 错误码 | 级别 | 含义 | 常见原因 | 处理建议 |', '| --- | --- | --- | --- | --- |');
    for (const row of group.rows) {
      lines.push(`| \`${row.code}\` | ${row.level} | ${row.message} | ${row.causes} | ${row.suggestion} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export const DOC_ENTRIES: DocEntry[] = [
  { id: 'readme', title: '项目概览', category: 'guide', source: stripPrivateLines(sourceOf('README.md')) },
  { id: 'features', title: '功能说明', category: 'guide', source: sourceOf('docs/FEATURES.md') },
  { id: 'errors', title: '错误码', category: 'reference', source: errorCodeSource() },
  { id: 'developing', title: '二次开发指南', category: 'develop', source: sourceOf('docs/DEVELOPING.md') },
  { id: 'architecture', title: '架构设计', category: 'architecture', source: architectureSource() },
];
