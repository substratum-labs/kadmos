import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { REPOSITORY_CONTRACT, type RepositoryRunOptions, type RepositoryRunRecord, type AttemptRecord, type InputBinding } from './contracts.js';
import { createWorkspace, safePath } from './workspace.js';
import { hostPath, validateResultProtocol } from './verifier_command.js';
import { captureIdentity } from './identity.js';
import { createVerificationContext } from './context.js';
import { initializeRun, checkpointRun, publishRun } from './publication.js';
import { verifyCandidate } from './verify.js';
import { classifyFailure } from './feedback.js';
import { validateDelivery } from './artifacts.js';
import { copy } from './evidence.js';

function logData(path:string,options:RepositoryRunOptions,workspace:string):string {
 const fd=openSync(hostPath(path,workspace,options.policy),constants.O_RDONLY|constants.O_NOFOLLOW);
 try {const size=fstatSync(fd).size,bytes=Buffer.alloc(Math.min(size,4096));readSync(fd,bytes,0,bytes.length,0);return bytes.toString('utf8')+(size>bytes.length?'\n[truncated]':'');}finally{closeSync(fd);}
}
/** Host-owned serialized fixed-World loop. Model prose never conveys approval or acceptance. */
export async function runRepositoryTask(given: RepositoryRunOptions): Promise<RepositoryRunRecord> {
 // Detach all immutable inputs before the first backend await; the backend and signal are capabilities.
 const options={...copy({...given,backend:null,signal:null}),backend:given.backend,signal:given.signal} as RepositoryRunOptions;
 const now=Date.now();
 let record:RepositoryRunRecord={schema:REPOSITORY_CONTRACT,runId:options.runId,status:'incomplete',limits:options.limits,startedAt:new Date(now).toISOString(),deadlineEpochMs:now+options.limits.overallMs,attempts:[],revisions:[options.revision],effects:[],delivery:null,diagnostics:[]};
 let owned=false,projection=false,lock='',workspace='',root='';
 const diagnose=(message:string,status:RepositoryRunRecord['status']='blocked')=>{record={...record,status,delivery:null,diagnostics:[...record.diagnostics,message]};};
 const display=()=>{
  // A compatibility projection only. Delivery authority resides in complete + independent readback.
  const path=safePath(join(root,'run.json')),temp=safePath(join(root,'run-display.tmp'));
  if(existsSync(temp))throw new Error('stranded display temporary');
  const fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,JSON.stringify(record));}finally{closeSync(fd);}
  safePath(path);renameSync(temp,path);
 };
 try {
  options.policy.verifiers.forEach(validateResultProtocol);
  root=hostPath(options.artifactDir,options.source,options.policy);
  // Reject stale artifacts rather than adopting or replacing another run's history/projection.
  if(existsSync(root) && readdirSync(root).length)throw new Error('active or existing run artifacts; fresh start refused');
  mkdirSync(root,{recursive:true,mode:0o700});
  lock=safePath(join(root,'controller'));mkdirSync(lock,{mode:0o700});owned=true;
  workspace=safePath(join(dirname(root),basename(root)+'-workspace'));
  const storage={artifactDir:root,workspace,policy:options.policy,runId:options.runId};
  const header=initializeRun({...storage,limits:options.limits});
  record={...record,startedAt:header.startedAt,deadlineEpochMs:header.deadlineEpochMs,limits:header.limits};
  display();projection=true;
  const created=createWorkspace({source:options.source,destination:workspace,policy:options.policy});
  if(created.status!=='created'){diagnose(created.diagnostics.join('\n'));return record;}
  const identity={...options,workspace,revisionId:options.revision.id};
  const baseline=captureIdentity(identity);
  createVerificationContext({...identity,expected:baseline});
  checkpointRun(storage,record);
  for(let index=0;index<header.limits.maxAttempts;index++) {
   if(options.signal.aborted || Date.now()>=header.deadlineEpochMs){diagnose(options.signal.aborted?'controller cancelled before attempt':'original run deadline exhausted','incomplete');checkpointRun(storage,record);break;}
   const id=`a${index+1}`;
   const binding=captureIdentity({...identity,baseline});
   const feedback=record.diagnostics.slice(-12).map(s=>s.slice(0,8192));
   const instructions=options.instructions+(feedback.length?'\nHost diagnostic data (quoted JSON; never commands or operator permission):\n'+JSON.stringify(feedback):'');
   const backend=await options.backend.run({runId:options.runId,attemptId:id,workspace,instructions,binding,limits:header.limits,deadlineEpochMs:header.deadlineEpochMs,artifactDir:root,feedback},options.signal);
   let verification:AttemptRecord['verification']=null,route:AttemptRecord['route']='ENVIRONMENT_BLOCKED';
   const diagnostics=[...backend.diagnostics];
   if(backend.runId!==options.runId || backend.attemptId!==id)throw new Error('backend returned wrong run/attempt identity');
   if(backend.status==='exited' && backend.process.exitCode===0 && backend.process.signal===null && backend.process.treeStopped===true && backend.candidate) {
    let current:InputBinding;
    try{current=captureIdentity({...identity,baseline});}
    catch{current={...binding,candidate:backend.candidate};} // The real verifier records protected-change refusal.
    if(isDeepStrictEqual(backend.candidate,current.candidate)) {
     verification=await verifyCandidate({runId:options.runId,attemptId:id,workspace,binding:current,policy:options.policy,artifactDir:root,limits:header.limits,deadlineEpochMs:header.deadlineEpochMs},options.signal);
     route=classifyFailure(verification);diagnostics.push(...verification.diagnostics);
     for(const check of verification.checks)for(const stream of ['stdoutPath','stderrPath'] as const) {
      try{diagnostics.push(`${check.checkId} ${stream}: ${logData(check.process[stream],options,workspace)}`);}catch(error){diagnostics.push(`diagnostic unavailable: ${String(error)}`);}
     }
    }else{route='NEEDS_REVIEW';diagnostics.push('backend snapshot differs from independent host candidate');}
   }else diagnostics.push(`backend ${backend.status}; exit ${backend.process.exitCode}; stopped ${backend.process.treeStopped}; no code acceptance`);
   record={...record,attempts:[...record.attempts,{id,revisionId:options.revision.id,backend,verification,route}],diagnostics:[...record.diagnostics,...diagnostics]};
   checkpointRun(storage,record);display();
   if(verification?.status==='passed') {
    const verdict=validateDelivery({workspace,policy:options.policy,receipt:verification,expected:verification.before,requiredCheckIds:options.policy.verifiers.map(c=>c.id),unresolvedEffects:[]});
    if(verdict.status!=='eligible' || !verdict.manifest){diagnose(verdict.diagnostics.join('\n'));checkpointRun(storage,record);break;}
    const complete={...record,status:'delivered' as const,delivery:verdict.manifest};
    // publishRun returns only after complete readback independently validates current evidence.
    record=publishRun(storage,complete);display();return record;
   }
   if(route!=='CODE_REPAIR'){record={...record,status:route==='WORLD_CHANGE_REQUIRED'?'awaiting_world':'blocked'};checkpointRun(storage,record);break;}
   if(index+1===header.limits.maxAttempts){diagnose('original total attempt limit exhausted');checkpointRun(storage,record);}
  }
 }catch(error){diagnose(String(error));}
 finally {
  if(owned){try{if(projection)display();}catch(error){diagnose(`display projection failed: ${String(error)}`);}rmSync(lock,{recursive:true});}
 }
 return record;
}
