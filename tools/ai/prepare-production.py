"""Provision AI files and its dedicated database on the VPS, never print secrets.
Run with sudo, pass the existing deployment directory. Does not deploy services.
Use --metadata after starting New API and before starting the gateway.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('deployment', type=Path)
parser.add_argument('--metadata', action='store_true')
args = parser.parse_args()
if os.geteuid() != 0:
    raise SystemExit('Run with sudo; credentials live under /etc/herkules-ai.')
os.umask(0o077)
root = args.deployment.resolve()
auth_env = root/'.env.auth'
auth_stat = auth_env.stat()
config = Path('/etc/herkules-ai')
gateway = config/'gateway'
config.mkdir(mode=0o700, exist_ok=True)
gateway.mkdir(mode=0o700, exist_ok=True)
config.chmod(0o700)
os.chown(config, 0, 0)
gateway.chmod(0o700)
os.chown(gateway, 1000, 1000)

def write(path, text, uid=0):
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    os.chown(path,uid,uid)
    path.write_text(text)
    path.chmod(0o400 if uid else 0o600)

def secret(name, uid=1000):
    path = gateway/name if uid else config/name
    if path.exists():
        value = path.read_text().strip()
        if len(value)<32 or any(c.isspace() for c in value):
            raise SystemExit('Invalid existing credential file: '+str(path))
        path.chmod(0o400 if uid else 0o600)
        os.chown(path, uid, uid)
        return value
    value = secrets.token_hex(32)
    write(path,value+'\n',uid)
    return value

def sql(database, statement):
    result = subprocess.run(['sh',str(root/'compose.sh'),'exec','-T','postgres',
        'psql','-v','ON_ERROR_STOP=1','-U','herkules','-d',database],
        input=statement,text=True,capture_output=True,cwd=root)
    if result.returncode:
        # SQL errors can include query text and passwords. Do not print stderr.
        raise SystemExit('AI database provisioning failed. Review the database state privately.')

view = """CREATE OR REPLACE VIEW herkules_token_identity AS
SELECT encode(sha256(convert_to(key,'UTF8')),'hex') AS key_hash,user_id
FROM tokens WHERE deleted_at IS NULL;
REVOKE ALL ON herkules_token_identity FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ai_metadata;
GRANT SELECT ON herkules_token_identity TO ai_metadata;
"""
if args.metadata:
    sql('herkules_ai',view)
    print('Restricted metadata view is ready.')
    raise SystemExit(0)

db = secret('db-password',0)
metadata = secret('metadata-password',0)
# Our generated hexadecimal secrets are safe SQL literals; reject unexpected existing values.
if not all(c in '0123456789abcdef' for c in db+metadata):
    raise SystemExit('Provisioning passwords must be generated hexadecimal values.')
for role,password in [('herkules_ai',db),('ai_metadata',metadata)]:
    sql('herkules',f"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='{role}') THEN CREATE ROLE {role} LOGIN; END IF; END $$; ALTER ROLE {role} PASSWORD '{password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;")
sql('herkules',"SELECT 'CREATE DATABASE herkules_ai OWNER herkules_ai' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='herkules_ai')\\gexec\n")
sql('herkules',"REVOKE CONNECT ON DATABASE herkules_ai FROM PUBLIC; GRANT CONNECT ON DATABASE herkules_ai TO herkules_ai,ai_metadata;")
client = secret('client-secret')
sync = secret('sync-secret')
secret('root-password')
secret('dispatch-key')
write(root/'.env.ai',f'SQL_DSN=postgres://herkules_ai:{db}@postgres:5432/herkules_ai\nSESSION_SECRET={secret("session-secret",0)}\n')
write(root/'.env.ai-gateway',f'AI_METADATA_DATABASE_URL=postgres://ai_metadata:{metadata}@postgres:5432/herkules_ai\n')
# Compose reads env files as the deployment operator, before contacting Docker.
for name in ['.env.ai', '.env.ai-gateway']:
    os.chown(root/name, auth_stat.st_uid, auth_stat.st_gid)
# Keep auth settings in its existing host-owned env file, preserving unrelated settings.
lines = auth_env.read_text().splitlines()
values = {'AI_PORTAL_ORIGIN':'https://ai-portal.herkules.dev','AI_CLIENT_SECRET':client,'AI_SYNC_SECRET':sync}
lines = [line for line in lines if line.split('=',1)[0] not in values]
write(auth_env,'\n'.join(lines+[f'{k}={v}' for k,v in values.items()])+'\n')
os.chown(auth_env, auth_stat.st_uid, auth_stat.st_gid)
if not (gateway/'workers.json').exists():
    write(gateway/'workers.json',json.dumps([{'id':'gpu-4090','model':'qwen3.8-27b',
        'url':'https://gpu-4090.herkules.dev','keyFile':'/run/ai/adapter-key',
        'accessIdFile':'/run/ai/cf-access-client-id','accessSecretFile':'/run/ai/cf-access-client-secret'}],indent=2)+'\n',1000)
print('AI database and credentials prepared. Worker/Access files still need staging; see tools/ai/README.md.')
