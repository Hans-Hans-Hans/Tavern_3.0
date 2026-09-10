import React from 'react';
import { createRoot } from 'react-dom/client';
import { AdminRooms } from '../../../app/admin-resources';
import { setAccountDevice } from '../../../lib/api';
import '../../../app/globals.css';
setAccountDevice('ADMIN-A');
(window as any).adminRoomFixture = { changeOwner() { setAccountDevice('ADMIN-B'); setAccountDevice('ADMIN-A'); } };
createRoot(document.getElementById('root')!).render(<AdminRooms/>);
