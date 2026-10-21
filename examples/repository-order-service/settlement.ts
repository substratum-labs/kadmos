import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { safePath } from '../../src/agent/repository/workspace.js';
import { supervise } from '../../src/agent/repository/host_process.js';
import type { IWorldChecker } from '../../src/types/ports.js';
import type { EffectRecord } from '../../src/agent/repository/contracts.js';
export interface SettlementInput {
 readonly operationId: string; readonly checker: IWorldChecker;
 readonly actuator: { readonly executable: string; readonly argv: readonly string[] };
 readonly query: { readonly executable: string; readonly argv: readonly string[] };
 readonly recordPath: string; readonly signal: AbortSignal;
}
const active = new WeakSet<IWorldChecker>();
/** Early F prerequisite only: explicit precommit refusal, never commit reconciliation.
 * A permanent dispatch reservation + unknown record precedes every external launch.
 * Unknown outcomes fence all repeats, including restart; query is deliberately unused. */
export async function settleOperation(input: SettlementInput): Promise<EffectRecord> {
 const unknown:EffectRecord={operationId:input.operationId,outcome:'unknown',reconciliation:'unavailable',effectCount:'unknown',checkerRollback:false,trace:['serialized']};
 let reserved=false,recordPath='',directory='';
 const save=(record:EffectRecord)=>{const temp=safePath(join(directory,'record.tmp'));writeFileSync(temp,JSON.stringify({...record,delivery:null})+'\n',{flag:'wx',mode:0o600});safePath(recordPath);renameSync(temp,recordPath);};
 try {
 if(!/^[a-zA-Z0-9_-]{1,128}$/.test(input.operationId)||!isAbsolute(input.recordPath))throw new Error('invalid host settlement input');
 recordPath=safePath(input.recordPath);directory=safePath(recordPath+'.dispatch');
 if(existsSync(recordPath)||existsSync(directory)) {
  if(existsSync(recordPath)&&lstatSync(recordPath).isFile()&&lstatSync(recordPath).nlink===1&&lstatSync(recordPath).size<=65536) {
   const previous=JSON.parse(readFileSync(recordPath,'utf8'));
   if(previous.operationId===input.operationId&&previous.outcome==='not_committed'&&previous.checkerRollback===true&&previous.effectCount===0&&previous.delivery===null)return previous;
  }
  return {...unknown,trace:['reconstruct:unknown','serialized']};
 }
 if(active.has(input.checker)||input.signal.aborted)return unknown;
 const command=input.actuator;
 if(!isAbsolute(command.executable)||!Array.isArray(command.argv)||command.argv.some(a=>typeof a!=='string'||a.includes('\0')))throw new Error('invalid host actuator argv');
 safePath(command.executable);mkdirSync(dirname(recordPath),{recursive:true});mkdirSync(directory,{mode:0o700});reserved=true;active.add(input.checker);
 // Persist uncertainty before changing internal state or dispatching anything.
 writeFileSync(recordPath,JSON.stringify({...unknown,delivery:null})+'\n',{flag:'wx',mode:0o600});
 if(input.signal.aborted)return unknown;
 const verdict=input.checker.step({transitionId:'INITIATE_PAYMENT',proposedDirective:'DISPATCH_PAYMENT_GATEWAY'});
 if(!verdict.allowed)return unknown;
 const trace=['step'];
 const out=join(directory,'stdout'),err=join(directory,'stderr');
 const observation=await supervise(command.executable,command.argv,dirname(recordPath),'',out,err,input.signal,Date.now()+5000,100,false);
 writeFileSync(join(directory,'process.json'),JSON.stringify(observation)+'\n',{flag:'wx',mode:0o600});
 let refusal=false;
 if(!input.signal.aborted&&!observation.reason&&observation.exitCode===2&&observation.signal===null&&observation.treeStopped===true&&lstatSync(out).size<=4096) {
  try{const value=JSON.parse(readFileSync(out,'utf8'));refusal=Object.keys(value).sort().join(',')==='effectCount,operationId,outcome,protocol'&&value.protocol==='kadmos.precommit-refusal.v1'&&value.operationId===input.operationId&&value.outcome==='not_committed'&&value.effectCount===0;}catch{/* malformed is unknown */}
 }
 if(refusal) {
  trace.push('actuator:refused');input.checker.rollbackLastStep();trace.push('rollback');
  const record:EffectRecord={operationId:input.operationId,outcome:'not_committed',reconciliation:'not_needed',effectCount:0,checkerRollback:true,trace};save(record);return record;
 }
 const record={...unknown,trace:[...trace,'actuator:unknown']};save(record);return record;
 }catch{return unknown;}finally{if(reserved)active.delete(input.checker);}
}
