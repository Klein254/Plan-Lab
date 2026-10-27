import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Development builds expose the store for automated UI tests
if (import.meta.env.DEV) {
  void import('./state/store.ts').then((m) => ((window as unknown as Record<string, unknown>).__planlab = m));
}
