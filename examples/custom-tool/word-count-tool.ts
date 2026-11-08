import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { resolveWorkspacePath } from '../../src/basic-tools.js';
import type { RegisteredTool } from '../../src/tool-gateway.js';

/**
 * 最小自定义工具示例：统计工作区内一个文本文件的行数、词数和字符数。
 * effect 为 'read'，不会触发审批；路径通过 resolveWorkspacePath 限制在工作区内。
 */
const wordCountInput = z.object({ path: z.string().min(1) });

export function createWordCountTool(workspacePath: string): RegisteredTool<z.infer<typeof wordCountInput>, { lines: number; words: number; chars: number }> {
  return {
    name: 'word_count',
    inputSchema: wordCountInput,
    effect: 'read',
    async execute({ path }) {
      const text = await readFile(resolveWorkspacePath(workspacePath, path), 'utf8');
      return {
        lines: text === '' ? 0 : text.split(/\r?\n/).length,
        words: text.split(/\s+/).filter(Boolean).length,
        chars: [...text].length,
      };
    },
  };
}
