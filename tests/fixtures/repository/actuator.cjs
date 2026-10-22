// Independent local file actuator, intentionally bounded (not crash-durable).
const fs = require('node:fs');
const [file, action, id, mode, protocol] = process.argv.slice(2);
const bound=protocol==='--bound'; // opt-in host protocol; preserve original fixture output by default
fs.appendFileSync(file+'.trace.jsonl',JSON.stringify({action,id,mode})+'\n');
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : { operations:{}, effects:0 };
if (action === 'query') {
  if (mode === 'unavailable') { console.error('reconciliation unavailable'); process.exit(3); }
  console.log(JSON.stringify(bound ? {outcome:Object.hasOwn(state.operations,id)?'committed':'not_committed',protocol:'kadmos.effect-query.v1',operationId:id,effectCount:Object.hasOwn(state.operations,id)?1:0} : {outcome:Object.hasOwn(state.operations,id)?'committed':'not_committed',effects:state.effects}));
} else if (mode === 'refuse' && !Object.hasOwn(state.operations,id)) { console.log(JSON.stringify({protocol:'kadmos.precommit-refusal.v1',operationId:id,outcome:'not_committed',effectCount:0})); process.exitCode=2;
} else {
  if (!Object.hasOwn(state.operations,id)) { Object.defineProperty(state.operations,id,{value:true,enumerable:true}); state.effects++; fs.writeFileSync(file,JSON.stringify(state)); }
  if (mode === 'drop') { console.error('response lost after commit'); process.exitCode=4; }
  else console.log(JSON.stringify(bound ? {protocol:'kadmos.effect-commit.v1',operationId:id,outcome:'committed',effectCount:1} : {outcome:'committed',effects:state.effects}));
}
