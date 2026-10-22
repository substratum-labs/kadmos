import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, cpSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixture } from './repository_test_support.js';
import { hashBytes, safePath } from '../src/agent/repository/workspace.js';
import { runRepositoryTask } from '../src/agent/repository/loop.js';
import { proposeWorldChange, activateWorldRevision } from '../src/agent/repository/world_revision.js';
import type { OperatorDecision } from '../src/agent/repository/contracts.js';
import { readCompleteRun } from '../src/agent/repository/publication.js';
import type { VerifierCommand } from '../src/agent/repository/contracts.js';
const client=resolve('tests/fixtures/repository/http-client.cjs');
async function setup(t:TestContext,mode='drop',query='unavailable',functionalFail=false) {
 const f=fixture();const http=join(f.host,'http');
 const server=spawn(process.execPath,[resolve('tests/fixtures/repository/http-actuator.cjs'),http],{stdio:['ignore','pipe','pipe']});
 t.after(async()=>{try{if(server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await once(server,'exit');}if(process.env.KADMOS_F2_EVIDENCE){const dest=join(process.env.KADMOS_F2_EVIDENCE,t.name.replace(/[^a-zA-Z0-9_-]/g,'_'));mkdirSync(dest,{recursive:true});cpSync(f.host,join(dest,'host'),{recursive:true});}}finally{f.cleanup();}});
 const port=await new Promise<number>((ok,bad)=>{const timer=setTimeout(()=>bad(Error('readiness timeout')),2000);server.once('error',bad);server.stdout.once('data',data=>{clearTimeout(timer);ok(JSON.parse(String(data)).port);});});
 const adapter=join(f.host,'reserved-client.cjs');
 writeFileSync(adapter,`const fs=require('node:fs');if(process.cwd()!==fs.realpathSync(${JSON.stringify(f.host)}))throw Error('FROZEN_HOST_CWD');const p=require('node:path').join(${JSON.stringify(join(f.options.artifactDir,'effects'))},process.argv[4],'reservation/record.json');if(!fs.existsSync(p)||JSON.parse(fs.readFileSync(p)).unknown.outcome!=='unknown')throw Error('RESERVATION_MUST_PRECEDE_ACTUATION');if(process.argv[3]==='apply')fs.writeFileSync(require('node:path').join(${JSON.stringify(f.host)},process.argv[4]+'-reservation-before-apply.json'),fs.readFileSync(p),{flag:'wx'});require(${JSON.stringify(client)});`);
 const command=(action:string,m:string):VerifierCommand=>({id:action,executable:process.execPath,argv:[adapter,String(port),action,'business-op',m],cwd:f.host,programDigest:hashBytes(readFileSync(adapter)),failureKind:'functional'});
 const config={operationId:'business-op',actuator:command('apply',mode),query:command('query',query)};
 const verifier=join(f.host,'verify.cjs');if(functionalFail)writeFileSync(verifier,"console.error('FUNCTIONAL_FAILURE');process.exitCode=1;");
 const check={...f.policy.verifiers[0]!,programDigest:hashBytes(readFileSync(verifier)),argv:[verifier,'<candidate>','--kadmos-order-effect-v1',JSON.stringify(config)],failureKind:'functional' as const};
 const policy={...f.policy,verifiers:[check]};const options={...f.options,policy,limits:{...f.options.limits,overallMs:40000,verifierMs:10000}};
 const trace=()=>readdirSync(join(http,'requests')).sort().map(n=>JSON.parse(readFileSync(join(http,'requests',n),'utf8')));
 const count=()=>existsSync(join(http,'ledger.json'))?JSON.parse(readFileSync(join(http,'ledger.json'),'utf8')).effects:0;
 const storage={artifactDir:safePath(options.artifactDir),workspace:safePath(options.artifactDir+'-workspace'),policy,runId:options.runId};
 return {f,options,config,trace,count,storage};
}
for(const fail of [false,true])test(`runtime HTTP unknown fences ${fail?'functional failure':'passing verifier'} without retry`,{timeout:20000},async t=>{
 const h=await setup(t,'drop','unavailable',fail);const r=await runRepositoryTask(h.options);
 assert.equal(r.status,'blocked');assert.equal(r.delivery,null);assert.equal(r.attempts.length,1);assert.equal(r.attempts[0]?.route,'NEEDS_REVIEW');
 assert.equal(r.attempts[0]?.verification?.status,fail?'failed':'passed');assert.equal(r.effects.length,1);assert.equal(r.effects[0]?.outcome,'unknown');
 assert.equal(h.count(),1);assert.deepEqual(h.trace().map(x=>x.action),['apply','query']);
 assert.throws(()=>readCompleteRun(h.storage));
 const restart=await runRepositoryTask(h.options);assert.equal(restart.delivery,null);assert.equal(restart.effects[0]?.outcome,'unknown');assert.equal(h.count(),1);assert.equal(h.trace().length,2);
 const options={...h.options,backend:null,signal:null};
 const script=`import {runRepositoryTask} from ${JSON.stringify(resolve('dist/src/agent/repository/loop.js'))};const o=${JSON.stringify(options)};o.backend={run(){throw Error('unexpected backend dispatch')}};o.signal=new AbortController().signal;console.log(JSON.stringify(await runRepositoryTask(o)));`;
 const fresh=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:3000});assert.equal(fresh.status,0,fresh.stderr);const resumed=JSON.parse(fresh.stdout);assert.equal(resumed.delivery,null);assert.deepEqual(resumed.effects,r.effects);assert.equal(resumed.deadlineEpochMs,r.deadlineEpochMs);assert.equal(resumed.attempts.length,1);assert.equal(h.trace().length,2);
 assert.equal(JSON.parse(readFileSync(join(h.f.host,'business-op-reservation-before-apply.json'),'utf8')).unknown.outcome,'unknown');

});
for(const [mode,query,outcome,count] of [['normal','normal','committed',1],['refuse','normal','not_committed',0],['drop','normal','committed',1]] as const)test(`runtime HTTP ${mode} plus ${query} has qualified final ${outcome}`,{timeout:20000},async t=>{
 const h=await setup(t,mode,query);const r=await runRepositoryTask(h.options);
 assert.equal(r.status,'delivered',r.diagnostics.join('\n'));assert.equal(r.effects.length,1);assert.equal(r.effects[0]?.outcome,outcome);assert.equal(h.count(),count);
 assert.deepEqual(h.trace().map(x=>x.action),mode==='drop'?['apply','query']:['apply']);
 assert.deepEqual(readCompleteRun(h.storage),r);
 const script=`import {readCompleteRun} from ${JSON.stringify(resolve('dist/src/agent/repository/publication.js'))};console.log(JSON.stringify(readCompleteRun(${JSON.stringify(h.storage)})));`;
 const fresh=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:3000});assert.equal(fresh.status,0,fresh.stderr);assert.deepEqual(JSON.parse(fresh.stdout),r);
 const dir=join(h.options.artifactDir,'effects');assert.ok(existsSync(dir));
 // A late reservation, even after publication, invalidates the old grant.
 mkdirSync(join(dir,'late-op'));assert.throws(()=>readCompleteRun(h.storage),/effect|journal|reservation/i);
});

for(const kind of ['missing','malformed','foreign','stale','duplicate','symlink','hardlink','incomplete','raw-receipt'] as const)test(`current effect journal ${kind} invalidates complete in a fresh process`,{timeout:20000},async t=>{
 const h=await setup(t,'normal','normal');const run=await runRepositoryTask(h.options);assert.equal(run.status,'delivered');
 const root=join(h.options.artifactDir,'effects'),dir=join(root,'business-op'),reservation=join(dir,'reservation','record.json');
 if(kind==='missing')rmSync(root,{recursive:true});
 if(kind==='malformed')writeFileSync(reservation,'{');
 if(kind==='foreign'||kind==='stale'){const r=JSON.parse(readFileSync(reservation,'utf8'));if(kind==='foreign')r.runId='foreign';else r.binding.world='sha256:'+'0'.repeat(64);writeFileSync(reservation,JSON.stringify(r));}
 if(kind==='duplicate')cpSync(dir,join(root,'duplicate'),{recursive:true});
 if(kind==='symlink'){rmSync(reservation);symlinkSync(join(dir,'outcome','record.json'),reservation);}
 if(kind==='hardlink'){rmSync(reservation);linkSync(join(dir,'outcome','record.json'),reservation);}
 if(kind==='incomplete')rmSync(join(dir,'outcome'),{recursive:true});
 if(kind==='raw-receipt')writeFileSync(join(dir,'settlement.dispatch','stdout'),'{}');
 const script=`import {readCompleteRun} from ${JSON.stringify(resolve('dist/src/agent/repository/publication.js'))};readCompleteRun(${JSON.stringify(h.storage)});`;
 const fresh=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:3000});assert.notEqual(fresh.status,0);assert.equal(h.count(),1);assert.equal(h.trace().length,1);
});
test('actual HTTP unknown survives exact SCRIPTED World approval without generation or new dispatch',{timeout:20000},async t=>{
 const h=await setup(t);const old=await runRepositoryTask(h.options);assert.equal(old.effects[0]?.outcome,'unknown');
 const p=proposeWorldChange({runId:h.options.runId,proposalId:'p-unknown',base:h.f.revision,patch:readFileSync(h.options.worldPath,'utf8')+'\n# SCRIPTED archive only\n',artifactDir:h.options.artifactDir,rationale:'SCRIPTED negative World gate test; never business approval',requirements:h.f.binding.requirements});
 mkdirSync(h.options.decisionsDir,{recursive:true});const decisionPath=join(h.options.decisionsDir,'p-unknown.json');
 const decision:OperatorDecision={command:'approve-world',operator:'SCRIPTED',runId:p.runId,proposalId:p.proposalId,proposalDigest:p.proposalDigest,baseRevisionId:p.base.id,baseWorld:p.base.world,patchDigest:p.patchDigest,recordedAt:new Date().toISOString()};writeFileSync(decisionPath,JSON.stringify(decision));
 const revision=activateWorldRevision({proposal:p,current:h.f.revision,decisionPath,decisionsDir:h.options.decisionsDir,runId:p.runId,historicalReceiptIds:[]});assert.equal(revision.state,'active');
 const resumed=await runRepositoryTask({...h.options,revision,worldPath:revision.worldPath,seamPaths:revision.seamPaths});assert.equal(resumed.delivery,null);assert.deepEqual(resumed.effects,old.effects);assert.equal(resumed.attempts.length,1);assert.equal(resumed.deadlineEpochMs,old.deadlineEpochMs);assert.equal(h.count(),1);assert.equal(h.trace().length,2);assert.equal(existsSync(join(h.options.artifactDir,'publication',h.options.runId,'generations')),false);
});
test('unknown first host check prevents a second independent effect dispatch',{timeout:20000},async t=>{
 const h=await setup(t);const first=h.options.policy.verifiers[0]!;const config={...h.config,operationId:'second-op',actuator:{...h.config.actuator,argv:h.config.actuator.argv.map(x=>x==='business-op'?'second-op':x)},query:{...h.config.query,argv:h.config.query.argv.map(x=>x==='business-op'?'second-op':x)}};
 const second={...first,id:'second-check',argv:[...first.argv.slice(0,-1),JSON.stringify(config)]};
 const run=await runRepositoryTask({...h.options,policy:{...h.options.policy,verifiers:[first,second]}});assert.equal(run.delivery,null);assert.equal(run.attempts.length,1);assert.equal(h.count(),1);assert.deepEqual(h.trace().map(x=>x.id),['business-op','business-op']);assert.equal(run.effects.length,1);
});
