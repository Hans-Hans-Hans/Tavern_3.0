import React from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { AdminUsers } from '../../../app/admin-users';
import '../../../app/globals.css';
export function mountFixture() {
  createRoot(document.getElementById('root')!).render(<><AdminUsers session={{ userId: '@owner:local', deviceId: 'BROWSER', baseUrl: '/api/matrix', admin: true }} /><Toaster/></>);
}
