/** Reproducible repository-only SCRIPTED repair, never an installed-agent/A20 claim. */
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { compileWorldSpec, parseWorldSpec } from '../../src/world_compiler.js';
import { ScriptedBackend } from '../../src/agent/repository/backend.js';
import { runRepositoryTask } from '../../src/agent/repository/loop.js';
import { captureIdentity } from '../../src/agent/repository/identity.js';
import { hashBytes, safePath } from '../../src/agent/repository/workspace.js';
import type { RepositoryPolicy } from '../../src/agent/repository/contracts.js';

const template=(name:string)=>readFileSync(resolve('examples/repository-order-service',name),'utf8');
const client=(fixed:boolean)=>fixed?template('http-client.mjs'):template('http-client.mjs').replace('throw error;', "return post(port, 'apply', id, mode);");
const persistence=(fixed:boolean)=>fixed?template('persistence.mjs'):template('persistence.mjs').replace('return outcome;', "return outcome === 'unknown' ? 'not_committed' : outcome;");
const fabric=(fixedOrder:boolean)=>fixedOrder?template('fabric.mjs'):template('fabric.mjs').replace("transitionId: 'INITIATE_PAYMENT'", "transitionId: 'CONFIRM_PAYMENT'");
/** Independent verifier uses host-selected World/checker/HTTP endpoint and raw server ledger. */
function verifier(dist:string,world:string):string {return `
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
let checking=false;
(async()=>{const root=process.argv[2],port=Number(process.argv[3]),httpRoot=process.argv[4];
const {createWorldChecker}=await import(${JSON.stringify(pathToFileURL(join(dist,'src/world_checker.js')).href)});
const {parseWorldSpec}=await import(${JSON.stringify(pathToFileURL(join(dist,'src/world_compiler.js')).href)});
const {settle}=await import(require('node:url').pathToFileURL(path.join(root,'src/fabric.mjs')).href);
const traces=()=>fs.readdirSync(path.join(httpRoot,'requests')).sort().map(n=>JSON.parse(fs.readFileSync(path.join(httpRoot,'requests',n))));
for(const [mode,query,expected,count] of [['refuse','normal','not_committed',0],['drop','normal','committed',1],['drop','unavailable','unknown',1]]){
checking=false;
const id='negative-fixture-'+mode+'-'+query+'-'+traces().length,checker=createWorldChecker(parseWorldSpec(fs.readFileSync(${JSON.stringify(world)},'utf8')));
checking=true;let result;
await assert.doesNotReject(async()=>{result=await settle(checker,port,id,mode,query);},'FABRIC_SETTLEMENT');
const observed=traces().filter(x=>x.id===id);assert.equal(observed.filter(x=>x.action==='apply').length,1,'NO_RETRY_AFTER_AMBIGUOUS_APPLY');
assert.deepEqual(observed.map(x=>x.action),mode==='refuse'?['apply']:['apply','query'],'QUERY_BEFORE_SETTLEMENT');
assert.equal(result,expected,'UNKNOWN_IS_NOT_ZERO');assert.equal(checker.getState(),mode==='refuse'?'CREATED':'PAYMENT_PENDING','SOUND_ROLLBACK');
const ledger=fs.existsSync(path.join(httpRoot,'ledger.json'))?JSON.parse(fs.readFileSync(path.join(httpRoot,'ledger.json'))):{operations:[]};assert.equal(ledger.operations.includes(id)?1:0,count,'INDEPENDENT_EFFECT_COUNT');
console.log(JSON.stringify({scope:'expected-negative-fixture',id,mode,query,result,effectCount:count,trace:observed}));
}
})().catch(e=>{console.error(e.stack);process.exitCode=checking&&e?.code==='ERR_ASSERTION'?1:86});`;
}
export async function runScriptedOrderDemo(declared:string) {
 const root=safePath(declared);mkdirSync(root,{recursive:true});const source=join(root,'source'),host=join(root,'host');mkdirSync(join(source,'src'),{recursive:true});mkdirSync(host);
 const world=join(source,'world.yaml');copyFileSync(resolve('conformance/fixtures/order_settlement.world.yaml'),world);const w=readFileSync(world,'utf8'),compiled=compileWorldSpec(parseWorldSpec(w));mkdirSync(join(source,'generated'));
 writeFileSync(join(source,'generated/ports.d.ts'),compiled.portsDts);writeFileSync(join(source,'generated/world_checker.ts'),compiled.worldCheckerTs);
 writeFileSync(join(source,'requirements.md'),'Repair order settlement across Fabric/client/persistence. Refusal rolls back only local state; unknown stays unknown; query before settling, no automatic apply retry.');
 for(const [name,data] of Object.entries({'fabric.mjs':fabric(false),'http-client.mjs':client(false),'persistence.mjs':persistence(false)}))writeFileSync(join(source,'src',name),data);
 const git=(argv:string[])=>{const p=spawnSync('git',argv,{cwd:source,encoding:'utf8'});if(p.status!==0)throw Error(p.stderr);return p.stdout.trim();};git(['init','-q']);git(['add','.']);git(['-c','user.name=Scripted','-c','user.email=scripted@example.invalid','commit','-qm','deliberately faulty Fabric']);const baseCommit=git(['rev-parse','HEAD']);
 const httpRoot=join(host,'negative-fixture-http');const server=spawn(process.execPath,[resolve('tests/fixtures/repository/http-actuator.cjs'),httpRoot],{stdio:['ignore','pipe','pipe']});
 try{
 const port=await new Promise<number>((ok,bad)=>{const timer=setTimeout(()=>bad(Error('HTTP readiness')),2000);server.once('error',bad);server.stdout.once('data',b=>{clearTimeout(timer);ok(JSON.parse(String(b)).port);});});
 const check=join(host,'verify.cjs');writeFileSync(check,verifier(resolve('dist'),world));
 const backend=join(host,'scripted.cjs');
 // Bounded deterministic repairs follow observed independent diagnostics; no model call.
 const patches=[{fabric:fabric(false),client:client(false),persistence:persistence(false)},{fabric:fabric(true),client:client(false),persistence:persistence(false)},{fabric:fabric(true),client:client(true),persistence:persistence(true)}];
 writeFileSync(backend,`const fs=require('node:fs'),path=require('node:path');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const args=process.argv,root=args[args.indexOf('--cd')+1],count=${JSON.stringify(join(host,'iteration'))};const n=fs.existsSync(count)?Number(fs.readFileSync(count))+1:1;fs.writeFileSync(count,String(n));const patches=${JSON.stringify(patches)},p=patches[Math.min(n-1,patches.length-1)];for(const [name,key] of [['fabric.mjs','fabric'],['http-client.mjs','client'],['persistence.mjs','persistence']])fs.writeFileSync(path.join(root,'src',name),p[key]);fs.appendFileSync(${JSON.stringify(join(host,'feedback.jsonl'))},JSON.stringify({n,input})+'\\n');console.log(JSON.stringify({type:'turn.completed'}));});`);
 const policy:RepositoryPolicy={sourceRoot:source,baseCommit,allowedPaths:['src/'],protectedPaths:['world.yaml','generated/','requirements.md'],excludedOutputs:[],verifiers:[{id:'independent-http',executable:process.execPath,argv:[check,'<candidate>',String(port),httpRoot],cwd:host,programDigest:hashBytes(readFileSync(check)),failureKind:'functional',resultProtocol:'exit-v1'}]};
 const identity=captureIdentity({workspace:source,policy,requirementsPath:join(source,'requirements.md'),worldPath:world,seamPaths:[join(source,'generated')],revisionId:'r0'});
 const run=await runRepositoryTask({runId:'scripted-order',source,artifactDir:join(host,'run'),requirementsPath:join(source,'requirements.md'),worldPath:world,seamPaths:[join(source,'generated')],instructions:'SCRIPTED deterministic repair. Use independent diagnostics; preserve World.',policy,backend:new ScriptedBackend({executable:process.execPath,prefixArgs:[backend]}),limits:{maxAttempts:3,attemptMs:3000,verifierMs:8000,overallMs:40000,killGraceMs:100},signal:new AbortController().signal,revision:{id:'r0',world:identity.world,seam:identity.seam,parentId:null,proposalId:null,worldPath:world,seamPaths:[join(source,'generated')],state:'active',staleReceiptIds:[]},decisionsDir:join(host,'run/decisions')});
 writeFileSync(join(root,'summary.json'),JSON.stringify({kind:'SCRIPTED',installedBackend:false,run,negativeFixtureLedger:existsSync(join(httpRoot,'ledger.json'))?JSON.parse(readFileSync(join(httpRoot,'ledger.json'),'utf8')):null},null,2));return run;
 }finally{if(server.exitCode===null&&server.signalCode===null){server.kill('SIGTERM');await once(server,'exit');}}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const root=process.argv[2];if(!root)throw Error('Usage: node dist/examples/repository-order-service/scripted-demo.js <new absolute output directory>');const run=await runScriptedOrderDemo(root);console.log(JSON.stringify({kind:'SCRIPTED',status:run.status,attempts:run.attempts.map(a=>({id:a.id,verification:a.verification?.status,route:a.route})),delivery:run.delivery}));if(run.status!=='delivered')process.exitCode=1;}
