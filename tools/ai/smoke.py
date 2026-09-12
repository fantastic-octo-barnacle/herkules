"""Exercise the isolated local stack. Never accepts a production URL or prints keys."""
import concurrent.futures
import html
import http.cookiejar
import json
import pathlib
import re
import time
import urllib.error
import urllib.parse as parse
import urllib.request as request

portal = 'http://localhost:4010'
private = 'http://localhost:4014'
opener = request.build_opener(request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def api(path, data=None, token=None, method=None):
    headers = {'Content-Type': 'application/json', 'Origin': portal}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    response = opener.open(request.Request(path, data=json.dumps(data).encode() if data is not None else None,
        headers=headers, method=method), timeout=20)
    value = json.load(response)
    if value.get('success') is False:
        raise RuntimeError('Management request failed: ' + parse.urlsplit(path).path)
    return value.get('data', value)

state = api(portal + '/api/oauth/state', {'provider': 'herkules', 'intent': 'login'})['flow_token']
query = parse.urlencode(dict(client_id='herkules-ai', redirect_uri=portal+'/oauth/herkules',
    response_type='code', scope='openid email profile', state=state))
page = opener.open('http://localhost:4012/auth/oauth2/authorize?' + query).read().decode()
continuation = html.unescape(re.search('name="oauth_query" value="([^"]*)"', page)[1])
response = opener.open(request.Request('http://localhost:4012/dev/login',
    data=parse.urlencode(dict(user='alice', oauth_query=continuation)).encode()))
result = api(portal + '/api/oauth/herkules?' + parse.urlsplit(response.url).query)
token, user_id = result['access_token'], result['user']['id']
root = api(private+'/api/user/login', {'username':'herkulesroot',
    'password':(pathlib.Path.home()/'.config/herkules/ai/dev/root-password').read_text().strip()})['access_token']
def quota(value):
    api(private+'/api/user/manage', {'id':user_id,'action':'add_quota','value':value,'mode':'override'},root)
quota(100000)
name = 'local-smoke-' + str(time.time_ns())
api(portal+'/api/token/', {'name':name,'remain_quota':50000,'expired_time':-1,'group':'default'},token)
keys = api(portal+'/api/token/?p=1&page_size=100',token=token)['items']
key_id = next(k['id'] for k in keys if k['name']==name)
key = api(portal+f'/api/token/{key_id}/key',{},token)['key']
key = key if key.startswith('sk-') else 'sk-'+key

def generate():
    req = request.Request('http://127.0.0.1:4010/v1/chat/completions',
        data=json.dumps({'model':'qwen3.8-27b','messages':[{'role':'user','content':'Hello'}],
            'stream':True,'max_tokens':32}).encode(),
        headers={'Content-Type':'application/json','Authorization':'Bearer '+key})
    try:
        with request.urlopen(req,timeout=20) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()

try:
    before = api(portal+'/api/user/self',token=token)['used_quota']
    start = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _:generate(),range(2)))
    assert all(status==200 and '[DONE]' in body for status,body in results), 'stream failed'
    assert time.monotonic()-start >= 2.8, 'same-user generations overlapped'
    after = api(portal+'/api/user/self',token=token)['used_quota']
    assert after-before==50, 'unexpected quota charge'
    quota(0)
    assert generate()[0] >= 400, 'exhausted quota was accepted'
    quota(100000)
    api('http://localhost:4012/dev/disable/alice',{})
    assert generate()[0]==403, 'disabled identity retained inference access'
    print('PASS: OIDC, API keys, serialized streaming, quota accounting, exhaustion and issuer revocation')
finally:
    # Restore the fixture so the portal remains usable after running this test.
    api('http://localhost:4012/dev/enable/alice',{})
    api(private+'/api/user/manage',{'id':user_id,'action':'enable'},root)
