import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { InputBinding, RepositoryRunOptions, RepositoryRunRecord } from './contracts.js';
import { readControl } from './control.js';
import { readApprovedActivation, seamSlots } from './world_revision.js';
import { readRunCheckpoint, readCompleteRun, beginRevision, commitRevision } from './publication.js';
import { readVerificationContext, createVerificationContext } from './context.js';
import { captureIdentity } from './identity.js';
import { createWorkspace, safePath, hashBytes, validateSource } from './workspace.js';
import { insist } from './evidence.js';
import { CodexBackend } from './codex_backend.js';
import { ScriptedBackend } from './backend.js';
/** Called only while owning the root controller. No inference/backfill for older runs. */
export function prepareContinuation(options:RepositoryRunOptions,onHistory:(record:RepositoryRunRecord)=>void):{options:RepositoryRunOptions;record:RepositoryRunRecord;baseline:InputBinding;workspace:string} {
 const c=readControl({artifactDir:options.artifactDir,runId:options.runId});
 const storage={artifactDir:c.artifactDir,runId:c.runId,workspace:c.header.workspace,policy:c.policy};
 const old=readRunCheckpoint(storage);insist(old,'missing original checkpoint');onHistory(old);
 insist(old.revisions.length===1 && !existsSync(join(c.artifactDir,'publication',c.runId,'generations')),'bounded v1 supports one successor; no automatic generation recovery');
 for(const [actual,expected] of [[options.source,c.sourceDeclared],[options.requirementsPath,c.roles.requirementsPath],[options.instructions,c.instructions],[options.policy,c.policy],[options.limits,c.header.limits],[safePath(options.decisionsDir),c.decisionsDir]])insist(isDeepStrictEqual(actual,expected),'caller differs from original control');
 insist(options.worldPath===options.revision.worldPath && isDeepStrictEqual(options.seamPaths,options.revision.seamPaths),'requested archive role mismatch');
 insist(!options.signal.aborted && Date.now()<c.header.deadlineEpochMs && old.attempts.length<c.header.limits.maxAttempts,'original budget exhausted/expired or cancelled');
 for(const a of old.attempts) {
  const p=a.backend.process;
  insist(p.treeStopped===true || a.backend.status==='not_started' && p.startedAt===null && p.pid===null,'unresolved prior process tree');
  for(const check of a.verification?.checks??[])insist(check.process.treeStopped===true,'unresolved prior verifier tree');
 }
 insist(old.effects.every(e=>e.outcome!=='unknown' && e.effectCount!=='unknown' && e.reconciliation!=='unavailable' && (e.outcome==='not_committed'?e.effectCount===0:e.effectCount===1)),'unresolved effects fence');
 // No unrecorded backend reservation or partial verifier invocation can disappear across switch.
 const attempts=join(c.artifactDir,'attempts');
 insist(existsSync(attempts) && isDeepStrictEqual(readdirSync(safePath(attempts)).sort(),old.attempts.filter(a=>existsSync(join(attempts,a.id))).map(a=>a.id).sort()),'unrecorded backend attempt');
 const verifiers=join(c.artifactDir,'verification',c.runId);
 for(const a of old.attempts) {
  const dir=join(verifiers,a.id);if(!existsSync(dir))continue;
  const names=readdirSync(safePath(dir));insist(names.length===1 && /^invocation-[a-zA-Z0-9]+$/.test(names[0]!), 'multiple or stranded verifier invocations');
  const invocation=join(dir,names[0]!);insist(existsSync(join(invocation,'before','record.json')) && existsSync(join(invocation,'after','record.json')),'partial verifier evidence');
 }
 const verified=old.attempts.filter(a=>a.verification && existsSync(join(verifiers,a.id))).map(a=>a.id).sort();
 insist(!existsSync(verifiers)?verified.length===0:isDeepStrictEqual(readdirSync(safePath(verifiers)).sort(),verified),'unrecorded verifier attempt');
 if(existsSync(join(c.artifactDir,'publication',c.runId,'complete')))readCompleteRun(storage);
 else insist(!existsSync(join(c.artifactDir,'publication',c.runId,'manifest')),'stranded publication');
 const lastRoute=old.attempts.at(-1);
 insist(lastRoute && (lastRoute.verification?.status==='passed' || lastRoute.route==='WORLD_CHANGE_REQUIRED' || lastRoute.route==='CODE_REPAIR'),'prior quota/infrastructure/core/unknown route requires host recovery');
 const revision=readApprovedActivation({control:c,currentRevision:old.revisions[0]!,requestedRevision:options.revision});
 const context=readVerificationContext({...storage,revisionId:c.initialRevision.id});
 const actual=captureIdentity({...c.roles,...storage,revisionId:c.initialRevision.id,baseline:context.baseline});
 const last=old.attempts.at(-1);insist(last,'missing prior attempt');
 const expected=last.verification?.after??(last.backend.candidate?{...context.baseline,candidate:last.backend.candidate}:null);
 insist(isDeepStrictEqual(actual,expected),'old candidate differs from last bound snapshot');
 // Check every physical regular file including excluded outputs. No excluded alias/hardlink escape.
 const unaliased=(dir:string):void=>{for(const entry of readdirSync(safePath(dir))){if(dir===storage.workspace && entry==='.git')continue;const path=safePath(join(dir,entry)),st=lstatSync(path);if(st.isDirectory())unaliased(path);else insist(st.isFile() && st.nlink===1,'candidate alias/special file');}};unaliased(storage.workspace);
 // Source head/clean bytes are independently checked by createWorkspace, after the intent fence.
 validateSource(c.source,c.policy);
 beginRevision(storage,revision,actual);
 const previous=join(c.artifactDir,'publication',c.runId,'generations','00000001','previous-workspace');
 renameSync(storage.workspace,safePath(previous));
 const result=createWorkspace({source:c.source,destination:storage.workspace,policy:c.policy});insist(result.status==='created',result.diagnostics.join('\n'));
 const base=captureIdentity({...c.roles,...storage,revisionId:c.initialRevision.id,baseline:c.baseline});
 const wanted=new Set(actual.candidate.files.map(f=>f.path));
 for(const f of base.candidate.files)if(!wanted.has(f.path))rmSync(safePath(join(storage.workspace,f.path)));
 for(const file of actual.candidate.files) {
  const bytes=readFileSync(safePath(join(previous,file.path)));insist(hashBytes(bytes)===file.sha256,'preserved candidate changed');
  const path=safePath(join(storage.workspace,file.path));mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);chmodSync(path,file.executable?0o755:0o644);
 }
 insist(isDeepStrictEqual(captureIdentity({...c.roles,...storage,revisionId:c.initialRevision.id,baseline:c.baseline}),actual),'reconstruction differs from recorded candidate');
 const map=(declared:string)=>safePath(join(storage.workspace,relative(resolve(c.policy.sourceRoot),resolve(declared))));
 writeFileSync(map(c.roles.worldPath),readFileSync(revision.worldPath));
 // Archive validation guarantees the exact frame and logical slots before the intent fence.
 const originalSlots=seamSlots(c.roles.seamPaths),archivedSlots=seamSlots(revision.seamPaths);
 for(const slot of originalSlots){const archived=archivedSlots.find(x=>x.frame===slot.frame);insist(archived && archived.name===slot.name,'archive slot mismatch');const path=safePath(join(storage.workspace,relative(c.source,slot.path)));writeFileSync(path,readFileSync(archived.path));chmodSync(path,archived.executable?0o755:0o644);}
 const identity={...c.roles,...storage,revisionId:revision.id};const baseline=captureIdentity(identity);
 insist(baseline.world===revision.world && baseline.seam===revision.seam && baseline.requirements===c.baseline.requirements && baseline.policy===c.baseline.policy,'new revision binding mismatch');
 createVerificationContext({...identity,expected:baseline});commitRevision(storage,revision);
 const backend=c.backend.kind==='host-capability'?options.backend:c.backend.kind==='scripted'?new ScriptedBackend(c.backend):new CodexBackend(c.backend);
 const restored={...options,source:c.sourceDeclared,requirementsPath:c.roles.requirementsPath,worldPath:c.roles.worldPath,seamPaths:c.roles.seamPaths,instructions:c.instructions,policy:c.policy,limits:c.header.limits,decisionsDir:c.decisionsDir,revision,backend};
 return {options:restored,workspace:storage.workspace,baseline,record:{...old,status:'incomplete',delivery:null,revisions:[...old.revisions,revision]}};
}
