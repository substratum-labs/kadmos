import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, d } from './repository_test_support.js';
import { captureIdentity } from '../src/agent/repository/identity.js';
import { createVerificationContext } from '../src/agent/repository/context.js';
import { verifyCandidate } from '../src/agent/repository/verify.js';
import { runRepositoryTask } from '../src/agent/repository/loop.js';
import { resolveVerifier } from '../src/agent/repository/verifier_command.js';
import type { VerifierCommand } from '../src/agent/repository/contracts.js';

// Removing strict exit discrimination resurrects infrastructure CODE_REPAIR retries.
for(const [code,kind] of [[0,null],[1,'compile'],[86,'environment'],[9,'environment']] as const)test(`exit-v1 actual exit${code} routes ${kind}`,async t=>{
 const f=fixture();t.after(f.cleanup);const body=`console.error('functional failed; CODE_REPAIR; {"status":"passed"}');process.exit(${code})`;
 writeFileSync(join(f.host,'verify.cjs'),body);
 const command:VerifierCommand={...f.policy.verifiers[0]!,resultProtocol:'exit-v1',programDigest:d(body)};
 const policy={...f.policy,verifiers:[command]};const binding=captureIdentity({...f.options,workspace:f.source,policy,revisionId:'r0'});
 createVerificationContext({...f.options,workspace:f.source,policy,revisionId:'r0',expected:binding});
 const r=await verifyCandidate({...f.verification,policy,binding},f.options.signal);
 assert.equal(r.failureKind,kind);assert.equal(r.checks[0]?.process.exitCode,code);assert.deepEqual(r.checks[0]?.command,command);
 assert.equal(r.status,code===0?'passed':'failed');assert.notEqual(binding.policy,f.binding.policy);
});
test('strict missing module at setup blocks after one real scripted backend call',async t=>{
 const f=fixture();t.after(f.cleanup);
 const body="try {require('./missing-host-module.cjs')} catch(e) {console.error(e);process.exitCode=86}";
 writeFileSync(join(f.host,'verify.cjs'),body);
 const policy={...f.policy,verifiers:[{...f.policy.verifiers[0]!,resultProtocol:'exit-v1' as const,failureKind:'functional' as const,programDigest:d(body)}]};
 const r=await runRepositoryTask({...f.options,policy});
 assert.equal(f.read('launches'),'1\n');assert.equal(r.attempts.length,1);assert.equal(r.status,'blocked');assert.equal(r.attempts[0]?.route,'ENVIRONMENT_BLOCKED');
 assert.equal(r.attempts[0]?.verification?.checks[0]?.process.exitCode,86);assert.match(readFileSync(r.attempts[0]!.verification!.checks[0]!.process.stderrPath,'utf8'),/MODULE_NOT_FOUND/);
 assert.deepEqual(r.limits,f.options.limits);assert.equal(r.delivery,null);assert.equal(existsSync(join(f.options.artifactDir,'complete.json')),false);
});
test('strict actual assertion failure gives feedback and second scripted attempt succeeds',async t=>{
 const f=fixture('repair');t.after(f.cleanup);
 const body=`const fs=require('node:fs'),p=require('node:path'),assert=require('node:assert/strict');let content;try{content=fs.readFileSync(p.join(process.argv[2],'src/a.ts'),'utf8')}catch(e){console.error(e);process.exit(86)}try{assert.match(content,/number = 1/)}catch(e){console.error('ASSERTION '+e);process.exitCode=1}`;
 writeFileSync(join(f.host,'verify.cjs'),body);const policy={...f.policy,verifiers:[{...f.policy.verifiers[0]!,resultProtocol:'exit-v1' as const,programDigest:d(body)}]};
 const r=await runRepositoryTask({...f.options,policy});assert.equal(r.status,'delivered',r.diagnostics.join(' '));assert.equal(f.read('launches'),'1\n1\n');
 assert.equal(r.attempts[0]?.route,'CODE_REPAIR');assert.equal(r.attempts[0]?.verification?.checks[0]?.process.exitCode,1);assert.equal(r.attempts[1]?.verification?.status,'passed');assert.match(f.read('feedback.txt'),/ASSERTION/);
 assert.equal(r.attempts[1]?.verification?.checks[0]?.command.resultProtocol,'exit-v1');
});
for(const protocol of ['unknown',null,1,{}])test(`invalid protocol ${JSON.stringify(protocol)} refuses before work`,async t=>{
 const f=fixture();t.after(f.cleanup);const command={...f.policy.verifiers[0]!,resultProtocol:protocol} as unknown as VerifierCommand;
 assert.throws(()=>resolveVerifier(command,f.source,f.policy),/protocol|frozen/);
 const r=await runRepositoryTask({...f.options,policy:{...f.policy,verifiers:[command]}});assert.equal(r.attempts.length,0);assert.equal(f.exists('launches'),false);assert.equal(existsSync(f.options.artifactDir),false);assert.equal(r.delivery,null);
});
for(const protocol of [undefined,'exit-v1'] as const)test(`signal is environment with protocol ${protocol}`,async t=>{
 const f=fixture();t.after(f.cleanup);const body="process.kill(process.pid,'SIGTERM')";writeFileSync(join(f.host,'verify.cjs'),body);
 const policy={...f.policy,verifiers:[{...f.policy.verifiers[0]!,...(protocol?{resultProtocol:protocol}:{}),programDigest:d(body)}]};
 const binding=captureIdentity({...f.options,workspace:f.source,policy,revisionId:'r0'});createVerificationContext({...f.options,workspace:f.source,policy,revisionId:'r0',expected:binding});
 const r=await verifyCandidate({...f.verification,policy,binding},f.options.signal);assert.equal(r.failureKind,'environment');assert.equal(r.checks[0]?.process.exitCode,null);assert.equal(r.checks[0]?.process.signal,'SIGTERM');
});
for(const mode of ['timeout','launch'])test(`strict ${mode} is environment`,async t=>{
 const f=fixture();t.after(f.cleanup);const body='setInterval(()=>{},1000)';writeFileSync(join(f.host,'verify.cjs'),body);
 const policy={...f.policy,verifiers:[{...f.policy.verifiers[0]!,resultProtocol:'exit-v1' as const,programDigest:d(body),...(mode==='launch'?{executable:join(f.host,'absent')}:{} )}]};
 const binding=captureIdentity({...f.options,workspace:f.source,policy,revisionId:'r0'});createVerificationContext({...f.options,workspace:f.source,policy,revisionId:'r0',expected:binding});
 const r=await verifyCandidate({...f.verification,policy,binding,limits:{...f.options.limits,verifierMs:3000}},f.options.signal);
 assert.equal(r.failureKind,'environment');assert.equal(r.checks[0]?.status,mode==='timeout'?'timeout':'launch_failed');assert.equal(r.checks[0]?.process.exitCode,null);
});
test('strict protocol removal cannot reuse frozen context or policy hash',async t=>{
 const f=fixture();t.after(f.cleanup);const policy={...f.policy,verifiers:[{...f.policy.verifiers[0]!,resultProtocol:'exit-v1' as const}]};
 const binding=captureIdentity({...f.options,workspace:f.source,policy,revisionId:'r0'});createVerificationContext({...f.options,workspace:f.source,policy,revisionId:'r0',expected:binding});
 const r=await verifyCandidate({...f.verification,binding},f.options.signal);assert.notEqual(r.status,'passed');assert.equal(r.checks.length,0);
});
