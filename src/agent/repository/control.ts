import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { createAtomicJson } from './store.js';
import { atomic, copy, fileRef, insist, readRef } from './evidence.js';
import { containsPath, hashBytes, safePath } from './workspace.js';
import { readRunStart } from './publication.js';
import { readVerificationContext } from './context.js';
import { captureIdentity } from './identity.js';
import { CodexBackend } from './codex_backend.js';
import { ScriptedBackend } from './backend.js';
import type { RepositoryRunOptions, InputBinding, WorldRevision } from './contracts.js';
import type { RunHeader } from './publication.js';
import type { FileRef } from './evidence.js';
export type BackendDescriptor = { readonly kind:'codex'|'scripted'; readonly executable:string; readonly prefixArgs:readonly string[] } | {readonly kind:'host-capability';readonly restorable:false};
export interface OriginalControl {
 readonly schema:'kadmos.original-control.v1'; readonly runId:string; readonly artifactDir:string; readonly source:string; readonly sourceDeclared:string;
 readonly roles:{readonly requirementsPath:string;readonly worldPath:string;readonly seamPaths:readonly string[]};
 readonly instructions:string; readonly policy:RepositoryRunOptions['policy']; readonly initialRevision:WorldRevision; readonly decisionsDir:string;
 readonly backend:BackendDescriptor; readonly header:RunHeader; readonly baseline:InputBinding; readonly startRef:FileRef; readonly contextRef:FileRef;
}

const schema='kadmos.original-control.v1' as const;
export function freezeControlData<T>(value:T):T {
 if(value!==null && typeof value==='object'){Object.values(value).forEach(freezeControlData);Object.freeze(value);}return value;
}
function text(value:unknown):asserts value is string {insist(typeof value==='string' && value.length>0 && !value.includes('\0'),'invalid control text');}
function path(value:unknown):string {text(value);insist(isAbsolute(value),'absolute control path required');return safePath(value);}
function id(value:unknown):asserts value is string {insist(typeof value==='string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(value),'unsafe control ID');}
function keys(value:unknown,names:readonly string[]):void {insist(value!==null && typeof value==='object' && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(),[...names].sort()),'invalid control schema');}
function descriptor(value:BackendDescriptor):void {
 if(value.kind==='host-capability'){keys(value,['kind','restorable']);insist(value.restorable===false,'capability cannot be restored');return;}
 keys(value,['kind','executable','prefixArgs']);insist(value.kind==='codex'||value.kind==='scripted','unknown control backend');text(value.executable);
 insist(Array.isArray(value.prefixArgs) && value.prefixArgs.every(x=>typeof x==='string'&&!x.includes('\0')),'invalid backend prefix');
}
/** Only exact built-in prototypes have a supported restorable configuration. No capability serialization. */
export function describeBackend(backend:RepositoryRunOptions['backend']):BackendDescriptor {
 const proto=Object.getPrototypeOf(backend);
 const kind=proto===ScriptedBackend.prototype?'scripted':proto===CodexBackend.prototype?'codex':null;
 if(kind===null)return {kind:'host-capability',restorable:false};
 const options=(backend as CodexBackend).options;
 const d:BackendDescriptor={kind,executable:options.executable,prefixArgs:[...options.prefixArgs]};descriptor(d);return freezeControlData(d);
}
/** Freeze actual execution options synchronously too; custom capabilities remain host-owned. */
export function detachBackend(backend:RepositoryRunOptions['backend']):RepositoryRunOptions['backend'] {
 const d=describeBackend(backend);
 return d.kind==='host-capability'?backend:d.kind==='scripted'?new ScriptedBackend({executable:d.executable,prefixArgs:d.prefixArgs}):new CodexBackend({executable:d.executable,prefixArgs:d.prefixArgs});
}
function location(root:string,runId:string):string {id(runId);return safePath(join(path(root),'inputs','controllers',runId,'original-control'));}
function validate(c:OriginalControl,root:string,runId:string):void {
 keys(c,['schema','runId','artifactDir','source','sourceDeclared','roles','instructions','policy','initialRevision','decisionsDir','backend','header','baseline','startRef','contextRef']);
 insist(c.schema===schema && c.runId===runId && c.artifactDir===root,'control root/run mismatch');
 text(c.instructions);id(c.initialRevision.id);descriptor(c.backend);
 insist(path(c.source)===c.source && path(c.sourceDeclared)===c.source && path(c.policy.sourceRoot)===c.source,'control source mismatch');
 const workspace=path(c.header.workspace),decisions=path(c.decisionsDir);
 insist(c.decisionsDir===decisions,'noncanonical decision address');
 for(const role of [c.source,workspace]){
  insist(!containsPath(role,root) && !containsPath(root,role),'control host storage overlaps source/candidate');
  insist(!containsPath(role,decisions) && !containsPath(decisions,role),'control decision storage overlaps source/candidate');
 }
 keys(c.roles,['requirementsPath','worldPath','seamPaths']);
 insist(Array.isArray(c.roles.seamPaths)&&c.roles.seamPaths.length>0,'control seam paths required');
 const rolePaths=[c.roles.requirementsPath,c.roles.worldPath,...c.roles.seamPaths];
 const lexical=new Set<string>();
 for(const declared of rolePaths){
  text(declared);insist(isAbsolute(declared),'absolute role declaration required');
  const rel=relative(resolve(c.policy.sourceRoot),resolve(declared));
  insist(rel!=='' && rel!=='..' && !rel.startsWith('..'+sep) && !isAbsolute(rel),'role outside lexical source');
  const full=path(declared);insist(containsPath(c.source,full),'role outside canonical source');
  insist(!lexical.has(full.toLowerCase()),'duplicate control role');lexical.add(full.toLowerCase());
 }
 const input={artifactDir:root,workspace:c.header.workspace,policy:c.policy,runId};
 const header=readRunStart(input);
 insist(isDeepStrictEqual(header,c.header),'original header disagreement');
 const expectedStart=join(root,'publication',runId,'start','record.json');
 insist(readRef(root,c.startRef)===safePath(expectedStart),'control start reference mismatch');
 atomic(join(root,'publication',runId,'start'));
 const dir=join(root,'inputs','revisions',runId,c.initialRevision.id,'verification-context');
 insist(readRef(root,c.contextRef)===safePath(join(dir,'record.json')),'control context reference mismatch');atomic(dir);
 const context=readVerificationContext({...input,revisionId:c.initialRevision.id});
 insist(isDeepStrictEqual(context.roles,c.roles) && isDeepStrictEqual(context.baseline,c.baseline),'original context disagreement');
 const revision=c.initialRevision;
 keys(revision,['id','world','seam','parentId','proposalId','worldPath','seamPaths','state','staleReceiptIds']);
 insist(revision.parentId===null && revision.proposalId===null && revision.state==='active' && isDeepStrictEqual(revision.staleReceiptIds,[]) && revision.world===c.baseline.world && revision.seam===c.baseline.seam && revision.worldPath===c.roles.worldPath && isDeepStrictEqual(revision.seamPaths,c.roles.seamPaths),'initial revision disagreement');
}
/** After legitimate initial context, before attempts; failed reservations never recover. */
export function createControl(input:RepositoryRunOptions & {readonly workspace:string}):OriginalControl {
 const root=path(input.artifactDir);id(input.runId);
 const header=readRunStart({...input,artifactDir:root});
 insist(isDeepStrictEqual(input.limits,header.limits),'caller limits disagree with original header');
 insist(!existsSync(join(root,'attempts')) && !existsSync(join(root,'verification',input.runId)),'control must precede backend work');
 const context=readVerificationContext({...input,artifactDir:root,revisionId:input.revision.id});
 insist(isDeepStrictEqual(captureIdentity({...input,revisionId:input.revision.id}),context.baseline),'initial control binding mismatch');
 const c:OriginalControl=copy({schema,runId:input.runId,artifactDir:root,source:path(input.source),sourceDeclared:input.source,
  roles:{requirementsPath:input.requirementsPath,worldPath:input.worldPath,seamPaths:input.seamPaths},instructions:input.instructions,policy:input.policy,initialRevision:input.revision,decisionsDir:path(input.decisionsDir),backend:describeBackend(input.backend),header,baseline:context.baseline,
  startRef:fileRef(root,join(root,'publication',input.runId,'start','record.json')),contextRef:fileRef(root,join(root,'inputs','revisions',input.runId,input.revision.id,'verification-context','record.json'))});
 validate(c,root,input.runId);createAtomicJson(location(root,input.runId),{control:c,digest:hashBytes(JSON.stringify(c))});return freezeControlData(c);
}
/** Host-selected external root only. Never initialize, recover or discover roots from backend metadata. */
export function readControl(input:{readonly artifactDir:string;readonly runId:string}):OriginalControl {
 keys(input,['artifactDir','runId']);const root=path(input.artifactDir);id(input.runId);
 const dir=location(root,input.runId);fileRef(root,join(dir,'record.json'));
 const envelope=atomic(dir) as {control:OriginalControl;digest:string};keys(envelope,['control','digest']);
 insist(envelope.digest===hashBytes(JSON.stringify(envelope.control)),'control integrity mismatch');
 validate(envelope.control,root,input.runId);return freezeControlData(copy(envelope.control));
}
