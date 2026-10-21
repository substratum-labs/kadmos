import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './repository_test_support.js';
import { safePath } from '../src/agent/repository/workspace.js';
import { runCli } from '../src/cli.js';
import { readCompleteRun } from '../src/agent/repository/publication.js';
function input(f:ReturnType<typeof fixture>) {
 const {backend,signal,revision,...rest}=f.options;
 return {...rest,schema:'kadmos.repository.v1',revisionId:revision.id,backend:f.backend.options};
}
function launch(f:ReturnType<typeof fixture>,value:unknown=input(f)) {
 const path=join(f.host,'input.json');writeFileSync(path,JSON.stringify(value));
 return spawnSync(process.execPath,[resolve('bin/kadmos.js'),'repo','run','--input',path],{encoding:'utf8',timeout:20000});
}
test('repository CLI real process delivers independently verified repaired candidate', {timeout:25000},t=>{
 const f=fixture('repair');t.after(f.cleanup);const p=launch(f);assert.equal(p.status,0,p.stderr+p.stdout);
 const result=JSON.parse(p.stdout);assert.equal(result.status,'delivered');assert.equal(result.runId,'run-1');assert.equal(result.artifactDir,safePath(f.options.artifactDir));
 const record=readCompleteRun({artifactDir:result.artifactDir,workspace:result.workspace,policy:{...f.policy,sourceRoot:safePath(f.policy.sourceRoot),verifiers:f.policy.verifiers.map(c=>({...c,executable:safePath(c.executable),cwd:safePath(c.cwd)}))},runId:result.runId});
 assert.equal(record.attempts.length,2);assert.equal(record.attempts[0]?.verification?.status,'failed');assert.equal(record.attempts[1]?.verification?.status,'passed');
 assert.match(readFileSync(join(result.workspace,'src/a.ts'),'utf8'),/number = 1/);assert.match(readFileSync(join(result.workspace,'src/b.ts'),'utf8'),/b = 2/);
 assert.equal(result.delivery.binding.candidate.digest,record.delivery?.binding.candidate.digest);
});
test('runCli rejects unknown repository arguments and invalid command arity',async()=>{
 for(const args of [['repo','run','--config','x'],['repo','continue','--input','x','--extra'],['repo','run','--input','x','--extra']])await assert.rejects(async()=>runCli(args),/Usage|repo run/);
});
for(const bad of ['signal','backend','limits','policy','revisionId','seamPaths','decisionsDir'])test(`CLI validates ${bad} before artifacts`,t=>{
 const f=fixture();t.after(f.cleanup);const v:Record<string,unknown>=input(f);
 v[bad]=bad==='signal'?{}:bad==='limits'?{maxAttempts:Infinity}:bad==='backend'?{executable:process.execPath,prefixArgs:['x'],model:'invented'}:bad==='policy'?{}:bad==='seamPaths'?['../bad']:bad==='decisionsDir'?f.source:'';
 const p=launch(f,v);assert.equal(p.status,1);assert.match(p.stderr,/input|invalid|host|absolute|overlap/i);assert.equal(existsSync(f.options.artifactDir),false);
});
test('CLI failed backend is blocked with no delivery',t=>{
 const f=fixture('quota');t.after(f.cleanup);const p=launch(f);assert.equal(p.status,1,p.stderr+p.stdout);const r=JSON.parse(p.stdout);assert.equal(r.status,'blocked');assert.equal(r.delivery,null);assert.equal(f.read('launches'),'1\n');
});
test('CLI SIGTERM aborts real running backend and returns incomplete evidence', {timeout:20000},async t=>{
 const f=fixture('hang');t.after(f.cleanup);const v=input(f);v.limits={...v.limits,attemptMs:10000};const path=join(f.host,'input.json');writeFileSync(path,JSON.stringify(v));
 const p=spawn(process.execPath,[resolve('bin/kadmos.js'),'repo','run','--input',path],{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);
 const done=new Promise<number|null>(res=>p.once('exit',res));t.after(()=>{if(p.exitCode===null)p.kill('SIGKILL');});
 const until=Date.now()+5000;while(!existsSync(join(f.host,'child.pid'))&&Date.now()<until)await delay(25);
 assert.ok(existsSync(join(f.host,'child.pid')),err);p.kill('SIGTERM');assert.equal(await done,1);const r=JSON.parse(out);assert.notEqual(r.status,'delivered');assert.equal(r.delivery,null);assert.equal(r.attempts[0].backend.status,'cancelled');assert.equal(r.attempts[0].backend.process.treeStopped,true);
});

test('CLI applies finite defaults and retains operator backend prefix verbatim',t=>{const f=fixture('quota');t.after(f.cleanup);const value:Record<string,unknown>=input(f);delete value.limits;delete value.decisionsDir;const p=launch(f,value);assert.equal(p.status,1,p.stderr);const r=JSON.parse(p.stdout);assert.equal(r.status,'blocked');assert.equal(r.limits.maxAttempts,3);assert.equal(r.limits.attemptMs,1200000);assert.equal(r.limits.overallMs,5400000);assert.deepEqual(r.attempts[0].backend.process.argv.slice(0,3),f.backend.options.prefixArgs);});

test('CLI preserves exit-v1 in frozen context, policy digest and complete check receipts',t=>{
 const f=fixture('repair');t.after(f.cleanup);const value=input(f);
 const p=launch(f,{...value,policy:{...value.policy,verifiers:value.policy.verifiers.map(c=>({...c,resultProtocol:'exit-v1'}))}});
 assert.equal(p.status,0,p.stderr+p.stdout);const r=JSON.parse(p.stdout);assert.equal(r.attempts.length,2);
 for(const a of r.attempts)assert.equal(a.verification.checks[0].command.resultProtocol,'exit-v1');
 const context=JSON.parse(readFileSync(join(r.artifactDir,'inputs/revisions/run-1/r0/verification-context/record.json'),'utf8'));
 assert.equal(context.context.policy.verifiers[0].resultProtocol,'exit-v1');
 assert.equal(r.delivery.binding.policy,context.context.baseline.policy);
});
for(const resultProtocol of ['exit-v2',null,1,{}])test(`CLI refuses invalid resultProtocol ${JSON.stringify(resultProtocol)} before artifacts or backend`,t=>{
 const f=fixture();t.after(f.cleanup);const v=input(f);const p=launch(f,{...v,policy:{...v.policy,verifiers:v.policy.verifiers.map(c=>({...c,resultProtocol}))}});
 assert.equal(p.status,1);assert.equal(existsSync(f.options.artifactDir),false);assert.equal(f.exists('launches'),false);
});
