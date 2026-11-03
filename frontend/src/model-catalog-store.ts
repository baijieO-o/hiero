export const MODEL_CATALOG_KEY = 'hiero-model-catalog';
export const DEFAULT_CHAT_MODEL = 'gpt-5.6-luna';
const DEFAULT_MODEL_KEY = 'hiero-default-model';

export function readStoredModelCatalog(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MODEL_CATALOG_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  } catch {
    return [];
  }
}

export function readStoredDefaultModel(): string {
  return localStorage.getItem(DEFAULT_MODEL_KEY) || DEFAULT_CHAT_MODEL;
}

export function storeDefaultModel(model: string): void {
  localStorage.setItem(DEFAULT_MODEL_KEY, model);
}

export function storeModelCatalog(models: string[]): void {
  localStorage.setItem(MODEL_CATALOG_KEY, JSON.stringify([...new Set(models)]));
}

// 对话框的模型下拉框必须包含当前选中值，否则 <select> 会显示错误。
export function chatModelOptions(catalog: string[], selected: string): string[] {
  const options = catalog.length > 0 ? catalog : [DEFAULT_CHAT_MODEL];
  return options.includes(selected) ? options : [selected, ...options];
}
