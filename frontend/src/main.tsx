import '@fontsource/anton/latin-400.css';
import { StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import EffectsDemo from './effects-demo';
import RadialCursor from './effects-cursor';
import { usePreferences } from './settings';
import './effects-demo.css';
import { installDevtools } from './devtools';
import { loadModelPrices } from './token-cost';
import './style.css';
import 'dockview/dist/styles/dockview.css';

installDevtools();

// 仅在「自定义光标」开启时挂载径向光标，关闭后圆环与菜单立即移除。
function CustomCursorGate(): ReactElement | null {
  const enabled = usePreferences((state) => state.values.customCursor);
  return enabled ? <RadialCursor /> : null;
}

const root = createRoot(document.getElementById('app')!);
// `?effects=1` opens the standalone interaction-effects showcase instead of the app.
const showEffects = new URLSearchParams(window.location.search).has('effects');
const renderApp = (): void => root.render(
  <StrictMode>
    <CustomCursorGate />
    {showEffects ? <EffectsDemo /> : <App />}
  </StrictMode>,
);
renderApp();
// Hide the boot splash (index.html) after the first frame and once its draw-in animation has played.
const SPLASH_MIN_MS = 3000;
requestAnimationFrame(() => {
  const splash = document.getElementById('boot-splash');
  const wait = Math.max(0, SPLASH_MIN_MS - performance.now());
  window.setTimeout(() => {
    splash?.classList.add('done');
    splash?.addEventListener('transitionend', () => splash.remove(), { once: true });
  }, wait);
});
// Cost figures read the price table at render time, so re-render once the remote table is in.
void loadModelPrices().then(renderApp);
