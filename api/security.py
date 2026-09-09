"""Small, independently testable authentication primitives. No Matrix crypto lives here."""
from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import re
import secrets
import struct
import time
from urllib.parse import quote

DEFAULT_SECURITY = {'minimumPasswordLength': 12, 'sessionHours': 12, 'persistentDays': 30, 'loginPerIpPerMinute': 12, 'loginPerAccountPerFiveMinutes': 10, 'mfaRequirement': 'off'}


def password_error(password: object, confirmation: object | None = None) -> str | None:
    if not isinstance(password, str) or len(password) < 12:
        return "Use a password with at least 12 characters."
    if len(password) > 1024:
        return "Use a password with at most 1024 characters."
    if confirmation is not None and password != confirmation:
        return "The passwords do not match."
    if password.casefold() in {"adminadminadmin", "passwordpassword", "123456789012", "abcdefghijkl"}:
        return "Choose a less predictable password."
    return None


def email_address(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("Enter a valid email address.")
    value = value.strip().casefold()
    if len(value) > 254 or not re.fullmatch(r"[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+", value):
        raise ValueError("Enter a valid email address.")
    return value


def totp(secret: str, counter: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 15
    return str((struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7fffffff) % 1000000).zfill(6)


def verify_totp(secret: str, code: object, last_counter: int = -1, now: float | None = None) -> int | None:
    if not isinstance(code, str) or not re.fullmatch(r"\d{6}", code):
        return None
    current = int((time.time() if now is None else now) // 30)
    for counter in (current, current - 1, current + 1):
        if counter > last_counter and counter >= 0 and hmac.compare_digest(totp(secret, counter), code):
            return counter
    return None


def totp_setup(user: str, issuer: str = "Tavern") -> tuple[str, str]:
    secret = base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")
    return secret, f"otpauth://totp/{quote(issuer + ':' + user, safe='')}?secret={secret}&issuer={quote(issuer, safe='')}&algorithm=SHA1&digits=6&period=30"


def network_list(value: str) -> list:
    return [ipaddress.ip_network(x.strip(), strict=False) for x in value.split(",") if x.strip()]


def client_address(peer: str | None, forwarded: str | None, trusted: list) -> str:
    """Strip trusted proxies right-to-left. Never use an untrusted sender's XFF."""
    try:
        current = ipaddress.ip_address(peer or "")
    except ValueError:
        raise ValueError("The client network address is unavailable.") from None
    if not forwarded:
        return str(current)
    if not any(current in network for network in trusted):
        raise ValueError("Configure the trusted proxy networks before using forwarded client addresses.")
    chain = forwarded.split(",")
    if len(chain) > 16:
        raise ValueError("Invalid proxy chain.")
    for item in reversed(chain):
        if not any(current in network for network in trusted):
            break
        try:
            current = ipaddress.ip_address(item.strip())
        except ValueError:
            raise ValueError("Invalid proxy chain.") from None
    return str(current)


def uia_password_challenge(error: dict) -> bool:
    """Do not turn a multi-factor challenge into a password-only flow."""
    return isinstance(error.get("session"), str) and any(
        flow.get("stages") == ["m.login.password"]
        for flow in error.get("flows", []) if isinstance(flow, dict)
    )
