import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
// Runs host checks only. Deliberately has no backend construction or launch path.
const [inputPath,bad,good,out]=process.argv.slice(2);
const digest=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
mkdirSync(out,{recursive:false});
const report={status:'BLOCKED',modelInvocations:0,inputPath,inputDigest:null,programs:[],samples:[],checks:[],diagnostic:null};
const files=root=>{const result=[];const walk=(dir,rel='')=>{for(const name of readdirSync(dir).sort()){if(name==='.git'||name==='dist')continue;const path=join(dir,name),r=rel?rel+'/'+name:name;if(statSync(path).isDirectory())walk(path,r);else result.push({path:r,digest:digest(readFileSync(path))});}};walk(root);return result;};
try {
 const bytes=readFileSync(inputPath);report.inputDigest=digest(bytes);const input=JSON.parse(bytes);
 const commands=input.policy.verifiers;
 if(commands.length!==2||commands[0].id!=='typecheck'||commands[1].id!=='functional')throw Error('expected exact demo checker pair');
 for(const c of commands){if(c.resultProtocol!=='exit-v1'||digest(readFileSync(c.argv[0]))!==c.programDigest)throw Error('invalid frozen program/protocol');report.programs.push({path:c.argv[0],digest:c.programDigest,tool:c.argv[2],toolDigest:digest(readFileSync(c.argv[2]))});}
 for(const [label,root] of [['original',bad],['reference',good]]) {
  const before=files(root);report.samples.push({label,root,files:before});
  for(const c of commands) {
   const argv=c.argv.map(x=>x==='<candidate>'?root:x),cwd=c.cwd==='<candidate>'?root:c.cwd;
   const r=spawnSync(c.executable,argv,{cwd,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
   const stdout=join(out,label+'-'+c.id+'.stdout'),stderr=join(out,label+'-'+c.id+'.stderr');writeFileSync(stdout,r.stdout||'');writeFileSync(stderr,r.stderr||'');
   report.checks.push({label,argv:[c.executable,...argv],cwd,exit:r.status,signal:r.signal,error:r.error?String(r.error):null,stdout,stderr,stdoutDigest:digest(readFileSync(stdout)),stderrDigest:digest(readFileSync(stderr))});
   const expected=label==='original'&&c.id==='functional'?1:0;
   if(r.error||r.signal||r.status!==expected)throw Error(label+' '+c.id+' infrastructure or unexpected outcome');
   if(c.id==='functional') {
    if(label==='reference'&&(r.stdout.match(/^PASS /gm)||[]).length!==5)throw Error('reference must PASS5');
    if(label==='original'&&(!/^FAIL pricing product and safe input:/m.test(r.stderr)||!/^FAIL legal payment before dispatch:/m.test(r.stderr)||!/AssertionError/m.test(r.stderr)))throw Error('original expected assertions absent');
   }
  }
  if(JSON.stringify(before)!==JSON.stringify(files(root)))throw Error('protected/sample input changed');
 }
 for(const c of commands)if(digest(readFileSync(c.argv[0]))!==c.programDigest)throw Error('program drift');
 if(digest(readFileSync(inputPath))!==report.inputDigest)throw Error('input drift');
 report.status='PASS';
}catch(e){report.diagnostic=String(e);console.error(e);process.exitCode=86;}
writeFileSync(join(out,'preflight.json'),JSON.stringify(report,null,2)+'\n');
