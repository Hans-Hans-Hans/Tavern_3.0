import { createRoot } from 'react-dom/client';
import { AuthGateway } from './auth-gateway';
import './globals.css';

createRoot(document.getElementById('root')!).render(<AuthGateway />);
