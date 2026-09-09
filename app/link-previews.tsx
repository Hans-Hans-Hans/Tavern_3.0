import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { accountArtworkOwner, isManagedAccount, requestApi } from '@/lib/api';
import { getMatrixClient } from '@/lib/matrix';
import { messageLinkUrl, visibleMessageLinks } from '@/lib/message-markdown';

type PreviewResult = { url: string; title: string; description: string; siteName: string };
function Preview({ url }: { url: string }) {
  const [result, setResult] = useState<PreviewResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [hidden, setHidden] = useState(false);
  const owner = useRef(getMatrixClient()).current, account = useRef(accountArtworkOwner()).current, mounted = useRef(false);
  const actor = useRef(owner?.getUserId()).current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && isManagedAccount() && owner === getMatrixClient() && actor === owner?.getUserId() && account === accountArtworkOwner();
  if (hidden || owner !== getMatrixClient() || actor !== owner?.getUserId() || account !== accountArtworkOwner()) return null;
  return <div className="link-preview">{result ? <>
    <a href={result.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><small>{result.siteName || new URL(result.url).host}</small><strong>{result.title}</strong>{result.description && <p>{result.description}</p>}</a>
    <button type="button" className="text-button" onClick={() => setHidden(true)}>Hide preview</button>
  </> : <>
    <button type="button" className="text-button" disabled={busy} onClick={async () => {
      if (!current()) return;
      setBusy(true); setError('');
      try {
        const value = await requestApi<PreviewResult>('/link-preview', { url, consent: true });
        if (!current()) return;
        const href = messageLinkUrl(value?.url);
        if (!href || [value.title, value.description, value.siteName].some(field => typeof field !== 'string')) throw new Error('The website did not return a usable preview.');
        setResult({ ...value, url: href });
      } catch (e) { if (current()) setError((e as Error).message); }
      finally { if (current()) setBusy(false); }
    }}>{busy ? 'Loading preview' : 'Preview ' + new URL(url).host}</button>
    <small>Contacts this website through your Tavern server.</small>
  </>}{error && <p className="connect-error" role="alert">{error}</p>}</div>;
}
export function LinkPreviews({ text }: { text: string }) {
  const urls = useMemo(() => visibleMessageLinks(text), [text]);
  if (!isManagedAccount()) return null;
  // Any edit discards earlier consent/results, even when a destination survives.
  return <Fragment key={text}>{urls.map(url => <Preview key={url} url={url}/>)}</Fragment>;
}
