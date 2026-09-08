"""Bounded signed webhook protocol, independent of Matrix and HTTP frameworks."""
import hashlib
import hmac
import json
import re
import time
import uuid

def authenticate(hook, timestamp, delivery, signature, body, secret, now=None):
    if not re.fullmatch(r'[a-z0-9_-]{1,64}',hook): raise ValueError('Invalid hook')
    if len(body)>16384 or not re.fullmatch(r'[0-9]{1,12}',timestamp): raise ValueError('Invalid request')
    if abs((time.time() if now is None else now)-int(timestamp))>300: raise ValueError('Expired request')
    if str(uuid.UUID(delivery))!=delivery: raise ValueError('Invalid delivery')
    signed=b'v1\n'+hook.encode()+b'\n'+timestamp.encode()+b'\n'+delivery.encode()+b'\n'+body
    expected='sha256='+hmac.new(secret,signed,hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected,signature): raise ValueError('Invalid signature')
    value=json.loads(body)
    if not isinstance(value,dict) or set(value)!={'text'} or not isinstance(value['text'],str) or not value['text'].strip() or len(value['text'])>12000: raise ValueError('Expected a nonempty text message up to 12000 characters')
    return value['text']

def transaction(hook,delivery):
    return 'tavern-'+hashlib.sha256((hook+'\n'+delivery).encode()).hexdigest()
