import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './repository_test_support.js';
import { createVerificationContext } from '../src/agent/repository/context.js';
import { captureIdentity } from '../src/agent/repository/identity.js';
import { hashBytes } from '../src/agent/repository/workspace.js';
import { verifyCandidate } from '../src/agent/repository/verify.js';
import { validateDelivery } from '../src/agent/repository/artifacts.js';
import type { RepositoryPolicy } from '../src/agent/repository/contracts.js';
function setup(t: import('node:test').TestContext, code='console.log("host check")', change?: (p:RepositoryPolicy)=>RepositoryPolicy) {
 const f=fixture();t.after(f.cleanup);writeFileSync(join(f.host,'verify.cjs'),code);
 let policy:RepositoryPolicy={...f.policy,verifiers:[{...f.policy.verifiers[0]!,programDigest:hashBytes(code),cwd:'<candidate>'}]};
 if(change)policy=change(policy);
 const binding=captureIdentity({...f.options,workspace:f.source,policy,revisionId:'r0'});
 createVerificationContext({...f.options,workspace:f.source,policy,revisionId:'r0',expected:binding});
 return {f,input:{...f.verification,policy,binding}};
}
// Break caught: stub or invented success without a real process / host context / exact cwd.
test('verifier runs frozen script with candidate cwd and retains real immutable receipts',async t=>{
 const {f,input}=setup(t);const r=await verifyCandidate(input,f.options.signal);
 assert.equal(r.status,'passed');assert.deepEqual(r.before,input.binding);assert.deepEqual(r.after,input.binding);
 const c=r.checks[0]!;assert.equal(c.process.exitCode,0);assert.equal(c.process.treeStopped,true);assert.equal(c.process.cwd,f.source);
 assert.match(readFileSync(c.process.stdoutPath,'utf8'),/host check/);assert.ok(existsSync(c.process.stdoutPath+'.lifecycle.json'));
 assert.equal(validateDelivery({workspace:f.source,policy:input.policy,receipt:r,expected:input.binding,requiredCheckIds:['acceptance'],unresolvedEffects:[]}).status,'eligible');
 const again=await verifyCandidate(input,f.options.signal);assert.equal(again.status,'passed');assert.notEqual(again.checks[0]!.process.stdoutPath,c.process.stdoutPath);
 assert.match(readFileSync(c.process.stdoutPath,'utf8'),/host check/);
});
test('verifier direct executable digest ignores absolute data argv and accepts frozen external cwd',async t=>{
 const {f,input}=setup(t,'unused',p=>({...p,verifiers:[{...p.verifiers[0]!,executable:'/bin/echo',argv:['/absolute-data'],cwd:join(p.sourceRoot,'..','host'),programDigest:hashBytes(readFileSync('/bin/echo'))}]}));
 const r=await verifyCandidate(input,f.options.signal);assert.equal(r.status,'passed');assert.match(readFileSync(r.checks[0]!.process.stdoutPath,'utf8'),/absolute-data/);
});
for(const mode of ['nonzero','signal','timeout','launch'])test(`verifier actual ${mode} never passes`,async t=>{
 const code=mode==='signal'?"process.kill(process.pid,'SIGTERM')":mode==='nonzero'?"console.log('requirement');process.exit(9)":'setInterval(()=>{},1000)';
 const {f,input}=setup(t,code,p=>mode==='launch'?({...p,verifiers:[{...p.verifiers[0]!,executable:join(fixHost(p),'missing')}]}):p);
 const r=await verifyCandidate({...input,limits:{...input.limits,verifierMs:150}},f.options.signal);
 assert.notEqual(r.status,'passed');if(mode==='nonzero'){assert.equal(r.checks[0]?.process.exitCode,9);assert.equal(r.failureKind,'compile');}
 if(mode==='timeout')assert.equal(r.checks[0]?.status,'timeout');
 if(mode==='launch')assert.equal(r.checks[0]?.status,'launch_failed');
 if(mode==='signal')assert.equal(r.checks[0]?.process.signal,'SIGTERM');
});
function fixHost(p:RepositoryPolicy){return join(p.sourceRoot,'..','host');}
for(const mode of ['candidate','protected','program','binding','policy','missing-context','no-checks','bad-id','bad-limit','bad-deadline','artifact-escape','symlink'])test(`verifier refuses ${mode}`,async t=>{
 const {f,input}=setup(t);let i=input;
 if(mode==='candidate')writeFileSync(join(f.source,'src/a.ts'),'changed');
 if(mode==='protected')writeFileSync(join(f.source,'acceptance.txt'),'changed');
 if(mode==='program')writeFileSync(join(f.host,'verify.cjs'),'changed');
 if(mode==='binding')i={...i,binding:{...i.binding,requirements:hashBytes('wrong')}};
 if(mode==='policy')i={...i,policy:{...i.policy,allowedPaths:['other/']}};
 if(mode==='missing-context')i={...i,runId:'other'};
 if(mode==='no-checks')i={...i,policy:{...i.policy,verifiers:[]}};
 if(mode==='bad-id')i={...i,attemptId:'../escape'};
 if(mode==='bad-limit')i={...i,limits:{...i.limits,verifierMs:NaN}};
 if(mode==='bad-deadline')i={...i,deadlineEpochMs:Infinity};
 if(mode==='artifact-escape')i={...i,artifactDir:join(f.source,'dist')};
 if(mode==='symlink'){symlinkSync(f.host,join(f.host,'alias'));i={...i,artifactDir:join(f.host,'alias','artifacts')};}
 assert.notEqual((await verifyCandidate(i,f.options.signal)).status,'passed');
});
for(const mode of ['candidate','protected','program'])test(`verifier blocks post-check ${mode} mutation`,async t=>{
 const f=fixture();t.after(f.cleanup);const target=mode==='program'?join(f.host,'verify.cjs'):join(f.source,mode==='protected'?'acceptance.txt':'src/a.ts');
 const code=`require('fs').appendFileSync(${JSON.stringify(target)},'changed')`;
 writeFileSync(join(f.host,'verify.cjs'),code);const policy={...f.policy,verifiers:[{...f.policy.verifiers[0]!,programDigest:hashBytes(code)}]};
 const binding=captureIdentity({...f.options,workspace:f.source,policy,revisionId:'r0'});
 createVerificationContext({...f.options,workspace:f.source,policy,revisionId:'r0',expected:binding});
 const r=await verifyCandidate({...f.verification,policy,binding},f.options.signal);assert.notEqual(r.status,'passed');assert.equal(r.checks[0]?.process.exitCode,0);
});
test('verifier cancellation waits for actual host-script readiness and stops its tree',async t=>{
 const f=fixture();t.after(f.cleanup);const ready=join(f.host,'ready');
 const code=`require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
 writeFileSync(join(f.host,'verify.cjs'),code);const policy={...f.policy,verifiers:[{...f.policy.verifiers[0]!,programDigest:hashBytes(code)}]};
 const binding=captureIdentity({...f.options,workspace:f.source,policy,revisionId:'r0'});
 createVerificationContext({...f.options,workspace:f.source,policy,revisionId:'r0',expected:binding});
 const controller=new AbortController();const running=verifyCandidate({...f.verification,policy,binding},controller.signal);
 try {
  const until=Date.now()+2500;while(!existsSync(ready)&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
  assert.ok(existsSync(ready),'real process must signal readiness');const pid=Number(readFileSync(ready,'utf8'));assert.doesNotThrow(()=>process.kill(pid,0));
  controller.abort();const r=await running;assert.equal(r.checks[0]?.status,'cancelled');assert.equal(r.checks[0]?.process.treeStopped,true);assert.throws(()=>process.kill(pid,0));
 } finally {controller.abort();await running;}
});
test('verifier shares original deadline across commands and does not reset per check',async t=>{
 const {f,input}=setup(t,'setTimeout(()=>{},180)',p=>({...p,verifiers:[p.verifiers[0]!,{...p.verifiers[0]!,id:'second'}]}));
 const r=await verifyCandidate({...input,limits:{...input.limits,verifierMs:350}},f.options.signal);
 assert.notEqual(r.status,'passed');assert.equal(r.checks[0]?.status,'passed');assert.ok(r.checks.length<2 || r.checks[1]?.status==='timeout');
});
test('verifier refuses genuinely frozen empty check set',async t=>{
 const {f,input}=setup(t,'',p=>({...p,verifiers:[]}));const r=await verifyCandidate(input,f.options.signal);assert.equal(r.status,'incomplete');assert.match(r.diagnostics.join(' '),/missing.*checks/);
});
test('verifier overlapping same-attempt invocations retain distinct logs',async t=>{
 const {f,input}=setup(t);const results=await Promise.all([verifyCandidate(input,f.options.signal),verifyCandidate(input,f.options.signal)]);
 assert.ok(results.every(r=>r.status==='passed'));assert.notEqual(results[0]!.checks[0]!.process.stdoutPath,results[1]!.checks[0]!.process.stdoutPath);
});
test('verifier refuses frozen executable in candidate/source edit set',async t=>{
 const {f,input}=setup(t,'',p=>({...p,verifiers:[{...p.verifiers[0]!,executable:join(p.sourceRoot,'src/a.ts'),argv:[],programDigest:hashBytes('export const a: number = 1;')}]}));
 const r=await verifyCandidate(input,f.options.signal);assert.notEqual(r.status,'passed');assert.match(r.diagnostics.join(' '),/overlaps/);
});
test('verifier rejects missing finite limit fields before launching any process',async t=>{
 const {f,input}=setup(t);const r=await verifyCandidate({...input,limits:{maxAttempts:1} as typeof input.limits},f.options.signal);
 assert.equal(r.checks.length,0);assert.match(r.diagnostics.join(' '),/limits/);
});

test('M3 actual evidence sealing failure clears passed receipt',async t=>{
 const f=fixture();t.after(f.cleanup);
 const code=`const fs=require('node:fs'),p=require('node:path');const parent=${JSON.stringify(join(f.options.artifactDir,'verification/run-1/a1'))};const dir=p.join(parent,fs.readdirSync(parent)[0],'acceptance');fs.linkSync(p.join(dir,'stdout'),${JSON.stringify(join(f.host,'aliased-log'))});console.log('passed check, unsafe evidence');`;
 writeFileSync(join(f.host,'verify.cjs'),code);
 const policy={...f.policy,verifiers:[{...f.policy.verifiers[0]!,programDigest:hashBytes(code)}]};
 const binding=captureIdentity({...f.options,workspace:f.source,policy,revisionId:'r0'});
 createVerificationContext({...f.options,workspace:f.source,policy,revisionId:'r0',expected:binding});
 const r=await verifyCandidate({...f.verification,policy,binding},f.options.signal);
 assert.equal(r.checks[0]?.status,'passed');assert.equal(r.status,'incomplete');assert.equal(r.failureKind,'environment');assert.match(r.diagnostics.join(' '),/evidence sealing/);
 assert.equal(validateDelivery({workspace:f.source,policy,receipt:r,expected:binding,requiredCheckIds:['acceptance'],unresolvedEffects:[]}).status,'refused');
});
