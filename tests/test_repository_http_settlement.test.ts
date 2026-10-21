import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, symlinkSync, linkSync, cpSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixture } from './repository_test_support.js';
import { settleOperation, type SettlementInput } from '../examples/repository-order-service/settlement.js';
import { createWorldChecker } from '../src/world_checker.js';
import { parseWorldSpec } from '../src/world_compiler.js';
const serverScript=resolve('tests/fixtures/repository/http-actuator.cjs'),client=resolve('tests/fixtures/repository/http-client.cjs');
async function setup(t:TestContext,mode='drop',queryMode='normal',id='operation-http') {
 const f=fixture();const root=join(f.host,'http');
 t.after(async()=>{try {if(server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await once(server,'exit');}const evidence=process.env.KADMOS_F1_EVIDENCE;if(evidence){const dest=join(evidence,t.name.replace(/[^a-zA-Z0-9_-]/g,'_'));mkdirSync(dest,{recursive:true});for(const name of ['http','settlement.json','settlement.json.dispatch']){const src=join(f.host,name);if(!existsSync(src))continue;const st=lstatSync(src);if(!st.isSymbolicLink()&&(st.isDirectory()||st.isFile()&&st.nlink===1))cpSync(src,join(dest,name),{recursive:true});}}}finally{f.cleanup();}});
 const server=spawn(process.execPath,[serverScript,root],{stdio:['ignore','pipe','pipe']});
 const ready=await new Promise<{port:number;pid:number}>((resolveReady,reject)=>{const timer=setTimeout(()=>reject(Error('server readiness deadline')),2000);server.once('error',reject);server.stdout.once('data',data=>{clearTimeout(timer);try{resolveReady(JSON.parse(String(data)));}catch(e){reject(e);}});});
 assert.notEqual(ready.pid,process.pid);
 const checker=createWorldChecker(parseWorldSpec(readFileSync(f.options.worldPath,'utf8')));
 const command=(action:string,m:string)=>({executable:process.execPath,argv:[client,String(ready.port),action,id,m]});
 const input:SettlementInput={operationId:id,checker,actuator:command('apply',mode),query:command('query',queryMode),recordPath:join(f.host,'settlement.json'),signal:f.options.signal};
 const trace=()=>readdirSync(join(root,'requests')).sort().map(x=>JSON.parse(readFileSync(join(root,'requests',x),'utf8')));
 const count=()=>existsSync(join(root,'ledger.json'))?JSON.parse(readFileSync(join(root,'ledger.json'),'utf8')).effects:0;
 return {f,root,input,trace,count,command,server};
}
for(const mode of ['normal','drop'])test(`independent HTTP ${mode} commits once, reconciles before settling and replays fresh checker`,{timeout:15000},async t=>{
 const h=await setup(t,mode);const r=await settleOperation(h.input);
 assert.equal(r.outcome,'committed');assert.equal(r.effectCount,1);assert.equal(r.checkerRollback,false);assert.equal(h.count(),1);
 assert.deepEqual(h.trace().map(x=>x.action),mode==='drop'?['apply','query']:['apply']);
 if(mode==='drop'){assert.equal(r.reconciliation,'queried');assert.ok(r.trace.indexOf('query:committed')<r.trace.indexOf('settle'));}
 const fresh=createWorldChecker(parseWorldSpec(readFileSync(h.f.options.worldPath,'utf8')));
 const replay=await settleOperation({...h.input,checker:fresh});assert.equal(replay.outcome,'committed');assert.equal(fresh.getState(),'PAYMENT_PENDING');assert.equal(h.count(),1);assert.equal(h.trace().filter(x=>x.action==='apply').length,1);
 assert.equal(JSON.parse(readFileSync(h.input.recordPath+'.dispatch/unknown.json','utf8')).outcome,'unknown');
 assert.equal(JSON.parse(readFileSync(h.input.recordPath,'utf8')).delivery,null);
});
test('HTTP explicit refusal retains A17 exact rollback trace and zero physical effects',async t=>{
 const h=await setup(t,'refuse');const r=await settleOperation(h.input);assert.equal(r.outcome,'not_committed');assert.deepEqual(r.trace,['step','actuator:refused','rollback']);assert.equal(h.input.checker.getState(),'CREATED');assert.equal(h.count(),0);assert.deepEqual(h.trace().map(x=>x.action),['apply']);
});
test('HTTP unavailable query fences overlap and fresh-process restart without losing unknown',{timeout:15000},async t=>{
 const h=await setup(t,'drop','unavailable');const [a,b]=await Promise.all([settleOperation(h.input),settleOperation(h.input)]);
 for(const r of [a,b]){assert.equal(r.outcome,'unknown');assert.equal(r.effectCount,'unknown');assert.equal(r.checkerRollback,false);}
 assert.equal(h.count(),1);assert.deepEqual(h.trace().map(x=>x.action),['apply','query']);
 const {checker:_c,signal:_s,...config}=h.input;const file=join(h.f.host,'restart.json');writeFileSync(file,JSON.stringify({...config,worldPath:h.f.options.worldPath}));
 const p=spawnSync(process.execPath,[resolve('tests/fixtures/repository/settlement-driver.cjs'),resolve('dist'),file],{encoding:'utf8',timeout:3000});
 assert.equal(p.status,0,p.stderr);const r=JSON.parse(p.stdout);assert.equal(r.outcome,'unknown');assert.ok(r.trace.includes('reconstruct:unknown'));assert.ok(r.trace.includes('serialized'));assert.equal(h.count(),1);assert.equal(h.trace().filter(x=>x.action==='apply').length,1);assert.equal(JSON.parse(readFileSync(h.input.recordPath,'utf8')).delivery,null);
});
for(const id of ['constructor','__proto__'])test(`HTTP literal operation key ${id} is a real effect, independently deduplicated`,async t=>{
 const h=await setup(t,'drop','normal',id);const r=await settleOperation(h.input);assert.equal(r.outcome,'committed');assert.equal(h.count(),1);assert.deepEqual(JSON.parse(readFileSync(join(h.root,'ledger.json'),'utf8')).operations,[id]);
 const p=spawnSync(process.execPath,[client,h.input.actuator.argv[1]!,'apply',id,'normal'],{encoding:'utf8',timeout:3000});
 // spawnSync blocks this host, not the independent server.
 assert.equal(p.status,0,p.stderr);assert.equal(JSON.parse(p.stdout).effectCount,1);assert.equal(h.count(),1);
});
for(const mode of ['wrong-id','bad-count','extra','malformed'])test(`HTTP ${mode} receipts cannot settle ambiguous actuation`,async t=>{
 const h=await setup(t,mode,mode);const r=await settleOperation(h.input);assert.equal(r.outcome,'unknown');assert.equal(r.effectCount,'unknown');assert.equal(h.count(),1);assert.deepEqual(h.trace().map(x=>x.action),['apply','query']);assert.equal(h.input.checker.getState(),'PAYMENT_PENDING');
});
test('denied step preserves prior valid checker undo and performs no HTTP request',async t=>{
 const h=await setup(t);assert.equal(h.input.checker.step({transitionId:'INITIATE_PAYMENT',proposedDirective:'DISPATCH_PAYMENT_GATEWAY'}).allowed,true);
 const r=await settleOperation(h.input);assert.equal(r.outcome,'unknown');assert.equal(h.trace().length,0);assert.equal(h.input.checker.getState(),'PAYMENT_PENDING');h.input.checker.rollbackLastStep();assert.equal(h.input.checker.getState(),'CREATED');
});
test('throwing step preserves prior valid checker undo and performs no HTTP request',async t=>{
 const h=await setup(t);h.input.checker.step({transitionId:'INITIATE_PAYMENT',proposedDirective:'DISPATCH_PAYMENT_GATEWAY'});
 const r=await settleOperation({...h.input,checker:{...h.input.checker,step(){throw Error('denied');}}});assert.equal(r.outcome,'unknown');assert.equal(h.trace().length,0);h.input.checker.rollbackLastStep();assert.equal(h.input.checker.getState(),'CREATED');
});
for(const mode of ['wrong-id','count','signal','exit','timeout'])test(`unqualified ${mode} precommit stdout never confirms zero`,{timeout:12000},async t=>{
 const h=await setup(t);const script=join(h.f.host,'unqualified.cjs');const v={protocol:'kadmos.precommit-refusal.v1',operationId:mode==='wrong-id'?'other':h.input.operationId,outcome:'not_committed',effectCount:mode==='count'?1:0};
 writeFileSync(script,`console.log(${JSON.stringify(JSON.stringify(v))});${mode==='signal'?"process.kill(process.pid,'SIGTERM')":mode==='timeout'?'setInterval(()=>{},1000)':`process.exitCode=${mode==='exit'?0:2}`}`);
 const r=await settleOperation({...h.input,actuator:{executable:process.execPath,argv:[script]},query:{executable:process.execPath,argv:['-e','process.exitCode=3']}});assert.equal(r.outcome,'unknown');assert.equal(r.effectCount,'unknown');assert.equal(r.checkerRollback,false);assert.equal(h.trace().length,0);
});
for(const kind of ['symlink','hardlink','directory','reservation'])test(`unsafe ${kind} record refuses all physical requests`,async t=>{
 const h=await setup(t);const target=join(h.f.host,'target');writeFileSync(target,'{}');
 if(kind==='symlink')symlinkSync(target,h.input.recordPath);if(kind==='hardlink')linkSync(target,h.input.recordPath);if(kind==='directory')mkdirSync(h.input.recordPath);if(kind==='reservation')mkdirSync(h.input.recordPath+'.dispatch');
 assert.equal((await settleOperation(h.input)).outcome,'unknown');assert.equal(h.trace().length,0);assert.equal(h.input.checker.getState(),'CREATED');
});
test('refusal cannot rollback otherflow work performed while the actuator awaits',async t=>{
 const h=await setup(t,'refuse');const pending=settleOperation(h.input);
 assert.equal(h.input.checker.step({transitionId:'CONFIRM_PAYMENT',eventPayload:{captured_amount:5000}}).allowed,true);
 const r=await pending;assert.equal(r.outcome,'unknown');assert.equal(r.checkerRollback,false);assert.equal(h.input.checker.getState(),'PAID');
 h.input.checker.rollbackLastStep();assert.equal(h.input.checker.getState(),'PAYMENT_PENDING');assert.equal(h.count(),0);
});
test('known result reconstruction refuses changed underlying receipt instead of trusting a projection',async t=>{
 const h=await setup(t,'normal');assert.equal((await settleOperation(h.input)).outcome,'committed');
 writeFileSync(h.input.recordPath+'.dispatch/stdout',JSON.stringify({protocol:'kadmos.effect-commit.v1',operationId:'wrong',outcome:'committed',effectCount:1}));
 assert.equal((await settleOperation(h.input)).outcome,'unknown');assert.equal(h.trace().length,1);
});
test('query-confirmed noncommit alone permits rollback after an arbitrary apply failure',async t=>{
 const h=await setup(t);const script=join(h.f.host,'noeffect.cjs');writeFileSync(script,'process.exitCode=9');
 const r=await settleOperation({...h.input,actuator:{executable:process.execPath,argv:[script]}});assert.equal(r.outcome,'not_committed');assert.equal(r.reconciliation,'queried');assert.equal(r.effectCount,0);assert.equal(r.checkerRollback,true);assert.equal(h.input.checker.getState(),'CREATED');assert.equal(h.count(),0);assert.deepEqual(h.trace().map(x=>x.action),['query']);
});
test('known committed replay preserves unrelated otherflow state and its savepoint',async t=>{
 const h=await setup(t,'normal');await settleOperation(h.input);h.input.checker.step({transitionId:'CONFIRM_PAYMENT',eventPayload:{captured_amount:5000}});
 assert.equal((await settleOperation(h.input)).outcome,'unknown');assert.equal(h.input.checker.getState(),'PAID');h.input.checker.rollbackLastStep();assert.equal(h.input.checker.getState(),'PAYMENT_PENDING');assert.equal(h.trace().length,1);
});
for(const id of ['', '../escape', 'has space', 'x'.repeat(129)])test(`invalid operation ID ${JSON.stringify(id.slice(0,20))} never dispatches`,async t=>{
 const h=await setup(t);assert.equal((await settleOperation({...h.input,operationId:id})).outcome,'unknown');assert.equal(h.trace().length,0);
});
for(const mode of ['signal','wrong-id','count','exit'])test(`query ${mode} cannot resolve ambiguous apply to zero`,async t=>{
 const h=await setup(t);const apply=join(h.f.host,'apply.cjs'),query=join(h.f.host,'query.cjs');writeFileSync(apply,'process.exitCode=4');
 const value={protocol:'kadmos.effect-query.v1',operationId:mode==='wrong-id'?'different':h.input.operationId,outcome:'not_committed',effectCount:mode==='count'?1:0};
 writeFileSync(query,`console.log(${JSON.stringify(JSON.stringify(value))});${mode==='signal'?"process.kill(process.pid,'SIGTERM')":`process.exitCode=${mode==='exit'?2:0}`}`);
 const r=await settleOperation({...h.input,actuator:{executable:process.execPath,argv:[apply]},query:{executable:process.execPath,argv:[query]}});assert.equal(r.outcome,'unknown');assert.equal(r.checkerRollback,false);assert.equal(r.effectCount,'unknown');assert.equal(h.input.checker.getState(),'PAYMENT_PENDING');assert.equal(h.trace().length,0);
});
test('record operation binding cannot be relabelled to authorize a second effect',async t=>{
 const h=await setup(t,'normal');await settleOperation(h.input);
 const r=await settleOperation({...h.input,operationId:'another-operation'});assert.equal(r.outcome,'unknown');assert.equal(h.count(),1);assert.equal(h.trace().length,1);
});
test('multiple operation IDs each have one effect while query count stays operation-bound',async t=>{
 const h=await setup(t,'normal');assert.equal((await settleOperation(h.input)).effectCount,1);
 const id='second-operation',fresh=createWorldChecker(parseWorldSpec(readFileSync(h.f.options.worldPath,'utf8')));
 const r=await settleOperation({...h.input,operationId:id,checker:fresh,recordPath:join(h.f.host,'second.json'),actuator:{...h.input.actuator,argv:[client,h.input.actuator.argv[1]!,'apply',id,'drop']},query:{...h.input.query,argv:[client,h.input.actuator.argv[1]!,'query',id,'normal']}});
 assert.equal(r.outcome,'committed');assert.equal(r.effectCount,1);assert.equal(h.count(),2);assert.deepEqual(h.trace().map(x=>x.action),['apply','apply','query']);
});
test('HTTP server restart retains the operation ledger and deduplicates the same literal ID',async t=>{
 const h=await setup(t,'normal','normal','__proto__');await settleOperation(h.input);
 h.server.kill('SIGTERM');await once(h.server,'exit');
 const server=spawn(process.execPath,[serverScript,h.root],{stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await once(server,'exit');}});
 const ready=await new Promise<{port:number}>((ok,bad)=>{const timer=setTimeout(()=>bad(Error('restart readiness')),2000);server.once('error',bad);server.stdout.once('data',b=>{clearTimeout(timer);try{ok(JSON.parse(String(b)));}catch(e){bad(e);}});});
 const p=spawnSync(process.execPath,[client,String(ready.port),'apply','__proto__','normal'],{encoding:'utf8',timeout:3000});assert.equal(p.status,0,p.stderr);assert.equal(JSON.parse(p.stdout).effectCount,1);assert.equal(h.count(),1);assert.deepEqual(h.trace().map(x=>x.action),['apply','apply']);
});
test('FIFO and relative record paths refuse without opening an effect channel',async t=>{
 const h=await setup(t);const p=spawnSync('mkfifo',[h.input.recordPath],{encoding:'utf8',timeout:1000});assert.equal(p.status,0,p.stderr);
 assert.equal((await settleOperation(h.input)).outcome,'unknown');assert.equal((await settleOperation({...h.input,recordPath:'relative.json'})).outcome,'unknown');assert.equal(h.trace().length,0);
});
