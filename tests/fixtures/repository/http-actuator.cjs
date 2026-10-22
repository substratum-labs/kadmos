// Independent loopback-only actuator: one server serializes a persistent local ledger.
// Trusted local mock, process restart only; no power-loss or multi-host claim.
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const [root]=process.argv.slice(2);fs.mkdirSync(path.join(root,'requests'),{recursive:true});
const file=path.join(root,'ledger.json');let state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{operations:[],effects:0};
let sequence=fs.readdirSync(path.join(root,'requests')).length;
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://127.0.0.1'),action=u.pathname.slice(1),id=u.searchParams.get('id'),mode=u.searchParams.get('mode');
 fs.writeFileSync(path.join(root,'requests',String(++sequence).padStart(6,'0')+'.json'),JSON.stringify({action,id,mode})+'\n',{flag:'wx',mode:0o400});
 if(req.method!=='POST'||!['apply','query'].includes(action)||!id||!/^[a-zA-Z0-9_-]{1,128}$/.test(id)){res.writeHead(400).end();return;}
 const committed=()=>state.operations.includes(id);
 const receipt=(outcome)=>({protocol:action==='query'?'kadmos.effect-query.v1':'kadmos.effect-commit.v1',operationId:id,outcome,effectCount:outcome==='committed'?1:0});
 if(action==='query'&&mode==='unavailable'){res.writeHead(503).end();return;}
 if(action==='apply'&&mode==='refuse'){
  // A precommit refusal is legal only before this ID has committed.
  if(committed()){res.writeHead(409).end();return;}
  res.writeHead(409,{'content-type':'application/json'}).end(JSON.stringify({protocol:'kadmos.precommit-refusal.v1',operationId:id,outcome:'not_committed',effectCount:0}));return;
 }
 if(action==='apply'&&!committed()){
  state.operations.push(id);state.effects++;
  fs.writeFileSync(file+'.tmp',JSON.stringify(state)+'\n',{flag:'wx',mode:0o600});fs.renameSync(file+'.tmp',file);
 }
 if(action==='apply'&&mode==='drop'){req.socket.destroy();return;}
 let value=receipt(committed()?'committed':'not_committed');
 if(mode==='wrong-id')value.operationId='another-id';
 if(mode==='bad-count')value.effectCount=2;
 if(mode==='extra')value.extra=true;
 if(mode==='malformed'){res.writeHead(200).end('{');return;}
 res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value));
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,pid:process.pid})));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
