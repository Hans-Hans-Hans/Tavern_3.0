"""Account-scoped, revocable discovery codes. Codes never grant access."""
import re
import secrets
import sqlite3
import time

ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'


def normalize_code(value):
    if not isinstance(value, str) or len(value) > 80:
        return None
    value = re.sub(r'[\s-]', '', value).upper()
    if len(value) == 15 and value.startswith('TAV'):
        value = value[3:]
    value = value.translate(str.maketrans({'O': '0', 'I': '1', 'L': '1'}))
    return value if len(value) == 12 and all(char in ALPHABET for char in value) else None


def display_code(value):
    return 'TAV-' + '-'.join(value[index:index + 4] for index in range(0, 12, 4))


def ensure_schema(db):
    db.execute('CREATE TABLE IF NOT EXISTS social_friend_codes(user_id TEXT PRIMARY KEY,code TEXT UNIQUE NOT NULL,updated REAL NOT NULL)')


def own_code(db, user):
    row = db.execute('SELECT code FROM social_friend_codes WHERE user_id=?', (user,)).fetchone()
    if row:
        return display_code(row[0])
    for _ in range(5):
        candidate = ''.join(secrets.choice(ALPHABET) for _ in range(12))
        try:
            db.execute('INSERT INTO social_friend_codes VALUES(?,?,?) ON CONFLICT(user_id) DO NOTHING', (user, candidate, time.time()))
        except sqlite3.IntegrityError:
            continue
        return display_code(db.execute('SELECT code FROM social_friend_codes WHERE user_id=?', (user,)).fetchone()[0])
    raise RuntimeError('A friend code could not be created. Try again shortly.')


def rotate_code(db, user, previous):
    previous = normalize_code(previous)
    if not previous or not db.execute('SELECT 1 FROM social_friend_codes WHERE user_id=? AND code=?', (user, previous)).fetchone():
        return None
    for _ in range(5):
        candidate = ''.join(secrets.choice(ALPHABET) for _ in range(12))
        if candidate == previous:
            continue
        try:
            changed = db.execute('UPDATE social_friend_codes SET code=?,updated=? WHERE user_id=? AND code=?', (candidate, time.time(), user, previous))
        except sqlite3.IntegrityError:
            continue
        return display_code(candidate) if changed.rowcount else None
    raise RuntimeError('A new friend code could not be created. Try again shortly.')


def resolve_code(db, code):
    row = db.execute('SELECT user_id FROM social_friend_codes WHERE code=?', (code,)).fetchone()
    return row[0] if row else None
