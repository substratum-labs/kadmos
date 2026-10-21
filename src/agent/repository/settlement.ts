import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { safePath } from './workspace.js';
import { supervise, type Observation } from './host_process.js';
import type { IWorldChecker } from '../../types/ports.js';
import type { EffectRecord } from './contracts.js';
export interface SettlementInput {
 readonly operationId: string; readonly checker: IWorldChecker;
 readonly actuator: { readonly executable: string; readonly argv: readonly string[]; readonly cwd?: string };
 readonly query: { readonly executable: string; readonly argv: readonly string[]; readonly cwd?: string };
 readonly recordPath: string; readonly signal: AbortSignal;
 readonly deadlineEpochMs?: number;
}
const active = new WeakSet<IWorldChecker>();
const step = {transitionId:'INITIATE_PAYMENT',proposedDirective:'DISPATCH_PAYMENT_GATEWAY'} as const;
function snapshot(checker:IWorldChecker) {return {state:checker.getState(),context:checker.getContext()};}
function regular(file:string):void {
 const st=lstatSync(safePath(file));if(!st.isFile()||st.nlink!==1||st.size>65536)throw Error('unsafe settlement evidence');
}
function read(file:string):unknown {regular(file);return JSON.parse(readFileSync(file,'utf8'));}
function commandValid(command:SettlementInput['actuator']):void {
 if(!isAbsolute(command.executable)||!Array.isArray(command.argv)||command.argv.length>256||command.argv.some(a=>typeof a!=='string'||a.includes('\0')||a.length>65536))throw Error('invalid host argv');
 if(command.cwd!==undefined && (!isAbsolute(command.cwd)||!lstatSync(safePath(command.cwd)).isDirectory()))throw Error('invalid host cwd');
 const st=lstatSync(safePath(command.executable));if(!st.isFile())throw Error('invalid host executable');
}
/** This parser consumes only a HOST-selected executable's qualified output. A model
 * cannot select this capability or confer authority by printing protocol-shaped JSON. */
function receipt(file:string,o:Observation,id:string,protocol:string,exit:number):'committed'|'not_committed'|null {
 if(o.reason||o.exitCode!==exit||o.signal!==null||o.treeStopped!==true)return null;
 try {
  regular(file);if(lstatSync(file).size>4096)return null;
  const v=read(file) as Record<string,unknown>;
  if(!v||Object.keys(v).sort().join(',')!=='effectCount,operationId,outcome,protocol'||v.protocol!==protocol||v.operationId!==id)return null;
  if(v.outcome==='committed'&&v.effectCount===1&&protocol!=='kadmos.precommit-refusal.v1')return 'committed';
  if(v.outcome==='not_committed'&&v.effectCount===0&&protocol!=='kadmos.effect-commit.v1')return 'not_committed';
 }catch{/* Ambiguity is never confirmed zero. */}
 return null;
}
/** One trusted local controller, persistent host directory, no stale-lock stealing.
 * Process restart is fenced, not power-loss/multi-host exactly-once. Internal
 * rollback restores only our authorized step; it cannot undo an external commit. */
export async function settleOperation(input: SettlementInput): Promise<EffectRecord> {
 const unknown:EffectRecord={operationId:input.operationId,outcome:'unknown',reconciliation:'unavailable',effectCount:'unknown',checkerRollback:false,trace:['serialized']};
 const reconstructed={...unknown,trace:['reconstruct:unknown','serialized']};
 let owned=false,directory='',recordPath='';
 const immutable=(name:string,value:unknown)=>writeFileSync(safePath(join(directory,name)),JSON.stringify(value)+'\n',{flag:'wx',mode:0o400});
 const project=(record:EffectRecord)=>{
  if(existsSync(recordPath))regular(recordPath);
  const temp=safePath(join(directory,'projection.tmp'));writeFileSync(temp,JSON.stringify({...record,delivery:null})+'\n',{flag:'wx',mode:0o600});safePath(recordPath);renameSync(temp,recordPath);
 };
 const finish=(record:EffectRecord)=>{immutable('outcome.json',{...record,delivery:null});project(record);return record;};
 try {
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(input.operationId)||!isAbsolute(input.recordPath)||input.recordPath.includes('\0'))throw Error('invalid host settlement input');
  if(active.has(input.checker)||input.signal.aborted)return unknown;
  recordPath=safePath(input.recordPath);directory=safePath(recordPath+'.dispatch');
  if(existsSync(recordPath))regular(recordPath);
  if(existsSync(directory)||existsSync(recordPath)) {
   if(!existsSync(directory)||!lstatSync(directory).isDirectory())return reconstructed;
   // Never repair or steal an interrupted reservation. Unknown history is retained.
   const binding=read(join(directory,'binding.json')) as {operationId:string;before:ReturnType<typeof snapshot>};
   if(binding.operationId!==input.operationId)return reconstructed;
   const v=read(join(directory,'outcome.json')) as EffectRecord & {delivery:null};
   if(Object.keys(v).sort().join(',')!=='checkerRollback,delivery,effectCount,operationId,outcome,reconciliation,trace'||v.operationId!==input.operationId||v.delivery!==null||!Array.isArray(v.trace)||v.trace.some(x=>typeof x!=='string'))return reconstructed;
   const committed=v.outcome==='committed'&&v.effectCount===1&&v.checkerRollback===false&&(v.reconciliation==='queried'||v.reconciliation==='not_needed')&&v.trace.at(-1)==='settle';
   const refused=v.outcome==='not_committed'&&v.effectCount===0&&v.checkerRollback===true&&(v.reconciliation==='queried'||v.reconciliation==='not_needed')&&v.trace.at(-1)==='rollback';
   if(!committed&&!refused)return reconstructed;
   const initial=read(join(directory,'unknown.json'));
   if(!isDeepStrictEqual(initial,{...unknown,delivery:null}))return reconstructed;
   // Validate the original qualified operation-bound receipt again, not the
   // mutable legacy projection (nor an outcome file detached from its evidence).
   const query=v.reconciliation==='queried';
   const process=read(join(directory,query?'query-process.json':'process.json')) as Observation;
   const protocol=query?'kadmos.effect-query.v1':committed?'kadmos.effect-commit.v1':'kadmos.precommit-refusal.v1';
   if(receipt(join(directory,query?'query.stdout':'stdout'),process,input.operationId,protocol,!query&&refused?2:0)!==v.outcome)return reconstructed;
   if(query&&(read(join(directory,'process.json')) as Observation).treeStopped!==true)return reconstructed;
   const authorized=read(join(directory,'authorized.json')) as {operationId:string;after:ReturnType<typeof snapshot>};
   if(authorized.operationId!==input.operationId)return reconstructed;
   if(committed) {
    // Reconstruct only the saved starting state, never reset arbitrary otherflow
    // state. Matching already-applied state needs no step and preserves its undo.
    const current=snapshot(input.checker);
    if(!isDeepStrictEqual(current,authorized.after)) {
     if(!isDeepStrictEqual(current,binding.before))return reconstructed;
     const verdict=input.checker.step(step);if(!verdict.allowed)return reconstructed;
     if(!isDeepStrictEqual(snapshot(input.checker),authorized.after))return reconstructed;
    }
   }
   return v;
  }
  commandValid(input.actuator);commandValid(input.query);
  mkdirSync(dirname(recordPath),{recursive:true});mkdirSync(directory,{mode:0o700});owned=true;active.add(input.checker);
  // Create-once evidence precedes BOTH authorization and every external launch.
  immutable('unknown.json',{...unknown,delivery:null});
  immutable('binding.json',{operationId:input.operationId,before:snapshot(input.checker),actuator:input.actuator,query:input.query});
  writeFileSync(recordPath,JSON.stringify({...unknown,delivery:null})+'\n',{flag:'wx',mode:0o600});
  if(input.signal.aborted)return unknown;
  const verdict=input.checker.step(step);
  // A denied/throwing core step already restores its own state; its previous
  // undo may belong to another operation. Never blindly rollback that savepoint.
  if(!verdict.allowed)return unknown;
  const authorizedAfter=snapshot(input.checker);
  immutable('authorized.json',{operationId:input.operationId,after:authorizedAfter});
  const trace=['step'];const deadline=Math.min(Date.now()+5000,input.deadlineEpochMs??Infinity);
  const launch=async(command:SettlementInput['actuator'],query:boolean)=>{
   const out=join(directory,query?'query.stdout':'stdout'),err=join(directory,query?'query.stderr':'stderr');
   const observation=await supervise(command.executable,command.argv,command.cwd??dirname(recordPath),'',out,err,input.signal,deadline,100,false);
   immutable(query?'query-process.json':'process.json',observation);return {observation,out};
  };
  const applied=await launch(input.actuator,false);
  const refusal=!input.signal.aborted&&receipt(applied.out,applied.observation,input.operationId,'kadmos.precommit-refusal.v1',2)==='not_committed';
  if(refusal) {
   if(!isDeepStrictEqual(snapshot(input.checker),authorizedAfter))return unknown;
   trace.push('actuator:refused');input.checker.rollbackLastStep();trace.push('rollback');
   return finish({operationId:input.operationId,outcome:'not_committed',reconciliation:'not_needed',effectCount:0,checkerRollback:true,trace});
  }
  if(!input.signal.aborted&&receipt(applied.out,applied.observation,input.operationId,'kadmos.effect-commit.v1',0)==='committed') {
   trace.push('actuator:committed','settle');return finish({operationId:input.operationId,outcome:'committed',reconciliation:'not_needed',effectCount:1,checkerRollback:false,trace});
  }
  trace.push('actuator:unknown');
  // No query while the apply process may remain live. One shared deadline.
  if(!input.signal.aborted&&applied.observation.treeStopped===true&&Date.now()<deadline) {
   const queried=await launch(input.query,true);
   const outcome=!input.signal.aborted?receipt(queried.out,queried.observation,input.operationId,'kadmos.effect-query.v1',0):null;
   if(outcome==='committed') {
    trace.push('query:committed','settle');return finish({operationId:input.operationId,outcome,reconciliation:'queried',effectCount:1,checkerRollback:false,trace});
   }
   if(outcome==='not_committed') {
    if(!isDeepStrictEqual(snapshot(input.checker),authorizedAfter))return unknown;
    trace.push('query:not_committed');input.checker.rollbackLastStep();trace.push('rollback');return finish({operationId:input.operationId,outcome,reconciliation:'queried',effectCount:0,checkerRollback:true,trace});
   }
   trace.push('query:unknown');
  }
  const result={...unknown,trace};project(result);return result;
 }catch{return existsSync(directory)&&!owned?reconstructed:unknown;}finally{if(owned)active.delete(input.checker);}
}
