import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixture, actuator, actuatorFixture } from './repository_test_support.js';
import { settleOperation, type SettlementInput } from '../examples/repository-order-service/settlement.js';
import { createWorldChecker } from '../src/world_checker.js';
import { parseWorldSpec } from '../src/world_compiler.js';
function request(f:ReturnType<typeof fixture>,mode:string,queryMode='normal'):SettlementInput {
 return {operationId:'op-1',checker:createWorldChecker(parseWorldSpec(readFileSync(f.options.worldPath,'utf8'))),actuator:{executable:process.execPath,argv:[actuatorFixture,join(f.host,'effects.json'),'apply','op-1',mode,'--bound']},query:{executable:process.execPath,argv:[actuatorFixture,join(f.host,'effects.json'),'query','op-1',queryMode,'--bound']},recordPath:join(f.host,'settlement.json'),signal:f.options.signal};
}
test('A17 precommit refusal rolls back authorized checker step with zero observed effects',{timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);const input=request(f,'refuse');const r=await settleOperation(input);
 assert.equal(r.outcome,'not_committed');assert.equal(r.checkerRollback,true);assert.equal(input.checker.getState(),'CREATED');
 assert.deepEqual(r.trace,['step','actuator:refused','rollback']);assert.equal(existsSync(join(f.host,'effects.json')),false);
});
test('A18 commit then lost response reconciles before same-ID retry settles exactly one effect',{timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);const input=request(f,'drop');const first=await settleOperation(input);
 assert.equal(first.reconciliation,'queried');assert.equal(first.outcome,'committed');
 const physical=readFileSync(join(f.host,'effects.json.trace.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
 assert.deepEqual(physical.map(x=>x.action),['apply','query'],'reconciliation must physically precede settlement');
 const retry=await settleOperation(input);
 assert.equal(retry.outcome,'committed');assert.equal(JSON.parse(readFileSync(join(f.host,'effects.json'),'utf8')).effects,1);
 const queried=first.trace.indexOf('query:committed');assert.ok(queried>=0);assert.ok(first.trace.indexOf('settle')>queried);
});
test('A19 restart and overlap serialize checker access; unresolved physical effect remains unknown',{timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);const input=request(f,'drop','unavailable');
 const [a,b]=await Promise.all([settleOperation(input),settleOperation(input)]);
 assert.equal(a.outcome,'unknown');assert.equal(b.outcome,'unknown');
 assert.ok(existsSync(join(f.host,'effects.json')),'external effect must actually be observed');
 assert.equal(JSON.parse(readFileSync(join(f.host,'effects.json'),'utf8')).effects,1,'external commit must survive lost responses');
 assert.ok(existsSync(input.recordPath),'unknown physical effect must be retained');
 const configPath=join(f.host,'restart.json');const {checker: _checker,signal: _signal,...config}=request(f,'normal','unavailable');
 writeFileSync(configPath,JSON.stringify({...config,worldPath:f.options.worldPath}));
 const restarted=spawnSync(process.execPath,[resolve('tests/fixtures/repository/settlement-driver.cjs'),resolve('dist'),configPath],{encoding:'utf8',timeout:3000});
 assert.equal(restarted.status,0,restarted.stderr);const reconstructed=JSON.parse(restarted.stdout);
 assert.equal(reconstructed.outcome,'unknown');assert.equal(reconstructed.reconciliation,'unavailable');
 assert.ok(reconstructed.trace.includes('reconstruct:unknown'));assert.ok(reconstructed.trace.includes('serialized'));
 const externalCalls=readFileSync(join(f.host,'effects.json.trace.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
 assert.equal(externalCalls.filter(x=>x.action==='apply').length,1,'unknown physical effect cannot be automatically repeated');
 const record=JSON.parse(readFileSync(input.recordPath,'utf8')); assert.equal(record.delivery,null);assert.equal(record.outcome,'unknown');
});
// Live A20 has no scripted substitute. Task F must supply a separately selected
// real installed-backend run plus independent normal/repair/revision receipts.
// Deliberately no skipped/passing placeholder test masquerading as A20.

import { spawnSync } from 'node:child_process';
