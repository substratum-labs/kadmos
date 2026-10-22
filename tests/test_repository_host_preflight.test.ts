import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, d } from './repository_test_support.js';
const scripts=resolve('scripts/repository-demo');
function setup(t:import('node:test').TestContext) {
 const f=fixture();t.after(f.cleanup);const good=fixture();t.after(good.cleanup);
 const badPricing='export function lineTotal(a:number,b:number){return a;}';
 const goodPricing='export function lineTotal(a:number,b:number){if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<=0||b<=0||!Number.isSafeInteger(a*b))throw Error("invalid");return a*b;}';
 const badOrder=`import type {IWorldChecker} from '../generated/ports.js';import {lineTotal} from './pricing.js';export function fulfill(c:IWorldChecker,a:number,b:number,dispatch:()=>void){const n=lineTotal(a,b);if(!c.step({transitionId:'DISPATCH_GOODS',proposedDirective:'INVOKE_LOGISTICS_DISPATCH'}).allowed)throw Error('denied');dispatch();return n;}`;
 const goodOrder=`import type {IWorldChecker} from '../generated/ports.js';import {lineTotal} from './pricing.js';export function fulfill(c:IWorldChecker,a:number,b:number,dispatch:()=>void){const n=lineTotal(a,b);if(n!==c.getContext().order_amount)throw Error('amount');for(const req of [{transitionId:'INITIATE_PAYMENT',proposedDirective:'DISPATCH_PAYMENT_GATEWAY'},{transitionId:'CONFIRM_PAYMENT',eventPayload:{captured_amount:n}},{transitionId:'DISPATCH_GOODS',proposedDirective:'INVOKE_LOGISTICS_DISPATCH'}] as const)if(!c.step(req).allowed)throw Error('denied');try{dispatch()}catch(e){c.rollbackLastStep();throw e}return n;}`;
 for(const [x,pricing,order] of [[f,badPricing,badOrder],[good,goodPricing,goodOrder]] as const){writeFileSync(join(x.source,'package.json'),'{"type":"module"}');writeFileSync(join(x.source,'src/pricing.ts'),pricing);writeFileSync(join(x.source,'src/order.ts'),order);}
 const commands=['typecheck','functional'].map(id=>{const program=join(f.host,id+'.cjs');copyFileSync(join(scripts,id+'.cjs'),program);return {id,executable:process.execPath,argv:[program,'<candidate>',resolve('node_modules/typescript/bin/tsc'),resolve('.')],cwd:f.host,programDigest:d(readFileSync(program,'utf8')),failureKind:id==='typecheck'?'compile':'functional',resultProtocol:'exit-v1'};});
 const input=join(f.host,'input.json');writeFileSync(input,JSON.stringify({policy:{verifiers:commands}}));
 return {f,good,input,commands};
}
test('host preflight proves known reference PASS5 and original actual assertion failures with no backend',t=>{
 const {f,good,input}=setup(t);const out=join(f.host,'preflight');
 const r=spawnSync(process.execPath,[join(scripts,'preflight.mjs'),input,f.source,good.source,out],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr+r.stdout+(existsSync(join(out,'reference-typecheck.stdout'))?readFileSync(join(out,'reference-typecheck.stdout'),'utf8'):''));const receipt=JSON.parse(readFileSync(join(out,'preflight.json'),'utf8'));
 assert.equal(receipt.status,'PASS');assert.equal(receipt.modelInvocations,0);assert.equal(receipt.checks.length,4);assert.equal(f.exists('launches'),false);
});
for(const fault of ['cwd','output','tool'])test(`host preflight ${fault} blocks with zero backend`,t=>{
 const {f,good,input,commands}=setup(t);
 if(fault==='cwd')commands[1]!.cwd=good.host;
 if(fault==='tool')commands[0]!.argv[2]=join(f.host,'missing-tsc');
 if(fault==='output'){const p=commands[1]!.argv[0]!;const code=readFileSync(p,'utf8').replace('dist/pricing.js','dist/src/pricing.js');assert.notEqual(code,readFileSync(p,'utf8'));writeFileSync(p,code);commands[1]!.programDigest=d(code);}
 writeFileSync(input,JSON.stringify({policy:{verifiers:commands}}));const out=join(f.host,'preflight');
 const r=spawnSync(process.execPath,[join(scripts,'preflight.mjs'),input,f.source,good.source,out],{encoding:'utf8'});
 assert.equal(r.status,86,r.stderr+r.stdout);assert.equal(JSON.parse(readFileSync(join(out,'preflight.json'),'utf8')).status,'BLOCKED');assert.equal(f.exists('launches'),false);assert.equal(existsSync(join(f.host,'artifacts')),false);
});
