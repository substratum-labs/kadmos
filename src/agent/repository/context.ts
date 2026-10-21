import { captureIdentity, type IdentityRequest } from './identity.js';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { containsPath, hashBytes, safePath } from './workspace.js';
import { createAtomicJson, readAtomicJson } from './store.js';
import type { InputBinding, RepositoryPolicy } from './contracts.js';
export type ContextCreate = Omit<IdentityRequest, 'baseline'> & { readonly runId: string; readonly artifactDir: string; readonly expected: InputBinding };
export interface ContextRead { readonly artifactDir: string; readonly runId: string; readonly revisionId: string; readonly workspace: string; readonly policy: RepositoryPolicy }
export interface VerificationContext { readonly schema: 'kadmos.host-verification-context.v1'; readonly runId: string; readonly revisionId: string; readonly policy: RepositoryPolicy; readonly roles: { readonly requirementsPath: string; readonly worldPath: string; readonly seamPaths: readonly string[] }; readonly baseline: InputBinding }

const schema = 'kadmos.host-verification-context.v1' as const;
function requireValue(ok: boolean, message: string): asserts ok { if (!ok) throw new Error(message); }
function object(value: unknown): Record<string, unknown> {
 requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'record object required');
 return value as Record<string, unknown>;
}
function digest(value: unknown): void { requireValue(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value), 'invalid digest'); }
function relativeFile(value: unknown): asserts value is string {
 requireValue(typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !value.includes('\\') && !value.includes('\0') && !/^[A-Za-z]:/.test(value) && value.split('/').every(x => x !== '' && x !== '.' && x !== '..'), 'invalid baseline path');
}
function ordered(values: readonly string[]): void {
 requireValue(values.every((x, i) => i === 0 || values[i - 1]! < x) && new Set(values.map(x => x.toLowerCase())).size === values.length, 'noncanonical paths');
}
function baseline(value: unknown, input: ContextRead): asserts value is InputBinding {
 const b=object(value), c=object(b.candidate);
 for (const name of ['requirements','world','seam','policy']) digest(b[name]);
 requireValue(b.policy === hashBytes(JSON.stringify(input.policy)) && b.revisionId === input.revisionId && c.baseCommit === input.policy.baseCommit, 'baseline policy/revision/base mismatch');
 requireValue(Array.isArray(c.files) && Array.isArray(c.deleted), 'candidate lists required');
 const files=c.files.map((value: unknown) => {
  const f=object(value);relativeFile(f.path);digest(f.sha256);requireValue(typeof f.executable === 'boolean','invalid executable mode');
  const normalized={path:f.path,sha256:f.sha256,executable:f.executable};requireValue(isDeepStrictEqual(f,normalized),'invalid file identity');return normalized;
 });
 const deleted=c.deleted.map((value: unknown) => { relativeFile(value);return value; });
 ordered(files.map(f=>f.path));ordered(deleted);
 requireValue(deleted.every(path=>!files.some(f=>f.path.toLowerCase()===path.toLowerCase())),'file/deletion collision');
 const normalized={baseCommit:c.baseCommit,files,deleted};
 requireValue(c.digest===hashBytes(JSON.stringify(normalized)),'candidate digest mismatch');
 requireValue(isDeepStrictEqual(c,{...normalized,digest:c.digest}) && isDeepStrictEqual(b,{requirements:b.requirements,world:b.world,seam:b.seam,policy:b.policy,candidate:c,revisionId:b.revisionId}),'invalid baseline shape');
}
function location(input: ContextRead): string {
 for (const id of [input.runId,input.revisionId]) requireValue(typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(id),'unsafe host record id');
 requireValue(isAbsolute(input.artifactDir),'artifact directory must be absolute');
 const root=safePath(input.artifactDir), workspace=safePath(input.workspace), source=safePath(input.policy.sourceRoot);
 requireValue(!containsPath(workspace,root) && !containsPath(source,root),'context must be outside candidate and source');
 const dir=safePath(join(root,'inputs','revisions',input.runId,input.revisionId,'verification-context'));
 requireValue(!containsPath(workspace,dir) && !containsPath(source,dir),'context location overlaps candidate or source');
 return dir;
}
function freeze<T>(value: T): T {
 if(value !== null && typeof value === 'object') { for(const child of Object.values(value))freeze(child);Object.freeze(value); }
 return value;
}
/** Only the host calls this, before exposing the candidate to a backend. No backend metadata is accepted. */
export function createVerificationContext(input: ContextCreate): VerificationContext {
 const dir=location(input);
 const captured=captureIdentity(input);
 requireValue(isDeepStrictEqual(captured,input.expected),'initial binding mismatch');
 baseline(captured,input);
 const context: VerificationContext={schema,runId:input.runId,revisionId:input.revisionId,policy:input.policy,
  roles:{requirementsPath:input.requirementsPath,worldPath:input.worldPath,seamPaths:input.seamPaths},baseline:captured};
 // Detach from caller-owned objects before persistence/freezing.
 const copy=JSON.parse(JSON.stringify(context)) as VerificationContext;
 createAtomicJson(dir,{context:copy,digest:hashBytes(JSON.stringify(copy))});
 return freeze(copy);
}
/** Load only from host artifact storage, validate frozen context, then capture the current candidate against its original baseline. */
export function loadVerificationContext(input: ContextRead): { readonly context: VerificationContext; readonly current: InputBinding } {
 const envelope=object(readAtomicJson(location(input))), c=object(envelope.context), roles=object(c.roles);
 requireValue(envelope.digest===hashBytes(JSON.stringify(c)) && isDeepStrictEqual(envelope,{context:c,digest:envelope.digest}),'context integrity mismatch');
 requireValue(c.schema===schema && c.runId===input.runId && c.revisionId===input.revisionId && isDeepStrictEqual(c.policy,input.policy),'host context identity mismatch');
 requireValue(typeof roles.requirementsPath==='string' && typeof roles.worldPath==='string' && Array.isArray(roles.seamPaths) && roles.seamPaths.every(x=>typeof x==='string'),'invalid source roles');
 baseline(c.baseline,input);
 const context: VerificationContext={schema,runId:input.runId,revisionId:input.revisionId,policy:input.policy,
  roles:{requirementsPath:roles.requirementsPath,worldPath:roles.worldPath,seamPaths:roles.seamPaths as string[]},baseline:c.baseline};
 requireValue(isDeepStrictEqual(c,context),'invalid context shape');
 const current=captureIdentity({...context.roles,workspace:input.workspace,policy:input.policy,revisionId:input.revisionId,baseline:context.baseline});
 return freeze({context:JSON.parse(JSON.stringify(context)) as VerificationContext,current});
}
