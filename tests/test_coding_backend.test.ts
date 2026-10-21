import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { fixture } from './repository_test_support.js';
import { createWorkspace } from '../src/agent/repository/workspace.js';

test('A01 argv preserves literal stdin and hostile workspace bytes without shell effects', {timeout:20_000}, async t => {
  const f=fixture();t.after(f.cleanup);
  const result=await f.backend.run(f.task,f.options.signal);
  assert.equal(result.status,'exited','physical process must actually run');
  const observed=JSON.parse(f.read('invocation.json'));
  assert.deepEqual(observed.argv,['exec','--json','--color','never','--sandbox','workspace-write','--cd',f.source,'-']);
  assert.equal(observed.input,f.task.instructions);assert.equal(observed.selectedCwd,f.source);
  assert.equal(observed.cwd,f.source);assert.equal(existsSync(join(f.source,'PWNED')),false);
  assert.equal(result.process.argv.includes('--model'),false);assert.equal(result.process.argv.includes('--config'),false);
});
test('A02 zero exit and done prose are process evidence without delivery authority', async t=>{
  const f=fixture();t.after(f.cleanup);const r=await f.backend.run(f.task,f.options.signal);
  assert.equal(r.process.exitCode,0,'zero-exit fixture must execute');assert.equal('accepted' in r,false);
  assert.ok(r.candidate,'candidate identity must be independently inspectable');assert.equal(r.candidate.digest,f.binding.candidate.digest);
});
for(const mode of ['timeout','cancel','quota','malformed'] as const) test(`A03 ${mode} is bounded and retains diagnostics with no live descendants`,{timeout:20_000},async t=>{
  const f=fixture(mode==='timeout'||mode==='cancel'?'hang':mode);t.after(f.cleanup);
  const controller=new AbortController();t.after(()=>controller.abort());const timer=mode==='cancel'?setTimeout(()=>controller.abort(),250):null;
  t.after(()=>{if(timer)clearTimeout(timer);});
  const start=Date.now();const r=await f.backend.run(f.task,controller.signal);
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
