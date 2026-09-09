import React from 'react';
import {createRoot} from 'react-dom/client';
import {WelcomeTour,openWelcomeTour} from '../../../app/welcome-tour';
export function mountFixture(){createRoot(document.getElementById('root')!).render(<WelcomeTour invitations={1} onCreateServer={()=>{}} onInvitations={()=>{}} onChanged={async()=>{}}/>);document.getElementById('reopen')!.onclick=openWelcomeTour;}
