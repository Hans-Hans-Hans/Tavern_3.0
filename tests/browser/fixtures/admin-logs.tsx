import React from 'react';
import { createRoot } from 'react-dom/client';
import { AdminLogs } from '../../../app/admin-logs';
import '../../../app/globals.css';
export function mountFixture() { createRoot(document.getElementById('root')!).render(<AdminLogs/>); }
