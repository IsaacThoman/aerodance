import { createRoot } from 'react-dom/client';
import App from './App.tsx';

// No StrictMode: its double-mounted effects would make the frame-stepped capture less predictable.
const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');
createRoot(root).render(<App />);
