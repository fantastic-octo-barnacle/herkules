import subprocess,json,time,urllib.request,pathlib,concurrent.futures
ROOT=pathlib.Path('/home/herkules/model-tests'); BIN='/home/herkules/llama.cpp-unsloth/build/bin/llama-server'; MODELS=pathlib.Path('/home/herkules/models')
models=[('ling-3.0-tiny','Ling-3.0-tiny-Q6_K.gguf',2),('gemma-4-12b','gemma-4-12b-it-qat-q4_0.gguf',2),('granite-4.2-8b','granite-4.2-8b-Q6_K.gguf',1),('mellum2-12b','Mellum2-12B-A2.5B-Instruct-Q8_0.gguf',2),('nanbeige4.2-3b','Nanbeige_Nanbeige4.2-3B-Q8_0.gguf',1),('qwen3.6-35b-a3b','Qwen3.6-35B-A3B-UD-IQ4_XS.gguf',2)]
def call(path,body=None):
 r=urllib.request.Request('http://127.0.0.1:8090'+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'})
 return json.load(urllib.request.urlopen(r,timeout=240))
if subprocess.run(['systemctl', 'is-active', '--quiet', 'llama-server']).returncode == 0:
 raise SystemExit('Drain and stop llama-server before running GPU probes')
ROOT.mkdir(parents=True, exist_ok=True)
results=[]
for name,file,np in models:
 path=MODELS/file
 if not path.exists():
  results.append({'model':name,'error':'download pending'});continue
 for ctx in [131072,65536]:
  log=open(ROOT/(name+'-'+str(ctx)+'.log'),'w')
  args=[BIN,'-m',str(path),'--host','127.0.0.1','--port','8090','--alias',name,'-ngl','99','-c',str(ctx*np),'-np',str(np),'-ctk','q8_0','-ctv','q8_0','-fa','on','--jinja','--fit','off','--cache-ram','0','--slots']
  p=subprocess.Popen(args,stdout=log,stderr=log)
  result={'model':name,'context':ctx,'slots':np}
  try:
   for _ in range(180):
    if p.poll() is not None: raise RuntimeError('load failed')
    try:
     call('/health');break
    except Exception: time.sleep(1)
   else: raise RuntimeError('load timeout')
   result['vram_by_gpu_mib']=[int(value) for value in subprocess.check_output(['nvidia-smi','--query-gpu=memory.used','--format=csv,noheader,nounits']).decode().splitlines()]
   result['vram_mib']=sum(result['vram_by_gpu_mib'])
   def generate(_=0):
    data=call('/completion',{'prompt':'Write a Python function that merges two sorted lists.\n','n_predict':128,'ignore_eos':True,'temperature':0,'cache_prompt':False})
    return data.get('timings',{})
   result['single']=generate()
   start=time.monotonic()
   with concurrent.futures.ThreadPoolExecutor(max_workers=np) as pool: result['concurrent']=list(pool.map(generate,range(np)))
   result['aggregate_tps']=128*np/(time.monotonic()-start)
   tool=call('/v1/chat/completions',{'model':name,'messages':[{'role':'user','content':'Call get_weather for Hong Kong. Do not answer without calling the tool.'}],'tools':[{'type':'function','function':{'name':'get_weather','description':'Get weather for a city','parameters':{'type':'object','properties':{'city':{'type':'string'}},'required':['city']}}}],'tool_choice':'required','max_tokens':2048,'temperature':0,'chat_template_kwargs':{'enable_thinking':False}})
   msg=tool['choices'][0]['message'];result['tool_calls']=msg.get('tool_calls');result['finish_reason']=tool['choices'][0]['finish_reason']
   result['passed']=bool(result['tool_calls'])
   results.append(result);print(json.dumps(result),flush=True);break
  except Exception as e:
   result['error']=str(e);print(json.dumps(result),flush=True)
   if ctx==65536: results.append(result)
  finally:
   p.terminate()
   try:p.wait(timeout=20)
   except subprocess.TimeoutExpired:p.kill();p.wait()
   log.close();time.sleep(2)
 (ROOT/'results.json').write_text(json.dumps(results,indent=2))
(ROOT/'results.json').write_text(json.dumps(results,indent=2))
