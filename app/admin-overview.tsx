import { useEffect, useState } from 'react';
import { accountArtworkOwner, requestApi } from '@/lib/api';
import { ExperienceError } from './experience-error';
export function AdminOverview({ data, onSection }: { data: any; onSection: (section: 'Storage' | 'Email' | 'Diagnostics') => void }) {
  const owner = accountArtworkOwner(), [checks, setChecks] = useState<any>(null), [storage, setStorage] = useState<any>(null), [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let active = true;
    setChecks(null);setStorage(null);setError(null);
    void Promise.allSettled([requestApi('/admin/diagnostics'), requestApi('/admin/storage')]).then(([health, quota]) => {
      if (!active || owner !== accountArtworkOwner()) return;
      if (health.status === 'fulfilled') setChecks(health.value); else setError(health.reason);
      if (quota.status === 'fulfilled') setStorage(quota.value); else setError(quota.reason);
    });
    return () => { active = false; };
  }, [owner, data]);
  const measured = storage?.usageInitialized === true && Number.isFinite(storage.globalUsedBytes) && storage.globalQuotaBytes > 0;
  const percent = measured ? Math.round(storage.globalUsedBytes / storage.globalQuotaBytes * 100) : null;
  return <><div className="admin-metrics">{[['Users',data.users],['Rooms',data.rooms],['Active sessions',data.sessions]].map(([label,value])=><article className="admin-metric" key={label}><span>{label}</span><strong>{typeof value==='number'?value.toLocaleString():'Unavailable'}</strong></article>)}</div>
    <div className="home-grid"><article><h3>Storage</h3><p>{percent===null?'Usage has not been verified.':`${percent}% of the instance quota is used.`}</p>{percent!==null&&percent>=80&&<p role="status">Storage is filling up. Review usage and quotas before uploads are affected.</p>}<button className="secondary-button" onClick={()=>onSection('Storage')}>Manage storage</button></article>
      <article><h3>Email and recovery</h3><p>{data.emailConfigured?'Email is configured. Send a test to confirm delivery.':'Set up email so members can verify accounts and recover history.'}</p><button className="secondary-button" onClick={()=>onSection('Email')}>{data.emailConfigured?'Test email delivery':'Set up email'}</button></article>
      <article><h3>Services and calls</h3>{checks?.checks?.length?<ul>{checks.checks.map((check:any)=><li key={check.component}>{check.component}: <strong>{check.status}</strong></li>)}</ul>:<p>Service health has not been checked yet.</p>}<p className="login-help">A local health check does not confirm external media connectivity. Diagnostics includes TURN allocation and relay traffic tests.</p><button className="secondary-button" onClick={()=>onSection('Diagnostics')}>Open diagnostics</button></article></div>
    <ExperienceError error={error} retry={()=>onSection('Diagnostics')}/><p className="login-help">Tavern {data.version} · Synapse {data.synapseVersion||'Unavailable'}. These settings apply to the whole installation. Manage a community from its server menu.</p></>;
}
