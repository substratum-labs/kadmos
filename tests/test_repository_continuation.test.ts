import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexBackend } from '../src/agent/repository/codex_backend.js';
import { d, hostFixture } from './repository_test_support.js';
import { join } from 'node:path';
import { fixture } from './repository_test_support.js';
import { runRepositoryTask } from '../src/agent/repository/loop.js';
import { proposeWorldChange, activateWorldRevision } from '../src/agent/repository/world_revision.js';
import { readCompleteRun, readRunCheckpoint } from '../src/agent/repository/publication.js';
import { readControl } from '../src/agent/repository/control.js';
import type { OperatorDecision, RepositoryRunOptions } from '../src/agent/repository/contracts.js';
function approve(f:ReturnType<typeof fixture>) {
 const p=proposeWorldChange({runId:f.options.runId,proposalId:'p1',base:f.revision,patch:readFileSync(f.options.worldPath,'utf8')+'\n# approved exact revision\n',artifactDir:f.options.artifactDir,rationale:'SCRIPTED operator test',requirements:f.binding.requirements});
 mkdirSync(f.options.decisionsDir,{recursive:true});const path=join(f.options.decisionsDir,'p1.json');
 const d:OperatorDecision={command:'approve-world',operator:'SCRIPTED',runId:p.runId,proposalId:p.proposalId,proposalDigest:p.proposalDigest,baseRevisionId:p.base.id,baseWorld:p.base.world,patchDigest:p.patchDigest,recordedAt:new Date().toISOString()};
 writeFileSync(path,JSON.stringify(d));
 const revision=activateWorldRevision({proposal:p,current:f.revision,decisionPath:path,decisionsDir:f.options.decisionsDir,runId:p.runId,historicalReceiptIds:['subset-only']});assert.equal(revision.state,'active');
 return {...f.options,revision,worldPath:revision.worldPath,seamPaths:revision.seamPaths};
}
function storage(f:ReturnType<typeof fixture>) {const c=readControl({artifactDir:f.options.artifactDir,runId:f.options.runId});return {artifactDir:c.artifactDir,workspace:c.header.workspace,policy:c.policy,runId:c.runId};}
function launches(f:ReturnType<typeof fixture>):string {return readFileSync(join(f.host,'launches'),'utf8');}
test('E2b current readback publishes one verified successor and retains exact original history', {timeout:20_000},async t=>{
 const f=fixture('repair');t.after(f.cleanup);const old=await runRepositoryTask(f.options);assert.equal(old.status,'delivered');const s=storage(f);
 const complete=readFileSync(join(s.artifactDir,'publication',s.runId,'complete','record.json'));const start=readFileSync(join(s.artifactDir,'publication',s.runId,'start','record.json'));
 const options=approve(f),run=await runRepositoryTask(options);assert.equal(run.status,'delivered',run.diagnostics.join('\n'));assert.equal(run.attempts.length,3);assert.deepEqual(run.attempts.slice(0,2),old.attempts);assert.deepEqual(run.revisions[1],options.revision);assert.equal(run.startedAt,old.startedAt);assert.equal(run.deadlineEpochMs,old.deadlineEpochMs);
 assert.equal(run.delivery?.binding.world,options.revision.world);assert.equal(run.delivery?.binding.revisionId,options.revision.id);assert.deepEqual(readCompleteRun(s),run);assert.deepEqual(readFileSync(join(s.artifactDir,'publication',s.runId,'complete','record.json')),complete);assert.deepEqual(readFileSync(join(s.artifactDir,'publication',s.runId,'start','record.json')),start);
 const count=launches(f);const replay=await runRepositoryTask(options);assert.equal(replay.delivery,null);assert.equal(launches(f),count);assert.deepEqual(readCompleteRun(s),run);
});
test('E2b awaiting World continuation uses exact approved bytes and all checks', {timeout:20_000},async t=>{
 const f=fixture('noop','requirement');t.after(f.cleanup);const old=await runRepositoryTask(f.options);assert.equal(old.status,'awaiting_world');const options=approve(f);const run=await runRepositoryTask(options);
 assert.equal(run.attempts.length,2,run.diagnostics.join('\n'));assert.equal(run.status,'awaiting_world');assert.equal(run.delivery,null);assert.equal(run.attempts[1]?.verification?.before.world,options.revision.world);assert.equal(run.attempts[1]?.verification?.checks.length,1);assert.throws(()=>readCompleteRun(storage(f)));
});
for(const bad of ['instructions','policy','limits','source','decisions','requirements','revision','decision','archive','old-candidate','protected','incumbent','partial-intent','missing-control','unrecorded-attempt','same-revision','unapproved','foreign-root'] as const)test(`E2b ${bad} refuses before a new backend or candidate switch`,{timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);const old=await runRepositoryTask(f.options);assert.equal(old.status,'delivered');const s=storage(f);let options:RepositoryRunOptions=approve(f);
 if(bad==='same-revision')options=f.options;
 if(bad==='unapproved')options={...options,revision:{...options.revision,id:'r-fabricated'}};
 if(bad==='foreign-root')options={...options,revision:{...options.revision,worldPath:join(f.host,'world.yaml')}};
 if(bad==='instructions')options={...options,instructions:'override'};
 if(bad==='policy')options={...options,policy:{...options.policy,allowedPaths:['other/']}};
 if(bad==='limits')options={...options,limits:{...options.limits,maxAttempts:99}};
 if(bad==='source')options={...options,source:f.host};
 if(bad==='decisions')options={...options,decisionsDir:f.host};
 if(bad==='requirements')options={...options,requirementsPath:options.worldPath};
 if(bad==='revision')options={...options,revision:{...options.revision,parentId:'foreign'}};
 if(bad==='decision')writeFileSync(join(f.options.decisionsDir,'p1.json'),'{}');
 if(bad==='archive')writeFileSync(options.revision.worldPath,'altered');
 if(bad==='old-candidate')writeFileSync(join(s.workspace,'src/a.ts'),'unrecorded bytes');
 if(bad==='protected')writeFileSync(join(s.workspace,'acceptance.txt'),'changed');
 if(bad==='incumbent')mkdirSync(join(s.artifactDir,'controller'));
 if(bad==='partial-intent')mkdirSync(join(s.artifactDir,'publication',s.runId,'generations','00000001'),{recursive:true});
 if(bad==='missing-control')rmSync(join(s.artifactDir,'inputs/controllers',s.runId,'original-control'),{recursive:true});
 if(bad==='unrecorded-attempt')mkdirSync(join(s.artifactDir,'attempts','a2'));
 const count=launches(f),before=readFileSync(join(s.workspace,'world.yaml'));const run=await runRepositoryTask(options);assert.equal(run.delivery,null);assert.equal(launches(f),count);assert.deepEqual(readFileSync(join(s.workspace,'world.yaml')),before);
 if(bad==='incumbent')assert.ok(existsSync(join(s.artifactDir,'controller')));
 if(bad==='partial-intent')assert.throws(()=>readCompleteRun(s));
});
test('E2b exhausted original budget cannot reserve a generation',{timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);const options={...f.options,limits:{...f.options.limits,maxAttempts:1}};const old=await runRepositoryTask(options);assert.equal(old.attempts.length,1);const approved={...approve(f),limits:options.limits};const count=launches(f);const run=await runRepositoryTask(approved);assert.equal(run.delivery,null);assert.equal(run.attempts.length,1);assert.equal(run.startedAt,old.startedAt);assert.equal(launches(f),count);assert.ok(!existsSync(join(f.options.artifactDir,'publication',f.options.runId,'generations')));
});
test('E2b any incomplete new generation fences old complete and checkpoint recovery', {timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);await runRepositoryTask(f.options);const s=storage(f);assert.equal(readCompleteRun(s).status,'delivered');
 mkdirSync(join(s.artifactDir,'publication',s.runId,'generations','00000001'),{recursive:true});assert.throws(()=>readCompleteRun(s));assert.throws(()=>readRunCheckpoint(s));
 assert.ok(readdirSync(join(s.artifactDir,'publication',s.runId)).includes('complete'));
});

test('E2b original deadline includes operator wait and expired dispatch stays zero',{timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);const options={...f.options,limits:{...f.options.limits,overallMs:2500}};const old=await runRepositoryTask(options);assert.equal(old.status,'delivered');const approved={...approve(f),limits:options.limits};await delay(Math.max(0,old.deadlineEpochMs-Date.now()+10));const count=launches(f);const run=await runRepositoryTask(approved);assert.equal(run.delivery,null);assert.equal(run.startedAt,old.startedAt);assert.equal(run.deadlineEpochMs,old.deadlineEpochMs);assert.equal(launches(f),count);assert.ok(!existsSync(join(f.options.artifactDir,'publication',f.options.runId,'generations')));
});
test('E2b fresh process restores frozen built-in backend and versioned readback',{timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);await runRepositoryTask(f.options);const options=approve(f);
 const loop=new URL('../src/agent/repository/loop.js',import.meta.url).href,backend=new URL('../src/agent/repository/codex_backend.js',import.meta.url).href;
 const script=`import {runRepositoryTask} from ${JSON.stringify(loop)};import {CodexBackend} from ${JSON.stringify(backend)};const options=${JSON.stringify({...options,backend:null,signal:null})};options.backend=new CodexBackend({executable:'/deliberately-missing',prefixArgs:[]});options.signal=new AbortController().signal;const r=await runRepositoryTask(options);console.log(JSON.stringify(r));process.exitCode=r.status==='delivered'?0:1;`;
 const p=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:15000});assert.equal(p.status,0,p.stdout+p.stderr);const run=JSON.parse(p.stdout);assert.equal(run.attempts.length,2);assert.deepEqual(readCompleteRun(storage(f)),run);
});
test('E2b binary additions deletions modes reconstruct and excluded outputs stay historical',{timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);const launcher=join(f.host,'launcher.cjs');writeFileSync(launcher,`const fs=require('fs'),path=require('path');const argv=process.argv.slice(2),cwd=argv[argv.indexOf('--cd')+1];const mode=fs.readFileSync(path.join(cwd,'world.yaml'),'utf8').includes('# approved exact revision')?'noop':'output-edits';process.argv.splice(2,0,mode,${JSON.stringify(f.host)});require(${JSON.stringify(hostFixture)});`);
 const verifier=join(f.host,'binary-check.cjs');writeFileSync(verifier,`const fs=require('fs'),path=require('path'),r=process.argv[2];if(fs.existsSync(path.join(r,'src/b.ts')) || !fs.readFileSync(path.join(r,'src/new.bin')).equals(Buffer.from([0,255,128])) || !(fs.statSync(path.join(r,'src/new.bin')).mode&0o111))process.exit(1);`);
 const policy={...f.policy,verifiers:[{...f.policy.verifiers[0]!,executable:process.execPath,argv:[verifier,'<candidate>'],programDigest:d(readFileSync(verifier,'utf8'))}]};
 const options={...f.options,policy,backend:new CodexBackend({executable:process.execPath,prefixArgs:[launcher]})};const old=await runRepositoryTask(options);assert.equal(old.status,'delivered',old.diagnostics.join('\n'));const approved={...approve(f),policy,backend:options.backend};const run=await runRepositoryTask(approved);assert.equal(run.status,'delivered',run.diagnostics.join('\n'));const s=storage(f);assert.deepEqual(readFileSync(join(s.workspace,'src/new.bin')),Buffer.from([0,255,128]));assert.ok(statSync(join(s.workspace,'src/new.bin')).mode&0o111);assert.ok(!existsSync(join(s.workspace,'src/b.ts')));assert.ok(!existsSync(join(s.workspace,'dist/output.bin')));assert.ok(existsSync(join(s.artifactDir,'publication',s.runId,'generations/00000001/previous-workspace/dist/output.bin')));
});
test('E2b overlapping continuation cannot steal controller and cancellation spends no extra attempt',{timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);let calls=0,release:()=>void=()=>{},entered:()=>void=()=>{};const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
 const backend={async run(...args:Parameters<typeof f.backend.run>){calls++;if(calls===2){entered();await gate;}return f.backend.run(...args);}};
 const options={...f.options,backend};const old=await runRepositoryTask(options);assert.equal(old.status,'delivered');const approved={...approve(f),backend};const pending=runRepositoryTask(approved);await ready;
 try {const abort=new AbortController();abort.abort();const overlap=await runRepositoryTask({...approved,signal:abort.signal});assert.equal(overlap.delivery,null);assert.equal(calls,2);assert.ok(existsSync(join(f.options.artifactDir,'controller')));assert.throws(()=>readCompleteRun(storage(f)));}finally{release();}
 const run=await pending;assert.equal(run.status,'delivered',run.diagnostics.join('\n'));assert.equal(run.attempts.length,2);assert.ok(!existsSync(join(f.options.artifactDir,'controller')));
});
test('E2b partial new complete cannot fall back to old grant and stranded intent refuses replay',{timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);await runRepositoryTask(f.options);const options=approve(f);const run=await runRepositoryTask(options);assert.equal(run.status,'delivered');const s=storage(f);rmSync(join(s.artifactDir,'publication',s.runId,'generations/00000001/complete'),{recursive:true});assert.throws(()=>readCompleteRun(s));const count=launches(f);const replay=await runRepositoryTask(options);assert.equal(replay.delivery,null);assert.equal(launches(f),count);assert.throws(()=>readCompleteRun(s));assert.ok(existsSync(join(s.artifactDir,'publication',s.runId,'complete')));
});
test('E2b second approved successor is explicitly outside bounded v1',{timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);await runRepositoryTask(f.options);const first=approve(f);const delivered=await runRepositoryTask(first);assert.equal(delivered.status,'delivered');
 const p=proposeWorldChange({runId:f.options.runId,proposalId:'p2',base:first.revision,patch:readFileSync(first.revision.worldPath,'utf8')+'# successor two\n',artifactDir:f.options.artifactDir,rationale:'SCRIPTED second successor test',requirements:f.binding.requirements});const path=join(f.options.decisionsDir,'p2.json');const decision:OperatorDecision={command:'approve-world',operator:'SCRIPTED',runId:p.runId,proposalId:p.proposalId,proposalDigest:p.proposalDigest,baseRevisionId:p.base.id,baseWorld:p.base.world,patchDigest:p.patchDigest,recordedAt:new Date().toISOString()};writeFileSync(path,JSON.stringify(decision));const revision=activateWorldRevision({proposal:p,current:first.revision,decisionPath:path,decisionsDir:f.options.decisionsDir,runId:p.runId,historicalReceiptIds:[]});assert.equal(revision.state,'active');const count=launches(f);const run=await runRepositoryTask({...f.options,revision,worldPath:revision.worldPath,seamPaths:revision.seamPaths});assert.equal(run.delivery,null);assert.equal(launches(f),count);assert.deepEqual(readCompleteRun(storage(f)),delivered);
});
for(const mode of ['quota','malformed'] as const)test(`E2b ${mode} is fenced even by a new exact approved archive`,{timeout:20_000},async t=>{
 const f=fixture(mode);t.after(f.cleanup);const old=await runRepositoryTask(f.options);assert.equal(old.status,'blocked');const approved=approve(f),count=launches(f);const run=await runRepositoryTask(approved);assert.equal(run.delivery,null);assert.equal(run.attempts.length,old.attempts.length);assert.equal(launches(f),count);assert.ok(!existsSync(join(f.options.artifactDir,'publication',f.options.runId,'generations')));
});
for(const variant of ['started-null-pid','unknown-effect','partial-verifier','source-head','source-dirty','excluded-hardlink'] as const)test(`E2b ${variant} fences before transition`,{timeout:20_000},async t=>{
 const f=fixture('noop','requirement');t.after(f.cleanup);await runRepositoryTask(f.options);const approved=approve(f),s=storage(f),count=launches(f);
 if(variant==='started-null-pid' || variant==='unknown-effect') {
  // Deliberate negative JSON inputs only: no passing receipt is created or upgraded.
  const dir=join(s.artifactDir,'publication',s.runId,'checkpoints');const latest=join(dir,readdirSync(dir).sort().at(-1)!,'record.json');const checkpoint=JSON.parse(readFileSync(latest,'utf8'));
  if(variant==='started-null-pid'){checkpoint.record.attempts[0].backend.process.pid=null;checkpoint.record.attempts[0].backend.process.treeStopped='unknown';}
  else checkpoint.record.effects.push({operationId:'uncertain',outcome:'unknown',reconciliation:'unavailable',effectCount:'unknown',checkerRollback:false,trace:[]});
  writeFileSync(latest,JSON.stringify(checkpoint));
 }
 if(variant==='partial-verifier')mkdirSync(join(s.artifactDir,'verification',s.runId,'a1','invocation-stranded'));
 if(variant==='source-head'){const p=spawnSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','drift'],{cwd:f.source});assert.equal(p.status,0);}
 if(variant==='source-dirty')writeFileSync(join(f.source,'src/a.ts'),'source drift');
 if(variant==='excluded-hardlink'){mkdirSync(join(s.workspace,'dist'));const {linkSync}=await import('node:fs');linkSync(join(s.workspace,'src/a.ts'),join(s.workspace,'dist/alias'));}
 const run=await runRepositoryTask(approved);assert.equal(run.delivery,null);assert.equal(launches(f),count);assert.ok(!existsSync(join(s.artifactDir,'publication',s.runId,'generations')),run.diagnostics.join('\n'));
});

test('E2b valid negative history with started process and null pid fences unknown closure',{timeout:20_000},async t=>{
 const f=fixture();t.after(f.cleanup);
 const backend={async run(...args:Parameters<typeof f.backend.run>){const actual=await f.backend.run(...args);assert.equal(actual.process.treeStopped,true);const negative={...actual,status:'launch_failed' as const,process:{...actual.process,pid:null,treeStopped:'unknown' as const},candidate:null};writeFileSync(join(args[0].artifactDir,'attempts',args[0].attemptId,'process.json'),JSON.stringify(negative));return negative;}};
 // This is deliberately negative JSON testinput retaining real launch logs, never a passing receipt.
 const old=await runRepositoryTask({...f.options,backend});assert.equal(old.status,'blocked');assert.equal(old.attempts[0]?.backend.process.pid,null);assert.ok(old.attempts[0]?.backend.process.startedAt);const count=launches(f);const run=await runRepositoryTask({...approve(f),backend});assert.equal(run.attempts.length,1);assert.equal(run.delivery,null);assert.match(run.diagnostics.at(-1)??'',/unresolved prior process tree/);assert.equal(launches(f),count);
});
