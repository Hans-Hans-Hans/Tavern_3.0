"""Retry explicitly configured room joins using the existing durable bot session."""
import asyncio
from nio import ErrorResponse
from server import Bridge

async def main():
    bridge=Bridge()
    try:
        if isinstance(await bridge.client.whoami(),ErrorResponse):raise RuntimeError('Bot session is unavailable; preserve its crypto store')
        for room in sorted({hook['room_id'] for hook in bridge.hooks.values()}):
            if isinstance(await bridge.client.join(room),ErrorResponse):raise RuntimeError('Join failed. Confirm the bot was invited to every configured room.')
        await asyncio.wait_for(bridge.client.sync(timeout=0,full_state=True),60)
        print('Configured room joins completed using the existing identity.')
    finally:
        await bridge.client.close();bridge.db.close();bridge.lock.close()

if __name__=='__main__':asyncio.run(main())
