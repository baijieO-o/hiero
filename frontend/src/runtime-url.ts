export const RUNTIME_WS_URL: string =
  (import.meta.env.VITE_HIERO_WS_URL as string | undefined) || 'ws://localhost:8080';
