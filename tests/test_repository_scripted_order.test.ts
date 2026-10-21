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
