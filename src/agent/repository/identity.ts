import { isDeepStrictEqual } from 'node:util';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { compileWorldSpec, parseWorldSpec } from '../../world_compiler.js';
import type { FileIdentity, InputBinding, RepositoryRunOptions } from './contracts.js';
import { containsPath, hashBytes, safePath, snapshotCandidate } from './workspace.js';
export type IdentityRequest = Pick<RepositoryRunOptions, 'requirementsPath' | 'worldPath' | 'seamPaths' | 'policy'> & { readonly workspace: string; readonly revisionId: string; readonly baseline?: InputBinding };
const matches = (path: string, rule: string): boolean => rule.endsWith('/') ? path.startsWith(rule) : path === rule;
/** Host capture; source-declared paths are mapped into the checked candidate, never read from source. */
export function captureIdentity(input: IdentityRequest): InputBinding {
 const { policy, baseline } = input;
 const source = safePath(policy.sourceRoot), workspace = safePath(input.workspace);
 const candidate = snapshotCandidate(workspace, policy);
 const require = (ok: boolean, why: string): void => { if (!ok) throw new Error(why); };
 const overlaps = (a: string, b: string): boolean => matches(a.endsWith('/') ? a.slice(0,-1) : a,b) || matches(b.endsWith('/') ? b.slice(0,-1) : b,a);
 for (const excluded of policy.excludedOutputs) for (const protectedPath of policy.protectedPaths) require(!overlaps(excluded,protectedPath),'excluded/protected overlap');
 const map = (path: string): string => {
  require(isAbsolute(path),'input path must be absolute');
  // Resolve declarations lexically before validating candidate ancestors. Source may legitimately drift later.
  const rel = relative(resolve(policy.sourceRoot),resolve(path));
  require(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),'input outside source');
  const full = safePath(join(workspace,rel)); require(containsPath(workspace,full),'input escapes candidate');
  return full;
 };
 const protectedInput = (path: string): void => {
  const rel = relative(workspace,path).split(sep).join('/');
  require(policy.protectedPaths.some(x=>matches(rel,x)),'identity input must be protected');
  require(!policy.excludedOutputs.some(x=>matches(rel,x)),'identity input excluded');
 };
 const bytes = (path: string): Buffer => { protectedInput(path); require(lstatSync(path).isFile(),'input must be regular'); return readFileSync(path); };
 const requirements = hashBytes(bytes(map(input.requirementsPath)));
 const worldBytes = bytes(map(input.worldPath));
 const world = hashBytes(worldBytes);
 if(baseline)require(world===baseline.world && requirements===baseline.requirements,'frozen inputs changed');
 const projection = compileWorldSpec(parseWorldSpec(worldBytes.toString('utf8')));
 const generated: Record<string,string> = { 'ports.d.ts': projection.portsDts, 'world_checker.ts': projection.worldCheckerTs };
 const seamFiles: FileIdentity[] = [], seen = new Set<string>(), generatedSeen = new Set<string>();
 input.seamPaths.forEach((declared,index)=>{
  const root = map(declared);
  const walk = (path: string, suffix: string): void => {
   const st = lstatSync(path);require(!st.isSymbolicLink(),'seam symlink');
   if (st.isDirectory()) { for (const name of readdirSync(path).sort()) walk(join(path,name),suffix ? `${suffix}/${name}` : name); return; }
   require(st.isFile(),'seam must be regular');protectedInput(path);
   const canonical = relative(workspace,path).toLowerCase();require(!seen.has(canonical),'seam collision');seen.add(canonical);
   const name = basename(path);require(Object.hasOwn(generated,name) && !generatedSeen.has(name),'unexpected or duplicate generated file');generatedSeen.add(name);
   const raw = bytes(path);require(raw.equals(Buffer.from(generated[name]!)),'generated seam differs from accepted World');
   seamFiles.push({path:`${index}/${suffix || name}`,sha256:hashBytes(raw),executable:(st.mode & 0o111)!==0});
  };walk(root,'');
 });
 require(generatedSeen.size===2,'incomplete TypeScript seam');
 seamFiles.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const binding: InputBinding = { requirements, world, seam:hashBytes(JSON.stringify(seamFiles)),policy:hashBytes(JSON.stringify(policy)),candidate,revisionId:input.revisionId };
 if (baseline) {
  require(binding.requirements===baseline.requirements && binding.world===baseline.world && binding.seam===baseline.seam && binding.policy===baseline.policy && binding.revisionId===baseline.revisionId && candidate.baseCommit===baseline.candidate.baseCommit,'frozen inputs changed');
  const before = new Map(baseline.candidate.files.map(x=>[x.path,x]));const after = new Map(candidate.files.map(x=>[x.path,x]));
  for (const path of new Set([...before.keys(),...after.keys()])) if (!isDeepStrictEqual(before.get(path),after.get(path))) {
   require(!policy.protectedPaths.some(x=>matches(path,x)) && policy.allowedPaths.some(x=>matches(path,x)),`unauthorized edit: ${path}`);
  }
 }
 return binding;
}
