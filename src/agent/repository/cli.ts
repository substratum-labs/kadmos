import { readFileSync, lstatSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, dirname, basename } from 'node:path';
import { DEFAULT_LIMITS, REPOSITORY_CONTRACT, type RepositoryRunOptions, type RepositoryPolicy } from './contracts.js';
import { ScriptedBackend } from './backend.js';
import { isDeepStrictEqual } from 'node:util';
import { readControl, type OriginalControl } from './control.js';
import { createAtomicJson } from './store.js';
import { insist } from './evidence.js';
import { proposeWorldChange, activateWorldRevision, readWorldProposal, readRequestedActivation, validateOperatorDecision } from './world_revision.js';
import type { WorldChangeProposal, OperatorDecision } from './contracts.js';
import { CodexBackend } from './codex_backend.js';
import { runRepositoryTask } from './loop.js';
import { captureIdentity } from './identity.js';
import { readCompleteRun, readRunCheckpoint } from './publication.js';
import { safePath, containsPath, validateSource } from './workspace.js';
import { hostPath } from './verifier_command.js';
type Obj = Record<string, unknown>;
function object(value:unknown,keys:readonly string[],required:readonly string[]=keys):Obj {
 if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('invalid repository input object');
 const v=value as Obj;if(Object.keys(v).some(k=>!keys.includes(k)) || required.some(k=>!(k in v)))throw new Error('invalid repository input keys');return v;
}
function text(value:unknown):string {if(typeof value!=='string'||!value||value.includes('\0'))throw new Error('invalid repository input string');return value;}
function array(value:unknown):string[] {if(!Array.isArray(value)||value.some(x=>typeof x!=='string'||x.includes('\0')))throw new Error('invalid repository input argv/paths');return [...value];}
function path(value:unknown):string {const p=text(value);if(!isAbsolute(p))throw new Error('absolute repository input path required');return safePath(p);}
function paths(value:unknown):string[] {return array(value).map(path);}
function relative(value:unknown):string[] {return array(value).map(p=>{if(!p||isAbsolute(p)||p.includes('\\')||p.replace(/\/$/,'').split('/').some(x=>!x||x==='.'||x==='..'))throw new Error('invalid repository input relative policy path');return p;});}
/** Host wire decoder: capabilities are constructed locally and never deserialized. */
export async function runRepositoryCli(args:readonly string[]):Promise<string> {
 if(args[0]!=='run')return worldCli(args);
 if(args.length!==3||args[0]!=='run'||args[1]!=='--input'||!args[2]||args[2].startsWith('--'))throw new Error('Usage: kadmos repo run --input <run.json>');
 const inputFile=path(args[2]),inputStat=lstatSync(inputFile);insist(inputStat.isFile() && inputStat.nlink===1,'host input must be unaliased regular file');
 const keys=['schema','runId','source','artifactDir','requirementsPath','worldPath','seamPaths','instructions','policy','backend','limits','revisionId','decisionsDir'];
 const v=object(JSON.parse(readFileSync(inputFile,'utf8')),keys,keys.filter(k=>!['limits','decisionsDir'].includes(k)));
 if(v.schema!==REPOSITORY_CONTRACT)throw new Error('invalid repository input schema');
 const runId=text(v.runId),revisionId=text(v.revisionId);if(!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)||!/^[a-zA-Z0-9_-]{1,128}$/.test(revisionId))throw new Error('invalid repository input ID');
 const source=path(v.source),artifactDir=path(v.artifactDir),requirementsPath=path(v.requirementsPath),worldPath=path(v.worldPath),seamPaths=paths(v.seamPaths);
 if(!seamPaths.length||![requirementsPath,worldPath,...seamPaths].every(p=>containsPath(source,p)))throw new Error('invalid repository input protected paths');
 if(typeof v.instructions!=='string'||v.instructions.includes('\0'))throw new Error('invalid repository input instructions');
 const p=object(v.policy,['sourceRoot','baseCommit','allowedPaths','protectedPaths','excludedOutputs','verifiers']);
 if(!Array.isArray(p.verifiers)||!p.verifiers.length)throw new Error('invalid repository input verifiers');
 const verifiers=p.verifiers.map(raw=>{const q=object(raw,['id','executable','argv','cwd','programDigest','failureKind','resultProtocol'],['id','executable','argv','cwd','programDigest','failureKind']);
 const id=text(q.id),programDigest=text(q.programDigest),failureKind=text(q.failureKind);
 if(!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)||!/^sha256:[a-f0-9]{64}$/.test(programDigest)||!['compile','functional','guard','requirement','core','environment','ambiguous'].includes(failureKind))throw new Error('invalid repository input verifier');
 if(Object.hasOwn(q,'resultProtocol')&&q.resultProtocol!=='exit-v1')throw new Error('invalid repository input result protocol');
 return {...(Object.hasOwn(q,'resultProtocol')?{resultProtocol:'exit-v1' as const}:{}),id,executable:path(q.executable),argv:array(q.argv),cwd:q.cwd==='<candidate>'?'<candidate>':path(q.cwd),programDigest,failureKind};});
 if(new Set(verifiers.map(q=>q.id)).size!==verifiers.length)throw new Error('invalid repository input duplicate verifier');
 const baseCommit=text(p.baseCommit);if(!/^[a-f0-9]{40,64}$/.test(baseCommit))throw new Error('invalid repository input baseCommit');
 const policy={sourceRoot:path(p.sourceRoot),baseCommit,allowedPaths:relative(p.allowedPaths),protectedPaths:relative(p.protectedPaths),excludedOutputs:relative(p.excludedOutputs),verifiers} as RepositoryPolicy;
 if(policy.sourceRoot!==source)throw new Error('invalid repository input sourceRoot');
 const workspace=safePath(join(dirname(artifactDir),basename(artifactDir)+'-workspace'));
 hostPath(inputFile,workspace,policy);
 hostPath(artifactDir,workspace,policy);const decisionsDir=hostPath(v.decisionsDir===undefined?join(artifactDir,'decisions'):path(v.decisionsDir),workspace,policy);
 const b=object(v.backend,['executable','prefixArgs']);const backend=new CodexBackend({executable:text(b.executable),prefixArgs:array(b.prefixArgs)});
 const l=v.limits===undefined?{}:object(v.limits,Object.keys(DEFAULT_LIMITS),[]);const limits={...DEFAULT_LIMITS,...l};
 for(const n of Object.values(limits))if(!Number.isSafeInteger(n)||Number(n)<=0||Number(n)>2147483647)throw new Error('invalid repository input limits');
 const initial=captureIdentity({workspace:source,requirementsPath,worldPath,seamPaths,policy,revisionId});
 const revision={id:revisionId,world:initial.world,seam:initial.seam,parentId:null,proposalId:null,worldPath,seamPaths,state:'active' as const,staleReceiptIds:[]};
 const controller=new AbortController();const abort=()=>controller.abort();process.on('SIGINT',abort);process.on('SIGTERM',abort);
 try {
 const options={runId,source,artifactDir,requirementsPath,worldPath,seamPaths,instructions:v.instructions,policy,backend,limits,signal:controller.signal,revision,decisionsDir} as RepositoryRunOptions;
 let record=await runRepositoryTask(options);
 if(record.status==='delivered')record=readCompleteRun({artifactDir,workspace,policy,runId});
 return JSON.stringify({...record,artifactDir,workspace},null,2)+'\n';
 }finally{process.off('SIGINT',abort);process.off('SIGTERM',abort);}
}

const worldUsage='Usage: kadmos repo propose-world|continue --input <file.json> | approve-world|reject-world --input <decision.json> --artifact-dir <hostRoot>';
function hostId(value:unknown):string {const s=text(value);insist(/^[a-z0-9][a-z0-9_-]{0,127}$/.test(s),'invalid repository input ID');return s;}
function hostInput(file:string,c:OriginalControl):void {
 const p=path(file),st=lstatSync(p);insist(st.isFile() && st.nlink===1,'host input must be unaliased regular file');
 insist(![c.source,c.header.workspace].some(root=>containsPath(root,p)),'host input overlaps source/candidate');
}
function storage(c:OriginalControl){return {artifactDir:c.artifactDir,workspace:c.header.workspace,policy:c.policy,runId:c.runId};}
function originalHistory(c:OriginalControl){
 const s=storage(c),old=readRunCheckpoint(s);insist(old,'missing original checkpoint');
 insist(old.revisions.length===1 && !existsSync(join(c.artifactDir,'publication',c.runId,'generations')),'bounded v1 supports one successor; already used or reserved');
 insist(isDeepStrictEqual(old.revisions[0],c.initialRevision),'current revision differs from original control');
 insist(Date.now()<c.header.deadlineEpochMs && old.attempts.length<c.header.limits.maxAttempts,'original budget exhausted/expired');
 const last=old.attempts.at(-1);insist(last && (last.route==='WORLD_CHANGE_REQUIRED' || last.route==='CODE_REPAIR' || last.verification?.status==='passed'),'original run is not paused for a supported revision');
 validateSource(c.source,c.policy);
 // Validate original source and candidate against the exact last retained attempt, not caller metadata.
 const actual=captureIdentity({...c.roles,...s,revisionId:c.initialRevision.id,baseline:c.baseline});
 const expected=last.verification?.after??(last.backend.candidate?{...c.baseline,candidate:last.backend.candidate}:null);
 insist(isDeepStrictEqual(actual,expected),'current candidate differs from retained history');
 for(const a of old.attempts){insist(a.backend.process.treeStopped===true,'unresolved prior backend');for(const check of a.verification?.checks??[])insist(check.process.treeStopped===true,'unresolved prior verifier');}
 insist(old.effects.every(e=>e.outcome!=='unknown' && e.effectCount!=='unknown' && e.reconciliation!=='unavailable'),'unresolved prior effects');
 if(old.status==='delivered')readCompleteRun(s);
 return old;
}
function boundProposal(p:WorldChangeProposal,c:OriginalControl):void {
 insist(p.runId===c.runId && p.artifactDir===c.artifactDir && isDeepStrictEqual(p.base,c.initialRevision) && p.requirements===c.baseline.requirements,'proposal differs from original current context');
}
async function worldCli(args:readonly string[]):Promise<string> {
 const command=args[0],isDecision=command==='approve-world'||command==='reject-world';
 if(!['propose-world','approve-world','reject-world','continue'].includes(command??'') || args.length!==(isDecision?5:3) || args[1]!=='--input' || !args[2] || args[2].startsWith('--') || isDecision&&(args[3]!=='--artifact-dir'||!args[4]||args[4].startsWith('--')))throw new Error(worldUsage);
 // Parse only a regular host file. It gains no authority until original control is loaded and its location validated.
 const inputFile=path(args[2]),st=lstatSync(inputFile);insist(st.isFile() && st.nlink===1,'host input must be unaliased regular file');
 const raw:unknown=JSON.parse(readFileSync(inputFile,'utf8'));
 const keys=command==='propose-world'?['schema','runId','proposalId','artifactDir','baseRevisionId','baseWorld','requirements','patch','rationale']:isDecision?['command','operator','runId','proposalId','proposalDigest','baseRevisionId','baseWorld','patchDigest','recordedAt']:['schema','runId','artifactDir','revisionId'];
 const v=object(raw,keys);
 if(!isDecision)insist(v.schema===REPOSITORY_CONTRACT,'invalid repository input schema');
 const runId=hostId(v.runId),artifactDir=isDecision?path(args[4]):path(v.artifactDir);
 const c=readControl({artifactDir,runId});hostInput(inputFile,c);
 if(command==='continue') {
  const revisionId=hostId(v.revisionId);originalHistory(c);
  insist(c.backend.kind!=='host-capability','opaque host capability cannot be restored from CLI');
  const revision=readRequestedActivation(c,revisionId);
  const backend=c.backend.kind==='scripted'?new ScriptedBackend(c.backend):new CodexBackend(c.backend);
  const controller=new AbortController(),abort=()=>controller.abort();process.on('SIGINT',abort);process.on('SIGTERM',abort);
  try {
   let record=await runRepositoryTask({runId:c.runId,source:c.sourceDeclared,artifactDir:c.artifactDir,requirementsPath:c.roles.requirementsPath,worldPath:revision.worldPath,seamPaths:revision.seamPaths,instructions:c.instructions,policy:c.policy,backend,limits:c.header.limits,revision,decisionsDir:c.decisionsDir,signal:controller.signal});
   if(record.status==='delivered') {record=readCompleteRun(storage(c));insist(record.delivery?.binding.revisionId===revision.id && record.delivery.binding.world===revision.world && record.delivery.binding.seam===revision.seam && isDeepStrictEqual(record.revisions.at(-1),revision),'requested complete revision mismatch');}
   return JSON.stringify({...record,artifactDir:c.artifactDir,workspace:c.header.workspace},null,2)+'\n';
  }finally{process.off('SIGINT',abort);process.off('SIGTERM',abort);}
 }
 // Same exclusive controller as run/continue; decision reservation is create-once even on later activation failure.
 const lock=path(join(c.artifactDir,'controller'));mkdirSync(lock,{mode:0o700});
 try {
  const old=originalHistory(c);
  if(command==='propose-world') {
   insist(v.baseRevisionId===c.initialRevision.id && v.baseWorld===c.initialRevision.world && v.requirements===c.baseline.requirements,'proposal base/requirements mismatch');
   const p=proposeWorldChange({runId,proposalId:hostId(v.proposalId),base:c.initialRevision,patch:text(v.patch),artifactDir:c.artifactDir,rationale:text(v.rationale),requirements:c.baseline.requirements});
   return JSON.stringify(p,null,2)+'\n';
  }
  const p=readWorldProposal({artifactDir:c.artifactDir,runId,proposalId:hostId(v.proposalId)});boundProposal(p,c);
  const approved=validateOperatorDecision(raw,p,command as OperatorDecision['command'],runId);
  const dir=path(join(c.decisionsDir,runId,p.proposalId));
  createAtomicJson(dir,approved);const decisionPath=join(dir,'record.json');
  if(command==='reject-world')return JSON.stringify({status:'rejected',decision:approved,decisionPath,revision:c.initialRevision},null,2)+'\n';
  const historicalReceiptIds=old.attempts.filter(a=>a.verification).map(a=>`${runId}/${a.id}`);
  const revision=activateWorldRevision({proposal:p,current:c.initialRevision,decisionPath,decisionsDir:c.decisionsDir,runId,historicalReceiptIds});
  insist(revision.state==='active','approved activation failed; trusted decision reservation retained');
  return JSON.stringify({status:'approved',decision:approved,decisionPath,revision},null,2)+'\n';
 }finally{rmSync(lock,{recursive:true});}
}
