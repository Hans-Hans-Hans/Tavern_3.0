"""Run once inside the bot container to create a durable encryption identity."""
import asyncio
import getpass
import json
import os
from pathlib import Path
from nio import AsyncClient, AsyncClientConfig, ErrorResponse
from nio.store import SqliteStore

async def main():
    os.umask(0o077);data=Path('/data');config=Path('/config')
    if (data/'identity.json').exists() or (data/'crypto/crypto.db').exists() or (config/'session.json').exists():raise RuntimeError('Refusing to replace an existing bot identity')
    settings=json.loads((config/'bot.json').read_text());user=input('Dedicated bot Matrix ID: ').strip()
    (data/'crypto').mkdir(parents=True,exist_ok=True)
    client=AsyncClient(settings['homeserver'],user=user,store_path=str(data/'crypto'),config=AsyncClientConfig(store=SqliteStore,store_name='crypto.db',store_sync_tokens=True,encryption_enabled=True,pickle_key=(config/'pickle.key').read_text().strip()))
    try:
        result=await client.login(getpass.getpass('Bot password: '),device_name='Tavern integrations')
        if isinstance(result,ErrorResponse):raise RuntimeError('Bot sign-in failed')
        (config/'session.json').write_text(json.dumps({'user_id':client.user_id,'device_id':client.device_id,'access_token':client.access_token}))
        (data/'identity.json').write_text(json.dumps({'user_id':client.user_id,'device_id':client.device_id,'ed25519':client.olm.account.identity_keys['ed25519']}))
        await client.sync(timeout=0,full_state=True)
        if isinstance(await client.keys_upload(),ErrorResponse):raise RuntimeError('Key upload failed; keep this identity and restart the service to retry')
        for hook in settings['hooks'].values():
            if isinstance(await client.join(hook['room_id']),ErrorResponse):raise RuntimeError('Invite the bot to the configured room before provisioning')
        print('Bot identity saved. Public fingerprint:',client.olm.account.identity_keys['ed25519'])
    finally:await client.close()

if __name__=='__main__':asyncio.run(main())
