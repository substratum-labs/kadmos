import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture } from './repository_test_support.js';
import { hashBytes, snapshotCandidate } from '../src/agent/repository/workspace.js';
import { validateDelivery } from '../src/agent/repository/artifacts.js';
import type { VerificationReceipt } from '../src/agent/repository/contracts.js';

// Host-authored receipt fixtures exercise the delivery gate, not verifier execution.
function checked(f: ReturnType<typeof fixture>): VerificationReceipt {
 const command=f.policy.verifiers[0]!; const stdoutPath=join(f.host,'stdout'),stderrPath=join(f.host,'stderr');
 const startedAt=new Date().toISOString();
 const r=spawnSync(process.execPath,['-e','process.exit(0)'],{cwd:f.host});
 writeFileSync(stdoutPath,r.stdout);writeFileSync(stderrPath,r.stderr);
 return {runId:'artifact-test',attemptId:'a1',status:'passed',before:f.binding,after:f.binding,diagnostics:[],failureKind:null,
 checks:[{checkId:command.id,command,status:'passed',process:{executable:command.executable,version:process.version,argv:command.argv.map(x=>x==='<candidate>'?f.source:x),cwd:command.cwd,pid:r.pid,processGroup:null,exitCode:r.status,signal:r.signal,stdoutPath,stderrPath,startedAt,endedAt:new Date().toISOString(),treeStopped:true,usage:'unknown'}}]};
}
function input(f: ReturnType<typeof fixture>,receipt=checked(f)) {return {workspace:f.source,policy:f.policy,receipt,expected:f.binding,requiredCheckIds:['acceptance'],unresolvedEffects:[]};}
test('artifact snapshot binds exact binary bytes, mode, deletions and untracked inputs; excludes explicit outputs',t=>{
 const f=fixture();t.after(f.cleanup);const a=snapshotCandidate(f.source,f.policy);
 writeFileSync(join(f.source,'src/raw'),Buffer.from([0,255,128]));const b=snapshotCandidate(f.source,f.policy);assert.notEqual(a.digest,b.digest);
 assert.equal(b.files.find(x=>x.path==='src/raw')?.sha256,hashBytes(Buffer.from([0,255,128])));
 chmodSync(join(f.source,'src/raw'),0o755);const c=snapshotCandidate(f.source,f.policy);assert.notEqual(b.digest,c.digest);
 rmSync(join(f.source,'src/a.ts'));assert.ok(snapshotCandidate(f.source,f.policy).deleted.includes('src/a.ts'));
 const d=snapshotCandidate(f.source,f.policy);mkdirSync(join(f.source,'dist'));writeFileSync(join(f.source,'dist/output'),'output');assert.deepEqual(snapshotCandidate(f.source,f.policy),d);
});
test('artifact snapshot refuses symlinks, case aliases and invalid policy paths',t=>{
 const f=fixture();t.after(f.cleanup);symlinkSync(f.host,join(f.source,'src/link'));assert.throws(()=>snapshotCandidate(f.source,f.policy));rmSync(join(f.source,'src/link'));
 writeFileSync(join(f.source,'src/Case'),'a');writeFileSync(join(f.source,'src/case'),'b');
 // Case-insensitive hosts collapse this pair; path-policy validation is portable.
 try {assert.throws(()=>snapshotCandidate(f.source,{...f.policy,allowedPaths:['../escape']}));}finally {rmSync(join(f.source,'src/Case'),{force:true});rmSync(join(f.source,'src/case'),{force:true});}
});
test('artifact eligible manifest requires complete matching host receipt and final readback',t=>{
 const f=fixture();t.after(f.cleanup);const r=validateDelivery(input(f));assert.equal(r.status,'eligible');assert.deepEqual(r.manifest?.files,f.binding.candidate.files);
});
for(const mode of ['missing','duplicate','nonzero','timeout','unknown-tree','missing-log','binding','policy','late-write','incomplete','unknown-effect','program-drift'])test(`artifact gate refuses ${mode}`,t=>{
 const f=fixture();t.after(f.cleanup);const receipt=checked(f);let i=input(f,receipt);const check=receipt.checks[0]!;
 if(mode==='missing')i={...i,receipt:{...receipt,checks:[]}};
 if(mode==='duplicate')i={...i,receipt:{...receipt,checks:[check,check]}};
 if(mode==='nonzero')i={...i,receipt:{...receipt,checks:[{...check,process:{...check.process,exitCode:9}}]}};
 if(mode==='timeout')i={...i,receipt:{...receipt,checks:[{...check,status:'timeout'}]}};
 if(mode==='unknown-tree')i={...i,receipt:{...receipt,checks:[{...check,process:{...check.process,treeStopped:'unknown'}}]}};
 if(mode==='missing-log')rmSync(check.process.stdoutPath);
 if(mode==='binding')i={...i,receipt:{...receipt,after:{...f.binding,world:hashBytes('other')}}};
 if(mode==='policy')i={...i,policy:{...f.policy,allowedPaths:['other/']}};
 if(mode==='late-write')writeFileSync(join(f.source,'src/late.ts'),'late');
 if(mode==='incomplete')i={...i,receipt:{...receipt,status:'incomplete'}};
 if(mode==='unknown-effect')i={...i,unresolvedEffects:[{operationId:'unknown',outcome:'unknown',reconciliation:'unavailable',effectCount:'unknown',checkerRollback:true,trace:[]}] as never[]};
 if(mode==='program-drift')writeFileSync(check.command.argv[0]!,'process.exit(0)');
 const result=validateDelivery(i);assert.equal(result.status,'refused');assert.equal(result.manifest,null);assert.ok(result.diagnostics.length);
});
