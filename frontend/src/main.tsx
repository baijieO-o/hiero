import '@fontsource/anton/latin-400.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installDevtools } from './devtools';
import { loadModelPrices } from './token-cost';
import './style.css';
import 'dockview/dist/styles/dockview.css';

installDevtools();

const root = createRoot(document.getElementById('app')!);
const renderApp = (): void => root.render(<StrictMode><App /></StrictMode>);
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
