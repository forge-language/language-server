const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
async function client(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'forge-async-test-')),log=path.join(dir,'calls');
 const makeCompiler=tag=>{const file=path.join(dir,'compiler-'+tag);fs.writeFileSync(file,`#!/usr/bin/env node
const fs=require('node:fs'),file=process.argv[2],text=fs.readFileSync(file,'utf8'),symbols=process.argv.includes('--symbols-json');
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,file,text,symbols,tag:${JSON.stringify(tag)}})+'\\n');
const slow=${JSON.stringify(tag)}==='old' && (symbols?text.includes('SLOW_SYMBOLS'):text.includes('SLOW_CHECK'));
setTimeout(()=>{if(symbols){const name=(text.match(/fn\\s+(\\w+)/)||[])[1]||'hello';process.stdout.write(JSON.stringify([{kind:'function',name}]))}else{process.stderr.write('forge: semantic: '+${JSON.stringify(tag)}+' '+text+'\\n');process.exitCode=1}},slow?1500:20);
`);fs.chmodSync(file,0o755);return file};
 const compiler=makeCompiler('old'),replacement=makeCompiler('new');
 const server=spawn(process.execPath,['out/server.js','--stdio']);let buffer=Buffer.alloc(0),nextId=0;const pending=new Map(),notifications=[];
 server.stdout.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const split=buffer.indexOf('\r\n\r\n');if(split<0)break;const length=Number(buffer.subarray(0,split).toString().match(/Content-Length: (\d+)/i)[1]);if(buffer.length<split+4+length)break;const message=JSON.parse(buffer.subarray(split+4,split+4+length));buffer=buffer.subarray(split+4+length);if(message.id!==undefined){pending.get(message.id)?.(message);pending.delete(message.id)}else notifications.push(message)}});
 function notify(method,params,id){const body=JSON.stringify({jsonrpc:'2.0',...(id===undefined?{}:{id}),method,params});server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)}
 function request(method,params,timeout=3500){const id=++nextId;const promise=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('timeout '+method))},timeout);pending.set(id,m=>{clearTimeout(timer);resolve(m)})});notify(method,params,id);return{id,promise}}
 const call=async(method,params,timeout)=>(await request(method,params,timeout).promise).result;
 const records=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
 async function wait(predicate,timeout=2500){const start=Date.now();while(Date.now()-start<timeout){const value=predicate();if(value)return value;await new Promise(r=>setTimeout(r,10))}throw new Error('condition timed out')}
 t.after(async()=>{try{if(server.exitCode===null){await call('shutdown',null);notify('exit');await new Promise(resolve=>server.once('exit',resolve))}}finally{server.kill();for(const row of records()){try{if(fs.readFileSync('/proc/'+row.pid+'/cmdline').includes(dir))process.kill(row.pid,'SIGKILL')}catch{}}fs.rmSync(dir,{recursive:true,force:true})}});
 await call('initialize',{capabilities:{},initializationOptions:{forge:{path:compiler}}});notify('initialized',{});
 return{notify,request,call,wait,records,notifications,replacement,server};
}
const uri='file:///tmp/project/async.fg';
const open=(c,text,version=1)=>c.notify('textDocument/didOpen',{textDocument:{uri,languageId:'forge',version,text}});
const change=(c,text,version)=>c.notify('textDocument/didChange',{textDocument:{uri,version},contentChanges:[{text}]});
const hover=c=>c.call('textDocument/hover',{textDocument:{uri},position:{line:0,character:2}},500);
const diagnostic=(c,version,fragment)=>c.notifications.find(m=>m.method==='textDocument/publishDiagnostics'&&m.params.version===version&&m.params.diagnostics.some(d=>d.message.includes(fragment)));
test('slow diagnostics do not block hover; superseded versions cancel and clean buffers',async t=>{
 const c=await client(t);open(c,'SLOW_CHECK_V1');const old=await c.wait(()=>c.records().find(r=>r.text==='SLOW_CHECK_V1'));
 await hover(c);change(c,'CURRENT_V2',2);await c.wait(()=>diagnostic(c,2,'CURRENT_V2'));
 assert.equal(c.notifications.some(m=>m.params?.version===1&&m.params.diagnostics?.length),false);
 await c.wait(()=>!fs.existsSync(old.file));assert.throws(()=>process.kill(old.pid,0),/ESRCH/);
});
test('close and same-version compiler configuration changes suppress obsolete diagnostics',async t=>{
 const c=await client(t);open(c,'SLOW_CHECK_CLOSE');const closed=await c.wait(()=>c.records().find(r=>r.text==='SLOW_CHECK_CLOSE'));
 c.notify('textDocument/didClose',{textDocument:{uri}});await c.wait(()=>c.notifications.find(m=>m.method==='textDocument/publishDiagnostics'&&m.params.diagnostics.length===0));await c.wait(()=>!fs.existsSync(closed.file));
 open(c,'SLOW_CHECK_CONFIG',3);await c.wait(()=>c.records().find(r=>r.text==='SLOW_CHECK_CONFIG'&&r.tag==='old'));
 c.notify('workspace/didChangeConfiguration',{settings:{forge:{path:c.replacement}}});await c.wait(()=>diagnostic(c,3,'new SLOW_CHECK_CONFIG'));
 assert.equal(c.notifications.some(m=>m.params?.diagnostics?.some(d=>d.message.includes('old SLOW_CHECK'))),false);
});
test('symbol queries stay responsive, coalesce and respect cancellation and newer document versions',async t=>{
 const c=await client(t);open(c,'fn prior(): int { return 1; } // SLOW_SYMBOLS');
 const request=c.request('textDocument/completion',{textDocument:{uri},position:{line:0,character:0}});
 await c.wait(()=>c.records().find(r=>r.symbols));await hover(c);
 c.notify('$/cancelRequest',{id:request.id});assert.deepEqual((await request.promise).result,[]);
 const outline=await c.call('textDocument/documentSymbol',{textDocument:{uri}});assert.equal(outline[0].name,'prior');assert.equal(c.records().filter(r=>r.symbols).length,1);
 change(c,'fn stale(): int { return 1; } // SLOW_SYMBOLS',2);
 const stale=c.request('textDocument/documentSymbol',{textDocument:{uri}});await c.wait(()=>c.records().find(r=>r.symbols&&r.text.includes('stale')));
 change(c,'fn newest(): int { return 2; }',3);assert.deepEqual((await stale.promise).result,[]);
 const current=await c.call('textDocument/documentSymbol',{textDocument:{uri}});assert.equal(current[0].name,'newest');
});

test('same-version settings changes suppress obsolete symbol responses',async t=>{
 const c=await client(t);open(c,'fn same_version(): int { return 1; } // SLOW_SYMBOLS');
 const old=c.request('textDocument/documentSymbol',{textDocument:{uri}});
 await c.wait(()=>c.records().find(r=>r.symbols&&r.tag==='old'));
 c.notify('workspace/didChangeConfiguration',{settings:{forge:{path:c.replacement}}});
 assert.deepEqual((await old.promise).result,[]);
 const fresh=await c.call('textDocument/documentSymbol',{textDocument:{uri}});
 assert.equal(fresh[0].name,'same_version');
 assert.equal(c.records().filter(r=>r.symbols&&r.tag==='new').length,1);
});
test('shutdown awaits active diagnostic and symbol process cleanup',async t=>{
 const c=await client(t);open(c,'fn stopping(): int { return 1; } // SLOW_SYMBOLS SLOW_CHECK');
 const symbols=c.request('textDocument/documentSymbol',{textDocument:{uri}});
 await c.wait(()=>c.records().length===2);
 const children=c.records();
 await c.call('shutdown',null);
 for(const child of children){assert.equal(fs.existsSync(child.file),false);assert.throws(()=>process.kill(child.pid,0),/ESRCH/)}
 assert.deepEqual((await symbols.promise).result,[]);
 c.notify('exit');await new Promise(resolve=>c.server.once('exit',resolve));
});

test('close and reopen at the same version suppress old completion and outline',async t=>{
 const c=await client(t);open(c,'fn before_reopen(): int { return 1; } // SLOW_SYMBOLS');
 const completion=c.request('textDocument/completion',{textDocument:{uri},position:{line:0,character:0}});
 const outline=c.request('textDocument/documentSymbol',{textDocument:{uri}});
 await c.wait(()=>c.records().find(r=>r.symbols));
 c.notify('textDocument/didClose',{textDocument:{uri}});
 open(c,'fn after_reopen(): int { return 2; }',1);
 assert.deepEqual((await completion.promise).result,[]);
 assert.deepEqual((await outline.promise).result,[]);
 const fresh=await c.call('textDocument/documentSymbol',{textDocument:{uri}});
 assert.equal(fresh[0].name,'after_reopen');
});
test('late edits and settings notifications during shutdown spawn no compiler work',async t=>{
 const c=await client(t);open(c,'fn stopping_late(): int { return 1; } // SLOW_SYMBOLS SLOW_CHECK');
 const symbols=c.request('textDocument/documentSymbol',{textDocument:{uri}});
 await c.wait(()=>c.records().length===2);
 const shutdown=c.request('shutdown',null);
 change(c,'fn late_edit(): int { return 3; }',2);
 c.notify('workspace/didChangeConfiguration',{settings:{forge:{path:c.replacement}}});
 c.notify('workspace/didChangeWatchedFiles',{changes:[{uri,type:2}]});
 await shutdown.promise;await symbols.promise;
 open(c,'fn late_open(): int { return 4; }',3);
 await new Promise(resolve=>setTimeout(resolve,300));
 assert.equal(c.records().length,2);
 c.notify('exit');await new Promise(resolve=>c.server.once('exit',resolve));
});
