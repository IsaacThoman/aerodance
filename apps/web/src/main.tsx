import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './styles.css';

// /?walk[=<scene>]: walk round the game's scenes instead (walk/WalkApp.tsx), loaded only then.
const WalkApp = lazy(() => import('./walk/WalkApp.tsx'));
// /?hands: a first-person demo of holding things with tracked hands (hands/HandsApp.tsx).
const HandsApp = lazy(() => import('./hands/HandsApp.tsx'));
const search = new URLSearchParams(location.search);

const root = document.getElementById('root');
if (!root) throw Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    {search.has('walk') ? <Suspense fallback={null}><WalkApp /></Suspense>
      : search.has('hands') ? <Suspense fallback={null}><HandsApp /></Suspense> : <App />}
  </StrictMode>,
);
