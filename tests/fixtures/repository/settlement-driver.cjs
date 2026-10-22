// Fresh settlement process: reconstruction must use retained records, not memory.
const fs=require('fs');const {pathToFileURL}=require('url');const path=require('path');
(async()=>{
 const [builtRoot,configPath]=process.argv.slice(2);const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
 const {settleOperation}=await import(pathToFileURL(path.join(builtRoot,'examples/repository-order-service/settlement.js')));
 const {createWorldChecker}=await import(pathToFileURL(path.join(builtRoot,'src/world_checker.js')));
 const {parseWorldSpec}=await import(pathToFileURL(path.join(builtRoot,'src/world_compiler.js')));
 const checker=createWorldChecker(parseWorldSpec(fs.readFileSync(config.worldPath,'utf8')));
 console.log(JSON.stringify(await settleOperation({...config,checker,signal:new AbortController().signal})));
})().catch(e=>{console.error(e);process.exitCode=1;});
