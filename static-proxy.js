'use strict';
const http=require('http'),fs=require('fs'),path=require('path');
const externalPort=process.env.PORT||3000;
const backendPort=process.env.BACKEND_PORT||3001;
process.env.PORT=backendPort;
require('./ibtech/server/server.js');
const root=path.join(__dirname,'ibtech');
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.xml':'application/xml','.txt':'text/plain'};
function proxy(req,res){const r=http.request({hostname:'127.0.0.1',port:backendPort,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:'+backendPort}},br=>{res.writeHead(br.statusCode,br.headers);br.pipe(res)});r.on('error',e=>{res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:e.message}))});req.pipe(r)}
http.createServer((req,res)=>{if(req.url.startsWith('/api/'))return proxy(req,res);if(req.method!=='GET'){res.writeHead(405);return res.end('Method Not Allowed')};let u=req.url.split('?')[0];if(u==='/')u='/index.html';const f=path.normalize(path.join(root,u));if(!f.startsWith(root+path.sep)||!fs.existsSync(f)||!fs.statSync(f).isFile()){res.writeHead(404);return res.end('Not found')};res.writeHead(200,{'Content-Type':mime[path.extname(f).toLowerCase()]||'application/octet-stream'});fs.createReadStream(f).pipe(res)}).listen(externalPort,()=>console.log('IB-TECH web gateway ready'));
