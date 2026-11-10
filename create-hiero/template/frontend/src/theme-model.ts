// Theme palettes are plain CSS-variable overrides. Only whitelisted variables can be set, so imported files cannot inject arbitrary styles.
export const THEME_VARIABLES = [
  '--bg',
  '--input-bg',
  '--surface',
  '--surface-2',
  '--surface-3',
  '--border',
  '--text-strong',
  '--text',
  '--text-muted',
  '--accent',
  '--accent-text',
  '--accent-contrast',
] as const;

export type ThemeVariable = (typeof THEME_VARIABLES)[number];
export type ThemePalette = Partial<Record<ThemeVariable, string>>;

export interface ThemePreset {
  id: string;
  name: string;
  palette: ThemePalette;
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: 'default-dark', name: '默认深色', palette: {} },
  { id: 'default-light', name: '默认浅色', palette: {} },
  {
    id: 'nord',
    name: 'Nord',
    palette: {
      '--bg': '#2e3440', '--input-bg': '#262c36', '--surface': '#3b4252', '--surface-2': '#434c5e', '--surface-3': '#4c566a',
      '--border': '#4c566a', '--text-strong': '#eceff4', '--text': '#d8dee9', '--text-muted': '#9aa5b8',
      '--accent': '#88c0d0', '--accent-text': '#8fbcbb', '--accent-contrast': '#2e3440',
    },
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    palette: {
      '--bg': '#002b36', '--input-bg': '#00252f', '--surface': '#073642', '--surface-2': '#0b3d4a', '--surface-3': '#124652',
      '--border': '#2b5560', '--text-strong': '#fdf6e3', '--text': '#93a1a1', '--text-muted': '#657b83',
      '--accent': '#b58900', '--accent-text': '#cb9f1c', '--accent-contrast': '#002b36',
    },
  },
  {
    id: 'high-contrast',
    name: '高对比度',
    palette: {
      '--bg': '#000000', '--input-bg': '#000000', '--surface': '#0a0a0a', '--surface-2': '#141414', '--surface-3': '#1f1f1f',
      '--border': '#ffffff', '--text-strong': '#ffffff', '--text': '#f0f0f0', '--text-muted': '#c8c8c8',
      '--accent': '#ffff00', '--accent-text': '#ffff66', '--accent-contrast': '#000000',
    },
  },
];

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isThemeVariable(name: string): name is ThemeVariable {
  return (THEME_VARIABLES as readonly string[]).includes(name);
}

// Keeps only whitelisted variables with valid #rgb / #rrggbb values.
export function sanitizePalette(input: unknown): ThemePalette {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: ThemePalette = {};
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (isThemeVariable(name) && typeof value === 'string' && HEX_COLOR.test(value.trim())) {
      result[name] = value.trim();
    }
  }
  return result;
}

export interface ThemeFile {
  format: 'hiero-theme';
  version: 1;
  name: string;
  palette: ThemePalette;
}

export function exportTheme(name: string, palette: ThemePalette): string {
  const file: ThemeFile = { format: 'hiero-theme', version: 1, name: name || '自定义主题', palette: sanitizePalette(palette) };
  return JSON.stringify(file, null, 2);
}

// Returns null when the text is not a valid theme file.
export function parseThemeFile(text: string): { name: string; palette: ThemePalette } | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const file = data as Partial<ThemeFile>;
  if (file.format !== 'hiero-theme' || file.version !== 1) return null;
  const palette = sanitizePalette(file.palette);
  if (Object.keys(palette).length === 0) return null;
  return { name: typeof file.name === 'string' && file.name.trim() ? file.name.trim().slice(0, 40) : '导入的主题', palette };
}
