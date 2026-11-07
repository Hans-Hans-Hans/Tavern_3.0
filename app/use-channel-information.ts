import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { accountArtworkOwner } from '@/lib/api';
import { getMatrixClient, onMatrixUpdate } from '@/lib/matrix';
import { appearanceOwner, isAppearanceOwner, readAppearance, saveAppearance } from '@/lib/appearance';

/** Reuse the saved appearance preference. Render a successful write immediately
 * even if the SDK's AccountData sync arrives after the write acknowledgement. */
export function useChannelInformation(): [boolean, (open: boolean) => void] {
  const client = getMatrixClient(), account = accountArtworkOwner();
  const [snapshot, setSnapshot] = useState(() => ({ client, account, open: readAppearance().memberList }));
  useEffect(() => {
    const refresh = () => setSnapshot({ client: getMatrixClient(), account: accountArtworkOwner(), open: readAppearance().memberList });
    refresh(); return onMatrixUpdate(refresh);
  }, [client, account]);
  const open = snapshot.client === client && snapshot.account === account ? snapshot.open : readAppearance().memberList;
  const change = (value: boolean) => {
    const owner = appearanceOwner();
    void saveAppearance({ memberList: value }).then(saved => {
      if (isAppearanceOwner(owner)) setSnapshot({ client, account, open: saved.memberList });
    }).catch(error => { if (isAppearanceOwner(owner)) toast.error(error.message); });
  };
  return [open, change];
}
