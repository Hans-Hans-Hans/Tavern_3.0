"""Read an explicitly configured secret without printing its content."""
import os
from pathlib import Path

def smtp_password_file():
    name = os.environ.get('SMTP_PASSWORD_FILE', '')
    if not name:
        return None
    try:
        with Path(name).open('rb') as stream:
            raw = stream.read(65537)
        if len(raw) > 65536:
            raise ValueError('too large')
        value = raw.decode('utf-8')
    except (OSError, UnicodeError, ValueError):
        raise ValueError('SMTP_PASSWORD_FILE must name a readable UTF-8 secret file no larger than 64 KiB.') from None
    if value.endswith('\r\n'):
        return value[:-2]
    return value[:-1] if value.endswith('\n') else value
