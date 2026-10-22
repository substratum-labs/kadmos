// Trusted host adapter; argv is supplied by the host, never by generated Fabric.
const http=require('node:http');
const [port,action,id,mode]=process.argv.slice(2);
if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535||!['apply','query'].includes(action)||!/^[a-zA-Z0-9_-]{1,128}$/.test(id))process.exit(64);
const req=http.request({hostname:'127.0.0.1',port:Number(port),method:'POST',path:`/${action}?id=${encodeURIComponent(id)}&mode=${encodeURIComponent(mode)}`},res=>{
 let body='';res.setEncoding('utf8');res.on('data',s=>{body+=s;if(body.length>4096)res.destroy();});
 res.on('end',()=>{if(res.statusCode===200){process.stdout.write(body);process.exitCode=0;}else if(res.statusCode===409&&mode==='refuse'){process.stdout.write(body);process.exitCode=2;}else process.exitCode=3;});
 res.on('error',()=>{process.exitCode=4;});
});
req.setTimeout(1500,()=>req.destroy(new Error('HTTP timeout')));req.on('error',()=>{process.exitCode=4;});req.end();
