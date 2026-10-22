import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScriptedOrderDemo } from '../examples/repository-order-service/scripted-demo.js';
test('SCRIPTED faulty multi-file Fabric is repaired by bounded repository loop with independent HTTP assertions',{timeout:30000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'kadmos-scripted-order-'));t.after(()=>{try{if(process.env.KADMOS_F2_EVIDENCE){const dest=join(process.env.KADMOS_F2_EVIDENCE,'scripted-order');mkdirSync(dest,{recursive:true});cpSync(root,join(dest,'run'),{recursive:true});}}finally{rmSync(root,{recursive:true,force:true});}});
 const r=await runScriptedOrderDemo(root);assert.equal(r.status,'delivered',r.diagnostics.join('\n'));assert.equal(r.attempts.length,3);assert.deepEqual(r.attempts.map(a=>a.verification?.status),['failed','failed','passed']);assert.deepEqual(r.attempts.slice(0,2).map(a=>a.route),['CODE_REPAIR','CODE_REPAIR']);
 assert.match(r.diagnostics.join('\n'),/GUARD_ORDER/);assert.match(r.diagnostics.join('\n'),/NO_RETRY_AFTER_AMBIGUOUS_APPLY/);assert.equal(r.revisions.length,1);assert.deepEqual(r.effects,[],'expected negative fixture effects are scoped separately from business effects');
 const files=r.attempts.map(a=>a.verification!.before.candidate.files.filter(f=>f.path.startsWith('src/')));assert.notDeepEqual(files[0],files[1]);assert.notDeepEqual(files[1],files[2]);assert.equal(files[2]?.length,3);assert.match(readFileSync(join(root,'host/feedback.jsonl'),'utf8'),/GUARD_ORDER/);
});

import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fixture } from './repository_test_support.js';
import { runRepositoryTask } from '../src/agent/repository/loop.js';
import { hashBytes } from '../src/agent/repository/workspace.js';
test('SCRIPTED verifier import/setup faults exit86 without CODE_REPAIR; faulty Fabric exits1 and consumes repair budget',{timeout:45000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'kadmos-verifier-classification-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.equal((await runScriptedOrderDemo(root)).status,'delivered');
 const original=readFileSync(join(root,'host/verify.cjs'),'utf8');
 for(const kind of ['import','setup','fabric']){
  const f=fixture();t.after(f.cleanup);
  let code=original;
  if(kind==='import')code=code.replace('src/world_checker.js','src/missing-world-checker.js');
  if(kind==='setup')code=code.replaceAll(join(root,'source/world.yaml'),join(root,'missing-world.yaml'));
  writeFileSync(join(f.source,'src/fabric.mjs'),"export async function settle(){throw Error('GUARD_ORDER: invalid Fabric');}");
  const check=join(f.host,'classification.cjs');writeFileSync(check,code);
  for(const argv of [['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','faulty Fabric input']])assert.equal(spawnSync('git',argv,{cwd:f.source}).status,0);
  const baseCommit=spawnSync('git',['rev-parse','HEAD'],{cwd:f.source,encoding:'utf8'}).stdout.trim();
  const policy={...f.policy,baseCommit,verifiers:[{id:'classification',executable:process.execPath,argv:[check,'<candidate>','1',resolve(root,'host/negative-fixture-http')],cwd:f.host,programDigest:hashBytes(readFileSync(check)),failureKind:'functional' as const,resultProtocol:'exit-v1' as const}]};
  const r=await runRepositoryTask({...f.options,policy,limits:{...f.options.limits,maxAttempts:3,overallMs:25000}});
  assert.equal(r.attempts[0]?.verification?.checks[0]?.process.exitCode,kind==='fabric'?1:86,kind);
  assert.equal(r.attempts[0]?.route,kind==='fabric'?'CODE_REPAIR':'ENVIRONMENT_BLOCKED',kind);
  assert.equal(r.attempts.length,kind==='fabric'?3:1,'infrastructure cannot spend subsequent CODE_REPAIR attempts');assert.equal(r.delivery,null);
 }
});
