import { accountArtworkOwner, type AccountSession } from './api';
let login: { key: CryptoKey; user: string; account: object; epoch: number; expires: number } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
export function forgetHistoryLogin() { login = null; clearTimeout(timer); }
export function rememberHistoryLogin(session: AccountSession, key: CryptoKey) {
  forgetHistoryLogin();
  if (typeof session.credentialEpoch !== 'number') return;
  login = { key, user: session.userId, account: accountArtworkOwner(), epoch: session.credentialEpoch, expires: Date.now() + 300000 };
  timer = setTimeout(forgetHistoryLogin, 300000);
}
export function savedHistoryLogin(user: string, account: object) { if(login&&login.account!==accountArtworkOwner())forgetHistoryLogin(); return login?.user === user && login.account === account && login.expires > Date.now() ? login : null; }
