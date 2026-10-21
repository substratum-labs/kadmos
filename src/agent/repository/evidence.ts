import { lstatSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hashBytes, containsPath, safePath } from './workspace.js';
import { readAtomicJson } from './store.js';
import { hostPath } from './verifier_command.js';
import type { VerificationInput, VerificationReceipt, Digest } from './contracts.js';
export interface FileRef { readonly path: string; readonly digest: Digest; readonly executable: boolean }
export interface VerificationEvidence { readonly input: VerificationInput; readonly invocation: string | null; readonly receipt: VerificationReceipt; readonly refs: readonly FileRef[] }
export function insist(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
export function copy<T>(value:T):T { return JSON.parse(JSON.stringify(value)) as T; }
export function atomic(dir:string):unknown {
 insist(isDeepStrictEqual(readdirSync(safePath(dir)).sort(),['record.json']),'incomplete record or stranded temporary');
 return readAtomicJson(dir);
}
export function fileRef(root:string,path:string):FileRef {
 const full=safePath(path),base=safePath(root);
 insist(containsPath(base,full) && full!==base,'evidence outside host artifact root');
 const stat=lstatSync(full);insist(stat.isFile() && stat.nlink===1,'evidence must be unaliased regular file');
 return {path:relative(base,full),digest:hashBytes(readFileSync(full)),executable:(stat.mode&0o111)!==0};
}
export function readRef(root:string,ref:FileRef):string {
 insist(typeof ref.path==='string' && !isAbsolute(ref.path) && !ref.path.includes('\\') && ref.path.split('/').every(x=>x!==''&&x!=='.'&&x!=='..'),'unsafe reference');
 const path=join(root,ref.path);insist(isDeepStrictEqual(fileRef(root,path),ref),'evidence integrity mismatch');return safePath(path);
}
export function verificationFiles(input:VerificationInput,invocation:string,receipt:VerificationReceipt):string[] {
 const root=hostPath(input.artifactDir,input.workspace,input.policy),dir=hostPath(invocation,input.workspace,input.policy);
 const parent=join(root,'verification',input.runId,input.attemptId);
 insist(containsPath(parent,dir) && dir!==parent && relative(parent,dir).match(/^invocation-[a-zA-Z0-9]+$/),'wrong verifier invocation');
 const files=[join(root,'inputs','revisions',input.runId,input.binding.revisionId,'verification-context','record.json'),join(dir,'before','record.json'),join(dir,'after','record.json')];
 for(const check of receipt.checks) {
  insist(/^[a-z0-9][a-z0-9_-]{0,127}$/.test(check.checkId),'unsafe check id');
  const c=join(dir,check.checkId);
  insist(check.process.stdoutPath===join(c,'stdout') && check.process.stderrPath===join(c,'stderr'),'wrong check logs');
  files.push(join(c,'receipt','record.json'),join(c,'stdout'),join(c,'stderr'),join(c,'stdout.lifecycle.json'));
 }
 return files;
}
export function checkVerificationEvidence(e:VerificationEvidence):void {
 const {input,receipt,invocation}=e;
 if(invocation===null){insist(receipt.status!=='passed' && receipt.checks.length===0 && e.refs.length===0,'early refusal cannot carry success evidence');return;}
 const files=verificationFiles(input,invocation,receipt);
 const complete=receipt.status==='passed';
 const expected=complete?files:files.filter(path=>existsSync(path));
 insist(e.refs.length===expected.length,'missing verifier references');
 expected.forEach((path,i)=>insist(readRef(input.artifactDir,e.refs[i]!)===safePath(path),'wrong verifier reference'));
 // Partial receipts retain exactly the available host evidence, never delivery authority.
 if(!complete)return;
 insist(isDeepStrictEqual(atomic(join(invocation,'before')),receipt.before),'before receipt differs');
 insist(isDeepStrictEqual(atomic(join(invocation,'after')),{after:receipt.after,receipt}),'final receipt differs');
 for(const check of receipt.checks) insist(isDeepStrictEqual(atomic(join(invocation,check.checkId,'receipt')),check),'check receipt differs');
}
