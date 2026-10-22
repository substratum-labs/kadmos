import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, d } from './repository_test_support.js';
import { createWorkspace } from '../src/agent/repository/workspace.js';
import { captureIdentity } from '../src/agent/repository/identity.js';
function setup(t: import('node:test').TestContext) {
 const f=fixture();t.after(f.cleanup); const workspace=join(f.root,'candidate');
 assert.equal(createWorkspace({source:f.source,destination:workspace,policy:f.policy}).status,'created');
 const request={...f.options,workspace,revisionId:'r0'};
 return {f,workspace,request};
}
test('host capture maps source paths to clone and matches frozen B preimages',t=>{
 const {f,request}=setup(t);assert.deepEqual(captureIdentity(request),f.binding);
 writeFileSync(join(f.source,'requirements.md'),'source drift');
 assert.deepEqual(captureIdentity(request),f.binding);
});
test('allowed binary additions, executable modes and deletions bind exact candidate bytes',t=>{
 const {f,workspace,request}=setup(t);const baseline=f.binding;
 writeFileSync(join(workspace,'src/raw'),Buffer.from([0,255,128]));chmodSync(join(workspace,'src/raw'),0o755);rmSync(join(workspace,'src/b.ts'));
 const actual=captureIdentity({...request,baseline});assert.notEqual(actual.candidate.digest,baseline.candidate.digest);
 assert.deepEqual(actual.candidate.files.find(x=>x.path==='src/raw'),{path:'src/raw',sha256:`sha256:${createHash('sha256').update(Buffer.from([0,255,128])).digest('hex')}`,executable:true});
 assert.deepEqual(actual.candidate.deleted,['src/b.ts']);
});
for(const mode of ['requirements','world','seam','protected-delete','unauthorized-add','unauthorized-mode','policy','overlap','symlink','escape','collision'])test(`host capture refuses ${mode}`,t=>{
 const {f,workspace,request}=setup(t);let r={...request,baseline:f.binding};
 if(mode==='requirements')writeFileSync(join(workspace,'requirements.md'),'changed');
 if(mode==='world')writeFileSync(join(workspace,'world.yaml'),readFileSync(join(workspace,'world.yaml'),'utf8')+'\n# drift');
 if(mode==='seam')writeFileSync(join(workspace,'generated/ports.d.ts'),'hand edited');
 if(mode==='protected-delete')rmSync(join(workspace,'acceptance.txt'));
 if(mode==='unauthorized-add')writeFileSync(join(workspace,'rogue.bin'),'x');
 if(mode==='unauthorized-mode')chmodSync(join(workspace,'acceptance.txt'),0o755);
 if(mode==='policy')r={...r,policy:{...r.policy,allowedPaths:['src/','rogue']}};
 if(mode==='overlap')r={...r,policy:{...r.policy,excludedOutputs:['generated/']}};
 if(mode==='symlink')symlinkSync(f.host,join(workspace,'src/link'));
 if(mode==='escape')r={...r,worldPath:join(f.host,'world.yaml')};
 if(mode==='collision')r={...r,seamPaths:[...r.seamPaths,...r.seamPaths]};
 assert.throws(()=>captureIdentity(r));
});
test('protected wins even when allowed and seam regeneration independently rejects initial hand edits',t=>{
 const {f,workspace,request}=setup(t);
 writeFileSync(join(workspace,'generated/ports.d.ts'),'hand edited');assert.throws(()=>captureIdentity(request));
 copyFileSync(join(f.source,'generated/ports.d.ts'),join(workspace,'generated/ports.d.ts'));
 const r={...request,policy:{...f.policy,allowedPaths:['src/','acceptance.txt']}};const baseline=captureIdentity(r);
 writeFileSync(join(workspace,'acceptance.txt'),'changed');assert.throws(()=>captureIdentity({...r,baseline}));
});
