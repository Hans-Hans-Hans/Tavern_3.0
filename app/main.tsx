import { createRoot } from 'react-dom/client';
import { AuthGateway } from './auth-gateway';
import { PwaStatus } from './pwa-status';
import './globals.css';

createRoot(document.getElementById('root')!).render(<><PwaStatus/><AuthGateway /></>);
