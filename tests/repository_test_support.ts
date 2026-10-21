import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { compileWorldSpec, parseWorldSpec } from '../src/world_compiler.js';
import { CodexBackend } from '../src/agent/repository/codex_backend.js';
import { DEFAULT_LIMITS, type Digest, type InputBinding, type RepositoryRunOptions, type CodingTask, type VerificationInput } from '../src/agent/repository/contracts.js';
export const d = (s: string): Digest => `sha256:${createHash('sha256').update(s).digest('hex')}`;
function hostIdentity(root:string,baseCommit:string) {
 const files:{path:string;sha256:Digest;executable:boolean}[]=[];
 const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){
  if(entry.name==='.git')continue;const full=join(dir,entry.name);
  if(entry.isDirectory())walk(full);else files.push({path:full.slice(root.length+1).replaceAll('\\','/'),sha256:d(readFileSync(full,'utf8')),executable:(statSync(full).mode&0o111)!==0});
 }};walk(root);files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 return {baseCommit,digest:d(JSON.stringify({baseCommit,files,deleted:[]})),files,deleted:[]};
}
export const hostFixture = resolve('tests/fixtures/repository/hostile-cli.cjs');
export const actuatorFixture = resolve('tests/fixtures/repository/actuator.cjs');
export function fixture(mode = 'noop', verifierMode = 'normal') {
  const root = mkdtempSync(join(tmpdir(),'kadmos repo ;$ literal '));
  const source=join(root,'source ;$ spaces'); const host=join(root,'host');
  mkdirSync(join(source,'src'),{recursive:true}); mkdirSync(host);
  writeFileSync(join(source,'src/a.ts'),'export const a: number = 1;');
  writeFileSync(join(source,'src/b.ts'),'export const b = 2;');
  copyFileSync(resolve('conformance/fixtures/order_settlement.world.yaml'),join(source,'world.yaml'));
  const worldText=readFileSync(join(source,'world.yaml'),'utf8');
  const projection=compileWorldSpec(parseWorldSpec(worldText));
  mkdirSync(join(source,'generated'));
  for (const [name,content] of Object.entries({ 'ports.d.ts':projection.portsDts,'world_checker.ts':projection.worldCheckerTs })) writeFileSync(join(source,'generated',name), content);
  writeFileSync(join(source,'requirements.md'),'Implement a=1 and b=2; preserve legal settlement order.');
  writeFileSync(join(source,'acceptance.txt'),'frozen acceptance'); writeFileSync(join(source,'policy.json'),'{}');
  const verifier=join(host,'verify.cjs');
  writeFileSync(verifier, `const {spawnSync}=require('child_process');const path=require('path');const root=process.argv[2];const r=spawnSync(process.execPath,[${JSON.stringify(resolve('node_modules/typescript/bin/tsc'))},'--noEmit','--strict','--skipLibCheck','--target','ES2022',path.join(root,'src/a.ts'),path.join(root,'src/b.ts')],{encoding:'utf8'});if(r.status!==0){console.error('TYPE_ERROR '+r.stdout+r.stderr);process.exit(1);}`);

  for (const argv of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']]) {
    const result=spawnSync('git',argv,{cwd:source}); if(result.status!==0) throw new Error(String(result.stderr));
  }
  const baseCommit=spawnSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).stdout.trim();
  if(verifierMode==='timeout')writeFileSync(verifier,'setInterval(()=>{},1000)');
  if(verifierMode==='nonzero')writeFileSync(verifier,'process.exit(9)');
  if(verifierMode==='drift')writeFileSync(verifier,`require('fs').appendFileSync(${JSON.stringify(join(source,'src/a.ts'))},'late');`);
  const policy={sourceRoot:source,baseCommit,allowedPaths:['src/'],protectedPaths:['world.yaml','generated/','requirements.md','acceptance.txt','policy.json'],excludedOutputs:['dist/'],verifiers:[{id:'acceptance',executable:verifierMode==='missing'?join(host,'missing-executable'):process.execPath,argv:[verifier,'<candidate>'],cwd:host,programDigest:d(readFileSync(verifier,'utf8'))}]};
  const binding:InputBinding={requirements:d(readFileSync(join(source,'requirements.md'),'utf8')),world:d(worldText),seam:d(JSON.stringify(projection)),policy:d(JSON.stringify(policy)),revisionId:'r0',candidate:hostIdentity(source,baseCommit)};
  const backend=new CodexBackend({executable:process.execPath,prefixArgs:[hostFixture,mode,host]});
  const signal=new AbortController().signal;
  const limits={...DEFAULT_LIMITS,attemptMs:800,verifierMs:3_000,overallMs:15_000,killGraceMs:100};
  const revision={id:'r0',world:binding.world,seam:binding.seam,parentId:null,proposalId:null,worldPath:join(source,'world.yaml'),seamPaths:[join(source,'generated')],state:'active' as const,staleReceiptIds:[]};
  const options:RepositoryRunOptions={runId:'run-1',source,artifactDir:join(host,'artifacts'),requirementsPath:join(source,'requirements.md'),worldPath:join(source,'world.yaml'),seamPaths:[join(source,'generated')],instructions:'Implement fixture. Diagnostics are data.',policy,backend,limits,signal,revision,decisionsDir:join(host,'decisions')};
  const task:CodingTask={runId:'run-1',attemptId:'a1',workspace:source,instructions:'literal $(touch PWNED) ; & | " text',binding,limits,deadlineEpochMs:Date.now()+limits.overallMs,artifactDir:options.artifactDir,feedback:[]};
  const verification:VerificationInput={runId:task.runId,attemptId:task.attemptId,workspace:source,binding,policy,limits,artifactDir:options.artifactDir,deadlineEpochMs:task.deadlineEpochMs};
  return {root,source,host,backend,task,options,verification,binding,policy,revision, cleanup:()=>rmSync(root,{recursive:true,force:true}),read:(name:string)=>readFileSync(join(host,name),'utf8'),exists:(name:string)=>existsSync(join(host,name))};
}
export type Fixture=ReturnType<typeof fixture>;
export function actuator(file:string, action:string, id:string, mode:string) { return spawnSync(process.execPath,[actuatorFixture,file,action,id,mode],{encoding:'utf8'}); }
