const {spawnSync}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
// Conservative adapter: no diagnostic text is authority. All compiler failures
// remain environment until an adapter positively identifies candidate diagnostics.
try {
 if(fs.realpathSync(process.cwd())!==fs.realpathSync(__dirname))throw Error('host cwd mismatch');
 const root=path.resolve(process.argv[2]),tsc=process.argv[3];fs.accessSync(tsc);
 for(const name of ['pricing.ts','order.ts'])fs.accessSync(path.join(root,'src',name));
 const r=spawnSync(process.execPath,[tsc,'--noEmit','--strict','--skipLibCheck','--target','ES2022','--module','NodeNext',path.join(root,'src/pricing.ts'),path.join(root,'src/order.ts')],{cwd:__dirname,encoding:'utf8',timeout:60000});
 process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)console.error(r.error);
 process.exitCode=r.status===0&&!r.error&&!r.signal?0:86;
}catch(e){console.error(e);process.exitCode=86;}
