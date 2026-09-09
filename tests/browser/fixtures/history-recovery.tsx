import React from 'react';
import { createRoot } from 'react-dom/client';
import { HistoryRecovery } from '../../../app/history-recovery';
import '../../../app/globals.css';
import '../../../app/product.css';
export function mountFixture() { createRoot(document.getElementById('root')!).render(<HistoryRecovery/>); }
