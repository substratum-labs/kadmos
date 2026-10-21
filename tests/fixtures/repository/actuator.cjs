// Independent local file actuator, intentionally bounded (not crash-durable).
const fs = require('node:fs');
const [file, action, id, mode] = process.argv.slice(2);
fs.appendFileSync(file+'.trace.jsonl',JSON.stringify({action,id,mode})+'\n');
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : { operations:{}, effects:0 };
if (action === 'query') {
  if (mode === 'unavailable') { console.error('reconciliation unavailable'); process.exit(3); }
  console.log(JSON.stringify({ outcome:state.operations[id] ? 'committed':'not_committed', effects:state.effects }));
} else if (mode === 'refuse') { console.error('precommit refusal'); process.exitCode=2;
} else {
  if (!state.operations[id]) { state.operations[id]=true; state.effects++; fs.writeFileSync(file,JSON.stringify(state)); }
  if (mode === 'drop') { console.error('response lost after commit'); process.exitCode=4; }
  else console.log(JSON.stringify({ outcome:'committed',effects:state.effects }));
}
