import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { browserStorageEnv } from './storage/browser.ts';
import { App } from './ui/App.tsx';
import './ui/app.css';
import { spawnVaultWorker } from './worker/spawn.ts';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

createRoot(container).render(
  <StrictMode>
    <App vault={spawnVaultWorker()} storage={browserStorageEnv()} />
  </StrictMode>,
);
