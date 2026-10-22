import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import RemoteApp from './RemoteApp.tsx';
import '../styles.css';

// The remote the iPhone/iPad app shows on the phone while the game is on a TV (/remote/).
const root = document.getElementById('root');
if (!root) throw Error('remote/index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <RemoteApp />
  </StrictMode>,
);
