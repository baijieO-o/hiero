import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installDevtools } from './devtools';
import './style.css';
import 'dockview/dist/styles/dockview.css';

installDevtools();

createRoot(document.getElementById('app')!).render(<StrictMode><App /></StrictMode>);
