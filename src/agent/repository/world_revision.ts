import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { compileWorldSpec, parseWorldSpec } from '../../world_compiler.js';
import type { ApprovedWorldChange, Digest, FileIdentity, OperatorDecision, WorldChangeInput, WorldChangeProposal, WorldRevision } from './contracts.js';
import { readVerificationContext } from './context.js';
import { readAtomicJson } from './store.js';
import { fileRef } from './evidence.js';
import { readControl, freezeControlData, type OriginalControl } from './control.js';
import { captureIdentity } from './identity.js';
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
/** Logical generated slots retain the existing declared-root index, relative path and mode frame. */
export function seamSlots(paths:readonly string[]):{path:string;frame:string;name:string;executable:boolean}[] {
 const slots:{path:string;frame:string;name:string;executable:boolean}[]=[],seen=new Set<string>(),names=new Set<string>();
 requireValue(Array.isArray(paths) && paths.length>0,'seam paths required');
 paths.forEach((declared,index)=>{
  const walk=(path:string,suffix:string):void=>{
   const full=absolute(path),st=lstatSync(full);
   if(st.isDirectory()){for(const name of readdirSync(full).sort())walk(join(full,name),suffix?`${suffix}/${name}`:name);return;}
   requireValue(st.isFile() && st.nlink===1 && !seen.has(full.toLowerCase()),'duplicate/invalid seam file');seen.add(full.toLowerCase());
   const name=basename(full);requireValue(['ports.d.ts','world_checker.ts'].includes(name) && !names.has(name),'unexpected/duplicate generated seam');names.add(name);
   slots.push({path:full,frame:`${index}/${suffix||name}`,name,executable:(st.mode&0o111)!==0});
  };walk(declared,'');
 });
 requireValue(names.size===2,'incomplete TypeScript seam');return slots.sort((a,b)=>a.frame<b.frame?-1:a.frame>b.frame?1:0);
}
function seamIdentity(paths:readonly string[],generated:Record<string,string>):Digest {
 const files:FileIdentity[]=seamSlots(paths).map(slot=>{
  const raw=bytes(slot.path);requireValue(raw.equals(Buffer.from(generated[slot.name]!)),'generated seam differs from World');
  return {path:slot.frame,sha256:hashBytes(raw),executable:slot.executable};
 });return hashBytes(JSON.stringify(files));
}
/** Derive archive locations solely from validated base roles, never from archive metadata. */
function archiveLayout(base:WorldRevision,dir:string,generated:Record<string,string>) {
 const slots=seamSlots(base.seamPaths);
 requireValue(base.seamPaths.every((_,i)=>slots.some(slot=>slot.frame.startsWith(`${i}/`))),'unsupported empty declared seam role');
 const seamPaths=base.seamPaths.map((role,i)=>{
  const root=base.seamPaths.length===1?join(dir,'seam'):join(dir,'seam',String(i));
  return lstatSync(role).isDirectory()?root:join(root,basename(role));
 });
 const files=slots.map(slot=>{
  const index=Number(slot.frame.split('/')[0]),suffix=slot.frame.slice(slot.frame.indexOf('/')+1);
  const role=base.seamPaths[index]!;
  return {...slot,path:lstatSync(role).isDirectory()?join(seamPaths[index]!,suffix):seamPaths[index]!,bytes:generated[slot.name]!};
 });
 const seam=hashBytes(JSON.stringify(files.map(f=>({path:f.frame,sha256:hashBytes(f.bytes),executable:f.executable}))));
 return {seamPaths,files,seam};
}
function archiveFiles(root:string):string[] {
 const result:string[]=[];
 const walk=(dir:string):void=>{for(const name of readdirSync(absolute(dir)).sort()){const full=absolute(join(dir,name)),st=lstatSync(full);if(st.isDirectory()){result.push(full+'/');walk(full);}else {requireValue(st.isFile(),'invalid archive file');result.push(full);}}};walk(root);return result.sort();
}
function expectedArchiveFiles(root:string,files:readonly string[]):string[] {
 const paths=new Set(files);
 for(const file of files){let parent=dirname(file);while(parent!==root){requireValue(containsPath(root,parent),'archive location escapes');paths.add(parent+'/');parent=dirname(parent);}}
 return [...paths].sort();
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
 return validateOperatorDecision(JSON.parse(utf8(bytes(path))),input.proposal,'approve-world',input.runId);
}
/** Shared frozen nine-field validator for host commands and archive readback. */
export function validateOperatorDecision(value:unknown,p:WorldChangeProposal,command:OperatorDecision['command'],runId:string):OperatorDecision {
 const d=object(value,['command','operator','runId','proposalId','proposalDigest','baseRevisionId','baseWorld','patchDigest','recordedAt']);
 text(d.operator);text(d.recordedAt);
 requireValue(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(d.recordedAt) && new Date(d.recordedAt).toISOString()===d.recordedAt,'invalid operator time');
 requireValue(d.command===command && d.runId===runId && d.runId===p.runId && d.proposalId===p.proposalId && d.proposalDigest===p.proposalDigest && d.baseRevisionId===p.base.id && d.baseWorld===p.base.world && d.patchDigest===p.patchDigest,'operator decision mismatch');
 return d as unknown as OperatorDecision;
}
export function readWorldProposal(input:{artifactDir:string;runId:string;proposalId:string}):WorldChangeProposal {
 const root=absolute(input.artifactDir),dir=proposalDir(root,input.runId,input.proposalId);
 fileRef(root,join(dir,'record.json'));fileRef(root,join(dir,'patch.yaml'));
 const record=object(JSON.parse(utf8(bytes(join(dir,'record.json')))),['schema','proposal']);
 requireValue(record.schema==='kadmos.host-world-proposal.v1','invalid proposal schema');
 const p=loadProposal(record.proposal as WorldChangeProposal);
 requireValue(p.artifactDir===root && p.runId===input.runId && p.proposalId===input.proposalId,'proposal location mismatch');return p;
}
/** Requested ID only locates an archive; full original-control validation conveys its authority. */
export function readRequestedActivation(control:OriginalControl,revisionId:string):WorldRevision {
 id(revisionId);const path=join(control.artifactDir,'inputs','revisions',control.runId,revisionId,'activation','record.json');fileRef(control.artifactDir,path);
 const record=JSON.parse(utf8(bytes(path))) as {revision:WorldRevision};
 requireValue(record.revision?.id===revisionId,'requested revision mismatch');
 return readApprovedActivation({control,currentRevision:control.initialRevision,requestedRevision:record.revision});
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
  const layout=archiveLayout(p.base,dir,generated);
  const result:WorldRevision={id:revisionId,parentId:p.base.id,proposalId:p.proposalId,world:hashBytes(p.patch),seam:layout.seam,worldPath:join(dir,'world.yaml'),seamPaths:layout.seamPaths,state:'active',staleReceiptIds};
  mkdirSync(dirname(dir),{recursive:true,mode:0o700});absolute(dirname(dir));mkdirSync(dir,{mode:0o700});
  writeExclusive(result.worldPath,p.patch);
  for(const file of layout.files){mkdirSync(dirname(file.path),{recursive:true,mode:0o700});writeExclusive(file.path,file.bytes);chmodSync(file.path,file.executable?0o700:0o600);}
  requireValue(seamIdentity(result.seamPaths,generated)===result.seam,'archive seam mismatch');
  writeExclusive(join(dir,'record.json'),JSON.stringify({schema:'kadmos.host-world-activation.v1',runId:p.runId,proposalDigest:p.proposalDigest,requirements:p.requirements,decisionPath:absolute(input.decisionPath),decisionDigest:hashBytes(bytes(input.decisionPath)),decision:approved,revision:result}));
  const fd=openSync(dir,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}
  return result;
 } catch { return {...input.current,state:'rejected'}; }
}

/** Read-only archive validation. Active labels are never controller authority. */
export function readApprovedActivation(input:{readonly control:OriginalControl;readonly currentRevision:WorldRevision;readonly requestedRevision:WorldRevision}):WorldRevision {
 object(input,['control','currentRevision','requestedRevision']);
 const c=readControl({artifactDir:input.control.artifactDir,runId:input.control.runId});
 requireValue(isDeepStrictEqual(c,input.control),'original control disagreement');
 // E2a supports one approved successor of the original revision. Later chains need durable controller history.
 requireValue(isDeepStrictEqual(input.currentRevision,c.initialRevision),'stale controller base');
 captureIdentity({...c.roles,workspace:c.source,policy:c.policy,revisionId:c.initialRevision.id,baseline:c.baseline});
 const requested=input.requestedRevision;id(requested.id);id(requested.proposalId);
 const root=c.artifactDir,dir=absolute(join(root,'inputs','revisions',c.runId,requested.id,'activation'));
 requireValue(isDeepStrictEqual(readdirSync(dir).sort(),['record.json','seam','world.yaml']),'partial/stranded activation archive');
 const retained=object(JSON.parse(utf8(bytes(join(dir,'record.json')))),['schema','runId','proposalDigest','requirements','decisionPath','decisionDigest','decision','revision']);
 requireValue(retained.schema==='kadmos.host-world-activation.v1' && retained.runId===c.runId && retained.requirements===c.baseline.requirements && isDeepStrictEqual(retained.revision,requested),'activation binding mismatch');
 const pd=proposalDir(root,c.runId,requested.proposalId),record=object(JSON.parse(utf8(bytes(join(pd,'record.json')))),['schema','proposal']);
 requireValue(record.schema==='kadmos.host-world-proposal.v1','invalid proposal schema');
 const p=loadProposal(record.proposal as WorldChangeProposal);
 requireValue(p.artifactDir===root && p.runId===c.runId && p.proposalId===requested.proposalId && isDeepStrictEqual(p.base,input.currentRevision) && p.requirements===c.baseline.requirements && p.proposalDigest===retained.proposalDigest,'proposal/controller mismatch');
 const layout=archiveLayout(p.base,dir,projection(p.patch));
 requireValue(requested.id===`r-${p.proposalDigest.slice(7)}` && requested.parentId===p.base.id && requested.worldPath===join(dir,'world.yaml') && isDeepStrictEqual(requested.seamPaths,layout.seamPaths) && requested.seam===layout.seam,'activation location/ancestry mismatch');
 const stale=canonicalReceipts(requested.staleReceiptIds);
 requireValue(isDeepStrictEqual(stale,requested.staleReceiptIds) && p.base.staleReceiptIds.every(x=>stale.includes(x)),'invalid archived stale receipt IDs');
 requireValue(requested.world===p.patchDigest && bytes(requested.worldPath).equals(Buffer.from(p.patch)),'archived World differs from proposal');
 revision(requested);
 requireValue(isDeepStrictEqual(archiveFiles(dir),expectedArchiveFiles(dir,[join(dir,'record.json'),requested.worldPath,...layout.files.map(f=>f.path)])),'unexpected archived seam');
 const decisionPath=retained.decisionPath;requireValue(typeof decisionPath==='string','invalid archived decision path');
 const approved=decision({proposal:p,current:input.currentRevision,decisionPath,decisionsDir:c.decisionsDir,runId:c.runId,historicalReceiptIds:stale});
 requireValue(hashBytes(bytes(decisionPath))===retained.decisionDigest && isDeepStrictEqual(approved,retained.decision),'original decision evidence changed/unavailable');
 // Reject hardlinks as well as symlinks for every retained archive/proposal/base/decision file.
 for(const path of [join(dir,'record.json'),requested.worldPath,...layout.files.map(f=>f.path),join(pd,'record.json'),join(pd,'patch.yaml')])fileRef(root,path);
 fileRef(c.decisionsDir,decisionPath);
 for(const path of [p.base.worldPath,...seamSlots(p.base.seamPaths).map(f=>f.path)]){
  requireValue(lstatSync(absolute(path)).nlink===1,'aliased original input');
 }
 return freezeControlData(JSON.parse(JSON.stringify(requested)) as WorldRevision);
}
