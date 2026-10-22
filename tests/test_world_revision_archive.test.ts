import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fixture, d } from './repository_test_support.js';
import { proposeWorldChange, activateWorldRevision } from '../src/agent/repository/world_revision.js';
import { createVerificationContext } from '../src/agent/repository/context.js';
import { compileWorldSpec, parseWorldSpec } from '../src/world_compiler.js';
import type { OperatorDecision } from '../src/agent/repository/contracts.js';
function setup(t: {after(fn:()=>void):void}) {
 const f=fixture();t.after(f.cleanup);
 const input={runId:'run-1',proposalId:'p1',base:f.revision,patch:readFileSync(f.options.worldPath,'utf8')+'\n# exact replacement\n',artifactDir:f.options.artifactDir,rationale:'SCRIPTED archive fixture',requirements:f.binding.requirements};
 const p=proposeWorldChange(input);
 const path=join(f.options.decisionsDir,'scripted.json');mkdirSync(dirname(path),{recursive:true});
 const decision:OperatorDecision={command:'approve-world',operator:'SCRIPTED operator',runId:p.runId,proposalId:p.proposalId,proposalDigest:p.proposalDigest,baseRevisionId:p.base.id,baseWorld:p.base.world,patchDigest:p.patchDigest,recordedAt:'2026-10-21T00:00:00.000Z'};
 writeFileSync(path,JSON.stringify(decision));
 const activation={proposal:p,current:f.revision,decisionPath:path,decisionsDir:f.options.decisionsDir,runId:p.runId,historicalReceiptIds:['z','a','z']};
 return {f,input,p,path,decision,activation};
}
test('E1 standalone exact raw bytes and frozen digest order; create once',t=>{
 const {f,p,input}=setup(t);
 assert.equal(p.patchDigest,d(input.patch));
 assert.equal(p.proposalDigest,d(JSON.stringify({runId:p.runId,proposalId:p.proposalId,baseRevisionId:p.base.id,baseWorld:p.base.world,requirements:p.requirements,patchDigest:p.patchDigest,rationale:p.rationale})));
 const dir=join(f.options.artifactDir,'proposals','run-1','p1');
 assert.equal(readFileSync(join(dir,'patch.yaml'),'utf8'),input.patch);
 assert.throws(()=>proposeWorldChange(input));
});
test('E1 immutable activation writes exact compiler output, independent context slot and replay refusal',t=>{
 const {f,p,activation}=setup(t);const r=activateWorldRevision(activation);
 assert.equal(r.state,'active');assert.equal(r.parentId,'r0');assert.equal(r.proposalId,'p1');assert.deepEqual(r.staleReceiptIds,['a','z']);
 assert.equal(readFileSync(r.worldPath,'utf8'),p.patch);assert.equal(r.world,d(p.patch));
 const generated=compileWorldSpec(parseWorldSpec(p.patch));
 assert.equal(readFileSync(join(r.seamPaths[0]!,'ports.d.ts'),'utf8'),generated.portsDts);
 assert.equal(readFileSync(join(r.seamPaths[0]!,'world_checker.ts'),'utf8'),generated.worldCheckerTs);
 const parent=join(f.options.artifactDir,'inputs','revisions','run-1',r.id);
 assert.equal(existsSync(join(parent,'activation','record.json')),true);
 mkdirSync(join(parent,'verification-context')); // archive does not consume context reservation
 assert.equal(activateWorldRevision(activation).state,'rejected');
 assert.equal(readFileSync(f.options.worldPath,'utf8'),readFileSync(f.revision.worldPath,'utf8'));
});
for(const kind of ['proposal-bytes','patch-bytes','seam','base-bytes','current','requirements','decision-unknown','decision-time','decision-operator','decision-symlink','root-symlink','partial'] as const)test(`E1 refuses ${kind}`,t=>{
 const x=setup(t);let a=x.activation;
 const proposalDir=join(x.f.options.artifactDir,'proposals','run-1','p1');mkdirSync(proposalDir,{recursive:true});
 if(kind==='proposal-bytes')writeFileSync(join(proposalDir,'record.json'),'{}');
 if(kind==='patch-bytes')writeFileSync(join(proposalDir,'patch.yaml'),x.p.patch+'\n');
 if(kind==='seam')writeFileSync(join(x.f.revision.seamPaths[0]!,'ports.d.ts'),'forged');
 if(kind==='base-bytes')writeFileSync(x.f.revision.worldPath,readFileSync(x.f.revision.worldPath,'utf8')+'\n');
 if(kind==='current')a={...a,current:{...a.current,id:'stale'}};
 if(kind==='requirements')a={...a,proposal:{...a.proposal,requirements:d('other')}};
 if(kind==='decision-unknown')writeFileSync(x.path,JSON.stringify({...x.decision,extra:true}));
 if(kind==='decision-time')writeFileSync(x.path,JSON.stringify({...x.decision,recordedAt:'yesterday'}));
 if(kind==='decision-operator')writeFileSync(x.path,JSON.stringify({...x.decision,operator:''}));
 if(kind==='decision-symlink'){const link=join(x.f.options.decisionsDir,'link.json');symlinkSync(x.path,link);a={...a,decisionPath:link};}
 if(kind==='root-symlink'){const link=join(x.f.host,'root-link');symlinkSync(x.f.options.decisionsDir,link);a={...a,decisionsDir:link};}
 if(kind==='partial'){
  const first=activateWorldRevision(a);assert.equal(first.state,'active');
  writeFileSync(join(dirname(first.worldPath),'record.json'),'{}');
 }
 const before=readFileSync(x.f.revision.worldPath);const result=activateWorldRevision(a);
 assert.equal(result.state,'rejected');assert.equal(result.id,a.current.id);assert.equal(result.world,a.current.world);assert.deepEqual(result.seamPaths,a.current.seamPaths);assert.deepEqual(readFileSync(x.f.revision.worldPath),before);
});
for(const kind of ['uppercase','traversal','host-in-source','invented-world','invented-seam','symlink','partial'] as const)test(`E1 proposal refuses ${kind} before overwrite`,t=>{
 const {f,input}=setup(t);let v={...input,proposalId:'p2'};
 if(kind==='uppercase')v.proposalId='P2';
 if(kind==='traversal')v.proposalId='../escape';
 if(kind==='host-in-source')v.artifactDir=join(f.source,'host');
 if(kind==='invented-world')v.base={...v.base,world:d('fake')};
 if(kind==='invented-seam')v.base={...v.base,seam:d('fake')};
 if(kind==='symlink'){const link=join(f.host,'link');symlinkSync(f.options.artifactDir,link);v.artifactDir=link;}
 if(kind==='partial')mkdirSync(join(v.artifactDir,'proposals',v.runId,v.proposalId),{recursive:true});
 assert.throws(()=>proposeWorldChange(v));
});
for(const field of ['runId','proposalId','proposalDigest','baseRevisionId','baseWorld','patchDigest','command'] as const)test(`E1 decision exact ${field} binding`,t=>{
 const x=setup(t);const original=readFileSync(x.f.revision.worldPath);
 writeFileSync(x.path,JSON.stringify({...x.decision,[field]:field==='command'?'reject-world':field.endsWith('Digest')||field==='baseWorld'?d('wrong'):'wrong'}));
 const result=activateWorldRevision(x.activation);assert.equal(result.state,'rejected');assert.deepEqual(readFileSync(x.f.revision.worldPath),original);
 assert.equal(existsSync(join(x.f.options.artifactDir,'run.json')),false);
});
for(const kind of ['reserved','world-partial','symlink'] as const)test(`E1 activation ${kind} never overwrites or recovers`,t=>{
 const x=setup(t);const parent=join(x.f.options.artifactDir,'inputs','revisions',x.p.runId,`r-${x.p.proposalDigest.slice(7)}`);mkdirSync(parent,{recursive:true});
 const dir=join(parent,'activation');
 if(kind==='symlink')symlinkSync(x.f.source,dir);else {mkdirSync(dir);if(kind==='world-partial')writeFileSync(join(dir,'world.yaml'),'partial evidence');}
 const result=activateWorldRevision(x.activation);assert.equal(result.state,'rejected');
 if(kind==='world-partial')assert.equal(readFileSync(join(dir,'world.yaml'),'utf8'),'partial evidence');
 assert.equal(existsSync(join(dir,'record.json')),false);
});
test('E1 invalid replacement and malformed proposal fields refuse without reservation',t=>{
 const {f,input}=setup(t);
 for(const bad of [{...input,proposalId:'bad',patch:'not: [yaml'}, {...input,proposalId:'bad',extra:true}, {...input,proposalId:'bad',requirements:'sha256:fake' as const}, {...input,proposalId:'bad',rationale:''}])assert.throws(()=>proposeWorldChange(bad));
 assert.equal(existsSync(join(f.options.artifactDir,'proposals','run-1','bad')),false);
});

test('E1 binds an existing frozen host context requirements and World',t=>{
 const f=fixture();t.after(f.cleanup);
 createVerificationContext({...f.options,workspace:f.source,revisionId:'r0',expected:f.binding});
 const input={runId:'run-1',proposalId:'p1',base:f.revision,patch:readFileSync(f.options.worldPath,'utf8'),artifactDir:f.options.artifactDir,rationale:'SCRIPTED context binding',requirements:d('wrong requirements')};
 assert.throws(()=>proposeWorldChange(input));
 assert.equal(existsSync(join(input.artifactDir,'proposals')),false);
});
test('E1 host root cannot contain source roles',t=>{
 const f=fixture();t.after(f.cleanup);
 assert.throws(()=>proposeWorldChange({runId:'run-1',proposalId:'p1',base:f.revision,patch:readFileSync(f.options.worldPath,'utf8'),artifactDir:f.root,rationale:'SCRIPTED ancestor refusal',requirements:f.binding.requirements}));
});
