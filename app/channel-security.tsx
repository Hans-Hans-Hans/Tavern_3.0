import { useEffect, useState } from 'react';
import { LockKeyhole, ShieldAlert, ShieldCheck } from 'lucide-react';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { accountArtworkOwner } from '@/lib/api';
import { subscribeSecurity } from '@/lib/security';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/** Read room encryption and this device's verification independently. Never
 * infer trust from room membership, an encrypted flag in a preview, or a badge. */
export function ChannelSecurity({ roomId, preview, onSettings }: { roomId: string; preview: boolean; onSettings: () => void }) {
  const [revision, setRevision] = useState(0);
  const [checked, setChecked] = useState<{client:ReturnType<typeof getMatrixClient>;account:object;device:string|null;value:'verified'|'unverified'|'unknown'}|null>(null);
  const client = getMatrixClient(), room = client?.getRoom(roomId), account = accountArtworkOwner();
  const crypto = client?.getCrypto(), encrypted = !preview && room ? room.hasEncryptionStateEvent() : null;
  const device = client?.getDeviceId() || null;
  const verification = checked?.client===client&&checked?.account===account&&checked?.device===device ? checked.value : 'unknown';
  useEffect(() => onMatrixUpdate(() => setRevision(value => value + 1)), []);
  useEffect(() => subscribeSecurity(() => setRevision(value => value + 1)), []);
  useEffect(() => {
    let active = true;
    if (!preview && crypto && client?.getUserId() && client.getDeviceId()) {
      void crypto.getDeviceVerificationStatus(client.getUserId()!, client.getDeviceId()!).then(status => {
        if (active && getMatrixClient() === client && accountArtworkOwner() === account && client.getDeviceId()===device)
          setChecked({client,account,device,value:status ? status.isVerified() ? 'verified' : 'unverified' : 'unknown'});
      }).catch(() => { /* Unknown is meaningful; do not claim verified. */ });
    }
    return () => { active = false; };
  }, [client, crypto, account, device, preview, revision]);
  const label = encrypted === null ? 'Security unavailable' : !encrypted ? 'Not encrypted' : !crypto ? 'Encryption unavailable' : verification === 'verified' ? 'Encrypted' : 'Encrypted · check device';
  const Icon = encrypted && crypto && verification === 'verified' ? ShieldCheck : encrypted === null ? LockKeyhole : ShieldAlert;
  return <Popover><PopoverTrigger asChild><button type='button' className='room-security-button' aria-label={'Room security: ' + label} data-warning={encrypted !== null && (!encrypted || !crypto || verification !== 'verified') || undefined}><Icon size={16} aria-hidden='true'/><span>{label}</span></button></PopoverTrigger>
    <PopoverContent align='end' className='room-security-popover' aria-label='Room security details'>
      <h2>Room security</h2>
      <p>{encrypted === null ? 'Connect to this room to check its encryption state.' : encrypted ? 'This room has Matrix end-to-end encryption enabled.' : 'This room is not end-to-end encrypted. Its messages can be read by the homeserver.'}</p>
      <dl><dt>This device</dt><dd>{preview ? 'Not connected' : !crypto ? 'Encryption is not available on this device' : verification === 'verified' ? 'Verified by Matrix' : verification === 'unverified' ? 'Verification incomplete' : 'Verification status unavailable'}</dd></dl>
      <p>Room encryption and device verification are separate. Encryption does not confirm every participant’s identity or device trust. Room names, membership and other metadata remain visible to the homeserver.</p>
      <button type='button' className='secondary-button' onClick={onSettings}>Privacy &amp; device settings</button>
    </PopoverContent></Popover>;
}
