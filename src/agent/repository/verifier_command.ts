import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { RepositoryPolicy, VerifierCommand } from './contracts.js';
import { containsPath, hashBytes, safePath } from './workspace.js';
export function hostPath(path: string, workspace: string, policy: RepositoryPolicy): string {
 if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('absolute host path required');
 const full=safePath(path);
 if ([workspace,policy.sourceRoot].some(root=>containsPath(safePath(root),full))) throw new Error('host verifier path overlaps source/candidate');
 return full;
}
/** Digest-directed convention: executable bytes win; otherwise argv[0] must be an absolute script entrypoint.
 * Absolute data arguments on a direct executable are never mistaken for programs. No shell or interpolation. */
export function resolveVerifier(command: VerifierCommand, workspace: string, policy: RepositoryPolicy) {
 if (typeof command.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(command.id) || !Array.isArray(command.argv) || command.argv.some(x=>typeof x!=='string'||x.includes('\0')) || !['compile','functional','guard','requirement','core','environment','ambiguous'].includes(command.failureKind)) throw new Error('invalid frozen check');
 const executable=hostPath(command.executable,workspace,policy);
 // Missing executable remains a real launch failure if a valid script is frozen.
 let executableDigest: string | null=null;
 try { if(!lstatSync(executable).isFile())throw new Error('executable not regular');executableDigest=hashBytes(readFileSync(executable)); } catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
 let program=executable;
 if(executableDigest!==command.programDigest) {
  if(!command.argv[0] || !isAbsolute(command.argv[0]))throw new Error('program digest mismatch');
  program=hostPath(command.argv[0],workspace,policy);
  if(!lstatSync(program).isFile() || hashBytes(readFileSync(program))!==command.programDigest)throw new Error('script digest mismatch');
 }
 const cwd=command.cwd==='<candidate>'?safePath(workspace):hostPath(command.cwd,workspace,policy);
 if(!lstatSync(cwd).isDirectory())throw new Error('check cwd not directory');
 return {executable:command.executable,argv:command.argv.map(x=>x==='<candidate>'?workspace:x),cwd:command.cwd==='<candidate>'?workspace:command.cwd,program,executableDigest};
}
