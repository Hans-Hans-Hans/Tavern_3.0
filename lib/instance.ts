/** Public, same-origin instance settings. Never place credentials in this file. */
export async function readInstanceConfig(): Promise<{ homeserverUrl: string; lockHomeserver?: boolean; managedAuth?:boolean; serverRolePolicy?:boolean; callsEnabled?:boolean }> {
  try {
    const response = await fetch('/tavern-config.json', {
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { homeserverUrl: '' };
    const config = await response.json();
    const url = new URL(config.homeserverUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      return { homeserverUrl: '' };
    }
    return { homeserverUrl: url.href.replace(/\/$/, ''), lockHomeserver: config.lockHomeserver === true, managedAuth:config.managedAuth===true, serverRolePolicy:config.serverRolePolicy===true, callsEnabled:typeof config.callsEnabled==='boolean'?config.callsEnabled:undefined };
  } catch {
    // A plain static deployment can leave this blank and enter its server at login.
    return { homeserverUrl: '' };
  }
}
