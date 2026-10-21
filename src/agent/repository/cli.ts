import { readFileSync } from 'node:fs';
import { isAbsolute, join, dirname, basename } from 'node:path';
import { DEFAULT_LIMITS, REPOSITORY_CONTRACT, type RepositoryRunOptions, type RepositoryPolicy } from './contracts.js';
import { CodexBackend } from './codex_backend.js';
import { runRepositoryTask } from './loop.js';
import { captureIdentity } from './identity.js';
import { readCompleteRun } from './publication.js';
import { safePath, containsPath } from './workspace.js';
import { hostPath } from './verifier_command.js';
type Obj = Record<string, unknown>;
function object(value:unknown,keys:readonly string[],required:readonly string[]=keys):Obj {
 if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('invalid repository input object');
 const v=value as Obj;if(Object.keys(v).some(k=>!keys.includes(k)) || required.some(k=>!(k in v)))throw new Error('invalid repository input keys');return v;
}
function text(value:unknown):string {if(typeof value!=='string'||!value||value.includes('\0'))throw new Error('invalid repository input string');return value;}
function array(value:unknown):string[] {if(!Array.isArray(value)||value.some(x=>typeof x!=='string'||x.includes('\0')))throw new Error('invalid repository input argv/paths');return [...value];}
function path(value:unknown):string {const p=text(value);if(!isAbsolute(p))throw new Error('absolute repository input path required');return safePath(p);}
function paths(value:unknown):string[] {return array(value).map(path);}
function relative(value:unknown):string[] {return array(value).map(p=>{if(!p||isAbsolute(p)||p.includes('\\')||p.replace(/\/$/,'').split('/').some(x=>!x||x==='.'||x==='..'))throw new Error('invalid repository input relative policy path');return p;});}
/** Host wire decoder: capabilities are constructed locally and never deserialized. */
export async function runRepositoryCli(args:readonly string[]):Promise<string> {
 if(args.length!==3||args[0]!=='run'||args[1]!=='--input'||!args[2]||args[2].startsWith('--'))throw new Error('Usage: kadmos repo run --input <run.json>');
 const keys=['schema','runId','source','artifactDir','requirementsPath','worldPath','seamPaths','instructions','policy','backend','limits','revisionId','decisionsDir'];
 const v=object(JSON.parse(readFileSync(safePath(args[2]),'utf8')),keys,keys.filter(k=>!['limits','decisionsDir'].includes(k)));
 if(v.schema!==REPOSITORY_CONTRACT)throw new Error('invalid repository input schema');
 const runId=text(v.runId),revisionId=text(v.revisionId);if(!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)||!/^[a-zA-Z0-9_-]{1,128}$/.test(revisionId))throw new Error('invalid repository input ID');
 const source=path(v.source),artifactDir=path(v.artifactDir),requirementsPath=path(v.requirementsPath),worldPath=path(v.worldPath),seamPaths=paths(v.seamPaths);
 if(!seamPaths.length||![requirementsPath,worldPath,...seamPaths].every(p=>containsPath(source,p)))throw new Error('invalid repository input protected paths');
 if(typeof v.instructions!=='string'||v.instructions.includes('\0'))throw new Error('invalid repository input instructions');
 const p=object(v.policy,['sourceRoot','baseCommit','allowedPaths','protectedPaths','excludedOutputs','verifiers']);
 if(!Array.isArray(p.verifiers)||!p.verifiers.length)throw new Error('invalid repository input verifiers');
 const verifiers=p.verifiers.map(raw=>{const q=object(raw,['id','executable','argv','cwd','programDigest','failureKind']);
 const id=text(q.id),programDigest=text(q.programDigest),failureKind=text(q.failureKind);
 if(!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id)||!/^sha256:[a-f0-9]{64}$/.test(programDigest)||!['compile','functional','guard','requirement','core','environment','ambiguous'].includes(failureKind))throw new Error('invalid repository input verifier');
 return {id,executable:path(q.executable),argv:array(q.argv),cwd:q.cwd==='<candidate>'?'<candidate>':path(q.cwd),programDigest,failureKind};});
 if(new Set(verifiers.map(q=>q.id)).size!==verifiers.length)throw new Error('invalid repository input duplicate verifier');
 const baseCommit=text(p.baseCommit);if(!/^[a-f0-9]{40,64}$/.test(baseCommit))throw new Error('invalid repository input baseCommit');
 const policy={sourceRoot:path(p.sourceRoot),baseCommit,allowedPaths:relative(p.allowedPaths),protectedPaths:relative(p.protectedPaths),excludedOutputs:relative(p.excludedOutputs),verifiers} as RepositoryPolicy;
 if(policy.sourceRoot!==source)throw new Error('invalid repository input sourceRoot');
 const workspace=safePath(join(dirname(artifactDir),basename(artifactDir)+'-workspace'));
 hostPath(artifactDir,workspace,policy);const decisionsDir=hostPath(v.decisionsDir===undefined?join(artifactDir,'decisions'):path(v.decisionsDir),workspace,policy);
 const b=object(v.backend,['executable','prefixArgs']);const backend=new CodexBackend({executable:text(b.executable),prefixArgs:array(b.prefixArgs)});
 const l=v.limits===undefined?{}:object(v.limits,Object.keys(DEFAULT_LIMITS),[]);const limits={...DEFAULT_LIMITS,...l};
 for(const n of Object.values(limits))if(!Number.isSafeInteger(n)||Number(n)<=0||Number(n)>2147483647)throw new Error('invalid repository input limits');
 const initial=captureIdentity({workspace:source,requirementsPath,worldPath,seamPaths,policy,revisionId});
 const revision={id:revisionId,world:initial.world,seam:initial.seam,parentId:null,proposalId:null,worldPath,seamPaths,state:'active' as const,staleReceiptIds:[]};
 const controller=new AbortController();const abort=()=>controller.abort();process.on('SIGINT',abort);process.on('SIGTERM',abort);
 try {
 const options={runId,source,artifactDir,requirementsPath,worldPath,seamPaths,instructions:v.instructions,policy,backend,limits,signal:controller.signal,revision,decisionsDir} as RepositoryRunOptions;
 let record=await runRepositoryTask(options);
 if(record.status==='delivered')record=readCompleteRun({artifactDir,workspace,policy,runId});
 return JSON.stringify({...record,artifactDir,workspace},null,2)+'\n';
 }finally{process.off('SIGINT',abort);process.off('SIGTERM',abort);}
}
