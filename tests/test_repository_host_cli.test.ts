import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { hostFixture, fixture, d } from './repository_test_support.js';
import { readControl } from '../src/agent/repository/control.js';
import { readCompleteRun } from '../src/agent/repository/publication.js';
const schema='kadmos.repository.v1';
function invoke(f:ReturnType<typeof fixture>,command:string,value:unknown,context=true,inputPath=join(f.host,'command.json')) {
 writeFileSync(inputPath,JSON.stringify(value));
 return spawnSync(process.execPath,[resolve('bin/kadmos.js'),'repo',command,'--input',inputPath,...(context&&['approve-world','reject-world'].includes(command)?['--artifact-dir',f.options.artifactDir]:[])],{encoding:'utf8',timeout:20000});
}
function setup(t:{after(fn:()=>void):void},custom=false,overrides:Record<string,unknown>={},continuationMode?:string,startupDelayMs=0) {
 const f=fixture();t.after(f.cleanup);
 const verifier=join(f.host,'world-check.cjs');
 writeFileSync(verifier,`const fs=require('fs'),p=require('path');if(!fs.readFileSync(p.join(process.argv[2],'world.yaml'),'utf8').includes('# SCRIPTED successor')){console.error('KADMOS_REQUIREMENT_UNEXPRESSIBLE: SCRIPTED revision needed');process.exit(1);}`);
 const policy={...f.policy,verifiers:[{...f.policy.verifiers[0]!,argv:[verifier,'<candidate>'],programDigest:d(readFileSync(verifier,'utf8')),failureKind:'requirement' as const,resultProtocol:'exit-v1' as const}]};
 let backendConfig=f.backend.options;
 if(continuationMode){const launcher=join(f.host,'scripted-launcher.cjs');writeFileSync(launcher,`const fs=require('fs'),path=require('path'),a=process.argv.slice(2);if(a.includes('--version')){console.log('SCRIPTED v1');process.exit(0);}const root=a[a.indexOf('--cd')+1],mode=fs.readFileSync(path.join(root,'world.yaml'),'utf8').includes('# SCRIPTED successor')?${JSON.stringify(continuationMode)}:'noop';process.argv.splice(2,0,mode,${JSON.stringify(f.host)});require(${JSON.stringify(hostFixture)});`);backendConfig={executable:process.execPath,prefixArgs:[launcher]};}
 if(startupDelayMs){const launcher=join(f.host,'delayed-scripted-launcher.cjs');writeFileSync(launcher,`setTimeout(()=>{process.argv.splice(2,0,'noop',${JSON.stringify(f.host)});require(${JSON.stringify(hostFixture)});},${startupDelayMs});`);backendConfig={executable:process.execPath,prefixArgs:[launcher]};}
 const {backend,signal,revision,...rest}=f.options;
 const value={...rest,schema,revisionId:revision.id,policy,backend:backendConfig,limits:{...f.options.limits,attemptMs:5000,overallMs:60000},...(custom?{decisionsDir:join(f.host,'separate-decisions')}:{} ),...overrides};
 const initial=invoke(f,'run',value);assert.equal(initial.status,1,initial.stderr);const old=JSON.parse(initial.stdout);assert.equal(old.status,'awaiting_world',initial.stdout);
 const proposal={schema,runId:old.runId,proposalId:'scripted-p1',artifactDir:f.options.artifactDir,baseRevisionId:revision.id,baseWorld:revision.world,requirements:f.binding.requirements,patch:readFileSync(f.options.worldPath,'utf8')+'\n# SCRIPTED successor\n',rationale:'SCRIPTED host CLI test'};
 return {f,old,proposal};
}
function propose(x:ReturnType<typeof setup>){const p=invoke(x.f,'propose-world',x.proposal);assert.equal(p.status,0,p.stderr+p.stdout);return JSON.parse(p.stdout);}
function decision(p:ReturnType<typeof JSON.parse>,command='approve-world') {return {command,operator:'SCRIPTED operator',runId:p.runId,proposalId:p.proposalId,proposalDigest:p.proposalDigest,baseRevisionId:p.base.id,baseWorld:p.base.world,patchDigest:p.patchDigest,recordedAt:'2026-10-21T00:00:00.000Z'};}
function count(f:ReturnType<typeof fixture>){return readFileSync(join(f.host,'launches'),'utf8');}
for(const custom of [false,true])test(`E2c CLI paused proposal approval fresh continuation (custom decisions ${custom})`,{timeout:25000},t=>{
 const x=setup(t,custom),p=propose(x),c=readControl({artifactDir:x.f.options.artifactDir,runId:p.runId});
 assert.equal(p.proposalDigest,d(JSON.stringify({runId:p.runId,proposalId:p.proposalId,baseRevisionId:p.base.id,baseWorld:p.base.world,requirements:p.requirements,patchDigest:p.patchDigest,rationale:p.rationale})));
 const approved=invoke(x.f,'approve-world',decision(p));assert.equal(approved.status,0,approved.stderr+approved.stdout);const r=JSON.parse(approved.stdout).revision;assert.equal(r.state,'active');
 assert.equal(count(x.f),'1\n');const continued=invoke(x.f,'continue',{schema,runId:p.runId,artifactDir:p.artifactDir,revisionId:r.id});assert.equal(continued.status,0,continued.stderr+continued.stdout);const run=JSON.parse(continued.stdout);
 assert.equal(run.status,'delivered');assert.equal(run.attempts.length,2);assert.deepEqual(run.attempts[0],x.old.attempts[0]);assert.equal(run.startedAt,x.old.startedAt);assert.equal(run.deadlineEpochMs,x.old.deadlineEpochMs);assert.deepEqual(run.limits,x.old.limits);
 assert.equal(run.delivery.binding.world,p.patchDigest);assert.equal(run.delivery.binding.revisionId,r.id);assert.equal(run.delivery.binding.seam,r.seam);assert.equal(run.attempts[1].verification.checks[0].command.resultProtocol,'exit-v1');
 const stored=readCompleteRun({artifactDir:c.artifactDir,runId:c.runId,workspace:c.header.workspace,policy:c.policy});assert.deepEqual(stored.delivery,run.delivery);
 assert.equal(readFileSync(c.roles.worldPath,'utf8'),readFileSync(x.f.options.worldPath,'utf8'));assert.equal(readFileSync(join(c.header.workspace,'world.yaml'),'utf8'),p.patch);
 const before=count(x.f);for(const cmd of ['propose-world','approve-world','continue']){const v=cmd==='propose-world'?{...x.proposal,proposalId:'second'}:cmd==='approve-world'?decision(p):{schema,runId:p.runId,artifactDir:p.artifactDir,revisionId:r.id};assert.equal(invoke(x.f,cmd,v).status,1);assert.equal(count(x.f),before);}
});
test('E2c CLI deliberate rejection persists once without active generation or World mutation',{timeout:25000},t=>{
 const x=setup(t),p=propose(x),before=count(x.f);const rejected=invoke(x.f,'reject-world',decision(p,'reject-world'));assert.equal(rejected.status,0,rejected.stderr);assert.equal(JSON.parse(rejected.stdout).status,'rejected');
 assert.equal(invoke(x.f,'approve-world',decision(p)).status,1);assert.equal(invoke(x.f,'reject-world',decision(p,'reject-world')).status,1);assert.equal(count(x.f),before);
 assert.equal(existsSync(join(p.artifactDir,'publication',p.runId,'generations')),false);assert.equal(existsSync(join(p.artifactDir,'inputs/revisions',p.runId,`r-${p.proposalDigest.slice(7)}`)),false);
});

test('E2c CLI malformed, stale, candidate, root and command inputs cannot trust a decision or call backend',{timeout:25000},t=>{
 const x=setup(t),p=propose(x),valid=decision(p),c=readControl({artifactDir:p.artifactDir,runId:p.runId}),before=count(x.f);
 const bads:Record<string,unknown>[]=[{...valid,operator:''},{...valid,recordedAt:'2026-10-21T00:00:00Z'},{...valid,proposalDigest:d('stale')},{...valid,baseRevisionId:'stale'},{...valid,baseWorld:d('stale')},{...valid,patchDigest:d('stale')},{...valid,runId:'other'},{...valid,proposalId:'absent'},{...valid,command:'reject-world'},{...valid,active:true},{...valid,artifactDir:p.artifactDir}];
 for(const value of bads){const result=invoke(x.f,'approve-world',value);assert.equal(result.status,1,result.stdout);}
 assert.equal(invoke(x.f,'approve-world',valid,false).status,1);
 const file=join(c.header.workspace,'src/forged.json');assert.equal(invoke(x.f,'approve-world',valid,true,file).status,1);rmSync(file);
 const sourceFile=join(x.f.source,'src/forged.json');assert.equal(invoke(x.f,'approve-world',valid,true,sourceFile).status,1);rmSync(sourceFile);
 const hostFile=join(x.f.host,'host-decision.json');writeFileSync(hostFile,JSON.stringify(valid));
 for(const args of [['approve-world','--input',hostFile,'--artifact-dir',x.f.source],['approve-world','--input',hostFile,'--artifact-dir',p.artifactDir,'--extra'],['approve-world','--input',hostFile,'--decisions-dir',c.decisionsDir],['continue','--input',hostFile,'--model','x']]){const r=spawnSync(process.execPath,[resolve('bin/kadmos.js'),'repo',...args],{encoding:'utf8',timeout:10000});assert.equal(r.status,1);}
 assert.equal(count(x.f),before);assert.equal(existsSync(join(c.decisionsDir,p.runId,p.proposalId)),false);
 const approved=invoke(x.f,'approve-world',valid);assert.equal(approved.status,0,approved.stderr);const r=JSON.parse(approved.stdout).revision;
 for(const value of [{schema,runId:p.runId,artifactDir:p.artifactDir,revisionId:r.id,limits:{maxAttempts:99}},{schema,runId:p.runId,artifactDir:p.artifactDir,revisionId:'unapproved'},{schema,runId:p.runId,artifactDir:p.artifactDir,revisionId:'r0'},{schema,runId:p.runId,artifactDir:x.f.source,revisionId:r.id}])assert.equal(invoke(x.f,'continue',value).status,1);
 assert.equal(count(x.f),before);assert.equal(existsSync(join(p.artifactDir,'publication',p.runId,'generations')),false);
});

for(const field of ['baseRevisionId','baseWorld','requirements','unknown','artifactDir'] as const)test(`E2c proposal ${field} refusal has zero dispatch`,{timeout:20000},t=>{
 const x=setup(t),before=count(x.f),v:Record<string,unknown>={...x.proposal};v[field]=field==='unknown'?true:field==='artifactDir'?x.f.source:field==='baseRevisionId'?'stale':d('stale');
 assert.equal(invoke(x.f,'propose-world',v).status,1);assert.equal(count(x.f),before);assert.equal(existsSync(join(x.proposal.artifactDir,'proposals')),false);
});
test('E2c delayed physical CLI startup still reaches World refusal with zero additional dispatch',{timeout:20000},t=>{
 const x=setup(t,false,{},undefined,1200),attempt=x.old.attempts[0];
 assert.equal(x.old.status,'awaiting_world');assert.equal(x.old.attempts.length,1);assert.equal(x.old.delivery,null);
 assert.equal(attempt.backend.status,'exited');assert.equal(attempt.backend.process.exitCode,0);assert.equal(attempt.backend.process.treeStopped,true);
 assert.ok(Date.parse(attempt.backend.process.endedAt)-Date.parse(attempt.backend.process.startedAt)>=1200);
 const wire=JSON.parse(readFileSync(join(x.f.host,'invocation.json'),'utf8'));
 const control=readControl({artifactDir:x.f.options.artifactDir,runId:x.old.runId});
 assert.deepEqual(wire.argv,['exec','--json','--color','never','--sandbox','workspace-write','--cd',control.header.workspace,'-']);
 assert.equal(wire.cwd,control.header.workspace);assert.equal(wire.selectedCwd,control.header.workspace);
 assert.equal(wire.input,readFileSync(join(x.f.options.artifactDir,'attempts/a1/stdin.txt'),'utf8'));assert.match(wire.input,/Implement fixture/);
 const events=readFileSync(attempt.backend.process.stdoutPath,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(events.map(event=>event.type),['thread.started','item.completed','turn.completed']);
 assert.equal(count(x.f),'1\n');const before=count(x.f);
 const refused=invoke(x.f,'propose-world',{...x.proposal,baseWorld:d('stale')});
 assert.equal(refused.status,1);assert.match(refused.stderr,/proposal base\/requirements mismatch/);
 assert.equal(count(x.f),before);assert.equal(existsSync(join(x.proposal.artifactDir,'proposals')),false);
});
test('E2c exhausted initial CLI budget refuses proposal without archive or new dispatch',{timeout:20000},t=>{
 const x=setup(t,false,{limits:{maxAttempts:1,attemptMs:2000,verifierMs:3000,overallMs:60000,killGraceMs:100}}),before=count(x.f);
 const r=invoke(x.f,'propose-world',x.proposal);assert.equal(r.status,1);assert.match(r.stderr,/budget/);assert.equal(count(x.f),before);assert.equal(existsSync(join(x.proposal.artifactDir,'proposals')),false);
});
test('E2c expired approved CLI continuation preserves original deadline and zero dispatch',{timeout:15000},async t=>{
 const x=setup(t,false,{limits:{maxAttempts:3,attemptMs:2000,verifierMs:3000,overallMs:4000,killGraceMs:100}}),p=propose(x);
 const a=invoke(x.f,'approve-world',decision(p));assert.equal(a.status,0,a.stderr);const revision=JSON.parse(a.stdout).revision,before=count(x.f);
 await delay(Math.max(0,x.old.deadlineEpochMs-Date.now()+20));const r=invoke(x.f,'continue',{schema,runId:p.runId,artifactDir:p.artifactDir,revisionId:revision.id});assert.equal(r.status,1);assert.match(r.stderr,/budget/);assert.equal(count(x.f),before);assert.equal(existsSync(join(p.artifactDir,'publication',p.runId,'generations')),false);
});
test('E2c CLI continuation cancellation reaches saved SCRIPTED backend and cleans listeners',{timeout:20000},async t=>{
 const x=setup(t,false,{limits:{maxAttempts:3,attemptMs:10000,verifierMs:3000,overallMs:60000,killGraceMs:150}},'hang'),p=propose(x);
 const a=invoke(x.f,'approve-world',decision(p));assert.equal(a.status,0,a.stderr);const revision=JSON.parse(a.stdout).revision,file=join(x.f.host,'continue.json');writeFileSync(file,JSON.stringify({schema,runId:p.runId,artifactDir:p.artifactDir,revisionId:revision.id}));
 const child=spawn(process.execPath,[resolve('bin/kadmos.js'),'repo','continue','--input',file],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);const done=new Promise<number|null>(res=>child.once('exit',res));t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 const until=Date.now()+6000;while(!existsSync(join(x.f.host,'child.pid'))&&Date.now()<until)await delay(25);assert.ok(existsSync(join(x.f.host,'child.pid')),err);child.kill('SIGTERM');assert.equal(await done,1,err);const r=JSON.parse(out);assert.equal(r.delivery,null);assert.equal(r.attempts.length,2);assert.equal(r.attempts[1].backend.status,'cancelled');assert.equal(r.attempts[1].backend.process.treeStopped,true);assert.equal(r.deadlineEpochMs,x.old.deadlineEpochMs);
 const before=count(x.f);assert.equal(invoke(x.f,'continue',{schema,runId:p.runId,artifactDir:p.artifactDir,revisionId:revision.id}).status,1);assert.equal(count(x.f),before);assert.equal(existsSync(join(p.artifactDir,'controller')),false);
});
test('E2c saved CLI backend failure cannot publish a complete grant',{timeout:20000},t=>{
 const x=setup(t,false,{},'quota'),p=propose(x),a=invoke(x.f,'approve-world',decision(p));assert.equal(a.status,0,a.stderr);const revision=JSON.parse(a.stdout).revision;
 const r=invoke(x.f,'continue',{schema,runId:p.runId,artifactDir:p.artifactDir,revisionId:revision.id});assert.equal(r.status,1,r.stderr);const run=JSON.parse(r.stdout);assert.equal(run.status,'blocked');assert.equal(run.delivery,null);assert.equal(run.attempts.length,2);assert.equal(run.attempts[1].backend.status,'quota');
 const c=readControl({artifactDir:p.artifactDir,runId:p.runId});assert.throws(()=>readCompleteRun({artifactDir:c.artifactDir,runId:c.runId,workspace:c.header.workspace,policy:c.policy}));
});

test('E2c CLI continuation refuses opaque host capability instead of rebuilding one',{timeout:20000},async t=>{
 const f=fixture('noop','requirement');t.after(f.cleanup);const {runRepositoryTask}=await import('../src/agent/repository/loop.js');
 const old=await runRepositoryTask({...f.options,limits:{...f.options.limits,attemptMs:5000},backend:{run:(task,signal)=>f.backend.run(task,signal)}});assert.equal(old.status,'awaiting_world');
 const proposal={schema,runId:old.runId,proposalId:'opaque',artifactDir:f.options.artifactDir,baseRevisionId:f.revision.id,baseWorld:f.revision.world,requirements:f.binding.requirements,patch:readFileSync(f.options.worldPath,'utf8')+'\n# SCRIPTED successor\n',rationale:'SCRIPTED opaque capability'};
 const created=invoke(f,'propose-world',proposal);assert.equal(created.status,0,created.stderr);const p=JSON.parse(created.stdout);const a=invoke(f,'approve-world',decision(p));assert.equal(a.status,0,a.stderr);const revision=JSON.parse(a.stdout).revision,before=count(f);
 const r=invoke(f,'continue',{schema,runId:p.runId,artifactDir:p.artifactDir,revisionId:revision.id});assert.equal(r.status,1);assert.match(r.stderr,/opaque host capability/);assert.equal(count(f),before);assert.equal(existsSync(join(p.artifactDir,'publication',p.runId,'generations')),false);
});

test('E2c failed new CLI revision cannot return historical delivered root complete',{timeout:20000},t=>{
 const f=fixture();t.after(f.cleanup);const verifier=join(f.host,'new-fault.cjs');writeFileSync(verifier,`if(require('fs').readFileSync(require('path').join(process.argv[2],'world.yaml'),'utf8').includes('# SCRIPTED successor'))process.exit(1);`);
 const {backend,signal,revision,...rest}=f.options;const policy={...f.policy,verifiers:[{...f.policy.verifiers[0]!,argv:[verifier,'<candidate>'],programDigest:d(readFileSync(verifier,'utf8')),failureKind:'requirement',resultProtocol:'exit-v1'}]};
 const oldResult=invoke(f,'run',{...rest,schema,revisionId:revision.id,backend:f.backend.options,policy,limits:{...f.options.limits,attemptMs:5000,overallMs:60000}});assert.equal(oldResult.status,0,oldResult.stderr);const old=JSON.parse(oldResult.stdout);
 const complete=join(f.options.artifactDir,'publication',old.runId,'complete/record.json'),bytes=readFileSync(complete);
 const q=invoke(f,'propose-world',{schema,runId:old.runId,proposalId:'new-fails',artifactDir:f.options.artifactDir,baseRevisionId:revision.id,baseWorld:revision.world,requirements:f.binding.requirements,patch:readFileSync(f.options.worldPath,'utf8')+'\n# SCRIPTED successor\n',rationale:'SCRIPTED no old grant'});assert.equal(q.status,0,q.stderr);const p=JSON.parse(q.stdout);
 const a=invoke(f,'approve-world',decision(p));assert.equal(a.status,0,a.stderr);const next=JSON.parse(a.stdout).revision;
 const r=invoke(f,'continue',{schema,runId:p.runId,artifactDir:p.artifactDir,revisionId:next.id});assert.equal(r.status,1,r.stderr);const run=JSON.parse(r.stdout);assert.equal(run.status,'awaiting_world');assert.equal(run.delivery,null);assert.equal(run.attempts.length,2);assert.deepEqual(readFileSync(complete),bytes);
 const c=readControl({artifactDir:p.artifactDir,runId:p.runId});assert.throws(()=>readCompleteRun({artifactDir:c.artifactDir,runId:c.runId,workspace:c.header.workspace,policy:c.policy}));
});

test('E2c CLI retained approval raw bytes must remain exact',{timeout:20000},t=>{
 const x=setup(t),p=propose(x),a=invoke(x.f,'approve-world',decision(p));assert.equal(a.status,0,a.stderr);const approved=JSON.parse(a.stdout),before=count(x.f);
 writeFileSync(approved.decisionPath,readFileSync(approved.decisionPath,'utf8')+'\n');const r=invoke(x.f,'continue',{schema,runId:p.runId,artifactDir:p.artifactDir,revisionId:approved.revision.id});assert.equal(r.status,1);assert.equal(count(x.f),before);assert.equal(existsSync(join(p.artifactDir,'publication',p.runId,'generations')),false);
});

// E Minor2 safe deferred disposition: archive-only approval grants no continuation.
for(const fault of ['orphan-attempt','orphan-verifier','effect-count'])test(`F1 E Minor2 reproduced ${fault}: approval archive then pre-reservation refusal`,{timeout:20000},async t=>{
 const x=setup(t),p=propose(x),c=readControl({artifactDir:p.artifactDir,runId:p.runId});
 if(fault==='orphan-attempt')mkdirSync(join(p.artifactDir,'attempts','a-orphan'));
 if(fault==='orphan-verifier')mkdirSync(join(p.artifactDir,'verification',p.runId,'a-orphan'));
 if(fault==='effect-count'){
  const {checkpointRun,readRunCheckpoint}=await import('../src/agent/repository/publication.js');
  const old=readRunCheckpoint({artifactDir:c.artifactDir,runId:c.runId,workspace:c.header.workspace,policy:c.policy})!;
  checkpointRun({artifactDir:c.artifactDir,runId:c.runId,workspace:c.header.workspace,policy:c.policy},{...old,effects:[...old.effects,{operationId:'inconsistent',outcome:'committed',reconciliation:'queried',effectCount:2,checkerRollback:false,trace:['host reproduction']}]});
 }
 const before=count(x.f),candidate=readFileSync(join(c.header.workspace,'world.yaml'),'utf8');
 const a=invoke(x.f,'approve-world',decision(p));assert.equal(a.status,0,a.stderr);const revision=JSON.parse(a.stdout).revision;assert.equal(revision.state,'active');
 const r=invoke(x.f,'continue',{schema,runId:p.runId,artifactDir:p.artifactDir,revisionId:revision.id});assert.equal(r.status,1);assert.equal(count(x.f),before);assert.equal(readFileSync(join(c.header.workspace,'world.yaml'),'utf8'),candidate);assert.equal(existsSync(join(p.artifactDir,'publication',p.runId,'generations')),false);
 assert.match(r.stdout+r.stderr,fault==='effect-count'?/unresolved effects/:/unrecorded .*attempt/);
 if(process.env.KADMOS_F1_EVIDENCE)writeFileSync(join(process.env.KADMOS_F1_EVIDENCE,`minor2-${fault}.json`),JSON.stringify({fault,approvalExit:a.status,approval:JSON.parse(a.stdout),continuationExit:r.status,stdout:r.stdout,stderr:r.stderr,backendCountUnchanged:count(x.f)===before,candidateUnchanged:readFileSync(join(c.header.workspace,'world.yaml'),'utf8')===candidate,generationReserved:false})+'\n');
});
