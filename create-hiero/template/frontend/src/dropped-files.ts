export const TEXT_FILE_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'env', 'csv', 'tsv', 'log',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'xml', 'svg', 'vue', 'svelte',
  'gitignore', 'dockerfile', 'makefile',
]);

export const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot < 0 ? base.toLowerCase() : base.slice(dot + 1).toLowerCase();
}

export type DroppedFileKind = 'text' | 'image' | 'other';

export function classifyFile(file: { name: string; type: string }): DroppedFileKind {
  if (file.type.startsWith('image/')) return 'image';
  if (TEXT_FILE_EXTENSIONS.has(extensionOf(file.name)) || file.type.startsWith('text/')) return 'text';
  return 'other';
}

/** Folder name used to pre-fill the picker; a dropped folder's real path is not available in the browser. */
export function folderNameFromEntry(entry: { name: string }): string {
  return entry.name;
}
