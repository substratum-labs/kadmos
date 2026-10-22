import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './repository_test_support.js';
import { createWorkspace, hashBytes } from '../src/agent/repository/workspace.js';
import { createVerificationContext, loadVerificationContext } from '../src/agent/repository/context.js';
import { createAtomicJson, readAtomicJson } from '../src/agent/repository/store.js';
function setup(t: import('node:test').TestContext) {
 const f=fixture(); t.after(f.cleanup);const workspace=join(f.root,'candidate');
 assert.equal(createWorkspace({source:f.source,destination:workspace,policy:f.policy}).status,'created');
 const create={...f.options,workspace,revisionId:'r0',expected:f.binding};
 const read={artifactDir:f.options.artifactDir,runId:'run-1',revisionId:'r0',workspace,policy:f.policy};
 const dir=join(read.artifactDir,'inputs/revisions/run-1/r0/verification-context');
 return {f,workspace,create,read,dir};
}
// Break caught: accepting candidate edits without the original frozen baseline, or losing source role declarations.
test('host context round-trips exact baseline and stable roles before candidate edits',t=>{
 const {f,workspace,create,read,dir}=setup(t);let context!: ReturnType<typeof createVerificationContext>;assert.doesNotThrow(()=>{context=createVerificationContext(create);});
 assert.deepEqual(context.baseline,f.binding); assert.equal(context.roles.worldPath,join(f.source,'world.yaml'));
 assert.ok(existsSync(join(dir,'record.json')));assert.ok(Object.isFrozen(context.baseline.candidate.files));
 writeFileSync(join(workspace,'src/a.ts'),'export const a=42;');
 const loaded=loadVerificationContext(read);assert.deepEqual(loaded.context,context);
 assert.notEqual(loaded.current.candidate.digest,f.binding.candidate.digest);
 assert.deepEqual(loaded.context.baseline,f.binding);assert.deepEqual(readdirSync(dir),['record.json']);
 assert.throws(()=>createVerificationContext(create));
});
// Break caught: writing an unvalidated initial identity, wrong policy, or permitting edit-set overlap.
for(const mode of ['requirements','world','seam','candidate','revision','policy','protected','inside-candidate','inside-source'])test(`context creation refuses ${mode}`,t=>{
 const {f,workspace,create}=setup(t);let input={...create};
 if(['requirements','world','seam','policy'].includes(mode))input={...input,expected:{...f.binding,[mode]:hashBytes('wrong')}};
 if(mode==='candidate')input={...input,expected:{...f.binding,candidate:{...f.binding.candidate,digest:hashBytes('wrong')}}};
 if(mode==='revision')input={...input,expected:{...f.binding,revisionId:'other'}};
 if(mode==='protected')writeFileSync(join(workspace,'acceptance.txt'),'drift');
 if(mode==='inside-candidate')input={...input,artifactDir:join(workspace,'dist/context')};
 if(mode==='inside-source')input={...input,artifactDir:join(f.source,'dist/context')};
 assert.throws(()=>createVerificationContext(input));
});
// Break caught: reading a record under a different host identity or permitting frozen/protected input drift.
for(const mode of ['run','revision','policy','requirements','world','seam','protected','unauthorized'])test(`context load refuses ${mode}`,t=>{
 const {workspace,create,read}=setup(t);createVerificationContext(create);let input={...read};
 if(mode==='run')input={...input,runId:'other'};
 if(mode==='revision')input={...input,revisionId:'r1'};
 if(mode==='policy')input={...input,policy:{...input.policy,allowedPaths:['other/']}};
 const paths:Record<string,string>={requirements:'requirements.md',world:'world.yaml',seam:'generated/ports.d.ts',protected:'acceptance.txt',unauthorized:'outside.txt'};
 if(paths[mode])writeFileSync(join(workspace,paths[mode]!), 'drift');
 assert.throws(()=>loadVerificationContext(input));
});
// Break caught: trusting malformed/tampered host records, including canonical digest forgery with a refreshed envelope.
for(const mode of ['partial','json','run','revision','policy','digest','file-order','role','extra'])test(`context refuses malformed stored ${mode}`,t=>{
 const {create,read,dir}=setup(t);createVerificationContext(create);const file=join(dir,'record.json');
 const value=JSON.parse(readFileSync(file,'utf8'));
 if(mode==='partial')writeFileSync(file,'{"context":');
 else if(mode==='json')writeFileSync(file,'null');
 else {
  if(mode==='run')value.context.runId='other';
  if(mode==='revision')value.context.revisionId='other';
  if(mode==='policy')value.context.policy.allowedPaths=['other/'];
  if(mode==='digest')value.context.baseline.candidate.digest=hashBytes('wrong');
  if(mode==='file-order')value.context.baseline.candidate.files.reverse();
  if(mode==='role')value.context.roles.worldPath=join(read.workspace,'world.yaml');
  if(mode==='extra')value.context.accepted=true;
  value.digest=hashBytes(JSON.stringify(value.context));writeFileSync(file,JSON.stringify(value));
 }
 assert.throws(()=>loadVerificationContext(read));
});
// Break caught: alias traversal, candidate-controlled context location, or identifier path escape.
for(const mode of ['../escape','a/b','a\\b','..','', '/absolute'])test(`context refuses unsafe id ${JSON.stringify(mode)}`,t=>{
 const {create,read}=setup(t);assert.throws(()=>createVerificationContext({...create,runId:mode}));
 assert.throws(()=>createVerificationContext({...create,revisionId:mode}));
 assert.throws(()=>loadVerificationContext({...read,runId:mode}));
});
test('context refuses symlink ancestors and record aliases without touching targets',t=>{
 const {f,create,read,dir}=setup(t);mkdirSync(read.artifactDir,{recursive:true});symlinkSync(f.host,join(read.artifactDir,'inputs'));
 assert.throws(()=>createVerificationContext(create));rmSync(join(read.artifactDir,'inputs'));
 createVerificationContext(create);const file=join(dir,'record.json');const target=join(f.host,'target.json');writeFileSync(target,'sentinel');rmSync(file);symlinkSync(target,file);
 assert.throws(()=>loadVerificationContext(read));assert.equal(readFileSync(target,'utf8'),'sentinel');
});
// Break caught: publishing partial bytes, replacing existing records, or reading orphan temporary files as complete.
test('atomic store publishes complete JSON once and refuses overwrite or incomplete reservation',t=>{
 const {f}=setup(t);const dir=join(f.host,'atomic');assert.doesNotThrow(()=>createAtomicJson(dir,{state:'incomplete',items:[1,2]}));
 assert.deepEqual(readAtomicJson(dir),{state:'incomplete',items:[1,2]});assert.deepEqual(readdirSync(dir),['record.json']);
 assert.throws(()=>createAtomicJson(dir,{state:'delivered'}));assert.equal(JSON.parse(readFileSync(join(dir,'record.json'),'utf8')).state,'incomplete');
 const partial=join(f.host,'partial');mkdirSync(partial);writeFileSync(join(partial,'.record.interrupted.tmp'),'{');
 assert.throws(()=>readAtomicJson(partial));assert.throws(()=>createAtomicJson(partial,{state:'delivered'}));assert.ok(!existsSync(join(partial,'record.json')));
 const cyclic:Record<string,unknown>={};cyclic.self=cyclic;const failed=join(f.host,'failed');assert.throws(()=>createAtomicJson(failed,cyclic));assert.ok(!existsSync(join(failed,'record.json')));
});

test('context refuses malformed runtime ids without coercion and final-location overlap',t=>{
 const {f,workspace,create}=setup(t);
 for(const bad of [123,null,{},[]]) assert.throws(()=>createVerificationContext({...create,runId:bad as unknown as string}));
 // The artifact root itself is outside the candidate, but the final context can still overlap it.
 const nested=join(f.host,'inputs');assert.equal(createWorkspace({source:f.source,destination:nested,policy:f.policy}).status,'created');
 assert.throws(()=>createVerificationContext({...create,artifactDir:f.host,workspace:nested}));
 assert.ok(existsSync(join(workspace,'world.yaml')));
});
