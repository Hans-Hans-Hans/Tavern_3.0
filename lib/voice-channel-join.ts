import { accountArtworkOwner } from './api';
import { getMatrixClient } from './matrix';
import { callSnapshot, callsConfigured } from './calls';
import { readChannelPolicy } from './channel-policy';
import { openConference } from './conference-session';

/** Only explicit channel selection / Join actions call this; restoring a page does not. */
export async function joinVoiceChannel(roomId: string, stillSelected: () => boolean) {
  const client = getMatrixClient(), account = accountArtworkOwner(), actor = client?.getUserId(), device = client?.getDeviceId(), base = client?.getHomeserverUrl(), room = client?.getRoom(roomId);
  const current = () => stillSelected() && !!client && getMatrixClient() === client && accountArtworkOwner() === account && client.getUserId() === actor && client.getDeviceId() === device && client.getHomeserverUrl() === base && client.getRoom(roomId) === room && room?.getMyMembership() === 'join' && readChannelPolicy(roomId).kind === 'voice';
  if (!current()) return;
  const configured = await callsConfigured();
  if (!current()) return;
  if (!configured) throw new Error('Your administrator needs to enable the call service.');
  const direct = callSnapshot().call;
  if (direct && direct.state !== 'ended') throw new Error('Finish the direct call before joining this voice channel.');
  openConference(roomId);
}
