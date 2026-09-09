import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { KeyboardShortcuts } from '../../../app/keyboard-shortcuts';
import '../../../app/globals.css';
function Fixture() { const [current, setCurrent] = useState('a'); return <><textarea aria-label='Composer'/><p role='status'>Current: {current}</p><KeyboardShortcuts userId='@fixture:local' currentRoomId={current} conversations={[{ id: 'a', unread: 1 }, { id: 'b', unread: 0 }, { id: 'c', unread: 1, muted: true }, { id: 'd', unread: 4 }]} onSelectRoom={setCurrent}/></>; }
export function mountFixture() { createRoot(document.getElementById('root')!).render(<Fixture/>); }
