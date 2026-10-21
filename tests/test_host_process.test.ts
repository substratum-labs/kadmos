import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supervise } from '../src/agent/repository/host_process.js';

// Losing the known-PID union leaves this real departed worker alive when ps fails.
test('D1c failed inventory still signals the previously observed departed worker', { timeout: 15_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'd1c-cleanup-'));
  const oldPath = process.env.PATH;
  let pid = 0;
  t.after(() => { process.env.PATH = oldPath; if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} } rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, 'ps'), '#!/bin/sh\nif [ -f "'+join(dir,'fail')+'" ]; then exit 1; fi\nexec /bin/ps "$@"\n', { mode: 0o700 });
  writeFileSync(join(dir,'worker.cjs'), `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(dir,'pid'))},String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(join(dir,'term'))},'yes');process.exit(0)});setInterval(()=>{},50);`);
  writeFileSync(join(dir,'parent.cjs'), `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,[${JSON.stringify(join(dir,'worker.cjs'))}],{detached:true,stdio:'ignore'});c.unref();setTimeout(()=>fs.writeFileSync(${JSON.stringify(join(dir,'fail'))},''),500);setTimeout(()=>process.exit(0),750);`);
  process.env.PATH = dir + ':' + oldPath;
  const r = await supervise(process.execPath, [join(dir,'parent.cjs')], dir, '', join(dir,'out'), join(dir,'err'), new AbortController().signal, Date.now()+4000, 100, false);
  pid = Number(readFileSync(join(dir,'pid'),'utf8'));
  const lifecycle=JSON.parse(readFileSync(join(dir,'out.lifecycle.json'),'utf8'));
  assert.ok(lifecycle.tracked.some((p: {pid:number})=>p.pid===pid),'worker really sampled before failure');
  assert.equal(r.treeStopped,'unknown');
  assert.equal(existsSync(join(dir,'term')),true,'known departed PID must receive cleanup SIGTERM despite failed ps');
});

// Removing the observation cap makes the real on-disk sidecar exceed its retained budget.
test('D1c lifecycle observation retention is bounded with honest counts', { timeout: 15_000 }, async t => {
  const dir=mkdtempSync(join(tmpdir(),'d1c-bound-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const r=await supervise(process.execPath,['-e','setTimeout(()=>{},6000)'],dir,'',join(dir,'out'),join(dir,'err'),new AbortController().signal,Date.now()+9000,100,false);
  assert.equal(r.exitCode,0);
  const l=JSON.parse(readFileSync(join(dir,'out.lifecycle.json'),'utf8'));
  assert.ok(l.observations.length<=64,'retained observations must stay within 64 samples');
  assert.ok(l.observationCount>64,'real supervision exceeded retention budget');
  assert.equal(l.observationsDropped,l.observationCount-l.observations.length);
  assert.equal(l.observationsTruncated,true);
  assert.equal(l.observationsSpilled,0);
});

// Removing finally cleanup strands this real child when its output path disappears.
test('D1c output I/O failure after spawn still reaps the child and refuses qualification', { timeout: 10_000 }, async t => {
  const dir=mkdtempSync(join(tmpdir(),'d1c-io-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const out=join(dir,'out');
  const r=await supervise(process.execPath,['-e',`require('node:fs').unlinkSync(${JSON.stringify(out)});setInterval(()=>{},50)`],dir,'',out,join(dir,'err'),new AbortController().signal,Date.now()+3000,100,false);
  assert.equal(r.reason,'launch_failed');assert.equal(r.treeStopped,'unknown');assert.ok(r.pid);
  assert.throws(()=>process.kill(r.pid!,0));
  assert.ok(r.diagnostics.some(x=>x.includes('supervision:')));
});
