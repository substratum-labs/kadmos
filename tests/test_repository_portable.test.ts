import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, hostFixture } from './repository_test_support.js';
import { codexArguments } from '../src/agent/repository/codex_backend.js';
import { snapshotCandidate } from '../src/agent/repository/workspace.js';

// Break caught: interpolation/shell dispatch or changed actual adapter argv/stdin.
test('portable adapter argv crosses real shell:false transport literally', t => {
  const f=fixture();t.after(f.cleanup);
  const argv=codexArguments([hostFixture,'noop',f.host],f.source);
  const r=spawnSync(process.execPath,argv,{cwd:f.source,shell:false,input:f.task.instructions,encoding:'utf8',timeout:10_000});
  assert.equal(r.status,0);
  const observed=JSON.parse(f.read('invocation.json'));
  assert.deepEqual(observed.argv,['exec','--json','--color','never','--sandbox','workspace-write','--cd',f.source,'-']);
  assert.equal(observed.input,'literal $(touch PWNED) ; & | " text');
  assert.equal(observed.selectedCwd,f.source);
  assert.equal(existsSync(join(f.source,'PWNED')),false);
  assert.equal('delivered' in observed,false);
});
// Break caught: snapshot accepting escaped policy paths or ignoring candidate byte changes.
test('portable snapshot boundary observes edits and rejects escaped policy paths', t => {
  const f=fixture();t.after(f.cleanup);
  const before=snapshotCandidate(f.source,f.policy);
  writeFileSync(join(f.source,'src/a.ts'),'export const a = 3;');
  assert.notEqual(snapshotCandidate(f.source,f.policy).digest,before.digest);
  assert.throws(()=>snapshotCandidate(f.source,{...f.policy,allowedPaths:['../escape/']}));
});
if(process.platform==='win32') {
  // Real unsupported OS gate must run before executable resolution or actuation.
  test('Windows unsupported backend refuses before launch and delivery', async t => {
    const f=fixture();t.after(f.cleanup);
    const r=await f.backend.run(f.task,f.options.signal);
    assert.equal(r.status,'not_started');assert.equal(r.process.pid,null);
    assert.equal(r.process.startedAt,null);assert.deepEqual(r.process.argv,[]);
    assert.equal(r.process.treeStopped,'unknown');assert.equal(r.candidate,null);
    assert.match(r.diagnostics.join(' '),/unqualified.*no process launched/);
    assert.equal(f.exists('invocation.json'),false);
    assert.equal(existsSync(join(f.task.artifactDir,'attempts')),false);
  });
}
