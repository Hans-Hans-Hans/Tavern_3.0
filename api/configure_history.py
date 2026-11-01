"""Explicit, local operator action; never deletes message keys or backups.

Inside the API container:
  python /app/configure_history.py --user hans --prompt-passphrase
Add --disable-email to disable outgoing email for the entire instance.
"""
import argparse
import os
from pathlib import Path
import time

try:
    from .server import Store
except ImportError:
    from server import Store


def configure(store, name, disable_email=False):
    users = [row[0] for row in store.db.execute('SELECT user_id FROM accounts')
             if row[0] == name or (not name.startswith('@') and row[0].split(':', 1)[0] == '@' + name)]
    if len(users) != 1:
        raise ValueError('Expected exactly one existing managed account. Use its full Matrix ID.')
    user = users[0]
    store.db.execute('BEGIN IMMEDIATE')
    try:
        store.set('history-preferences:' + user,
                  {'mode': 'off', 'setupRequired': True, 'promptAfter': time.time()})
        store.db.execute("DELETE FROM challenges WHERE user_id=? AND kind='history-recovery'", (user,))
        if disable_email:
            smtp = store.get('smtp', {})
            store.set('smtp', {**smtp, 'enabled': False})
        store.db.execute('INSERT INTO audit(created,actor,action,target,detail) VALUES(?,?,?,?,?)',
                         (time.time(), 'local-operator', 'history_setup_requested', user, 'next-login-passphrase'))
        store.db.execute('COMMIT')
    except Exception:
        store.db.execute('ROLLBACK')
        raise
    return user


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--user', required=True)
    parser.add_argument('--prompt-passphrase', required=True, action='store_true')
    parser.add_argument('--disable-email', action='store_true')
    args = parser.parse_args()
    folder = Path(os.environ.get('API_DATA_DIR', '/data'))
    if not (folder / 'tavern.sqlite3').is_file() or not (folder / 'secrets.key').is_file():
        parser.error('Run inside the existing API container with its account data mounted.')
    store = Store(folder)
    try:
        user = configure(store, args.user, args.disable_email)
        print('History recovery disabled; passphrase setup will be offered at the next login for ' + user)
        if args.disable_email:
            print('Outgoing email disabled for this instance. Existing MFA requirements are unchanged.')
    finally:
        store.db.close()


if __name__ == '__main__':
    main()
