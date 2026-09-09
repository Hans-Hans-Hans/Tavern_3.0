import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { requestApi, type AccountSession } from '@/lib/api';
import { Field } from './auth-gateway';
import { OperationsPanel } from './operations-panel';
import { AdminRooms, StoragePolicy } from './admin-resources';
import { InstancePolicy } from './instance-status';
import { ReportReview } from './report-review';
import { AdminAudit } from './admin-audit';
import { AdminUsers } from './admin-users';
import { AdminIntegrations } from './admin-integrations';
const sections = ['Overview', 'Users', 'Rooms', 'Storage', 'Integrations', 'Email', 'Instance', 'Policy', 'Reports', 'Audit', 'Diagnostics', 'Updates', 'Backups'] as const;
const formatTime = (n: number | string) => n ? new Date(typeof n === 'number' && n < 1e12 ? n * 1000 : n).toLocaleString() : '—';
export default function AdminConsole({ session }: { session: AccountSession }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [section, setSection] = useState<typeof sections[number]>('Overview'), [data, setData] = useState<any>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''), [page, setPage] = useState(0), [settings, setSettings] = useState<any>(null), [smtpPassword, setSmtpPassword] = useState('');
  const [to, setTo] = useState('');
  async function load() {
    setBusy(true); setError('');
    try {
      if(['Reports','Policy','Rooms','Storage','Audit','Integrations','Users'].includes(section)){setData({});return;}
      const route = section === 'Users' ? '/admin/users?limit=50&from=' + page + '&search=' + encodeURIComponent(query) : section === 'Email' || section === 'Instance' ? '/admin/settings' : '/admin/' + section.toLowerCase();
      const value = await requestApi(route); setData(value); if (section === 'Email' || section === 'Instance') setSettings(value);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  useEffect(() => { setData(null); void load(); }, [section, page]);
  async function mutation(fn: () => Promise<any>, message: string) { setBusy(true); setError(''); try { const result = await fn(); toast.success(message); await load(); return result; } catch (e: any) { setError(e.message); return null; } finally { setBusy(false); } }
  if (!session.admin) return <main className="auth-shell"><section className="auth-card"><h1>Administrator access required</h1><p>Your account does not have instance administration privileges.</p><a href="/">Return to Tavern</a></section></main>;
  const smtp = settings?.smtp || {}, instance = settings?.instance || {};
  const updateSmtp = (key: string, value: unknown) => setSettings((s: any) => ({ ...s, smtp: { ...s.smtp, [key]: value } }));
  const updateInstance = (key: string, value: unknown) => setSettings((s: any) => ({ ...s, instance: { ...s.instance, [key]: value } }));
  return <main className="admin-layout"><nav className="admin-nav" aria-label="Instance administration"><a href="/" className="secondary-button">← Tavern</a>{sections.map(s => <button key={s} aria-current={section === s} onClick={() => { setSection(s); setPage(0); }}>{s}</button>)}</nav><section className="admin-main"><header className="admin-toolbar"><h1>{section}</h1><button className="secondary-button" disabled={busy} onClick={()=>{setRefreshKey(key=>key+1);void load();}}>Refresh</button>{busy && <span role="status">Loading…</span>}</header>{error && <p className="connect-error" role="alert">{error}</p>}
    {section === 'Overview' && data && <><div className="admin-metrics">{[['Users', data.users], ['Rooms', data.rooms], ['Active sessions', data.sessions]].map(([label, value]) => <article key={String(label)} className="admin-metric"><span>{label}</span><strong>{typeof value === 'number' ? value.toLocaleString() : 'Unavailable'}</strong></article>)}</div><div className="product-section"><p>Tavern {data.version} · Synapse {data.synapseVersion || 'Unavailable'}</p><p>Email: {data.emailConfigured ? 'Configured' : 'Not configured'}</p></div></>}
    {section === 'Users' && <AdminUsers key={refreshKey} session={session}/>}
    {section === 'Email' && settings && <form className="dialog-form" onSubmit={e => { e.preventDefault(); void mutation(async () => { await requestApi('/admin/settings', { smtp: { ...smtp, ...(smtpPassword ? { password: smtpPassword } : {}) } }, 'PUT'); setSmtpPassword(''); }, 'Email settings saved'); }}><label className="check-label"><input type="checkbox" checked={!!smtp.enabled} onChange={e => updateSmtp('enabled', e.target.checked)}/>Enable email</label><Field label="SMTP host"><input required value={smtp.host || ''} onChange={e => updateSmtp('host', e.target.value)} placeholder="smtp.gmail.com"/></Field><Field label="Port"><input type="number" min={1} max={65535} required value={smtp.port || 587} onChange={e => updateSmtp('port', Number(e.target.value))}/></Field><Field label="Encryption"><select value={smtp.secure ? 'tls' : 'starttls'} onChange={e => updateSmtp('secure', e.target.value === 'tls')}><option value="starttls">STARTTLS (usually port 587)</option><option value="tls">TLS (usually port 465)</option></select></Field><Field label="Username"><input autoComplete="off" value={smtp.username || ''} onChange={e => updateSmtp('username', e.target.value)}/></Field><Field label={smtp.passwordConfigured ? 'Replace saved password (leave blank to keep)' : 'SMTP password / Gmail App Password'}><input type="password" autoComplete="new-password" value={smtpPassword} onChange={e => setSmtpPassword(e.target.value)}/></Field><Field label="Sender name"><input value={smtp.fromName || ''} onChange={e => updateSmtp('fromName', e.target.value)}/></Field><Field label="Sender address"><input type="email" required value={smtp.fromAddress || ''} onChange={e => updateSmtp('fromAddress', e.target.value)}/></Field><button className="primary-button" disabled={busy}>Save email settings</button><hr className="product-divider"/><p>Tests use the saved settings.</p><Field label="Test email recipient"><input type="email" value={to} onChange={e => setTo(e.target.value)}/></Field><div className="product-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void mutation(() => requestApi('/admin/email/test', { connectionOnly: true }), 'SMTP connection succeeded')}>Test connection</button><button type="button" className="secondary-button" disabled={busy || !to} onClick={() => void mutation(() => requestApi('/admin/email/test', { to }), 'Test email sent')}>Send test email</button></div></form>}
    {section === 'Instance' && settings && <form className="dialog-form" onSubmit={e => { e.preventDefault(); void mutation(() => requestApi('/admin/settings', { instance,policy:settings.policy }, 'PUT'), 'Instance settings saved'); }}>{[['name', 'Instance name'], ['description', 'Description'], ['contact', 'Administrator contact'], ['termsUrl', 'Terms URL'], ['privacyUrl', 'Privacy URL']].map(([key, label]) => <Field key={key} label={label}><input value={instance[key] || ''} onChange={e => updateInstance(key, e.target.value)} maxLength={key === 'description' ? 500 : 254}/></Field>)}<Field label="Account registration"><select value={settings.policy?.registrationMode||'admin'} onChange={e=>setSettings((s:any)=>({...s,policy:{...s.policy,registrationMode:e.target.value}}))}><option value="admin">Administrator creates accounts</option><option value="invite">Invitation required</option><option value="open">Open registration with verified email</option></select></Field><p>Self registration requires working email delivery.</p><button className="primary-button" disabled={busy}>Save instance settings</button></form>}
    {section === 'Audit' && <AdminAudit key={refreshKey}/>}
    {section === 'Diagnostics' && data && <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Component</th><th>Status</th><th>Details</th><th>Latency</th></tr></thead><tbody>{data.checks?.map((c: any) => <tr key={c.component}><td>{c.component}</td><td>{c.status}</td><td>{c.detail}</td><td>{typeof c.latencyMs === 'number' ? Math.round(c.latencyMs) + ' ms' : '—'}</td></tr>)}</tbody></table><p>Checked {formatTime(data.checkedAt)}</p></div>}
    {section === 'Updates' && data && <div className="product-section"><h3>{data.updateAvailable ? 'An update is available' : data.latestStable ? 'Current stable release checked' : 'Release information unavailable'}</h3><p>Installed: {typeof data.current === 'string' ? data.current : data.current?.version}<br/>Latest stable: {data.latestStable?.version || data.latestStable?.tag_name || data.latestStable || 'No published release'}<br/>Latest prerelease: {data.latestPrerelease?.version || data.latestPrerelease?.tag_name || data.latestPrerelease || 'No published prerelease'}</p>{data.reason && <p>{data.reason}</p>}</div>}
    {section === 'Updates' && <OperationsPanel key='updates' mode='updates' releases={data}/>}
    {section === 'Backups' && <OperationsPanel key='backups' mode='backups'/>}
    {section === 'Reports' && <ReportReview key={refreshKey}/>}
    {section === 'Rooms' && <AdminRooms key={refreshKey}/>}
    {section === 'Storage' && <StoragePolicy key={refreshKey}/>}
    {section === 'Integrations' && <AdminIntegrations key={refreshKey}/>}
    {section === 'Policy' && <InstancePolicy key={refreshKey}/>}
  </section></main>;
}
