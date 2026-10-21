import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, actuatorFixture } from './repository_test_support.js';
import { settleOperation } from '../examples/repository-order-service/settlement.js';
import { createWorldChecker } from '../src/world_checker.js';
import { parseWorldSpec } from '../src/world_compiler.js';
function request(f:ReturnType<typeof fixture>,script=actuatorFixture,mode='refuse') {return {operationId:'operation-safe',checker:createWorldChecker(parseWorldSpec(readFileSync(f.options.worldPath,'utf8'))),actuator:{executable:process.execPath,argv:[script,join(f.host,'effects.json'),'apply','operation-safe',mode]},query:{executable:process.execPath,argv:[]},recordPath:join(f.host,'settlement.json'),signal:f.options.signal};}
test('explicit refusal protocol records authorized step and internal rollback',async t=>{
 const f=fixture();t.after(f.cleanup);const q=request(f);const r=await settleOperation(q);assert.equal(r.outcome,'not_committed');assert.equal(r.effectCount,0);assert.equal(q.checker.getState(),'CREATED');assert.deepEqual(r.trace,['step','actuator:refused','rollback']);assert.equal(JSON.parse(readFileSync(q.recordPath,'utf8')).delivery,null);
});
for(const code of ["console.error('precommit refusal');process.exitCode=2", "console.log('{}');process.exitCode=2", "console.log(JSON.stringify({protocol:'kadmos.precommit-refusal.v1',operationId:'wrong',outcome:'not_committed',effectCount:0}));process.exitCode=2", "process.exitCode=9"])test(`nonprotocol result fences restart and overlap: ${code}`,async t=>{
 const f=fixture();t.after(f.cleanup);const script=join(f.host,'arbitrary.cjs');writeFileSync(script,`require('fs').appendFileSync(${JSON.stringify(join(f.host,'calls'))},'x');${code}`);const q=request(f,script);
 const [a,b]=await Promise.all([settleOperation(q),settleOperation(q)]);assert.equal(a.outcome,'unknown');assert.equal(b.outcome,'unknown');assert.equal(a.checkerRollback,false);assert.equal(f.read('calls'),'x');
 const r=await settleOperation({...q,checker:createWorldChecker(parseWorldSpec(readFileSync(f.options.worldPath,'utf8')))});assert.equal(r.outcome,'unknown');assert.equal(f.read('calls'),'x');assert.equal(JSON.parse(readFileSync(q.recordPath,'utf8')).delivery,null);
});
test('preabort never steps or launches actuator',async t=>{
 const f=fixture();t.after(f.cleanup);const c=new AbortController();c.abort();const q=request(f);const r=await settleOperation({...q,signal:c.signal});assert.equal(r.outcome,'unknown');assert.equal(q.checker.getState(),'CREATED');assert.equal(existsSync(join(f.host,'effects.json.trace.jsonl')),false);
});

test('lost response keeps physical commit and fences retry without claiming rollback',async t=>{const f=fixture();t.after(f.cleanup);const q=request(f,actuatorFixture,'drop');const r=await settleOperation(q);assert.equal(r.outcome,'unknown');assert.equal(r.checkerRollback,false);assert.equal(JSON.parse(f.read('effects.json')).effects,1);assert.equal(q.checker.getState(),'PAYMENT_PENDING');await settleOperation(q);assert.equal(f.read('effects.json.trace.jsonl').trim().split('\n').length,1);});
test('timeout remains unknown and permanently fences external repetition',{timeout:12000},async t=>{const f=fixture();t.after(f.cleanup);const script=join(f.host,'hang.cjs');writeFileSync(script,`require('fs').appendFileSync(${JSON.stringify(join(f.host,'calls'))},'x');setInterval(()=>{},1000)`);const q=request(f,script);const r=await settleOperation(q);assert.equal(r.outcome,'unknown');assert.equal(r.checkerRollback,false);await settleOperation(q);assert.equal(f.read('calls'),'x');const process=JSON.parse(readFileSync(q.recordPath+'.dispatch/process.json','utf8'));assert.equal(process.reason,'timeout');assert.equal(process.treeStopped,true);});
