// Host-owned process fixture: Codex argv/stdin shape, real file/process effects.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const [mode, host, ...argv] = process.argv.slice(2);
const cwd = argv[argv.indexOf('--cd') + 1] || process.cwd();
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(host, 'launches'), '1\n');
  fs.writeFileSync(path.join(host, 'invocation.json'), JSON.stringify({ argv, cwd: process.cwd(), selectedCwd: cwd, input }));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture' }));
  if (mode === 'quota') { console.error('usage_limit_reached'); process.exitCode = 1; return; }
  if (mode === 'malformed') { console.log('not-json'); return; }
  if (mode === 'natural-group' || mode === 'natural-subtree') {
    const child = spawn(process.execPath, ['-e', mode==='natural-subtree'?`const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),180)'],{stdio:'ignore'});c.on('exit',()=>process.exit(0));`:'setTimeout(()=>process.exit(0),180)'], {stdio:'ignore',detached:true});
    fs.writeFileSync(path.join(host,'child.pid'),String(child.pid));
    child.on('exit',()=>setTimeout(()=>{console.log(JSON.stringify({type:'turn.completed'}));},180));
    return;
  }
  if (mode === 'reparented-group') {
    const child = spawn(process.execPath, ['-e', `const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e',"setTimeout(()=>process.exit(0),600)"],{stdio:'ignore'}); require('fs').writeFileSync(${JSON.stringify(path.join(host,'grandchild.pid'))},String(c.pid));setTimeout(()=>process.exit(0),180);`], {stdio:'ignore',detached:true});
    fs.writeFileSync(path.join(host,'child.pid'),String(child.pid));
    setTimeout(()=>console.log(JSON.stringify({type:'turn.completed'})),1000);
    return;
  }
  if (['hang-delayed-heartbeat','hang','linger','stubborn','escape','escape-linger'].includes(mode)) {
    const child = spawn(process.execPath, ['-e', `${mode==='stubborn'?"process.on('SIGTERM',()=>{});":''}setTimeout(()=>setInterval(()=>require('fs').appendFileSync(${JSON.stringify(path.join(host,'heartbeat'))},'x'),20),${mode==='hang-delayed-heartbeat'?1000:0});setTimeout(()=>process.exit(),8000)`], { stdio: 'ignore', detached:mode==='escape'||mode==='escape-linger' });
    fs.writeFileSync(path.join(host, 'child.pid'), String(child.pid));
    if(mode==='linger'||mode==='escape-linger') { console.log(JSON.stringify({type:'turn.completed'})); setTimeout(()=>process.exit(0),150); return; }
    setInterval(() => {}, 1000); setTimeout(()=>process.exit(8),8000); return;
  }
  if (mode === 'receipt-collision') fs.mkdirSync(path.join(host,'artifacts/attempts/a1/stdout.jsonl.lifecycle.json'));
  if (mode.startsWith('tamper:')) fs.appendFileSync(path.join(cwd, mode.slice(7)), '\nTAMPER');
  if (mode === 'output-edits') { fs.mkdirSync(path.join(cwd,'dist'),{recursive:true});fs.writeFileSync(path.join(cwd,'dist/output.bin'),Buffer.from([255,0]));fs.unlinkSync(path.join(cwd,'src/b.ts'));fs.writeFileSync(path.join(cwd,'src/new.bin'),Buffer.from([0,255,128]),{mode:0o755}); }
  if (mode === 'repair') {
    const countPath = path.join(host,'attempts');
    const n = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath))+1 : 1;
    fs.writeFileSync(countPath, String(n));
    fs.writeFileSync(path.join(cwd,'src/a.ts'), n === 1 ? 'export const a: number = "bad";' : 'export const a: number = 1;');
    fs.writeFileSync(path.join(cwd,'src/b.ts'), 'export const b = 2;');
    fs.appendFileSync(path.join(host,'feedback.txt'), input+'\n');
  }
  console.log(JSON.stringify({ type:'item.completed',item:{ type:'agent_message',text:'done' } }));
  console.log(JSON.stringify({ type:'turn.completed',usage:{input_tokens:1,output_tokens:1} }));
});
