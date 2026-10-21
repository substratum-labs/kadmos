import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, actuator, hostFixture } from './repository_test_support.js';
import { DEFAULT_LIMITS, REPOSITORY_CONTRACT, type CodingBackend, type VerificationInput, type VerificationReceipt, type RepositoryRunOptions, type RepositoryRunRecord, type ApprovedWorldChange, type WorldRevision, type WorldChangeInput, type WorldChangeProposal, type RepositoryPolicy, type CandidateIdentity, type FailureRoute } from '../src/agent/repository/contracts.js';
import { validateDelivery } from '../src/agent/repository/artifacts.js';
import { CodexBackend } from '../src/agent/repository/codex_backend.js';
import { snapshotCandidate } from '../src/agent/repository/workspace.js';
import { verifyCandidate } from '../src/agent/repository/verify.js';
import { runRepositoryTask } from '../src/agent/repository/loop.js';
import { classifyFailure } from '../src/agent/repository/feedback.js';
import { proposeWorldChange, activateWorldRevision } from '../src/agent/repository/world_revision.js';
// Compile-time seams: these assignments fail the build if future implementations drift.
const seams: {
 backend:CodingBackend; snapshot:(w:string,p:RepositoryPolicy)=>CandidateIdentity;
 verify:(i:VerificationInput,s:AbortSignal)=>Promise<VerificationReceipt>;
 run:(o:RepositoryRunOptions)=>Promise<RepositoryRunRecord>;
 classify:(r:VerificationReceipt)=>FailureRoute;
 propose:(i:WorldChangeInput)=>WorldChangeProposal; activate:(i:ApprovedWorldChange)=>WorldRevision;
}={backend:new CodexBackend({executable:process.execPath,prefixArgs:[]}),snapshot:snapshotCandidate,verify:verifyCandidate,run:runRepositoryTask,classify:classifyFailure,propose:proposeWorldChange,activate:activateWorldRevision};
void seams;
void validateDelivery;
test('contract JSON transports exact identifiers, finite limits and unknown metrics',()=>{
 const value=JSON.parse(JSON.stringify({schema:REPOSITORY_CONTRACT,limits:DEFAULT_LIMITS,usage:'unknown'}));
 assert.equal(value.schema,'kadmos.repository.v1');assert.equal(value.usage,'unknown');
 assert.ok(Object.values(value.limits).every(v=>typeof v==='number'&&Number.isFinite(v)&&v>0));
});
test('hostile executable fixture actually accepts bytes and exits zero independently of backend',t=>{
 const f=fixture();t.after(f.cleanup);
 const r=spawnSync(process.execPath,[hostFixture,'noop',f.host,'exec','--json','--cd',f.source,'-'],{cwd:f.source,input:f.task.instructions,encoding:'utf8',timeout:2000});
 assert.equal(r.status,0);assert.equal(JSON.parse(f.read('invocation.json')).input,f.task.instructions);
 assert.equal(JSON.parse(r.stdout.trim().split('\n').at(-1)!).type,'turn.completed');
});
test('independent verifier fixture distinguishes faulty multi-file candidate from repair',t=>{
 const f=fixture();t.after(f.cleanup);const cmd=f.policy.verifiers[0]!;
 assert.equal(spawnSync(cmd.executable,cmd.argv.map(x=>x==='<candidate>'?f.source:x),{cwd:cmd.cwd}).status,0);
 writeFileSync(join(f.source,'src/a.ts'),'export const a: number = "bad";');
 const bad=spawnSync(cmd.executable,cmd.argv.map(x=>x==='<candidate>'?f.source:x),{cwd:cmd.cwd,encoding:'utf8'});
 assert.equal(bad.status,1);assert.match(bad.stderr,/TYPE_ERROR/);
});
test('independent actuator observes commit/drop, same-ID dedup, restart query and refusal',t=>{
 const f=fixture();t.after(f.cleanup);const file=join(f.host,'effects.json');
 assert.equal(actuator(file,'apply','refused','refuse').status,2);
 assert.equal(actuator(file,'apply','op-1','drop').status,4);
 assert.equal(actuator(file,'apply','op-1','normal').status,0);
 assert.equal(JSON.parse(readFileSync(file,'utf8')).effects,1);
 assert.deepEqual(JSON.parse(actuator(file,'query','op-1','normal').stdout),{outcome:'committed',effects:1});
 assert.equal(actuator(file,'query','op-1','unavailable').status,3);
});

test('JSON input schema rejects missing exact approval bindings and nonfinite limits',t=>{
 const f=fixture();t.after(f.cleanup);
 const schema=JSON.parse(readFileSync('docs/repository-input.schema.json','utf8'));
 function valid(value:unknown,rule:Record<string,unknown>):boolean {
  if(typeof rule.$ref==='string')return valid(value,schema.$defs[rule.$ref.split('/').at(-1)!]);
  if(Array.isArray(rule.oneOf))return rule.oneOf.filter(r=>valid(value,r)).length===1;
  if(rule.type==='array')return Array.isArray(value)&&(!rule.minItems||value.length>=Number(rule.minItems))&&value.every(v=>valid(v,rule.items as Record<string,unknown>));
  if(rule.type==='boolean')return typeof value==='boolean';
  if(Array.isArray(rule.enum)&&!rule.enum.includes(value))return false;
  if(rule.type==='string')return typeof value==='string'&&(!rule.pattern||new RegExp(String(rule.pattern)).test(value))&&(!rule.minLength||value.length>=Number(rule.minLength));
  if(rule.type==='integer')return typeof value==='number'&&Number.isSafeInteger(value)&&value>=Number(rule.minimum)&&value<=Number(rule.maximum);
  if(rule.type==='object') {
   if(!value||typeof value!=='object'||Array.isArray(value))return false;
   const obj=value as Record<string,unknown>,props=rule.properties as Record<string,Record<string,unknown>>;
   return (rule.required as string[]).every(k=>Object.hasOwn(obj,k))&&Object.keys(obj).every(k=>Object.hasOwn(props,k)&&valid(obj[k],props[k]!));
  }
  return true;
 }
 const digest=`sha256:${'a'.repeat(64)}`;
 const decision={command:'approve-world',operator:'operator',runId:'run-1',proposalId:'p1',proposalDigest:digest,baseRevisionId:'r0',baseWorld:digest,patchDigest:digest,recordedAt:'2026-10-20T00:00:00Z'};
 assert.equal(valid(decision,schema),true);
 const run={schema:REPOSITORY_CONTRACT,runId:'run-1',source:f.source,artifactDir:f.options.artifactDir,requirementsPath:f.options.requirementsPath,worldPath:f.options.worldPath,seamPaths:f.options.seamPaths,instructions:f.options.instructions,policy:f.policy,backend:{executable:process.execPath,prefixArgs:[]},limits:DEFAULT_LIMITS,revisionId:'r0',decisionsDir:f.options.decisionsDir};
 assert.equal(valid(run,schema),true);
 for(const altered of [{...run,seamPaths:'wrong'},{...run,policy:{...f.policy,verifiers:[]}},{...run,policy:{...f.policy,verifiers:[{...f.policy.verifiers[0],argv:false}]}}])assert.equal(valid(altered,schema),false);
 const continuation={schema:REPOSITORY_CONTRACT,runId:'run-1',artifactDir:f.options.artifactDir,revisionId:'r0'};
 assert.equal(valid(continuation,schema),true);assert.equal(valid({...continuation,backendApproval:true},schema),false);
 const proposal={schema:REPOSITORY_CONTRACT,runId:'run-1',proposalId:'p1',baseRevisionId:'r0',baseWorld:digest,patch:'exact World bytes',artifactDir:f.options.artifactDir,rationale:'new requirement',requirements:digest};
 assert.equal(valid(proposal,schema),true);assert.equal(valid({...proposal,patch:[]},schema),false);
 assert.equal(valid({...run,policy:{...f.policy,verifiers:[{...f.policy.verifiers[0],programDigest:'sha256:pending'}]}},schema),false);
 for(const key of ['runId','proposalId','proposalDigest','baseRevisionId','baseWorld','patchDigest']) {
  const altered:Record<string,unknown>={...decision};delete altered[key];assert.equal(valid(altered,schema.$defs.decision),false);
 }
 assert.equal(valid({...decision,accepted:true},schema.$defs.decision),false);
 for(const bad of [0,-1,Infinity,NaN,1.5])assert.equal(valid({...DEFAULT_LIMITS,maxAttempts:bad},schema.$defs.limits),false);
});
