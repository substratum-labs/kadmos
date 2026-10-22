import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, linkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fixture, d, type Fixture } from './repository_test_support.js';
import { runRepositoryTask } from '../src/agent/repository/loop.js';
import { createControl, readControl } from '../src/agent/repository/control.js';
import { proposeWorldChange, activateWorldRevision, readApprovedActivation } from '../src/agent/repository/world_revision.js';
import { CodexBackend } from '../src/agent/repository/codex_backend.js';
import { ScriptedBackend } from '../src/agent/repository/backend.js';
import { createVerificationContext } from '../src/agent/repository/context.js';
import { initializeRun } from '../src/agent/repository/publication.js';
import type { RepositoryRunOptions, OperatorDecision } from '../src/agent/repository/contracts.js';
const controlFile=(f:Fixture)=>join(f.options.artifactDir,'inputs/controllers/run-1/original-control/record.json');
const startFile=(f:Fixture)=>join(f.options.artifactDir,'publication/run-1/start/record.json');
const contextFile=(f:Fixture)=>join(f.options.artifactDir,'inputs/revisions/run-1/r0/verification-context/record.json');
const lookup=(f:Fixture)=>readControl({artifactDir:f.options.artifactDir,runId:'run-1'});
function prepared(t:{after(fn:()=>void):void}) {
 const f=fixture('noop','requirement');t.after(f.cleanup);
 initializeRun({...f.options,workspace:f.source});
 createVerificationContext({...f.options,workspace:f.source,revisionId:'r0',expected:f.binding});
 return f;
}
function edit(path:string,fn:(v:Record<string,any>)=>void) {const v=JSON.parse(readFileSync(path,'utf8'));fn(v);writeFileSync(path,JSON.stringify(v));}
function approved(f:Fixture) {
 const p=proposeWorldChange({runId:'run-1',proposalId:'p1',base:f.revision,patch:readFileSync(f.options.worldPath,'utf8')+'\n# SCRIPTED approved replacement\n',artifactDir:f.options.artifactDir,requirements:f.binding.requirements,rationale:'SCRIPTED archive test'});
 mkdirSync(f.options.decisionsDir,{recursive:true});const path=join(f.options.decisionsDir,'scripted.json');
 const decision:OperatorDecision={command:'approve-world',operator:'SCRIPTED operator',runId:p.runId,proposalId:p.proposalId,proposalDigest:p.proposalDigest,baseRevisionId:p.base.id,baseWorld:p.base.world,patchDigest:p.patchDigest,recordedAt:'2026-10-21T00:00:00.000Z'};
 writeFileSync(path,JSON.stringify(decision));
 const r=activateWorldRevision({proposal:p,current:f.revision,decisionPath:path,decisionsDir:f.options.decisionsDir,runId:p.runId,historicalReceiptIds:['z','a']});assert.equal(r.state,'active');return {p,r,path};
}
test('E2a fresh control exists before backend mutation and await; detached lexical inputs and generic capability',async t=>{
 const f=fixture('noop','requirement');t.after(f.cleanup);let calls=0;
 const options={...f.options,backend:{async run(task:Parameters<CodexBackend['run']>[0],signal:AbortSignal){
  calls++;const c=lookup(f);assert.equal(c.instructions,f.options.instructions);assert.deepEqual(c.backend,{kind:'host-capability',restorable:false});
  (options as {instructions:string}).instructions='MUTATED';(options.seamPaths as string[]).reverse();
  await Promise.resolve();assert.equal(lookup(f).instructions,f.options.instructions);return f.backend.run(task,signal);
 }}};
 const result=await runRepositoryTask(options);assert.equal(calls,1);assert.equal(result.status,'awaiting_world');
 const c=lookup(f);assert.equal(c.sourceDeclared,f.source);assert.equal(c.header.startedAt,result.startedAt);assert.equal(c.header.deadlineEpochMs,result.deadlineEpochMs);assert.deepEqual(c.header.limits,result.limits);assert.equal(c.baseline.world,f.binding.world);assert.equal(Object.isFrozen(c.roles.seamPaths),true);assert.throws(()=>{(c as {instructions:string}).instructions='bad';});assert.equal(lookup(f).instructions,f.options.instructions);
});
for(const kind of ['codex','scripted'] as const)test(`E2a ${kind} descriptor detached before first await`,async t=>{
 const f=fixture('noop','requirement');t.after(f.cleanup);
 const config={...f.backend.options,prefixArgs:[...f.backend.options.prefixArgs]};const backend=kind==='codex'?new CodexBackend(config):new ScriptedBackend(config);
 const pending=runRepositoryTask({...f.options,backend});const c=lookup(f);
 config.executable='/missing';config.prefixArgs.splice(0,config.prefixArgs.length,'changed');
 assert.deepEqual(c.backend,{kind,executable:f.backend.options.executable,prefixArgs:f.backend.options.prefixArgs});
 assert.equal((await pending).status,'awaiting_world');assert.deepEqual(lookup(f).backend,c.backend);
});
test('E2a exact initial control read and no overwrite',t=>{const f=prepared(t);const c=createControl({...f.options,workspace:f.source});assert.deepEqual(lookup(f),c);assert.deepEqual(c.roles,{requirementsPath:f.options.requirementsPath,worldPath:f.options.worldPath,seamPaths:f.options.seamPaths});assert.throws(()=>createControl({...f.options,workspace:f.source}));});
for(const kind of ['missing','partial','symlink','hardlink','wrong-run','extra','digest','header-time','header-limits','context','roles','instructions','roots','baseline-order','revision','start-ref','context-ref','backend'] as const)test(`E2a control rejects ${kind}`,t=>{
 const f=prepared(t);createControl({...f.options,workspace:f.source});let file=controlFile(f);
 if(kind==='missing')rmSync(dirname(file),{recursive:true});
 if(kind==='partial')writeFileSync(join(dirname(file),'stranded.tmp'),'partial');
 if(kind==='symlink'||kind==='hardlink'){const copy=join(f.host,'copy.json');writeFileSync(copy,readFileSync(file));rmSync(file);if(kind==='symlink')symlinkSync(copy,file);else linkSync(copy,file);}
 if(kind==='header-time')edit(startFile(f),v=>{v.startedAt='2026-10-21T00:00:00.000Z';v.deadlineEpochMs=Date.parse(v.startedAt)+v.limits.overallMs;});
 if(kind==='header-limits')edit(startFile(f),v=>{v.limits.maxAttempts++;});
 if(kind==='context')edit(contextFile(f),v=>{v.context.baseline.requirements=d('wrong');v.digest=d(JSON.stringify(v.context));});
 if(!['missing','partial','symlink','hardlink','header-time','header-limits','context'].includes(kind))edit(file,v=>{
  const c=v.control;
  if(kind==='wrong-run')c.runId='other';if(kind==='extra')c.extra=true;if(kind==='digest')v.digest=d('wrong');
  if(kind==='roles')c.roles.seamPaths.reverse(),c.roles.worldPath=f.options.requirementsPath;
  if(kind==='instructions')c.instructions=3;if(kind==='roots')c.artifactDir=f.source;
  if(kind==='baseline-order')c.baseline.candidate.files.reverse();if(kind==='revision')c.initialRevision.id='other';
  if(kind==='start-ref')c.startRef.path='../escape';if(kind==='context-ref')c.contextRef.path=c.startRef.path;
  if(kind==='backend')c.backend={kind:'provider',evaluate:'evil'};
  if(kind!=='digest')v.digest=d(JSON.stringify(c));
 });
 assert.throws(()=>lookup(f));
});
for(const kind of ['source-root','candidate-root','decisions-in-source','decisions-in-candidate','source-mismatch','revision-mismatch','limits-mismatch','roles-reordered','old-run'] as const)test(`E2a invalid initial ${kind} refuses before backend`,async t=>{
 const f=fixture();t.after(f.cleanup);let calls=0;let opts:RepositoryRunOptions={...f.options,backend:{async run(task,signal){calls++;return f.backend.run(task,signal);}}};
 if(kind==='source-root')opts={...opts,artifactDir:join(f.source,'lookalike')};
 if(kind==='candidate-root')opts={...opts,artifactDir:f.root};
 if(kind==='decisions-in-source')opts={...opts,decisionsDir:join(f.source,'decisions')};
 if(kind==='decisions-in-candidate')opts={...opts,decisionsDir:join(f.host,'artifacts-workspace','decisions')};
 if(kind==='source-mismatch')opts={...opts,source:f.host};
 if(kind==='revision-mismatch')opts={...opts,revision:{...opts.revision,world:d('wrong')}};
 if(kind==='limits-mismatch')opts={...opts,limits:{...opts.limits,maxAttempts:0}};
 if(kind==='roles-reordered')opts={...opts,seamPaths:[join(f.source,'generated/world_checker.ts'),join(f.source,'generated/ports.d.ts')]};
 if(kind==='old-run'){const p=prepared(t);assert.throws(()=>lookup(p));return;}
 assert.equal((await runRepositoryTask(opts)).status,'blocked');assert.equal(calls,0);
});
test('E2a genuine approved archive read is readonly, frozen, exact and grants no runtime pointer',t=>{
 const f=prepared(t);const c=createControl({...f.options,workspace:f.source});const {r}=approved(f);const before=readdirSync(f.options.artifactDir).sort();
 assert.deepEqual(readApprovedActivation({control:c,currentRevision:f.revision,requestedRevision:r}),r);assert.equal(Object.isFrozen(readApprovedActivation({control:c,currentRevision:f.revision,requestedRevision:r})),true);assert.deepEqual(readdirSync(f.options.artifactDir).sort(),before);assert.equal(existsSync(join(f.options.artifactDir,'run.json')),false);
});
for(const kind of ['requested-world','requested-path','requested-stale','current-id','current-world','control-forgery','archive-extra','archive-run','archive-requirements','archive-proposal','archive-decision-copy','archive-decision-digest','archive-revision','world','seam','patch','proposal','decision','decision-whitespace','decision-missing','decision-outside','decision-source','decision-symlink','decision-hardlink','archive-symlink','archive-hardlink','partial','uncommitted','stranded'] as const)test(`E2a approved loader refuses ${kind}`,t=>{
 const f=prepared(t);let control=createControl({...f.options,workspace:f.source});let {r,path,p}=approved(f);let currentRevision=f.revision;
 const dir=dirname(r.worldPath),record=join(dir,'record.json');
 if(kind==='requested-world')r={...r,world:d('wrong')};if(kind==='requested-path')r={...r,worldPath:f.options.worldPath};if(kind==='requested-stale')r={...r,staleReceiptIds:['a']};
 if(kind==='current-id')currentRevision={...currentRevision,id:'stale'};if(kind==='current-world')currentRevision={...currentRevision,world:d('wrong')};
 if(kind==='control-forgery')control={...control,decisionsDir:f.source};
 if(kind.startsWith('archive-')&&!['archive-symlink','archive-hardlink'].includes(kind))edit(record,v=>{
  if(kind==='archive-extra')v.extra=true;if(kind==='archive-run')v.runId='other';if(kind==='archive-requirements')v.requirements=d('wrong');if(kind==='archive-proposal')v.proposalDigest=d('wrong');if(kind==='archive-decision-copy')v.decision.operator='different';if(kind==='archive-decision-digest')v.decisionDigest=d('wrong');if(kind==='archive-revision')v.revision.parentId='other';
 });
 if(kind==='world')writeFileSync(r.worldPath,p.patch+'\n');if(kind==='seam')writeFileSync(join(r.seamPaths[0]!,'world_checker.ts'),'forged');
 if(kind==='patch')writeFileSync(join(f.options.artifactDir,'proposals/run-1/p1/patch.yaml'),p.patch+'\n');
 if(kind==='proposal')edit(join(f.options.artifactDir,'proposals/run-1/p1/record.json'),v=>{v.proposal.rationale='changed';});
 if(kind==='decision')edit(path,v=>{v.command='reject-world';});if(kind==='decision-whitespace')writeFileSync(path,readFileSync(path,'utf8')+'\n');if(kind==='decision-missing')rmSync(path);
 if(kind==='decision-source'||kind==='decision-outside'){const other=join(kind==='decision-source'?f.source:f.host,'other.json');writeFileSync(other,readFileSync(path));edit(record,v=>{v.decisionPath=other;});}
 if(['decision-symlink','decision-hardlink','archive-symlink','archive-hardlink'].includes(kind)){const file=kind.startsWith('decision')?path:r.worldPath;const copy=join(f.host,'raw-copy');writeFileSync(copy,readFileSync(file));rmSync(file);if(kind.endsWith('symlink'))symlinkSync(copy,file);else linkSync(copy,file);}
 if(kind==='partial')writeFileSync(record,'{}');if(kind==='uncommitted')rmSync(record);if(kind==='stranded')writeFileSync(join(dir,'stranded.tmp'),'partial');
 assert.throws(()=>readApprovedActivation({control,currentRevision,requestedRevision:r}));
});

test('E2a fresh paused run loads its genuine approval under original roots without renewing header',async t=>{
 const f=fixture('noop','requirement');t.after(f.cleanup);const run=await runRepositoryTask(f.options);assert.equal(run.status,'awaiting_world');
 const c=lookup(f),original=readFileSync(startFile(f));const {r}=approved(f);
 assert.deepEqual(readApprovedActivation({control:c,currentRevision:f.revision,requestedRevision:r}),r);assert.deepEqual(readFileSync(startFile(f)),original);assert.equal(c.header.deadlineEpochMs,run.deadlineEpochMs);assert.equal(c.header.limits.maxAttempts,run.limits.maxAttempts);
});
for(const file of ['requirements.md','acceptance.txt','generated/world_checker.ts'] as const)test(`E2a approved read refuses original protected input drift ${file}`,t=>{
 const f=prepared(t);const control=createControl({...f.options,workspace:f.source});const {r}=approved(f);writeFileSync(join(f.source,file),readFileSync(join(f.source,file),'utf8')+'\nchanged');
 assert.throws(()=>readApprovedActivation({control,currentRevision:f.revision,requestedRevision:r}));
});
test('E2a source-authored lookalike cannot redirect trusted host lookup',t=>{
 const f=prepared(t);createControl({...f.options,workspace:f.source});const original=readFileSync(controlFile(f));const root=join(f.source,'lookalike');const file=join(root,'inputs/controllers/run-1/original-control/record.json');mkdirSync(dirname(file),{recursive:true});writeFileSync(file,original);
 assert.throws(()=>readControl({artifactDir:root,runId:'run-1'}));assert.deepEqual(readFileSync(controlFile(f)),original);
});
for(const kind of ['partial','symlink','limits-disagree','after-attempt'] as const)test(`E2a control creation refuses ${kind} and retains reservation`,t=>{
 const f=prepared(t);const dir=dirname(controlFile(f));let options={...f.options,workspace:f.source};
 if(kind==='partial')mkdirSync(dir,{recursive:true});
 if(kind==='symlink'){mkdirSync(dirname(dir),{recursive:true});symlinkSync(f.source,dir);}
 if(kind==='limits-disagree')options={...options,limits:{...options.limits,maxAttempts:9}};
 if(kind==='after-attempt')mkdirSync(join(f.options.artifactDir,'attempts'));
 assert.throws(()=>createControl(options));assert.equal(existsSync(controlFile(f)),false);
});
test('E2a generic capability never serializes arbitrary objects or functions',t=>{
 const f=prepared(t);const backend={run:f.backend.run.bind(f.backend),toJSON(){throw new Error('must never serialize capability');},secret:()=>42};
 const c=createControl({...f.options,workspace:f.source,backend});assert.deepEqual(c.backend,{kind:'host-capability',restorable:false});assert.equal(readFileSync(controlFile(f),'utf8').includes('secret'),false);
});
