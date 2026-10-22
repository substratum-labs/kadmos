import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, symlinkSync, realpathSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { fixture } from './repository_test_support.js';
import { ScriptedBackend } from '../src/agent/repository/backend.js';
import { CodexBackend } from '../src/agent/repository/codex_backend.js';
import { snapshotCandidate, createWorkspace } from '../src/agent/repository/workspace.js';

test('A01 argv preserves literal stdin and hostile workspace bytes without shell effects', {timeout:20_000}, async t => {
  const f=fixture();t.after(f.cleanup);
  const result=await f.backend.run(f.task,f.options.signal);
  assert.equal(result.status,'exited','physical process must actually run');
  const observed=JSON.parse(f.read('invocation.json'));
  assert.deepEqual(observed.argv,['exec','--json','--color','never','--sandbox','workspace-write','--cd',f.source,'-']);
  assert.equal(observed.input,f.task.instructions);assert.equal(observed.selectedCwd,f.source);
  assert.equal(observed.cwd,realpathSync(f.source));assert.equal(existsSync(join(f.source,'PWNED')),false);
  assert.equal(result.process.argv.includes('--model'),false);assert.equal(result.process.argv.includes('--config'),false);
});
test('A02 zero exit and done prose are process evidence without delivery authority', async t=>{
  const f=fixture();t.after(f.cleanup);const r=await f.backend.run(f.task,f.options.signal);
  assert.equal(r.process.exitCode,0,'zero-exit fixture must execute');assert.equal('accepted' in r,false);
  assert.ok(r.candidate,'candidate identity must be independently inspectable');assert.equal(r.candidate.digest,f.binding.candidate.digest);
});
for(const mode of ['timeout','cancel','quota','malformed'] as const) test(`A03 ${mode} is bounded and retains diagnostics with no live descendants`,{timeout:20_000},async t=>{
  const f=fixture(mode==='cancel'?'hang-delayed-heartbeat':mode==='timeout'?'hang':mode,'normal',{attemptMs:mode==='cancel'?3000:800});t.after(f.cleanup);
  const controller=new AbortController();
  // Cancellation must exercise a live descendant, even when its first sample is delayed.
  // Intentional timeout/cancellation budgets are explicit at fixture creation.
  const task=f.task;
  const start=Date.now();
  const r=await (async()=>{
    const running=f.backend.run(task,controller.signal);
    // Readiness assertions can fail before we await the result. Always reap the run.
    void running.catch(()=>{});
    try {
      if(mode==='cancel') {
        const startupDeadline=Date.now()+2500;
        while(!f.exists('heartbeat')||f.read('heartbeat').length===0) {
          assert.ok(Date.now()<startupDeadline,'live descendant heartbeat startup deadline');
          await delay(10);
        }
        assert.ok(f.exists('child.pid'),'fixture spawned a descendant before cancellation');
        const pid=Number(f.read('child.pid'));
        assert.ok(Number.isSafeInteger(pid)&&pid>0,'recorded descendant PID');
        process.kill(pid,0);
        controller.abort();
      }
      return await running;
    } finally {
      controller.abort();
      await running;
    }
  })();
  assert.equal(r.status,mode==='cancel'?'cancelled':mode,'failure must reflect physical observation');
  assert.ok(Date.now()-start<4000);assert.ok(r.diagnostics.length>0);assert.ok(existsSync(r.process.stdoutPath));assert.ok(existsSync(r.process.stderrPath));assert.equal(f.read('launches').trim().split('\n').length,1,'no automatic retry');
  if(mode==='timeout'||mode==='cancel') {
    assert.equal(r.process.treeStopped,true);assert.ok(f.exists('child.pid'),'fixture spawned a descendant');
    const before=f.read('heartbeat');await delay(150);assert.equal(f.read('heartbeat'),before);
    const pid=Number(f.read('child.pid'));assert.throws(()=>process.kill(pid,0));
  }
});
for(const mode of ['dirty','symlink'] as const) test(`A04 ${mode} refuses workspace and preserves original`,t=>{
  const f=fixture();t.after(f.cleanup);const original=readFileSync(join(f.source,'src/a.ts'),'utf8');
  if(mode==='dirty')writeFileSync(join(f.source,'src/untracked.ts'),'untracked');
  else {
    symlinkSync(f.host,join(f.source,'src/escape'),process.platform==='win32'?'junction':'dir');
    if(process.platform!=='win32') {
      assert.equal(spawnSync('git',['add','.'],{cwd:f.source}).status,0);
      assert.equal(spawnSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','committed escape'],{cwd:f.source}).status,0);
    }
  }
  const baseCommit=mode==='symlink'&&process.platform!=='win32'?spawnSync('git',['rev-parse','HEAD'],{cwd:f.source,encoding:'utf8'}).stdout.trim():f.policy.baseCommit;
  const r=createWorkspace({source:f.source,destination:join(f.root,'candidate'),policy:{...f.policy,baseCommit}});
  assert.equal(r.status,'refused');assert.equal(r.workspace,null);assert.equal(readFileSync(join(f.source,'src/a.ts'),'utf8'),original);
  assert.equal(existsSync(join(f.root,'candidate')),false);
});

test('C workspace copies frozen base, snapshots additions/deletions, refuses path aliases', t=>{
 const f=fixture();t.after(f.cleanup);const destination=join(f.root,'candidate');
 const r=createWorkspace({source:f.source,destination,policy:f.policy});
 assert.equal(r.status,'created');assert.equal(r.workspace,destination);
 assert.equal(snapshotCandidate(destination,f.policy).digest,f.binding.candidate.digest);
 assert.equal(createWorkspace({source:f.source,destination,policy:f.policy}).status,'refused');
 writeFileSync(join(destination,'src/new.ts'),'new');
 const after=snapshotCandidate(destination,f.policy);assert.ok(after.files.some(x=>x.path==='src/new.ts'));assert.notEqual(after.digest,f.binding.candidate.digest);
 assert.equal(createWorkspace({source:f.source,destination:join(f.source,'nested'),policy:f.policy}).status,'refused');
});
test('C launch failure, pre-abort, invalid limits and candidate-local artifacts do not launch',async t=>{
 const f=fixture();t.after(f.cleanup);
 const missing=new CodexBackend({executable:join(f.host,'missing'),prefixArgs:[]});
 const r=await missing.run(f.task,f.options.signal);assert.equal(r.status,'launch_failed');assert.equal(r.process.exitCode,null);
 const c=new AbortController();c.abort();assert.equal((await f.backend.run({...f.task,attemptId:'abort'},c.signal)).status,'cancelled');
 assert.equal((await f.backend.run({...f.task,attemptId:'bad',limits:{...f.task.limits,attemptMs:Infinity}},f.options.signal)).status,'not_started');
 assert.equal((await f.backend.run({...f.task,artifactDir:join(f.source,'logs')},f.options.signal)).status,'not_started');assert.equal(f.exists('launches'),false);
});
test('C physical receipt captures version, usage and immutable attempt logs',async t=>{
 const f=fixture();t.after(f.cleanup);const r=await f.backend.run(f.task,f.options.signal);
 assert.equal(r.status,'exited');assert.ok(r.process.version.includes(process.version));assert.ok(r.process.pid);assert.ok(r.process.startedAt);assert.ok(r.process.endedAt);
 assert.deepEqual(r.process.usage,{tokens:2,costUsd:'unknown'});assert.equal(r.process.treeStopped,true);
 assert.equal((await f.backend.run(f.task,f.options.signal)).status,'not_started');
 assert.equal(f.read('launches').trim(),'1');
});
test('C normal parent exit stops a lingering descendant before returning',{timeout:20_000},async t=>{
 const f=fixture('linger');t.after(f.cleanup);const r=await f.backend.run(f.task,f.options.signal);
 assert.equal(r.status,'exited');assert.equal(r.process.exitCode,0);assert.equal(r.process.treeStopped,true);
 const before=f.read('heartbeat');await delay(150);assert.equal(f.read('heartbeat'),before);
 assert.throws(()=>process.kill(Number(f.read('child.pid')),0));
});

for(const mode of ['stubborn','escape'] as const)test(`C ${mode} descendants stop and escaped qualification stays unknown`,{timeout:20_000},async t=>{
 const f=fixture(mode,'normal',{attemptMs:800});t.after(f.cleanup);const r=await f.backend.run(f.task,f.options.signal);
 assert.equal(r.status,'timeout');assert.equal(r.process.treeStopped,mode==='escape'?'unknown':true);assert.equal(r.candidate,null);
 const before=f.read('heartbeat');await delay(150);assert.equal(f.read('heartbeat'),before);
 assert.throws(()=>process.kill(Number(f.read('child.pid')),0));
});
test('C snapshot rejects symlink ancestors and special edit paths; records deleted files',t=>{
 const f=fixture();t.after(f.cleanup);unlinkSync(join(f.source,'src/a.ts'));
 assert.deepEqual(snapshotCandidate(f.source,f.policy).deleted,['src/a.ts']);
 symlinkSync(f.source,join(f.root,'alias'),'dir');assert.throws(()=>snapshotCandidate(join(f.root,'alias'),f.policy),/symlink/);
 assert.throws(()=>snapshotCandidate(f.source,{...f.policy,excludedOutputs:['../']}),/invalid relative/);
});

test('C incomplete runtime limits refuse before any executable launch',async t=>{
 const f=fixture();t.after(f.cleanup);
 const {maxAttempts: _omitted, ...partial}=f.task.limits; const limits=partial as typeof f.task.limits;
 assert.equal((await f.backend.run({...f.task,limits},f.options.signal)).status,'not_started');assert.equal(f.exists('launches'),false);
});
test('C scripted backend uses the same physical evidence contract',async t=>{
 const f=fixture();t.after(f.cleanup);const r=await new ScriptedBackend(f.backend.options).run(f.task,f.options.signal);
 assert.equal(r.status,'exited');assert.equal(r.process.exitCode,0);assert.equal('accepted' in r,false);
});

for (const mode of ['natural-group','natural-subtree','reparented-group'] as const) test(`CQ ${mode} distinguishes observed natural closure from lost lineage`,{timeout:20_000},async t=>{
 const f=fixture(mode);t.after(f.cleanup);
 const task={...f.task,limits:{...f.task.limits,attemptMs:2500}};
 const r=await f.backend.run(task,f.options.signal);
 assert.equal(r.process.exitCode,0);
 assert.equal(r.process.treeStopped,mode!=='reparented-group'?true:'unknown');
 assert.equal(r.status,mode!=='reparented-group'?'exited':'launch_failed');
 assert.equal(Boolean(r.candidate),mode!=='reparented-group');
 const lifecycle=JSON.parse(readFileSync(r.process.stdoutPath+'.lifecycle.json','utf8'));
 assert.equal(lifecycle.escaped,true);assert.equal(lifecycle.inventoryFailed,false);
 assert.ok(lifecycle.observations.length>2);
 assert.ok(lifecycle.observations.some((o:{members:{group:number}[]})=>o.members.some(p=>p.group!==r.process.pid)));
 if(mode!=='reparented-group')assert.ok(lifecycle.naturallyClosed.includes(Number(f.read('child.pid'))));
 else assert.equal(lifecycle.lineageLost,true);
});

for(const failure of ['unavailable','malformed'] as const)test(`CQ ${failure} inventory never qualifies an empty remaining set`,async t=>{
 const f=fixture();t.after(f.cleanup);
 const ps=join(f.host,'ps');writeFileSync(ps,failure==='unavailable'?'#!/bin/sh\nexit 1\n':'#!/bin/sh\nprintf "bad inventory\\n"\n');chmodSync(ps,0o700);
 const previous=process.env.PATH;process.env.PATH=f.host+':'+(previous??''); t.after(()=>{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;});
 const r=await f.backend.run(f.task,f.options.signal);
 assert.equal(r.status,'launch_failed');assert.equal(r.process.treeStopped,'unknown');assert.equal(r.candidate,null);
 const lifecycle=JSON.parse(readFileSync(join(f.task.artifactDir,'attempts/a1/version.stdout.lifecycle.json'),'utf8'));
 assert.equal(lifecycle.inventoryFailed,true);assert.deepEqual(lifecycle.remaining,[]);
 assert.ok(lifecycle.observations.some((o:{members:unknown})=>o.members===null));
});

test('CQ ordinary exit with surviving departed child stays unknown even after cleanup',{timeout:20_000},async t=>{
 const f=fixture('escape-linger');t.after(f.cleanup);
 const r=await f.backend.run(f.task,f.options.signal);
 assert.equal(r.process.exitCode,0);assert.equal(r.status,'launch_failed');
 assert.equal(r.process.treeStopped,'unknown');assert.equal(r.candidate,null);
 const lifecycle=JSON.parse(readFileSync(r.process.stdoutPath+'.lifecycle.json','utf8'));
 assert.equal(lifecycle.lineageLost,true);assert.ok(lifecycle.observations.some((o:{phase:string})=>o.phase==='cleanup'));
 assert.throws(()=>process.kill(Number(f.read('child.pid')),0));
});
test('CQ missing lifecycle receipt cannot return a candidate',async t=>{
 const f=fixture('receipt-collision');t.after(f.cleanup);
 await assert.rejects(f.backend.run(f.task,f.options.signal),/EEXIST/);
 assert.equal(existsSync(join(f.task.artifactDir,'attempts/a1/process.json')),false);
 assert.equal(existsSync(join(f.task.artifactDir,'attempts/a1/stdout.jsonl')),true);
});
