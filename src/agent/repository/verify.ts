import { isDeepStrictEqual } from 'node:util';
import { mkdirSync, mkdtempSync, lstatSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { VerificationInput, VerificationReceipt, CheckReceipt, ProcessEvidence } from './contracts.js';
import { loadVerificationContext } from './context.js';
import { supervise } from './host_process.js';
import { hostPath, resolveVerifier } from './verifier_command.js';
import { createAtomicJson } from './store.js';
import { copy, fileRef, verificationFiles, checkVerificationEvidence, type VerificationEvidence } from './evidence.js';
const observedReceipts = new WeakMap<VerificationReceipt, VerificationEvidence>();
/** In-process host provenance. A serialized/fabricated receipt cannot mint this capability. */
export function verificationEvidence(receipt: VerificationReceipt): VerificationEvidence {
 const evidence=observedReceipts.get(receipt);
 if(!evidence || !isDeepStrictEqual(receipt,evidence.receipt))throw new Error('receipt lacks actual host verifier provenance');
 checkVerificationEvidence(evidence);return copy(evidence);
}

/** Actual frozen host checks. Host storage and sampled lineage assume a trusted single operator. */
export async function verifyCandidate(input: VerificationInput, signal: AbortSignal): Promise<VerificationReceipt> {
 const checks:CheckReceipt[]=[],diagnostics:string[]=[];
 let after:VerificationReceipt['after']=null, status:VerificationReceipt['status']='incomplete', failureKind:VerificationReceipt['failureKind']=null;
 let dir:string|undefined;
 const receipt=():VerificationReceipt=>({runId:input.runId,attemptId:input.attemptId,status,before:input.binding,after,checks,diagnostics,failureKind});
 const started=Date.now();
 let deadline=0;
 try {
  if([input.runId,input.attemptId,input.binding.revisionId].some(id=>typeof id!=='string'||!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)))throw new Error('invalid verification id');
  if(!isAbsolute(input.workspace) || !(['maxAttempts','attemptMs','verifierMs','overallMs','killGraceMs'] as const).every(key=>Number.isFinite(input.limits[key])&&input.limits[key]>0) || !Number.isInteger(input.limits.maxAttempts) || !Number.isFinite(input.deadlineEpochMs))throw new Error('invalid verification limits/path/deadline');
  deadline=Math.min(input.deadlineEpochMs,started+input.limits.verifierMs,started+input.limits.overallMs);
  const read={...input,revisionId:input.binding.revisionId};
  const loaded=loadVerificationContext(read);
  if(!isDeepStrictEqual(loaded.current,input.binding)){status='drift';throw new Error('current binding differs from verification input');}
  const commands=loaded.context.policy.verifiers;
  if(!commands.length || new Set(commands.map(c=>c.id)).size!==commands.length)throw new Error('missing or duplicate frozen checks');
  // Validate every frozen command before any work; preserve its original executable bytes as well as programDigest.
  const resolved=commands.map(c=>resolveVerifier(c,input.workspace,input.policy));
  const root=hostPath(input.artifactDir,input.workspace,input.policy);
  const parent=hostPath(join(root,'verification',input.runId,input.attemptId),input.workspace,input.policy);
  mkdirSync(parent,{recursive:true,mode:0o700});
  dir=mkdtempSync(join(parent,'invocation-'));
  hostPath(dir,input.workspace,input.policy);
  createAtomicJson(join(dir,'before'),input.binding);
  for(let index=0;index<commands.length;index++) {
   const command=commands[index]!, invocation=resolved[index]!;
   const checkDir=join(dir,command.id);mkdirSync(checkDir,{mode:0o700});
   const stdoutPath=join(checkDir,'stdout'),stderrPath=join(checkDir,'stderr');
   if(signal.aborted || Date.now()>=deadline) {diagnostics.push(signal.aborted?'verification cancelled before check':'verification deadline exhausted before check');failureKind='environment';break;}
   if(!isDeepStrictEqual(resolveVerifier(command,input.workspace,input.policy),invocation))throw new Error('host program changed before check');
   const startedAt=new Date().toISOString();
   const observed=await supervise(invocation.executable,invocation.argv,invocation.cwd,'',stdoutPath,stderrPath,signal,deadline,input.limits.killGraceMs,false);
   diagnostics.push(...observed.diagnostics);
   const process:ProcessEvidence={executable:invocation.executable,argv:invocation.argv,cwd:invocation.cwd,version:'unknown',pid:observed.pid,processGroup:observed.pid,exitCode:observed.exitCode,signal:observed.signal,stdoutPath,stderrPath,startedAt,endedAt:new Date().toISOString(),treeStopped:observed.treeStopped,usage:'unknown'};
   const checkStatus:CheckReceipt['status']=observed.reason==='timeout'?'timeout':observed.reason==='cancelled'?'cancelled':observed.reason==='launch_failed'?'launch_failed':observed.reason!==null||observed.exitCode!==0||observed.signal!==null||observed.treeStopped!==true?'failed':'passed';
   const check:CheckReceipt={checkId:command.id,command,status:checkStatus,process};checks.push(check);
   createAtomicJson(join(checkDir,'receipt'),check);
   if(!isDeepStrictEqual(resolveVerifier(command,input.workspace,input.policy),invocation))throw new Error('host program changed after check');
   if(!lstatSync(stdoutPath).isFile()||!lstatSync(stderrPath).isFile())throw new Error('missing check logs');
   // Recapture after every real process, even a failed one.
   after=loadVerificationContext(read).current;
   if(!isDeepStrictEqual(after,input.binding)){status='drift';throw new Error('candidate changed during verification');}
   if(checkStatus!=='passed') {status='failed';failureKind=observed.reason===null&&observed.treeStopped===true?command.failureKind:'environment';break;}
  }
  after=loadVerificationContext(read).current;
  if(!isDeepStrictEqual(after,input.binding)){status='drift';throw new Error('final binding drift');}
  resolved.forEach((r,i)=>{if(!isDeepStrictEqual(r,resolveVerifier(commands[i]!,input.workspace,input.policy)))throw new Error('final program drift');});
  if(checks.length===commands.length && checks.every(c=>c.status==='passed') && !signal.aborted && Date.now()<deadline)status='passed';
  else if(status!=='failed')failureKind='environment';
 } catch(error) {
  const message=String(error);diagnostics.push(message);
  if(/frozen inputs changed|unauthorized edit/.test(message))status='protected_change';
  failureKind??='environment';
 }
 if(dir)try {createAtomicJson(join(dir,'after'),{after,receipt:receipt()});}catch(error){status='incomplete';failureKind='environment';diagnostics.push(`receipt publication: ${String(error)}`);}
 const result=receipt();
 if(!dir)observedReceipts.set(result,{input:copy(input),invocation:null,receipt:copy(result),refs:[]});
 if(dir)try {
  const evidence:VerificationEvidence={input:copy(input),invocation:dir,receipt:copy(result),refs:verificationFiles(input,dir,result).filter(path=>existsSync(path)).map(path=>fileRef(input.artifactDir,path))};
  checkVerificationEvidence(evidence);observedReceipts.set(result,evidence);
 }catch(error){diagnostics.push(`evidence sealing: ${String(error)}`);}
 return result;
}
