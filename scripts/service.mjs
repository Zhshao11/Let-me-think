// macOS user service. Credentials stay in the application's ignored .env.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';

const exec=promisify(execFile);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const label='local.let-me-think';
const domain='gui/'+process.getuid?.();
const service=domain+'/'+label;
const agentFile=path.join(os.homedir(),'Library','LaunchAgents',label+'.plist');
const logs=path.join(root,'data','logs');
const origin='http://127.0.0.1:8787';
const command=process.argv[2]??'status';
const run=(...args)=>exec('/bin/launchctl',args,{timeout:15000,maxBuffer:1024*1024});
const xml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
async function info(){try{return (await run('print',service)).stdout;}catch{return null;}}
function health(){
  return new Promise(resolve=>{
    const request=http.get(origin+'/api/config',response=>{
      let data='';response.setEncoding('utf8');
      response.on('data',part=>{data+=part;});
      response.on('end',()=>{try{const value=JSON.parse(data);resolve(response.statusCode===200&&value.model==='gpt-6.1-sol'&&typeof value.configured==='boolean');}catch{resolve(false);}});
      response.on('error',()=>resolve(false));
    });
    request.setTimeout(1500,()=>request.destroy());request.on('error',()=>resolve(false));
  });
}
async function waitHealthy(){
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){if(await health())return;await pause(300);}
  throw new Error('服务尚未就绪，请查看 '+path.join(logs,'service.error.log'));
}
function portOpen(){return new Promise(resolve=>{
  const socket=net.connect({host:'127.0.0.1',port:8787});
  socket.setTimeout(1500);const finish=value=>{socket.destroy();resolve(value);};
  socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.once('timeout',()=>finish(false));
});}
async function install(){
  const loaded=await info();
  if(!loaded&&await portOpen())throw new Error('8787 端口已有其他启动的进程；请先停止旧进程，再安装常驻服务。');
  const stableNode=process.execPath.startsWith('/opt/homebrew/Cellar/')&&fs.existsSync('/opt/homebrew/bin/node')?'/opt/homebrew/bin/node':process.execPath;
  const searchPath=[path.dirname(stableNode),path.join(os.homedir(),'.local','bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'].join(':');
  fs.mkdirSync(path.dirname(agentFile),{recursive:true});fs.mkdirSync(logs,{recursive:true,mode:0o700});
  for(const name of ['service.log','service.error.log']){const file=path.join(logs,name);fs.closeSync(fs.openSync(file,'a',0o600));fs.chmodSync(file,0o600);}
  const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(stableNode)}</string><string>${xml(path.join(root,'server.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(searchPath)}</string><key>HOST</key><string>127.0.0.1</string><key>PORT</key><string>8787</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>ExitTimeOut</key><integer>15</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(logs,'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs,'service.error.log'))}</string>
</dict></plist>
`;
  if(loaded)await run('bootout',service);
  fs.writeFileSync(agentFile,plist,{mode:0o600});fs.chmodSync(agentFile,0o600);
  await run('enable',service);await run('bootstrap',domain,agentFile);
  await waitHealthy();
}
async function status(){
  const state=await info(),healthy=await health();
  const pid=state?.match(/^\s*pid = (\d+)/m)?.[1];
  console.log(JSON.stringify({service:label,loaded:Boolean(state),healthy,pid:pid?Number(pid):null,url:origin,agentFile,logs},null,2));
  if(!healthy)process.exitCode=1;
}
try{
  if(process.platform!=='darwin')throw new Error('常驻服务脚本适用于 macOS；其他系统请使用对应的进程管理器。');
  if(command==='install'){await install();await status();}
  else if(command==='start'){
    if(!await info()){
      if(await portOpen())throw new Error('8787 端口已有其他启动的进程，请先停止旧进程。');
      if(!fs.existsSync(agentFile))await install();
      else {await run('enable',service);await run('bootstrap',domain,agentFile);}
    }else await run('kickstart',service);
    await waitHealthy();await status();
  }
  else if(command==='restart'){
    if(!await info())throw new Error('常驻服务尚未加载，请先运行 npm run service:start。');
    await run('kickstart','-k',service);await waitHealthy();await status();
  }
  else if(command==='stop'){if(await info())await run('bootout',service);console.log('常驻服务已停止；npm run service:start 可重新启动，登录后仍会自动启动。');}
  else if(command==='status')await status();
  else throw new Error('用法：node scripts/service.mjs install|start|restart|stop|status');
}catch(error){console.error(error.message);process.exitCode=1;}
