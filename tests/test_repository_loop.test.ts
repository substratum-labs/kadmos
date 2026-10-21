import { createVerificationContext } from '../src/agent/repository/context.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, actuatorFixture } from './repository_test_support.js';
import { runRepositoryTask } from '../src/agent/repository/loop.js';
import { verifyCandidate } from '../src/agent/repository/verify.js';
import { snapshotCandidate } from '../src/agent/repository/workspace.js';

test('A05 independent type failure reaches second attempt; only repaired exact candidate delivered',{timeout:20_000},async t=>{
 const f=fixture('repair');t.after(f.cleanup);const r=await runRepositoryTask(f.options);
 assert.equal(r.attempts.length,2,'must actually observe initial failure then repair');
 assert.equal(r.attempts[0]?.verification?.status,'failed');assert.match(f.read('feedback.txt'),/TYPE_ERROR/);
 assert.equal(r.attempts[1]?.verification?.status,'passed');assert.equal(r.status,'delivered');
 assert.equal(r.delivery?.binding.world,f.binding.world);assert.equal(r.attempts[0]?.revisionId,r.attempts[1]?.revisionId);
 assert.equal(r.delivery?.binding.candidate.digest,r.attempts[1]?.verification?.after?.candidate.digest);
});
for(const path of ['world.yaml','generated/world_checker.ts','generated/ports.d.ts','requirements.md','acceptance.txt','policy.json'])test(`A06 protected ${path} tamper cannot become delivery`,{timeout:20_000},async t=>{
 const f=fixture(`tamper:${path}`);t.after(f.cleanup);const r=await runRepositoryTask(f.options);
 assert.equal(r.attempts[0]?.verification?.status,'protected_change','must detect actual protected input mutation');assert.equal(r.delivery,null);
});
test('A07 snapshot binds additions and deletions, verifier write and late drift block delivery',{timeout:20_000},async t=>{
 const f=fixture('noop','drift');t.after(f.cleanup);createVerificationContext({...f.options,workspace:f.source,revisionId:'r0',expected:f.binding});const before=snapshotCandidate(f.source,f.policy);
 writeFileSync(join(f.source,'src/new.ts'),'export const n=3;');unlinkSync(join(f.source,'src/b.ts'));
 const after=snapshotCandidate(f.source,f.policy);
 assert.notEqual(before.digest,after.digest,'source changes must affect identity');
 assert.ok(after.files.some(x=>x.path==='src/new.ts'));assert.ok(after.deleted.includes('src/b.ts'));
 const r=await verifyCandidate({...f.verification,binding:{...f.binding,candidate:after}},f.options.signal);
 assert.equal(r.status,'drift');
 writeFileSync(join(f.source,'src/post-check.ts'),'late backend write');
 const run=await runRepositoryTask(f.options);assert.equal(run.delivery,null);assert.notEqual(run.status,'delivered');
});
for(const mode of ['missing','timeout','nonzero'])test(`A08 verifier ${mode} is actual failed evidence`,{timeout:20_000},async t=>{
 const f=fixture('noop',mode);t.after(f.cleanup);createVerificationContext({...f.options,workspace:f.source,revisionId:'r0',expected:f.binding});const policy=f.policy;
 const r=await verifyCandidate({...f.verification,policy},f.options.signal);
 assert.equal(r.checks[0]?.status,mode==='missing'?'launch_failed':mode==='timeout'?'timeout':'failed');
 assert.notEqual(r.status,'passed');if(mode==='nonzero')assert.equal(r.checks[0]?.process.exitCode,9);
});
test('A09 three failed attempts exhaust the original run budget without delivery',{timeout:20_000},async t=>{
 const f=fixture('noop','nonzero');t.after(f.cleanup);
 const r=await runRepositoryTask(f.options);assert.equal(r.attempts.length,3);assert.equal(r.status,'blocked');assert.equal(r.delivery,null);
 });
test('A09 pre-aborted controller retains an incomplete run rather than a delivery', {timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);const controller=new AbortController();controller.abort();
 const r=await runRepositoryTask({...f.options,signal:controller.signal});
 assert.equal(r.status,'incomplete');assert.equal(r.delivery,null);
 assert.ok(r.diagnostics.some(x=>/cancel|interrupt/i.test(x)));
 assert.ok(existsSync(join(f.options.artifactDir,'run.json')),'incomplete record must exist physically');
 assert.equal(JSON.parse(readFileSync(join(f.options.artifactDir,'run.json'),'utf8')).delivery,null);
});
test('A10 exception and wrong checker order repair Fabric without changing World',{timeout:20_000},async t=>{
 const f=fixture('repair');t.after(f.cleanup);const world=readFileSync(f.options.worldPath,'utf8');
 const r=await runRepositoryTask({...f.options,instructions:'First repair legal-call-order; do not revise World.'});
 assert.equal(r.attempts[0]?.route,'CODE_REPAIR');
 const checker=createWorldChecker(parseWorldSpec(world));
 const result=await settleOperation({operationId:'op-10',checker,actuator:{executable:process.execPath,argv:[actuatorFixture,join(f.host,'effects.json'),'apply','op-10','refuse']},query:{executable:process.execPath,argv:[actuatorFixture,join(f.host,'effects.json'),'query','op-10','normal']},recordPath:join(f.host,'settlement.json'),signal:f.options.signal});
 assert.deepEqual(result.trace,['step','actuator:refused','rollback']);assert.equal(result.checkerRollback,true);
 assert.equal(checker.getState(),'CREATED');assert.equal(result.effectCount,0);
 assert.equal(readFileSync(f.options.worldPath,'utf8'),world);
});

import { createWorldChecker } from '../src/world_checker.js';
import { parseWorldSpec } from '../src/world_compiler.js';
import { settleOperation } from '../examples/repository-order-service/settlement.js';

test('A07 late source write after passing checks fails final delivery readback',{timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);createVerificationContext({...f.options,workspace:f.source,revisionId:'r0',expected:f.binding});const checked=await verifyCandidate(f.verification,f.options.signal);
 assert.equal(checked.status,'passed','establish actual successful checks before the late write');
 writeFileSync(join(f.source,'src/late.ts'),'export const late = 1;');
 const r=validateDelivery({workspace:f.source,policy:f.policy,receipt:checked,expected:f.binding,requiredCheckIds:['acceptance'],unresolvedEffects:[]});
 assert.equal(r.status,'refused');assert.equal(r.manifest,null);
});
test('A19 retained unknown physical effect blocks otherwise checked delivery',{timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);createVerificationContext({...f.options,workspace:f.source,revisionId:'r0',expected:f.binding});const checked=await verifyCandidate(f.verification,f.options.signal);
 assert.equal(checked.status,'passed');
 const r=validateDelivery({workspace:f.source,policy:f.policy,receipt:checked,expected:f.binding,requiredCheckIds:['acceptance'],unresolvedEffects:[{operationId:'op-unknown',outcome:'unknown',reconciliation:'unavailable',effectCount:'unknown',checkerRollback:true,trace:['step','commit:response-lost','rollback','query:unavailable']}]});
 assert.equal(r.status,'refused');assert.equal(r.manifest,null);
});
import { validateDelivery } from '../src/agent/repository/artifacts.js';
