
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {EmailHistoryRecovery} from '../../../app/email-history-recovery';
import '../../../app/globals.css';
const w=window as any;w.account={};w.client={};w.starts=0;w.unlocks=0;w.hasLogin=true;
w.recoveryStatus={configured:true,revision:'one',emailReady:true,credentialEpoch:0,passwordChanged:false,backupVersion:'1'};
let start:Promise<string>|undefined;w.autoStart=()=>start??=(w.starts++,Promise.resolve('challenge'));
function App(){const[known,setKnown]=useState(location.search.includes('known'));w.setKnown=setKnown;return <EmailHistoryRecovery known={known} ready automatic/>;}
createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
