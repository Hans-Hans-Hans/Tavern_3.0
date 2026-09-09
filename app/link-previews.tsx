import { useState } from 'react';
import { isManagedAccount, requestApi } from '@/lib/api';
function Preview({ url }: { url: string }) {
  const [result, setResult] = useState<{url:string;title:string;description:string;siteName:string}|null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [hidden,setHidden]=useState(false);
  if(hidden)return null;
  return <div className='link-preview'>{result ? <><a href={result.url} target='_blank' rel='noopener noreferrer' referrerPolicy='no-referrer'><small>{result.siteName || new URL(result.url).host}</small><strong>{result.title}</strong>{result.description && <p>{result.description}</p>}</a><button className='text-button' onClick={()=>setHidden(true)}>Hide preview</button></> : <><button className='text-button' disabled={busy} onClick={async () => { setBusy(true); setError(''); try { setResult(await requestApi('/link-preview', { url, consent:true })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>{busy ? 'Loading preview…' : 'Preview ' + new URL(url).host}</button><small>Contacts this website through your Tavern server.</small></>}{error && <p className='connect-error' role='alert'>{error}</p>}</div>;
}
export function LinkPreviews({ text }: { text: string }) {
  if (!isManagedAccount()) return null;
  const urls=[...new Set((text.match(/https?:\/\/[^\s<>"`]+/g)||[]).map(value=>value.replace(/[.,;!?)\]]+$/,'')))].filter(value=>{try{const url=new URL(value);return !url.username&&!url.password&&value.length<=2048;}catch{return false;}}).slice(0,3);
  return <>{urls.map(url=><Preview key={url} url={url}/>)}</>;
}
