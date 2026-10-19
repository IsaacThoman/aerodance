import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import PhoneApp from './PhoneApp.tsx';
import '../styles.css';

// The page a phone opens to be the game's camera (/phone/, usually from the game's QR code).
const root = document.getElementById('root');
if (!root) throw Error('phone/index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <PhoneApp />
  </StrictMode>,
);
