#!/usr/bin/env python3
import argparse
import hashlib
import hmac
import json
from pathlib import Path
import time
from urllib.parse import urlparse
from urllib.request import Request,urlopen
import uuid
parser=argparse.ArgumentParser(description='Send one signed Tavern integration message')
parser.add_argument('--url',required=True);parser.add_argument('--hook',default='builds');parser.add_argument('--secret-file',required=True);parser.add_argument('--text',required=True);parser.add_argument('--delivery-id',default=None)
args=parser.parse_args();url=urlparse(args.url)
if url.scheme!='https' or url.username or url.password or url.query or url.fragment:parser.error('Use a trusted HTTPS Tavern origin without credentials or query parameters')
timestamp=str(int(time.time()));delivery=args.delivery_id or str(uuid.uuid4());body=json.dumps({'text':args.text},separators=(',',':')).encode()
signature='sha256='+hmac.new(Path(args.secret_file).read_bytes().strip(),b'v1\n'+args.hook.encode()+b'\n'+timestamp.encode()+b'\n'+delivery.encode()+b'\n'+body,hashlib.sha256).hexdigest()
request=Request(args.url.rstrip('/')+'/hooks/'+args.hook,data=body,method='POST',headers={'Content-Type':'application/json','X-Tavern-Timestamp':timestamp,'X-Tavern-Delivery':delivery,'X-Tavern-Signature':signature})
with urlopen(request,timeout=30) as response: print(response.status,response.read().decode())
