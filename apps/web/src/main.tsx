import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';

// /?walk[=<scene>]: walk round the game's scenes instead (walk/WalkApp.tsx), loaded only then.
const WalkApp = lazy(() => import('./walk/WalkApp.tsx'));

const root = document.getElementById('root');
if (!root) throw Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    {new URLSearchParams(location.search).has('walk') ? <Suspense fallback={null}><WalkApp /></Suspense> : <App />}
  </StrictMode>,
);
