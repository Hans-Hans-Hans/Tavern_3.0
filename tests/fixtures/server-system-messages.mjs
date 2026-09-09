import { profileMetadataFixture } from './profile-metadata.mjs';

export function systemMessagesFixture() {
  const f = profileMetadataFixture();
  f.accountOwner = {}; f.managed = true; f.requests = []; f.beforeRequest = null; f.rejected = null;
  f.data = { enabled: true, ready: true, settings: null, eventId: null, destinations: [{ hookId: 'notices', roomId: f.channel.roomId, name: 'Welcome bot' }], counts: { pending: 2, sent: 3, cancelled: 1 }, configurationRevision: 'configuration-1' };
  f.request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    f.requests.push({ path, body: body && structuredClone(body), method }); await f.beforeRequest?.(path, body, method);
    if (f.rejected) throw Object.assign(new Error(f.rejected.message), { status: f.rejected.status });
    if (method === 'GET') return structuredClone(f.data);
    if (body.settings['io.tavern.previous_event'] !== f.data.eventId) throw Object.assign(new Error('A newer route was saved. Reload.'), { status: 409 });
    f.data.settings = structuredClone(body.settings); f.data.eventId = '$saved-' + f.requests.length; return { eventId: f.data.eventId };
  };
  return f;
}
