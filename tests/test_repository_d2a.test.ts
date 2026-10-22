import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, d, hostFixture } from './repository_test_support.js';
import { CodexBackend } from '../src/agent/repository/codex_backend.js';
import { runRepositoryTask } from '../src/agent/repository/loop.js';
import { createVerificationContext } from '../src/agent/repository/context.js';
import { snapshotCandidate, safePath } from '../src/agent/repository/workspace.js';
import { readCompleteRun } from '../src/agent/repository/publication.js';
import { classifyFailure } from '../src/agent/repository/feedback.js';
import type { VerificationReceipt } from '../src/agent/repository/contracts.js';

for (const [kind,route] of Object.entries({compile:'CODE_REPAIR',functional:'CODE_REPAIR',guard:'CODE_REPAIR',requirement:'WORLD_CHANGE_REQUIRED',core:'CORE_MISMATCH',environment:'ENVIRONMENT_BLOCKED',ambiguous:'NEEDS_REVIEW'})) test(`D2a actual check routes ${kind}`,async t=>{
 const f=fixture('noop','nonzero');t.after(f.cleanup);
 const policy={...f.policy,verifiers:f.policy.verifiers.map(c=>({...c,failureKind:kind as NonNullable<VerificationReceipt['failureKind']>}))};
 const r=await runRepositoryTask({...f.options,policy});
 assert.equal(r.attempts[0]?.route,route,JSON.stringify(r,null,2));
 assert.equal(r.attempts.length,route==='CODE_REPAIR'?3:1);
 assert.equal(r.status,kind==='requirement'?'awaiting_world':'blocked');assert.equal(r.delivery,null);
});
for(const mode of ['quota','malformed','hang']) test(`D2a ${mode} launches once, never verifies or delivers`,async t=>{
 const f=fixture(mode,'normal',{attemptMs:800});t.after(f.cleanup);const r=await runRepositoryTask(f.options);
 assert.equal(r.attempts.length,1);assert.equal(r.attempts[0]?.verification,null);
 assert.equal(f.read('launches').trim(),'1');assert.equal(r.delivery,null);assert.notEqual(r.status,'delivered');
});
test('D2a missing backend never delivers or retries',async t=>{
 const f=fixture();t.after(f.cleanup);
 const {CodexBackend}=await import('../src/agent/repository/codex_backend.js');
 const r=await runRepositoryTask({...f.options,backend:new CodexBackend({executable:join(f.host,'absent'),prefixArgs:[]})});
 assert.equal(r.attempts.length,1);assert.equal(r.attempts[0]?.backend.status,'launch_failed');assert.equal(r.delivery,null);
});
test('D2a frozen host policy excludes output without altering raw backend identity',async t=>{
 const f=fixture('output-edits');t.after(f.cleanup);
 createVerificationContext({...f.options,workspace:f.source,revisionId:'r0',expected:f.binding});
 const r=await f.backend.run(f.task,f.options.signal);
 assert.equal(r.status,'exited');assert.deepEqual(r.candidate,snapshotCandidate(f.source,f.policy));
 assert.ok(r.candidate?.deleted.includes('src/b.ts'));
 const added=r.candidate?.files.find(x=>x.path==='src/new.bin');assert.equal(added?.executable,true);assert.equal(added?.sha256,'sha256:'+createHash('sha256').update(Buffer.from([0,255,128])).digest('hex') );
 assert.ok(!r.candidate?.files.some(x=>x.path.startsWith('dist/')));
 assert.deepEqual(JSON.parse(readFileSync(join(f.options.artifactDir,'attempts/a1/process.json'),'utf8')),r);
});
test('D2a malformed existing context cannot use standalone fallback',async t=>{
 const f=fixture();t.after(f.cleanup);createVerificationContext({...f.options,workspace:f.source,revisionId:'r0',expected:f.binding});
 writeFileSync(join(f.options.artifactDir,'inputs/revisions/run-1/r0/verification-context/record.json'),'{}');
 const r=await f.backend.run(f.task,f.options.signal);assert.equal(r.status,'not_started');assert.equal(f.exists('launches'),false);
});
test('D2a concurrent second start cannot overwrite initial incomplete projection',async t=>{
 const f=fixture('repair');t.after(f.cleanup);const first=runRepositoryTask(f.options);
 assert.ok(existsSync(join(f.options.artifactDir,'run.json')));
 const initial=readFileSync(join(f.options.artifactDir,'run.json'),'utf8');
 const second=await runRepositoryTask(f.options);assert.notEqual(second.status,'delivered');
 assert.equal(readFileSync(join(f.options.artifactDir,'run.json'),'utf8'),initial);
 const r=await first;assert.equal(r.status,'delivered');
 const recovered=readCompleteRun({artifactDir:safePath(f.options.artifactDir),workspace:safePath(join(f.host,'artifacts-workspace')),policy:f.policy,runId:f.options.runId});assert.deepEqual(recovered,r);
 assert.equal(snapshotCandidate(f.source,f.policy).digest,f.binding.candidate.digest);
});
test('D2a dirty source remains unchanged and never launches',async t=>{
 const f=fixture();t.after(f.cleanup);writeFileSync(join(f.source,'src/a.ts'),'dirty');
 const r=await runRepositoryTask(f.options);assert.equal(r.delivery,null);assert.equal(r.attempts.length,0);assert.equal(f.exists('launches'),false);assert.equal(readFileSync(join(f.source,'src/a.ts'),'utf8'),'dirty');
});
test('D2a display projection symlink cannot overwrite host data',async t=>{
 const f=fixture();t.after(f.cleanup);const {symlinkSync}=await import('node:fs');mkdirSync(f.options.artifactDir,{recursive:true});
 const target=join(f.host,'keep');writeFileSync(target,'keep');symlinkSync(target,join(f.options.artifactDir,'run.json'));
 const r=await runRepositoryTask(f.options);assert.equal(r.delivery,null);assert.equal(readFileSync(target,'utf8'),'keep');assert.equal(f.exists('launches'),false);
});

test('D2a loop delivers exact raw additions and deletions while excluding generated output',async t=>{
 const f=fixture('output-edits');t.after(f.cleanup);
 const code="const fs=require('node:fs'),p=require('node:path');const root=process.argv[2];if(fs.existsSync(p.join(root,'src/b.ts'))||!fs.readFileSync(p.join(root,'src/new.bin')).equals(Buffer.from([0,255,128])))process.exit(9);";
 writeFileSync(join(f.host,'verify.cjs'),code);const policy={...f.policy,verifiers:[{...f.policy.verifiers[0]!,programDigest:d(code)}]};
 const r=await runRepositoryTask({...f.options,policy});assert.equal(r.status,'delivered',r.diagnostics.join(' '));
 assert.ok(r.delivery?.binding.candidate.deleted.includes('src/b.ts'));assert.ok(r.delivery?.files.some(x=>x.path==='src/new.bin'&&x.executable));
 assert.ok(!r.delivery?.files.some(x=>x.path.startsWith('dist/')));assert.deepEqual(r.attempts[0]?.backend.candidate,r.delivery?.binding.candidate);
 assert.equal(snapshotCandidate(f.source,f.policy).digest,f.binding.candidate.digest);
});

// The real shared positive fixture must reach its frozen independent check even
// when physical SCRIPTED initialization takes longer than the old 800ms budget.
test('D2a delayed shared positive startup reaches actual ambiguous host check', {timeout:20_000},async t=>{
 const f=fixture('noop','nonzero');t.after(f.cleanup);
 const launcher=join(f.host,'delayed-start.cjs');
 writeFileSync(launcher,`setTimeout(()=>require(${JSON.stringify(hostFixture)}),1200);`);
 const backend=new CodexBackend({executable:process.execPath,prefixArgs:[launcher,'noop',f.host]});
 const policy={...f.policy,verifiers:f.policy.verifiers.map(c=>({...c,failureKind:'ambiguous' as const}))};
 const r=await runRepositoryTask({...f.options,backend,policy});
 console.log('delayed shared fixture complete record '+JSON.stringify(r));
 for(const receipt of r.attempts.flatMap(a=>[a.backend.process,...(a.verification?.checks.map(c=>c.process)??[])])) {
  console.log('delayed shared fixture raw process '+JSON.stringify({receipt,stdout:readFileSync(receipt.stdoutPath,'utf8'),stderr:readFileSync(receipt.stderrPath,'utf8')}));
 }
 assert.equal(r.attempts[0]?.route,'NEEDS_REVIEW',JSON.stringify(r,null,2));
 assert.equal(r.attempts.length,1);assert.equal(r.status,'blocked');assert.equal(r.delivery,null);
 const a=r.attempts[0]!;
 assert.equal(a.backend.status,'exited');assert.equal(a.backend.process.exitCode,0);assert.equal(a.backend.process.treeStopped,true);
 assert.match(readFileSync(a.backend.process.stdoutPath,'utf8'),/turn.completed/);
 assert.equal(f.read('launches').trim(),'1');assert.ok(f.exists('invocation.json'));
 assert.equal(a.verification?.failureKind,'ambiguous');assert.equal(a.verification?.checks.length,1);
 assert.equal(a.verification?.checks[0]?.status,'failed');assert.equal(a.verification?.checks[0]?.process.exitCode,9);
 assert.deepEqual(JSON.parse(readFileSync(join(f.options.artifactDir,'attempts/a1/process.json'),'utf8')),a.backend);
});
