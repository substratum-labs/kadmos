import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { compileWorldSpec, parseWorldSpec } from '../../world_compiler.js';
import type { ApprovedWorldChange, Digest, FileIdentity, OperatorDecision, WorldChangeInput, WorldChangeProposal, WorldRevision } from './contracts.js';
import { readVerificationContext } from './context.js';
import { readAtomicJson } from './store.js';
import { containsPath, hashBytes, safePath } from './workspace.js';

function requireValue(ok: boolean, why: string): asserts ok { if (!ok) throw new Error(why); }
function id(value: unknown): asserts value is string { requireValue(typeof value==='string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value),'unsafe World archive id'); }
function digest(value: unknown): asserts value is Digest { requireValue(typeof value==='string' && /^sha256:[a-f0-9]{64}$/.test(value),'invalid World archive digest'); }
function text(value: unknown): asserts value is string { requireValue(typeof value==='string' && value.trim().length>0 && !value.includes('\0'),'invalid World archive string'); }
function absolute(value: string): string { requireValue(typeof value==='string' && isAbsolute(value) && !value.includes('\0'),'absolute World archive path required');return safePath(value); }
function object(value: unknown, keys: readonly string[]): Record<string,unknown> {
 requireValue(value!==null && typeof value==='object' && !Array.isArray(value),'World archive object required');
 const v=value as Record<string,unknown>;
 requireValue(Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k)),'invalid World archive keys');return v;
}
function bytes(path: string): Buffer {
 const fd=openSync(absolute(path),constants.O_RDONLY|constants.O_NOFOLLOW);
 try {requireValue(fstatSync(fd).isFile(),'World archive regular file required');return readFileSync(fd);}finally{closeSync(fd);}
}
function utf8(raw: Buffer): string { const s=raw.toString('utf8');requireValue(Buffer.from(s).equals(raw),'invalid UTF-8 World bytes');return s; }
function canonicalReceipts(values: readonly string[]): string[] {
 requireValue(Array.isArray(values),'receipt IDs required');values.forEach(text);return [...new Set(values)].sort();
}
function projection(raw: string): Record<string,string> {
 requireValue(typeof raw==='string' && Buffer.from(raw,'utf8').toString('utf8')===raw,'invalid replacement World UTF-8');
 const p=compileWorldSpec(parseWorldSpec(raw));return {'ports.d.ts':p.portsDts,'world_checker.ts':p.worldCheckerTs};
}
/** Same seam identity convention as captureIdentity, without source-role remapping. */
function seamIdentity(paths: readonly string[], generated: Record<string,string>): Digest {
 requireValue(Array.isArray(paths) && paths.length>0,'seam paths required');
 const files: FileIdentity[]=[],seen=new Set<string>(),names=new Set<string>();
 paths.forEach((declared,index)=>{
  const root=absolute(declared);
  const walk=(path:string,suffix:string):void=>{
   const full=absolute(path),st=lstatSync(full);
   if(st.isDirectory()){for(const name of readdirSync(full).sort())walk(join(full,name),suffix?`${suffix}/${name}`:name);return;}
   requireValue(st.isFile() && !seen.has(full.toLowerCase()),'duplicate/invalid seam file');seen.add(full.toLowerCase());
   const name=basename(full);requireValue(Object.hasOwn(generated,name) && !names.has(name),'unexpected/duplicate generated seam');names.add(name);
   const raw=bytes(full);requireValue(raw.equals(Buffer.from(generated[name]!)),'generated seam differs from World');
   files.push({path:`${index}/${suffix||name}`,sha256:hashBytes(raw),executable:(st.mode&0o111)!==0});
  };walk(root,'');
 });
 requireValue(names.size===2,'incomplete TypeScript seam');files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);return hashBytes(JSON.stringify(files));
}
function revision(value: WorldRevision): void {
 object(value,['id','world','seam','parentId','proposalId','worldPath','seamPaths','state','staleReceiptIds']);
 id(value.id);digest(value.world);digest(value.seam);
 if(value.parentId!==null)id(value.parentId);if(value.proposalId!==null)id(value.proposalId);
 requireValue(value.state==='active','base must be an active revision');canonicalReceipts(value.staleReceiptIds);
 const raw=bytes(value.worldPath);requireValue(hashBytes(raw)===value.world,'base World changed');
 requireValue(seamIdentity(value.seamPaths,projection(utf8(raw)))===value.seam,'base seam changed');
}
function proposalDigest(p: WorldChangeProposal | (WorldChangeInput & {patchDigest: Digest})): Digest {
 return hashBytes(JSON.stringify({runId:p.runId,proposalId:p.proposalId,baseRevisionId:p.base.id,baseWorld:p.base.world,requirements:p.requirements,patchDigest:p.patchDigest,rationale:p.rationale}));
}
function rootFor(input: WorldChangeInput): string {
 id(input.runId);id(input.proposalId);digest(input.requirements);text(input.rationale);revision(input.base);
 const root=absolute(input.artifactDir);
 // Standalone callers supply the trusted host root. Refuse placing it in any source role's tree.
 for(const role of [input.base.worldPath,...input.base.seamPaths]) {
  const rolePath=absolute(role),parent=lstatSync(rolePath).isDirectory()?rolePath:dirname(rolePath);
  requireValue(!containsPath(parent,root),'World host root overlaps source roles');
  if(containsPath(root,rolePath)) {
   const archive=absolute(join(root,'inputs','revisions',input.runId,input.base.id,'activation'));
   requireValue(containsPath(archive,rolePath),'World host root contains source roles');
   const record=JSON.parse(utf8(bytes(join(archive,'record.json')))) as Record<string,unknown>;
   requireValue(record.schema==='kadmos.host-world-activation.v1' && record.runId===input.runId && isDeepStrictEqual(record.revision,input.base),'invalid archived base');
  }
 }
 const contextDir=absolute(join(root,'inputs','revisions',input.runId,input.base.id,'verification-context'));
 if(existsSync(contextDir)) {
  const envelope=readAtomicJson(contextDir) as {context:{policy:import('./contracts.js').RepositoryPolicy}};
  const policy=envelope.context.policy;
  const context=readVerificationContext({artifactDir:root,workspace:policy.sourceRoot,policy,runId:input.runId,revisionId:input.base.id});
  requireValue(context.baseline.requirements===input.requirements && context.baseline.world===input.base.world && context.baseline.seam===input.base.seam,'frozen host context mismatch');
 }
 return root;
}
function proposalDir(root: string, runId: string, proposalId: string): string { id(runId);id(proposalId);return absolute(join(root,'proposals',runId,proposalId)); }
function writeExclusive(path: string, value: string): void {
 const fd=openSync(absolute(path),'wx',0o600);try{writeFileSync(fd,value);fsyncSync(fd);}finally{closeSync(fd);}
}
/** Exclusive reservation is never removed/recovered on error. The commit record is written LAST. */
function reserve(dir: string, files: Readonly<Record<string,string>>, record: unknown): void {
 mkdirSync(dirname(dir),{recursive:true,mode:0o700});absolute(dirname(dir));mkdirSync(dir,{mode:0o700});absolute(dir);
 for(const [name,value] of Object.entries(files))writeExclusive(join(dir,name),value);
 writeExclusive(join(dir,'record.json'),JSON.stringify(record));
 const fd=openSync(dir,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}
}
function normalized(input: WorldChangeInput): WorldChangeInput {
 object(input,['runId','proposalId','base','patch','artifactDir','rationale','requirements']);
 const root=rootFor(input);requireValue(typeof input.patch==='string','replacement YAML required');projection(input.patch);
 return JSON.parse(JSON.stringify({...input,artifactDir:root})) as WorldChangeInput;
}
export function proposeWorldChange(input: WorldChangeInput): WorldChangeProposal {
 const value=normalized(input),p={...value,patchDigest:hashBytes(value.patch),proposalDigest:proposalDigest({...value,patchDigest:hashBytes(value.patch)})};
 reserve(proposalDir(value.artifactDir,value.runId,value.proposalId),{'patch.yaml':value.patch},{schema:'kadmos.host-world-proposal.v1',proposal:p});
 return JSON.parse(JSON.stringify(p)) as WorldChangeProposal;
}
function loadProposal(p: WorldChangeProposal): WorldChangeProposal {
 object(p,['runId','proposalId','base','patch','artifactDir','rationale','requirements','patchDigest','proposalDigest']);
 const {patchDigest:pd,proposalDigest:qd,...input}=p;
 const v=normalized(input);digest(pd);digest(qd);
 requireValue(hashBytes(v.patch)===pd && proposalDigest({...v,patchDigest:pd})===qd,'proposal binding mismatch');
 const dir=proposalDir(v.artifactDir,v.runId,v.proposalId),raw=object(JSON.parse(utf8(bytes(join(dir,'record.json')))),['schema','proposal']);
 requireValue(raw.schema==='kadmos.host-world-proposal.v1' && isDeepStrictEqual(raw.proposal,p),'retained proposal mismatch');
 requireValue(bytes(join(dir,'patch.yaml')).equals(Buffer.from(v.patch)),'retained patch mismatch');return p;
}
function decision(input: ApprovedWorldChange): OperatorDecision {
 const root=absolute(input.decisionsDir),path=absolute(input.decisionPath);
 requireValue(path!==root && containsPath(root,path),'decision outside trusted host root');
 // A trusted decision root still cannot be inside source roles.
 for(const role of [input.current.worldPath,...input.current.seamPaths]) {
  const rp=absolute(role),parent=lstatSync(rp).isDirectory()?rp:dirname(rp);
  requireValue(!containsPath(parent,root),'decision root overlaps source roles');
 }
 const d=object(JSON.parse(utf8(bytes(path))),['command','operator','runId','proposalId','proposalDigest','baseRevisionId','baseWorld','patchDigest','recordedAt']);
 text(d.operator);text(d.recordedAt);
 requireValue(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(d.recordedAt) && new Date(d.recordedAt).toISOString()===d.recordedAt,'invalid operator time');
 const p=input.proposal;
 requireValue(d.command==='approve-world' && d.runId===input.runId && d.runId===p.runId && d.proposalId===p.proposalId && d.proposalDigest===p.proposalDigest && d.baseRevisionId===p.base.id && d.baseWorld===p.base.world && d.patchDigest===p.patchDigest,'operator approval mismatch');
 return d as unknown as OperatorDecision;
}
/** Standalone archive creation grants neither controller continuation nor delivery. */
export function activateWorldRevision(input: ApprovedWorldChange): WorldRevision {
 try {
  object(input,['proposal','current','decisionPath','decisionsDir','runId','historicalReceiptIds']);id(input.runId);
  const p=loadProposal(input.proposal);revision(input.current);
  requireValue(input.runId===p.runId && isDeepStrictEqual(input.current,p.base),'current base mismatch');
  const approved=decision(input),generated=projection(p.patch);
  const staleReceiptIds=canonicalReceipts([...input.current.staleReceiptIds,...input.historicalReceiptIds]);
  const revisionId=`r-${p.proposalDigest.slice(7)}`;
  const dir=absolute(join(p.artifactDir,'inputs','revisions',p.runId,revisionId,'activation'));
  // No context reservation here: E2 owns the sibling verification-context directory.
  requireValue(!existsSync(dir),'activation reservation already exists');
  const r: WorldRevision={id:revisionId,parentId:p.base.id,proposalId:p.proposalId,world:hashBytes(p.patch),seam:hashBytes(JSON.stringify(Object.entries(generated).map(([name,value])=>({path:`0/${name}`,sha256:hashBytes(value),executable:false})))),worldPath:join(dir,'world.yaml'),seamPaths:[join(dir,'seam')],state:'active',staleReceiptIds};
  // Keep exactly the two generated files in a dedicated seam directory.
  const seamDir=join(dir,'seam');
  mkdirSync(dirname(dir),{recursive:true,mode:0o700});absolute(dirname(dir));mkdirSync(dir,{mode:0o700});mkdirSync(seamDir,{mode:0o700});
  const result=r;
  writeExclusive(result.worldPath,p.patch);
  for(const [name,value] of Object.entries(generated))writeExclusive(join(seamDir,name),value);
  requireValue(seamIdentity(result.seamPaths,generated)===result.seam,'archive seam mismatch');
  writeExclusive(join(dir,'record.json'),JSON.stringify({schema:'kadmos.host-world-activation.v1',runId:p.runId,proposalDigest:p.proposalDigest,requirements:p.requirements,decisionPath:absolute(input.decisionPath),decisionDigest:hashBytes(bytes(input.decisionPath)),decision:approved,revision:result}));
  const fd=openSync(dir,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}
  return result;
 } catch { return {...input.current,state:'rejected'}; }
}
