import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractHeadings, searchDocs, type DocEntry } from '../frontend/src/docs-model.js';

test('extractHeadings reads ATX headings and skips fenced code', () => {
  const source = ['# 标题', '', '```bash', '# 这是注释，不是标题', '```', '', '## 第二节', '### 子节'].join('\n');
  const headings = extractHeadings(source);
  assert.deepEqual(headings.map((h) => [h.level, h.text]), [[1, '标题'], [2, '第二节'], [3, '子节']]);
});

test('extractHeadings gives duplicate headings unique anchors', () => {
  const headings = extractHeadings('## 概述\n\n## 概述\n\n## 概述');
  assert.deepEqual(headings.map((h) => h.anchor), ['概述', '概述-1', '概述-2']);
});

test('searchDocs matches title and body case-insensitively with a snippet', () => {
  const entries: DocEntry[] = [
    { id: 'a', title: 'Shortcuts', category: 'guide', source: 'Press Ctrl+Shift+U to open the docs.' },
    { id: 'b', title: '功能说明', category: 'guide', source: '支持流式输出。' },
  ];
  const byBody = searchDocs(entries, 'ctrl+shift+u');
  assert.equal(byBody.length, 1);
  assert.equal(byBody[0]?.entry.id, 'a');
  assert.match(byBody[0]?.snippet ?? '', /Ctrl\+Shift\+U/);

  const byTitle = searchDocs(entries, '功能');
  assert.deepEqual(byTitle.map((r) => r.entry.id), ['b']);
});

test('searchDocs returns nothing for an empty or whitespace query', () => {
  const entries: DocEntry[] = [{ id: 'a', title: 'x', category: 'guide', source: 'x' }];
  assert.deepEqual(searchDocs(entries, ''), []);
  assert.deepEqual(searchDocs(entries, '   '), []);
});
