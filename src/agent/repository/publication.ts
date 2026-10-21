import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { RepositoryPolicy, RepositoryRunRecord, RunLimits, DeliveryManifest } from './contracts.js';
import { createAtomicJson } from './store.js';
import { hostPath } from './verifier_command.js';
import { containsPath, safePath } from './workspace.js';
import { loadVerificationContext, readVerificationContext } from './context.js';
import { validateDelivery } from './artifacts.js';
import { verificationEvidence } from './verify.js';
import { atomic, copy, insist, fileRef, readRef, checkVerificationEvidence, type FileRef, type VerificationEvidence } from './evidence.js';
export interface RunStorage { readonly artifactDir: string; readonly workspace: string; readonly policy: RepositoryPolicy; readonly runId: string }
export interface RunHeader { readonly schema: 'kadmos.run-start.v1'; readonly runId: string; readonly workspace: string; readonly policy: RepositoryPolicy; readonly limits: RunLimits; readonly startedAt: string; readonly deadlineEpochMs: number }
interface Snapshot { schema:'kadmos.run-checkpoint.v1'; sequence:number; previous:FileRef|null; start:FileRef; record:RepositoryRunRecord; evidence:readonly VerificationEvidence[]; backendRefs:readonly FileRef[] }
interface Complete { schema:'kadmos.run-complete.v1'; publishedAt:string; start:FileRef; checkpoint:FileRef; manifest:FileRef; record:RepositoryRunRecord }
function id(value:string):void { insist(typeof value==='string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value),'unsafe run/revision/attempt id'); }
function location(input:RunStorage):string {
 id(input.runId);const root=hostPath(input.artifactDir,input.workspace,input.policy);
 insist(![input.workspace,input.policy.sourceRoot].some(p=>containsPath(root,safePath(p))),'artifact root contains candidate/source');
 return hostPath(join(root,'publication',input.runId),input.workspace,input.policy);
}
function mutate<T>(input:RunStorage,action:()=>T):T {
 const root=location(input);mkdirSync(root,{recursive:true,mode:0o700});
 const lock=join(root,'writer');mkdirSync(lock,{mode:0o700});
 try{return action();}finally{rmSync(lock,{recursive:true});}
}
function finite(limits:RunLimits):void {
 insist(isDeepStrictEqual(Object.keys(limits).sort(),['attemptMs','killGraceMs','maxAttempts','overallMs','verifierMs']),'invalid limit shape');
 insist(Object.values(limits).every(n=>Number.isSafeInteger(n)&&n>0&&n<=2147483647),'finite positive run limits required');
}
function start(input:RunStorage):RunHeader {
 const h=atomic(join(location(input),'start')) as RunHeader;finite(h.limits);
 insist(h.schema==='kadmos.run-start.v1' && h.runId===input.runId && h.workspace===input.workspace && isDeepStrictEqual(h.policy,input.policy),'original run identity mismatch');
 insist(Number.isSafeInteger(h.deadlineEpochMs) && new Date(h.startedAt).toISOString()===h.startedAt && h.deadlineEpochMs===Date.parse(h.startedAt)+h.limits.overallMs,'invalid original budget');
 insist(isDeepStrictEqual(h,{schema:h.schema,runId:h.runId,workspace:h.workspace,policy:h.policy,limits:h.limits,startedAt:h.startedAt,deadlineEpochMs:h.deadlineEpochMs}),'invalid start shape');return h;
}
/** Call once before attempts; never renew a budget on continue or revision. */
function initializeRunUnlocked(input:RunStorage & {readonly limits:RunLimits}):RunHeader {
 const root=location(input);finite(input.limits);
 insist(!existsSync(join(input.artifactDir,'attempts')) && !existsSync(join(input.artifactDir,'verification',input.runId)),'run start must precede attempts');
 const now=Date.now();
 const h:RunHeader={schema:'kadmos.run-start.v1',runId:input.runId,workspace:input.workspace,policy:copy(input.policy),limits:copy(input.limits),startedAt:new Date(now).toISOString(),deadlineEpochMs:now+input.limits.overallMs};
 createAtomicJson(join(root,'start'),h);return copy(h);
}
/** Recovery API: reads the original header even after expiry. It never initializes one. */
export function readRunStart(input:RunStorage):RunHeader {return copy(start(input));}
function recordShape(input:RunStorage,r:RepositoryRunRecord,h:RunHeader):void {
 insist(r.schema==='kadmos.repository.v1' && r.runId===input.runId && isDeepStrictEqual(r.limits,h.limits) && r.startedAt===h.startedAt && r.deadlineEpochMs===h.deadlineEpochMs,'run budget/identity reset');
 insist(['incomplete','blocked','awaiting_world','delivered'].includes(r.status) && Array.isArray(r.attempts) && Array.isArray(r.revisions) && Array.isArray(r.effects) && Array.isArray(r.diagnostics) && r.diagnostics.every(x=>typeof x==='string'),'invalid run shape');
 insist(isDeepStrictEqual(Object.keys(r).sort(),['attempts','deadlineEpochMs','delivery','diagnostics','effects','limits','revisions','runId','schema','startedAt','status']),'unexpected run fields');
 insist(r.attempts.length<=h.limits.maxAttempts && new Set(r.attempts.map(a=>a.id)).size===r.attempts.length,'attempt budget/identity mismatch');
 // D1 has no World activation authority. E must deliberately extend this with host approval evidence.
 insist(r.revisions.length===1,'D1 requires one initial fixed-World revision');
 const v=r.revisions[0]!;id(v.id);
 insist(v.state==='active' && v.parentId===null && v.proposalId===null && isDeepStrictEqual(v.staleReceiptIds,[]),'unapproved D1 revision');
 const context=readVerificationContext({...input,revisionId:v.id});
 insist(v.world===context.baseline.world && v.seam===context.baseline.seam && v.worldPath===context.roles.worldPath && isDeepStrictEqual(v.seamPaths,context.roles.seamPaths),'initial revision differs from host context');
 let lastRevision=-1;
 for(const a of r.attempts) {
  id(a.id);id(a.revisionId);const ri=r.revisions.findIndex(v=>v.id===a.revisionId);insist(ri>=lastRevision && ri>=0,'attempt revision order');lastRevision=ri;
  insist(a.backend.runId===r.runId && a.backend.attemptId===a.id,'backend attempt identity mismatch');
  insist(['CODE_REPAIR','WORLD_CHANGE_REQUIRED','CORE_MISMATCH','ENVIRONMENT_BLOCKED','NEEDS_REVIEW'].includes(a.route),'invalid failure route');
  if(a.verification)insist(a.verification.runId===r.runId && a.verification.attemptId===a.id && a.verification.before.revisionId===a.revisionId,'verification attempt/revision mismatch');
 }
 for(const e of r.effects) {id(e.operationId);insist(['not_committed','committed','unknown'].includes(e.outcome) && ['not_needed','queried','unavailable'].includes(e.reconciliation) && (e.effectCount==='unknown'||Number.isSafeInteger(e.effectCount)&&e.effectCount>=0) && typeof e.checkerRollback==='boolean' && Array.isArray(e.trace)&&e.trace.every((x:unknown)=>typeof x==='string'),'invalid effect');}
}
function prefix(previous:RepositoryRunRecord,next:RepositoryRunRecord):void {
 for(const key of ['attempts','revisions','effects','diagnostics'] as const)insist(isDeepStrictEqual(previous[key],next[key].slice(0,previous[key].length)),'history dropped or rewritten');
}
function backendFiles(input:RunStorage,r:RepositoryRunRecord):FileRef[] {
 const refs:FileRef[]=[];
 for(const a of r.attempts) {
  const p=a.backend.process,dir=join(input.artifactDir,'attempts',a.id),record=join(dir,'process.json');
  // Refused-before-launch attempts have no process receipt. Preserve them, never grant from them.
  if(p.pid===null && !existsSync(record))continue;
  insist(isDeepStrictEqual(JSON.parse(readFileSync(hostPath(record,input.workspace,input.policy),'utf8')),a.backend),'backend receipt mismatch');
  insist(safePath(p.stdoutPath)===safePath(join(dir,'stdout.jsonl')) && safePath(p.stderrPath)===safePath(join(dir,'stderr.txt')),'backend log identity mismatch');
  for(const path of [record,join(dir,'stdin.txt'),p.stdoutPath,p.stderrPath,join(dir,'version.stdout'),join(dir,'version.stderr')])refs.push(fileRef(input.artifactDir,path));
  for(const path of [p.stdoutPath+'.lifecycle.json',join(dir,'version.stdout.lifecycle.json')])if(existsSync(path))refs.push(fileRef(input.artifactDir,path));
 }
 return refs;
}
function validateEvidence(input:RunStorage,s:Snapshot):void {
 insist(s.evidence.length===s.record.attempts.filter(a=>a.verification!==null).length,'missing attempt evidence');
 let j=0;
 for(const a of s.record.attempts)if(a.verification) {
  const e=s.evidence[j++]!;
  insist(isDeepStrictEqual(e.receipt,a.verification) && e.input.runId===input.runId && e.input.attemptId===a.id && e.input.artifactDir===input.artifactDir && e.input.workspace===input.workspace && isDeepStrictEqual(e.input.policy,input.policy) && isDeepStrictEqual(e.input.binding,a.verification.before) && isDeepStrictEqual(e.input.limits,s.record.limits) && e.input.deadlineEpochMs===s.record.deadlineEpochMs,'wrong verifier authority/budget/binding');
  checkVerificationEvidence(e);
 }
 s.backendRefs.forEach(ref=>readRef(input.artifactDir,ref));
 insist(isDeepStrictEqual(backendFiles(input,s.record),s.backendRefs),'backend evidence changed');
}
function snapshots(input:RunStorage,h:RunHeader):Snapshot[] {
 const dir=join(location(input),'checkpoints');if(!existsSync(dir))return [];
 const names=readdirSync(safePath(dir)).sort(),result:Snapshot[]=[];
 let previous:FileRef|null=null;
 names.forEach((name,i)=>{
  insist(name===String(i+1).padStart(8,'0'),'incomplete checkpoint sequence');
  const path=join(dir,name),s=atomic(path) as Snapshot;
  insist(isDeepStrictEqual(Object.keys(s).sort(),['backendRefs','evidence','previous','record','schema','sequence','start']),'invalid checkpoint envelope');
  insist(s.schema==='kadmos.run-checkpoint.v1' && s.sequence===i+1 && isDeepStrictEqual(s.previous,previous),'broken checkpoint chain');
  insist(readRef(input.artifactDir,s.start)===safePath(join(location(input),'start','record.json')),'wrong start reference');
  recordShape(input,s.record,h);insist(s.record.status!=='delivered' && s.record.delivery===null,'checkpoint cannot grant delivery');
  if(result.length)prefix(result[result.length-1]!.record,s.record);
  validateEvidence(input,s);result.push(s);previous=fileRef(input.artifactDir,join(path,'record.json'));
 });return result;
}
/** Immutable versioned incomplete history. Failed/unknown attempts remain evidence. */
function checkpointUnlocked(input:RunStorage,record:RepositoryRunRecord):void {
 const root=location(input);insist(!existsSync(join(root,'manifest')) && !existsSync(join(root,'complete')),'run already sealed or stranded');
 const h=start(input),all=snapshots(input,h);recordShape(input,record,h);
 insist(record.status!=='delivered' && record.delivery===null,'checkpoint cannot grant delivery');
 if(all.length)prefix(all[all.length-1]!.record,record);
 const sequence=all.length+1,evidence=record.attempts.filter(a=>a.verification!==null).map(a=>{
  const prior=all[all.length-1]?.evidence.find(e=>isDeepStrictEqual(e.receipt,a.verification));
  return prior??verificationEvidence(a.verification!);
 });
 const s:Snapshot={schema:'kadmos.run-checkpoint.v1',sequence,previous:all.length?fileRef(input.artifactDir,join(root,'checkpoints',String(sequence-1).padStart(8,'0'),'record.json')):null,start:fileRef(input.artifactDir,join(root,'start','record.json')),record:copy(record),evidence,backendRefs:backendFiles(input,record)};
 validateEvidence(input,s);createAtomicJson(join(root,'checkpoints',String(sequence).padStart(8,'0')),s);
}
function eligible(input:RunStorage,r:RepositoryRunRecord,h:RunHeader,s:Snapshot):DeliveryManifest {
 recordShape(input,r,h);
 const backendDir=join(input.artifactDir,'attempts');
 const expectedBackend=r.attempts.filter(a=>existsSync(join(backendDir,a.id))).map(a=>a.id).sort();
 insist(existsSync(backendDir) && isDeepStrictEqual(readdirSync(safePath(backendDir)).sort(),expectedBackend),'unrecorded backend attempt');
 const verifierDir=join(input.artifactDir,'verification',input.runId);
 const expectedVerifier=r.attempts.filter(a=>a.verification && existsSync(join(verifierDir,a.id))).map(a=>a.id).sort();
 insist(existsSync(verifierDir) && isDeepStrictEqual(readdirSync(safePath(verifierDir)).sort(),expectedVerifier),'unrecorded verifier attempt');
 for(const e of s.evidence) {
  if(e.invocation===null)continue;
  const parent=join(verifierDir,e.input.attemptId);
  insist(isDeepStrictEqual(readdirSync(safePath(parent)),[e.invocation.slice(e.invocation.lastIndexOf('/')+1)]),'multiple or incomplete verifier invocations for attempt');
 }
 insist(r.status==='delivered' && r.delivery!==null,'not complete');
 insist(isDeepStrictEqual({...r,status:s.record.status,delivery:null},s.record),'complete differs from latest checkpoint');
 insist(r.effects.every(e=>e.outcome!=='unknown' && e.effectCount!=='unknown' && e.reconciliation!=='unavailable' && (e.outcome==='not_committed'?e.effectCount===0:e.effectCount===1)),'unresolved effects fence');
 const a=r.attempts[r.attempts.length-1],v=r.revisions[r.revisions.length-1];insist(a && v && a.verification && a.revisionId===v.id,'no latest current-revision verification');
 const receipt=a.verification,p=a.backend.process;
 insist(a.backend.status==='exited' && p.treeStopped===true && p.exitCode===0 && p.signal===null && isDeepStrictEqual(a.backend.candidate,receipt.before.candidate),'backend/candidate mismatch');
 for(const path of [p.stdoutPath+'.lifecycle.json',join(input.artifactDir,'attempts',a.id,'version.stdout.lifecycle.json')])fileRef(input.artifactDir,path);
 insist(v.world===receipt.before.world && v.seam===receipt.before.seam && v.staleReceiptIds.length===0,'stale revision');
 const context=loadVerificationContext({...input,revisionId:v.id});
 insist(v.worldPath===context.context.roles.worldPath && isDeepStrictEqual(v.seamPaths,context.context.roles.seamPaths),'revision role mismatch');insist(isDeepStrictEqual(context.current,receipt.before),'current host context differs');
 const begin=Date.parse(h.startedAt),end=h.deadlineEpochMs;
 const lifecycle=(p:typeof a.backend.process,max:number)=>{
  const from=Date.parse(p.startedAt??''),to=Date.parse(p.endedAt??'');
  insist(Number.isInteger(p.pid)&&p.pid!>0 && Number.isFinite(from)&&Number.isFinite(to)&&from>=begin && to>=from && to<=end+h.limits.killGraceMs && to-from<=max+h.limits.killGraceMs+2000,'lifecycle outside original budget');
 };
 lifecycle(p,h.limits.attemptMs);
 for(const c of receipt.checks) {lifecycle(c.process,h.limits.verifierMs);insist(Date.parse(c.process.startedAt!)>=Date.parse(p.endedAt!),'verification preceded backend');}
 for(const old of r.attempts) {
  const p=old.backend.process;if(p.startedAt!==null)lifecycle(p,h.limits.attemptMs);
  if(old.backend.process.treeStopped!==true && old.backend.process.pid!==null)throw new Error('unresolved prior process tree');
  for(const c of old.verification?.checks??[]) {lifecycle(c.process,h.limits.verifierMs);insist(c.process.treeStopped===true,'unresolved prior verifier tree');}
 }
 const verdict=validateDelivery({workspace:input.workspace,policy:input.policy,receipt,expected:context.current,requiredCheckIds:input.policy.verifiers.map(c=>c.id),unresolvedEffects:r.effects.filter(e=>e.outcome==='unknown')});
 insist(verdict.status==='eligible' && verdict.manifest && isDeepStrictEqual(verdict.manifest,r.delivery),'manifest eligibility/readback mismatch');return verdict.manifest;
}
/** Commit protocol: all immutable inputs/checkpoints, manifest, then complete marker LAST. */
function publishUnlocked(input:RunStorage,record:RepositoryRunRecord):RepositoryRunRecord {
 const root=location(input),h=start(input),all=snapshots(input,h),latest=all[all.length-1];
 insist(latest && Date.now()<h.deadlineEpochMs && !existsSync(join(root,'complete')),'missing checkpoint/expired/already sealed');
 // New checkpoint authority came from the actual verifier. Recovery reuses only that sealed authority.
 const manifest=eligible(input,record,h,latest);
 createAtomicJson(join(root,'manifest'),{schema:'kadmos.delivery-manifest.v1',manifest});
 const c:Complete={schema:'kadmos.run-complete.v1',publishedAt:new Date().toISOString(),start:fileRef(input.artifactDir,join(root,'start','record.json')),checkpoint:fileRef(input.artifactDir,join(root,'checkpoints',String(latest.sequence).padStart(8,'0'),'record.json')),manifest:fileRef(input.artifactDir,join(root,'manifest','record.json')),record:copy(record)};
 createAtomicJson(join(root,'complete'),c);return copy(record);
}
/** Durable readback does not renew or re-spend expired budgets. Checksums are not signatures. */
export function readCompleteRun(input:RunStorage):RepositoryRunRecord {
 const root=location(input);insist(isDeepStrictEqual(readdirSync(root).sort(),['checkpoints','complete','manifest','start']),'incomplete publication or stranded writer');
 const h=start(input),all=snapshots(input,h),s=all[all.length-1],c=atomic(join(root,'complete')) as Complete;
 insist(isDeepStrictEqual(Object.keys(c).sort(),['checkpoint','manifest','publishedAt','record','schema','start']),'invalid complete envelope');
 insist(s && c.schema==='kadmos.run-complete.v1','missing complete snapshot');
 insist(readRef(input.artifactDir,c.start)===safePath(join(root,'start','record.json')) && readRef(input.artifactDir,c.checkpoint)===safePath(join(root,'checkpoints',String(s.sequence).padStart(8,'0'),'record.json')) && readRef(input.artifactDir,c.manifest)===safePath(join(root,'manifest','record.json')),'complete reference mismatch');
 const at=Date.parse(c.publishedAt);insist(Number.isFinite(at) && at>=Date.parse(h.startedAt) && at<=h.deadlineEpochMs,'publication outside original budget');
 const manifest=atomic(join(root,'manifest'));
 insist(isDeepStrictEqual(manifest,{schema:'kadmos.delivery-manifest.v1',manifest:c.record.delivery}),'manifest differs from complete record');
 eligible(input,c.record,h,s);return copy(c.record);
}

export function initializeRun(input:RunStorage & {readonly limits:RunLimits}):RunHeader {return mutate(input,()=>initializeRunUnlocked(input));}
export function checkpointRun(input:RunStorage,record:RepositoryRunRecord):void {mutate(input,()=>checkpointUnlocked(input,record));}
export function publishRun(input:RunStorage,record:RepositoryRunRecord):RepositoryRunRecord {
 mutate(input,()=>publishUnlocked(input,record));return readCompleteRun(input);
}

/** Trusted host recovery; unknown/failed evidence and original budgets remain immutable. */
export function readRunCheckpoint(input:RunStorage):RepositoryRunRecord|null {
 const root=location(input);insist(!existsSync(join(root,'writer')) && (!existsSync(join(root,'manifest')) || existsSync(join(root,'complete'))),'stranded publication requires host recovery');
 const h=start(input),all=snapshots(input,h);return copy(all[all.length-1]?.record??null);
}
