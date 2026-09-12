"""Provision local admin/member previews through real OAuth and management APIs."""
import http.cookiejar
import json
from pathlib import Path
import urllib.request as request
import urllib.parse as parse
import urllib.error

portal='http://localhost:4010'
private='http://localhost:4014'

def api(opener,url,data=None,token=None):
    headers={'Content-Type':'application/json','Origin':portal}
    if token:headers['Authorization']='Bearer '+token
    with opener.open(request.Request(url,data=json.dumps(data).encode() if data is not None else None,headers=headers),timeout=20) as response:
        value=json.load(response)
    if value.get('success') is not True:raise RuntimeError('Local management request failed: '+parse.urlsplit(url).path)
    return value.get('data')

def login(name):
    op=request.build_opener(request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    response=op.open('http://localhost:4012/preview/'+name)
    result=api(op,portal+'/api/oauth/herkules?'+parse.urlsplit(response.url).query)
    return op,result

root_op=request.build_opener()
root=api(root_op,private+'/api/user/login',{'username':'herkulesroot','password':(Path.home()/'.config/herkules/ai/dev/root-password').read_text().strip()})['access_token']
for name,role in [('alice',10),('bob',1)]:
    op,result=login(name)
    user=result['user']; uid=user['id']
    if user['role']!=role:
        api(root_op,private+'/api/user/manage',{'id':uid,'action':'promote' if role==10 else 'demote'},root)
    api(root_op,private+'/api/user/manage',{'id':uid,'action':'add_quota','mode':'override','value':100000},root)
    op,result=login(name)
    assert result['user']['role']==role
    token=result['access_token']
    # Confirm the actual authorization boundary, not just a hidden sidebar.
    try:
        api(op,portal+'/api/user/?p=1&page_size=100',token=token)
        assert role==10, 'Member accessed administrator API'
    except urllib.error.HTTPError as error:
        assert role==1 and error.code==403, f'Unexpected admin access response: {error.code}'
    with op.open(request.Request(portal+'/pg/chat/completions', data=json.dumps({'model':'qwen3.8-27b','messages':[{'role':'user','content':'Hello from the preview'}],'stream':True,'max_tokens':32}).encode(), headers={'Content-Type':'application/json','Authorization':'Bearer '+token}),timeout=20) as stream:
        assert stream.status==200 and '[DONE]' in stream.read().decode(), 'Playground stream failed'
    print(f'{name}: {"administrator" if role==10 else "member"}, 100,000 test quota; authorization verified')
print('Admin: http://localhost:4012/preview/alice')
print('Member: http://localhost:4012/preview/bob')
