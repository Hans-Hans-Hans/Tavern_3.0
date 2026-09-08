#!/usr/bin/env python3
"""Prepare a private Synapse deployment without placing secrets in source control."""
import argparse, json, os, re, secrets
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--server-name',required=True,help='Matrix DNS name; immutable after accounts exist')
p.add_argument('--web-domain',required=True,help='Tavern DNS name')
p.add_argument('--synapse-image',required=True,help='Pinned matrixdotorg/synapse:vVERSION or digest')
a=p.parse_args()
for domain in [a.server_name,a.web_domain]:
 if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?',domain) or '.' not in domain:
  p.error('Use a plain lowercase DNS hostname without a scheme, port, or path.')
if a.server_name==a.web_domain:p.error('Use separate Matrix and Tavern hostnames.')
if not re.fullmatch(r'matrixdotorg/synapse:(?:v\d+\.\d+\.\d+)|matrixdotorg/synapse@sha256:[a-f0-9]{64}',a.synapse_image):
 p.error('Pin an official Synapse release tag (vX.Y.Z) or sha256 digest.')
root=Path(__file__).resolve().parent
if (root/'.env').exists() or (root/'synapse').exists():p.error('Configuration already exists. Refusing to overwrite secrets or server identity.')
os.umask(0o077)
pg=secrets.token_urlsafe(36);register=secrets.token_urlsafe(36);macaroon=secrets.token_urlsafe(36);form=secrets.token_urlsafe(36)
(root/'synapse').mkdir(mode=0o700)
(root/'.env').write_text(f'TAVERN_DOMAIN={a.web_domain}\nMATRIX_DOMAIN={a.server_name}\nSYNAPSE_IMAGE={a.synapse_image}\nPOSTGRES_PASSWORD={pg}\n')
# JSON is valid YAML, avoiding any template escaping hazards.
config={'server_name':a.server_name,'public_baseurl':f'https://{a.server_name}/','pid_file':'/data/homeserver.pid','listeners':[{'port':8008,'tls':False,'type':'http','x_forwarded':True,'bind_addresses':['0.0.0.0'],'resources':[{'names':['client'],'compress':False}]}], 'database':{'name':'psycopg2','args':{'user':'synapse','password':pg,'database':'synapse','host':'postgres','port':5432,'cp_min':5,'cp_max':10}},'media_store_path':'/data/media_store','signing_key_path':'/data/server.signing.key','registration_shared_secret':register,'macaroon_secret_key':macaroon,'form_secret':form,'enable_registration':False,'allow_guest_access':False,'enable_3pid_lookup':False,'url_preview_enabled':False,'report_stats':False,'federation_domain_whitelist':[],'trusted_key_servers':[],'allow_public_rooms_without_auth':False,'allow_public_rooms_over_federation':False,'max_upload_size':'10M','log_config':'/data/log.config','suppress_key_server_warning':True}
(root/'synapse'/'homeserver.yaml').write_text(json.dumps(config,indent=2)+'\n')
(root/'synapse'/'log.config').write_text(json.dumps({'version':1,'formatters':{'brief':{'format':'%(asctime)s %(levelname)s %(name)s: %(message)s'}},'handlers':{'console':{'class':'logging.StreamHandler','formatter':'brief'}},'root':{'level':'WARNING','handlers':['console']},'disable_existing_loggers':False},indent=2)+'\n')
print('Before startup, give Synapse access: sudo chown -R 991:991 synapse')
print('Configuration created. Keep .env and synapse/ private. Run docker compose up -d --build.')
