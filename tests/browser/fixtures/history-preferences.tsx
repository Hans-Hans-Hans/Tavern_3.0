import React from 'react';
import { createRoot } from 'react-dom/client';
import { HistoryPreferences } from '../../../app/history-preferences';
import '../../../app/globals.css';

const automatic = new URLSearchParams(location.search).has('automatic');
const known = new URLSearchParams(location.search).has('known');
createRoot(document.getElementById('root')!).render(<React.StrictMode><HistoryPreferences automatic={automatic} ready known={known}/></React.StrictMode>);
