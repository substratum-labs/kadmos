import { existsSync, mkdirSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { EffectRecord, VerifierCommand, VerificationInput, RepositoryRunRecord } from './contracts.js';
import type { RunStorage } from './publication.js';
import { settleOperation } from './settlement.js';
import { createWorldChecker } from '../../world_checker.js';
import { parseWorldSpec } from '../../world_compiler.js';
import { readVerificationContext } from './context.js';
import { resolveVerifier, hostPath } from './verifier_command.js';
import { createAtomicJson } from './store.js';
import { atomic, fileRef, readRef, insist, type FileRef } from './evidence.js';
import { safePath, hashBytes } from './workspace.js';
import type { Observation } from './host_process.js';
const marker='--kadmos-order-effect-v1';
interface Configuration { operationId:string; actuator:VerifierCommand; query:VerifierCommand }
interface Reservation { schema:'kadmos.host-effect.v1'; runId:string; attemptId:string; checkId:string; binding:VerificationInput['binding']; command:VerifierCommand; config:Configuration; unknown:EffectRecord }
interface Outcome { effect:EffectRecord; refs:FileRef[] }
/** Class C frozen argv extension. No candidate path/output supplies a capability. */
export function effectConfiguration(command:VerifierCommand):Configuration|null {
 const index=command.argv.indexOf(marker);if(index===-1)return null;
 insist(index===command.argv.length-2 && command.argv.lastIndexOf(marker)===index,'invalid host effect configuration');
 const c=JSON.parse(command.argv[index+1]!) as Configuration;
 insist(c && isDeepStrictEqual(Object.keys(c).sort(),['actuator','operationId','query']) && typeof c.operationId==='string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(c.operationId),'invalid host effect operation');
 for(const cmd of [c.actuator,c.query])insist(cmd && !cmd.argv.includes('<candidate>') && cmd.cwd!=='<candidate>' && !cmd.argv.includes(marker),'effect authority must be independent frozen host argv');
 return c;
}
function location(input:RunStorage):string{return hostPath(join(input.artifactDir,'effects'),input.workspace,input.policy);}
function files(root:string):string[] {
 insist(lstatSync(safePath(root)).isDirectory(),'invalid effect journal directory');
 return readdirSync(root).sort().flatMap(n=>{const p=safePath(join(root,n)),s=lstatSync(p);if(s.isDirectory())return files(p);insist(s.isFile()&&s.nlink===1,'effect journal alias/special file');return [p];});
}
function unknown(id:string):EffectRecord{return {operationId:id,outcome:'unknown',reconciliation:'unavailable',effectCount:'unknown',checkerRollback:false,trace:['host:reserved']};}
function commands(input:RunStorage,c:Configuration) {return [c.actuator,c.query].map(cmd=>resolveVerifier(cmd,input.workspace,input.policy));}
/** Reservation is durable before gatekeeper authorization or process launch. */
export async function observeHostEffect(input:VerificationInput,command:VerifierCommand,signal:AbortSignal,deadline:number):Promise<void> {
 const config=effectConfiguration(command);if(!config)return;
 const storage={...input},root=location(storage);commands(storage,config);
 mkdirSync(root,{recursive:true,mode:0o700});
 const dir=safePath(join(root,config.operationId));
 if(existsSync(dir)){const r=atomic(join(dir,'reservation')) as Reservation;insist(isDeepStrictEqual(r.config,config) && isDeepStrictEqual(r.command,command),'effect reservation authority changed');insist(censusEffects(storage).every(e=>e.outcome!=='unknown'),'unresolved effects fence');return;}
 mkdirSync(dir,{mode:0o700});
 const reservation:Reservation={schema:'kadmos.host-effect.v1',runId:input.runId,attemptId:input.attemptId,checkId:command.id,binding:input.binding,command,config,unknown:unknown(config.operationId)};
 createAtomicJson(join(dir,'reservation'),reservation);
 if(signal.aborted || Date.now()>=deadline)return;
 const context=readVerificationContext({...input,revisionId:input.binding.revisionId});
 const path=safePath(join(input.workspace,relative(input.policy.sourceRoot,context.roles.worldPath)));
 const world=readFileSync(path,'utf8');insist(hashBytes(world)===input.binding.world,'host effect checker World mismatch');
 const checker=createWorldChecker(parseWorldSpec(world));
 const resolved=commands(storage,config);
 const effect=await settleOperation({operationId:config.operationId,checker,recordPath:join(dir,'settlement'),actuator:{executable:resolved[0]!.executable,argv:resolved[0]!.argv,cwd:resolved[0]!.cwd},query:{executable:resolved[1]!.executable,argv:resolved[1]!.argv,cwd:resolved[1]!.cwd},signal,deadlineEpochMs:deadline});
 insist(isDeepStrictEqual(resolved,commands(storage,config)),'host effect executable drift');
 // Seal actual independent process/log/checker evidence, never a returned candidate EffectRecord.
 const refs=files(dir).map(p=>fileRef(input.artifactDir,p));
 createAtomicJson(join(dir,'outcome'),{effect,refs} satisfies Outcome);
}
function qualified(dir:string,r:Reservation,e:EffectRecord):void {
 insist(e.operationId===r.config.operationId,'effect outcome operation mismatch');
 const dispatch=join(dir,'settlement.dispatch');
 const binding=JSON.parse(readFileSync(safePath(join(dispatch,'binding.json')),'utf8'));
 const expected=(c:VerifierCommand)=>({executable:c.executable,argv:c.argv,cwd:c.cwd});
 insist(binding.operationId===e.operationId && isDeepStrictEqual(binding.actuator,expected(r.config.actuator)) && isDeepStrictEqual(binding.query,expected(r.config.query)),'effect process authority mismatch');
 insist(isDeepStrictEqual(JSON.parse(readFileSync(join(dispatch,'unknown.json'),'utf8')),{operationId:e.operationId,outcome:'unknown',reconciliation:'unavailable',effectCount:'unknown',checkerRollback:false,trace:['serialized'],delivery:null}),'missing raw unknown evidence');
 if(e.outcome==='unknown'){insist(e.effectCount==='unknown' && e.reconciliation==='unavailable','invalid unknown effect');return;}
 const query=e.reconciliation==='queried';
 const p=JSON.parse(readFileSync(join(dispatch,query?'query-process.json':'process.json'),'utf8')) as Observation;
 const original=JSON.parse(readFileSync(join(dispatch,'process.json'),'utf8')) as Observation;
 insist(original.treeStopped===true && p.treeStopped===true && Number.isSafeInteger(p.pid)&&p.pid!>0 && p.reason===null && p.signal===null && p.exitCode===(!query&&e.outcome==='not_committed'?2:0),'unqualified actual effect process');
 const raw=JSON.parse(readFileSync(join(dispatch,query?'query.stdout':'stdout'),'utf8'));
 const protocol=query?'kadmos.effect-query.v1':e.outcome==='committed'?'kadmos.effect-commit.v1':'kadmos.precommit-refusal.v1';
 insist(isDeepStrictEqual(raw,{protocol,operationId:e.operationId,outcome:e.outcome,effectCount:e.outcome==='committed'?1:0}),'unqualified operation-bound effect receipt');
 insist(isDeepStrictEqual(JSON.parse(readFileSync(join(dispatch,'outcome.json'),'utf8')),{...e,delivery:null}),'effect differs from actual settlement');
 insist(e.effectCount===(e.outcome==='committed'?1:0) && e.checkerRollback===(e.outcome==='not_committed') && e.trace.at(-1)===(e.outcome==='committed'?'settle':'rollback'),'invalid final effect');
}
/** Current census is re-read at every retry, continuation, publication and readback.
 * A missing journal is zero only when no recorded check dispatched a reserved effect. */
export function censusEffects(input:RunStorage,record?:RepositoryRunRecord):EffectRecord[] {
 const root=location(input);const names=existsSync(root)?readdirSync(safePath(root)).sort():[];
 const reservations:Reservation[]=[];
 const effects=names.map(name=>{
  insist(/^[a-z0-9][a-z0-9_-]{0,127}$/.test(name),'invalid effect journal entry');
  const dir=safePath(join(root,name)),r=atomic(join(dir,'reservation')) as Reservation;
  insist(r.schema==='kadmos.host-effect.v1' && r.runId===input.runId && r.config.operationId===name && r.checkId===r.command.id && isDeepStrictEqual(r.unknown,unknown(name)),'foreign effect reservation');
  insist(/^[a-z0-9][a-z0-9_-]{0,127}$/.test(r.attemptId) && isDeepStrictEqual(effectConfiguration(r.command),r.config) && input.policy.verifiers.some(c=>isDeepStrictEqual(c,r.command)),'effect not bound to frozen host checker');
  const context=readVerificationContext({...input,revisionId:r.binding.revisionId});
  for(const k of ['world','seam','policy','requirements'] as const)insist(r.binding[k]===context.baseline[k],'stale effect binding');
  commands(input,r.config);reservations.push(r);
  if(record){const a=record.attempts.find(a=>a.id===r.attemptId);insist(a?.revisionId===r.binding.revisionId && a.verification && isDeepStrictEqual(a.verification.before,r.binding) && a.verification.checks.some(c=>c.checkId===r.checkId && isDeepStrictEqual(c.command,r.command)),'effect lacks actual bound verifier');}
  if(!existsSync(join(dir,'outcome'))) {files(dir);return r.unknown;}
  const o=atomic(join(dir,'outcome')) as Outcome;
  insist(isDeepStrictEqual(Object.keys(o).sort(),['effect','refs']) && Array.isArray(o.refs),'invalid effect envelope');
  const actual=files(dir).filter(p=>p!==join(dir,'outcome','record.json'));
  insist(isDeepStrictEqual(o.refs.map(ref=>readRef(input.artifactDir,ref)),actual),'effect journal census drift');
  qualified(dir,r,o.effect);return o.effect;
 });
 if(record)for(const a of record.attempts)for(const c of a.verification?.checks??[])if(effectConfiguration(c.command))insist(reservations.some(r=>Number(r.attemptId.slice(1))<=Number(a.id.slice(1)) && r.checkId===c.checkId && isDeepStrictEqual(r.command,c.command)),'missing dispatched effect reservation');
 return effects.sort((a,b)=>{
  const ra=reservations.find(r=>r.config.operationId===a.operationId)!,rb=reservations.find(r=>r.config.operationId===b.operationId)!;
  return Number(ra.attemptId.slice(1))-Number(rb.attemptId.slice(1)) || input.policy.verifiers.findIndex(c=>c.id===ra.checkId)-input.policy.verifiers.findIndex(c=>c.id===rb.checkId);
 });
}
export function assertEffectCensus(input:RunStorage,record:RepositoryRunRecord):void {
 insist(record.effects.every(e=>e.outcome!=='unknown' && e.effectCount!=='unknown' && e.reconciliation!=='unavailable' && (e.outcome==='not_committed'?e.effectCount===0:e.effectCount===1)),'unresolved effects fence');
 insist(isDeepStrictEqual(censusEffects(input,record),record.effects),'effect journal differs from run history');
}
