import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from './repository_test_support.js';
import { initializeRun, checkpointRun, publishRun, readCompleteRun, readRunStart, readRunCheckpoint } from '../src/agent/repository/publication.js';
import { createVerificationContext } from '../src/agent/repository/context.js';
import { captureIdentity } from '../src/agent/repository/identity.js';
import { verifyCandidate } from '../src/agent/repository/verify.js';
import { validateDelivery } from '../src/agent/repository/artifacts.js';
import { hashBytes } from '../src/agent/repository/workspace.js';
import type { RepositoryRunRecord } from '../src/agent/repository/contracts.js';
async function setup(t: import('node:test').TestContext) {
 const f=fixture();t.after(f.cleanup);
 const code='console.log("actual publication verifier")';writeFileSync(join(f.host,'verify.cjs'),code);
 const policy={...f.policy,verifiers:[{...f.policy.verifiers[0]!,programDigest:hashBytes(code)}]};
 const storage={...f.options,workspace:f.source,policy};
 let header!:ReturnType<typeof initializeRun>;
 assert.doesNotThrow(()=>{header=initializeRun(storage);},'original run must initialize');
 const binding=captureIdentity({...f.options,workspace:f.source,policy,revisionId:'r0'});
 createVerificationContext({...storage,revisionId:'r0',expected:binding});
 const empty:RepositoryRunRecord={schema:'kadmos.repository.v1',runId:f.options.runId,status:'incomplete',limits:header.limits,startedAt:header.startedAt,deadlineEpochMs:header.deadlineEpochMs,attempts:[],revisions:[f.revision],effects:[],delivery:null,diagnostics:[]};
 checkpointRun(storage,empty);
 // Both processes are real. Backend exit alone never grants authority.
 const backend=await f.backend.run({...f.task,binding,limits:header.limits,deadlineEpochMs:header.deadlineEpochMs},f.options.signal);
 assert.equal(backend.status,'exited');assert.equal(backend.process.treeStopped,true);
 const receipt=await verifyCandidate({...f.verification,policy,binding,limits:header.limits,deadlineEpochMs:header.deadlineEpochMs},f.options.signal);
 assert.equal(receipt.status,'passed');
 const eligibility=validateDelivery({workspace:f.source,policy,receipt,expected:binding,requiredCheckIds:['acceptance'],unresolvedEffects:[]});
 assert.equal(eligibility.status,'eligible');
 const incomplete:RepositoryRunRecord={...empty,attempts:[{id:'a1',revisionId:'r0',backend,verification:receipt,route:'NEEDS_REVIEW'}]};
 const complete:RepositoryRunRecord={...incomplete,status:'delivered',delivery:eligibility.manifest};
 return {f,storage,header,empty,incomplete,complete};
}
// Break caught: pending implementation or a grant without atomic final marker/readback.
test('publication grants only after real verifier, immutable checkpoint and complete readback',async t=>{
 const {f,storage,incomplete,complete}=await setup(t);
 assert.throws(()=>readCompleteRun(storage));checkpointRun(storage,incomplete);
 assert.deepEqual(publishRun(storage,complete),complete);assert.deepEqual(readCompleteRun(storage),complete);
 const script=`import {readCompleteRun} from ${JSON.stringify(new URL('../src/agent/repository/publication.js',import.meta.url).href)};console.log(readCompleteRun(${JSON.stringify(storage)}).status)`;
 // Serialize only trusted storage fields (not backend/signal).
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'delivered');
 assert.match(readFileSync(complete.attempts[0]!.verification!.checks[0]!.process.stdoutPath,'utf8'),/actual publication verifier/);
 assert.throws(()=>publishRun(storage,complete));assert.throws(()=>initializeRun(storage));
 assert.throws(()=>checkpointRun(storage,incomplete));
});
for(const mode of ['no-checkpoint','forged-receipt','wrong-run','wrong-attempt','wrong-revision','wrong-policy','stale-manifest','unknown-effect','budget-reset','deadline-reset','old-start','over-budget','stale-history','backend-lifecycle','candidate-change','missing-context','missing-receipt','modified-log','missing-lifecycle','stranded-final'] as const)test(`publication refuses ${mode}`,async t=>{
 const x=await setup(t);let r=x.complete;
 if(!['no-checkpoint','forged-receipt'].includes(mode))checkpointRun(x.storage,x.incomplete);
 const v=r.attempts[0]!.verification!,p=v.checks[0]!.process;
 if(mode==='forged-receipt')r={...r,attempts:[{...r.attempts[0]!,verification:JSON.parse(JSON.stringify(v))}]};
 if(mode==='wrong-run')r={...r,runId:'other'};
 if(mode==='wrong-attempt')r={...r,attempts:[{...r.attempts[0]!,id:'other'}]};
 if(mode==='wrong-revision')r={...r,revisions:[{...x.f.revision,id:'r1'}]};
 if(mode==='wrong-policy')x.storage.policy={...x.storage.policy,allowedPaths:['other/']};
 if(mode==='stale-manifest')r={...r,delivery:{...r.delivery!,files:[]}};
 if(mode==='unknown-effect')r={...r,effects:[{operationId:'op1',outcome:'unknown',reconciliation:'unavailable',effectCount:'unknown',checkerRollback:true,trace:[]}]};
 if(mode==='budget-reset')r={...r,limits:{...r.limits,maxAttempts:999}};
 if(mode==='deadline-reset')r={...r,deadlineEpochMs:r.deadlineEpochMs+1000};
 if(mode==='old-start')r={...r,startedAt:new Date(Date.parse(r.startedAt)-1000).toISOString()};
 if(mode==='over-budget')r={...r,attempts:Array.from({length:4},(_,i)=>({...r.attempts[0]!,id:'a'+i}))};
 if(mode==='backend-lifecycle')r={...r,attempts:[{...r.attempts[0]!,backend:{...r.attempts[0]!.backend,process:{...r.attempts[0]!.backend.process,treeStopped:'unknown'}}}]};
 if(mode==='candidate-change')writeFileSync(join(x.f.source,'src/a.ts'),'late write');
 if(mode==='missing-context')rmSync(join(x.storage.artifactDir,'inputs'),{recursive:true});
 if(mode==='missing-receipt')rmSync(join(p.stdoutPath,'..','receipt'),{recursive:true});
 if(mode==='modified-log')writeFileSync(p.stdoutPath,'forged output');
 if(mode==='missing-lifecycle')rmSync(p.stdoutPath+'.lifecycle.json');
 if(mode==='stranded-final')mkdirSync(join(x.storage.artifactDir,'publication',x.storage.runId,'complete'),{recursive:true});
 if(mode==='stale-history')r={...r,attempts:[]};
 if(mode==='unknown-effect'){checkpointRun(x.storage,{...r,status:'incomplete',delivery:null});assert.throws(()=>checkpointRun(x.storage,x.incomplete));}
 if(mode==='forged-receipt')assert.throws(()=>checkpointRun(x.storage,{...r,status:'incomplete',delivery:null}));
 assert.throws(()=>publishRun(x.storage,r));assert.throws(()=>readCompleteRun(x.storage));
});
for(const mode of ['candidate','manifest','receipt','log','lifecycle','checkpoint','header','extra-checkpoint','temp','symlink'] as const)test(`complete readback refuses changed or missing ${mode}`,async t=>{
 const {f,storage,incomplete,complete}=await setup(t);checkpointRun(storage,incomplete);publishRun(storage,complete);
 const root=join(storage.artifactDir,'publication',storage.runId),p=complete.attempts[0]!.verification!.checks[0]!.process;
 if(mode==='candidate')writeFileSync(join(f.source,'src/a.ts'),'late');
 if(mode==='manifest')writeFileSync(join(root,'manifest','record.json'),'{}');
 if(mode==='receipt')rmSync(join(p.stdoutPath,'..','receipt'),{recursive:true});
 if(mode==='log')writeFileSync(p.stdoutPath,'changed');
 if(mode==='lifecycle')rmSync(p.stdoutPath+'.lifecycle.json');
 if(mode==='checkpoint')rmSync(join(root,'checkpoints'),{recursive:true});
 if(mode==='header')writeFileSync(join(root,'start','record.json'),'{}');
 if(mode==='extra-checkpoint')mkdirSync(join(root,'checkpoints','00000003'));
 if(mode==='temp')writeFileSync(join(root,'complete','.record.stranded.tmp'),'partial');
 if(mode==='symlink'){const out=p.stdoutPath+'.copy';writeFileSync(out,readFileSync(p.stdoutPath));rmSync(p.stdoutPath);symlinkSync(out,p.stdoutPath);}
 assert.throws(()=>readCompleteRun(storage));
});
test('original budget survives revision checkpoints and expired incomplete replay',async t=>{
 const {storage,empty,header}=await setup(t);
 const next={...empty,revisions:[...empty.revisions,{...empty.revisions[0]!,id:'r1',parentId:'r0'}]};
 checkpointRun(storage,next);
 assert.throws(()=>checkpointRun(storage,{...next,deadlineEpochMs:header.deadlineEpochMs+1000}));
 assert.throws(()=>checkpointRun(storage,empty),'cannot drop revision history');
 const names=readdirSync(join(storage.artifactDir,'publication',storage.runId,'checkpoints'));
 assert.equal(names.length,2);
});
for(const mode of ['id','inside-source','alias'] as const)test(`publication refuses unsafe ${mode}`,t=>{
 const f=fixture();t.after(f.cleanup);let artifactDir=f.options.artifactDir,runId=f.options.runId;
 if(mode==='id')runId='../escape';if(mode==='inside-source')artifactDir=join(f.source,'artifacts');
 if(mode==='alias'){mkdirSync(artifactDir,{recursive:true});const alias=join(f.host,'alias');symlinkSync(artifactDir,alias);artifactDir=alias;}
 assert.throws(()=>initializeRun({...f.options,workspace:f.source,artifactDir,runId}));
});

// Break caught: recovery must reuse persisted real authority without resetting budget or requiring old JS object identity.
test('recovered host checkpoint extends history and publishes with original budget',async t=>{
 const {f,storage,incomplete,header}=await setup(t);checkpointRun(storage,incomplete);
 let recovered!:RepositoryRunRecord;assert.doesNotThrow(()=>{recovered=readRunCheckpoint(storage)!;});assert.deepEqual(recovered,incomplete);
 const revision={...f.revision,id:'r1',parentId:'r0'};
 const binding=captureIdentity({...f.options,workspace:f.source,policy:storage.policy,revisionId:'r1'});
 createVerificationContext({...storage,revisionId:'r1',expected:binding});
 const backend=await f.backend.run({...f.task,attemptId:'a2',binding,limits:header.limits,deadlineEpochMs:header.deadlineEpochMs},f.options.signal);
 const verification=await verifyCandidate({...f.verification,attemptId:'a2',binding,policy:storage.policy,limits:header.limits,deadlineEpochMs:header.deadlineEpochMs},f.options.signal);
 assert.equal(verification.status,'passed');assert.equal(backend.status,'exited');
 const next:RepositoryRunRecord={...recovered,revisions:[...recovered.revisions,revision],attempts:[...recovered.attempts,{id:'a2',revisionId:'r1',backend,verification,route:'NEEDS_REVIEW'}]};
 assert.doesNotThrow(()=>checkpointRun(storage,next));
 const manifest=validateDelivery({workspace:f.source,policy:storage.policy,receipt:verification,expected:binding,requiredCheckIds:['acceptance'],unresolvedEffects:[]}).manifest;
 const done=publishRun(storage,{...next,status:'delivered',delivery:manifest});assert.equal(done.attempts.length,2);assert.equal(done.deadlineEpochMs,header.deadlineEpochMs);assert.equal(done.startedAt,header.startedAt);
});
test('expired original header replays incomplete history and refuses budget renewal',async t=>{
 const f=fixture();t.after(f.cleanup);const storage={...f.options,workspace:f.source,limits:{...f.options.limits,overallMs:1}};
 const h=initializeRun(storage);await new Promise(resolve=>setTimeout(resolve,10));
 const r:RepositoryRunRecord={schema:'kadmos.repository.v1',runId:storage.runId,status:'incomplete',limits:h.limits,startedAt:h.startedAt,deadlineEpochMs:h.deadlineEpochMs,attempts:[],revisions:[f.revision],effects:[],delivery:null,diagnostics:[]};
 checkpointRun(storage,r);assert.deepEqual(readRunCheckpoint(storage),r);assert.deepEqual(readRunStart(storage),h);assert.throws(()=>initializeRun(storage));
 assert.throws(()=>checkpointRun(storage,{...r,deadlineEpochMs:Date.now()+10000}));assert.throws(()=>publishRun(storage,{...r,status:'delivered'}));
});
test('incomplete launch evidence is preserved but never grants delivery',async t=>{
 const f=fixture('noop','missing');t.after(f.cleanup);const storage={...f.options,workspace:f.source};
 const h=initializeRun(storage),binding=captureIdentity({...f.options,workspace:f.source,revisionId:'r0'});
 createVerificationContext({...storage,revisionId:'r0',expected:binding});
 const backend=await f.backend.run({...f.task,binding,limits:h.limits,deadlineEpochMs:h.deadlineEpochMs},f.options.signal);
 const verification=await verifyCandidate({...f.verification,binding,limits:h.limits,deadlineEpochMs:h.deadlineEpochMs},f.options.signal);
 assert.equal(verification.checks[0]?.status,'launch_failed');
 const r:RepositoryRunRecord={schema:'kadmos.repository.v1',runId:storage.runId,status:'blocked',limits:h.limits,startedAt:h.startedAt,deadlineEpochMs:h.deadlineEpochMs,attempts:[{id:'a1',revisionId:'r0',backend,verification,route:'ENVIRONMENT_BLOCKED'}],revisions:[f.revision],effects:[],delivery:null,diagnostics:['launch failure retained']};
 assert.doesNotThrow(()=>checkpointRun(storage,r));assert.throws(()=>publishRun(storage,{...r,status:'delivered'}));
});
for(const stage of ['checkpoint','readback'] as const)test(`stranded writer refuses ${stage} until trusted host recovery`,async t=>{
 const {storage,empty,incomplete,complete}=await setup(t);
 if(stage==='readback'){checkpointRun(storage,incomplete);publishRun(storage,complete);}
 mkdirSync(join(storage.artifactDir,'publication',storage.runId,'writer'));
 if(stage==='checkpoint')assert.throws(()=>checkpointRun(storage,empty));else assert.throws(()=>readCompleteRun(storage));
});
for(const mode of ['backend','verifier'] as const)test(`unrecorded later real ${mode} cannot borrow older delivery`,async t=>{
 const {f,storage,incomplete,complete,header}=await setup(t);checkpointRun(storage,incomplete);
 if(mode==='backend')await f.backend.run({...f.task,attemptId:'a2',limits:header.limits,deadlineEpochMs:header.deadlineEpochMs},f.options.signal);
 else await verifyCandidate({...f.verification,policy:storage.policy,binding:complete.delivery!.binding,limits:header.limits,deadlineEpochMs:header.deadlineEpochMs},f.options.signal);
 assert.throws(()=>publishRun(storage,complete));assert.throws(()=>readCompleteRun(storage));
});
test('real pre-allocation refusal remains checkpointable without inventing receipts',async t=>{
 const f=fixture();t.after(f.cleanup);const storage={...f.options,workspace:f.source},h=initializeRun(storage);
 const backend=await f.backend.run({...f.task,limits:h.limits,deadlineEpochMs:h.deadlineEpochMs},f.options.signal);
 // Deliberately no host context: the real verifier cannot allocate an invocation.
 const verification=await verifyCandidate({...f.verification,limits:h.limits,deadlineEpochMs:h.deadlineEpochMs},f.options.signal);
 assert.equal(verification.status,'incomplete');assert.equal(verification.checks.length,0);
 const r:RepositoryRunRecord={schema:'kadmos.repository.v1',runId:storage.runId,status:'blocked',limits:h.limits,startedAt:h.startedAt,deadlineEpochMs:h.deadlineEpochMs,attempts:[{id:'a1',revisionId:'r0',backend,verification,route:'ENVIRONMENT_BLOCKED'}],revisions:[f.revision],effects:[],delivery:null,diagnostics:verification.diagnostics};
 assert.doesNotThrow(()=>checkpointRun(storage,r));assert.deepEqual(readRunCheckpoint(storage),r);assert.throws(()=>publishRun(storage,{...r,status:'delivered'}));
});
