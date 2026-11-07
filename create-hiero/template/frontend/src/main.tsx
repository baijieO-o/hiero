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
// Cost figures read the price table at render time, so re-render once the remote table is in.
void loadModelPrices().then(renderApp);
