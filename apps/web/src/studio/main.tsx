import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import StudioApp from './StudioApp.tsx';
import './studio.css';

createRoot(document.getElementById('root')!).render(<StrictMode><StudioApp /></StrictMode>);
