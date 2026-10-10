import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, readdir, rename, lstat } from 'node:fs/promises';
import { readPiCatalog, runPi } from '../bridge/pi-agent.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCliCommand } from '../bridge/cli.mjs';
import { createPiCliManager, inspectPi, resolvePiExecutable, latestPiRelease } from '../bridge/pi-cli.mjs';
const pkg = '@earendil-works/pi-coding-agent';
const help = '--mode rpc --print --no-tools --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files --no-themes --no-approve --offline --system-prompt --append-system-prompt --extension --tools --model --provider --thinking';
async function directory(t) { const p = await realpath(await mkdtemp(join(tmpdir(), 'reframe-pi-cli-'))); t.after(() => rm(p, { recursive: true, force: true })); return p; }
async function binary(path) { await mkdir(dirname(path), {recursive:true}); await writeFile(path, '#!/bin/sh\nexit 0\n', {mode:0o700}); return path; }
async function packageAt(root, version) { const p = join(root, 'node_modules', pkg); await binary(join(p, 'dist/cli.js')); await writeFile(join(p, 'package.json'), JSON.stringify({name:pkg,version,bin:{pi:'dist/cli.js'}})); return join(p, 'dist/cli.js'); }
async function npmAt(bin) { const p=join(bin,'../npm-package'); await binary(join(p,'bin/npm-cli.js')); await writeFile(join(p,'package.json'),JSON.stringify({name:'npm'})); await mkdir(bin,{recursive:true}); await symlink(join(p,'bin/npm-cli.js'),join(bin,'npm')); }
async function settled(m) { const until = Date.now()+5000; while(m.busy && Date.now()<until) await new Promise(r=>setTimeout(r,5)); assert.equal(m.busy,false); return m.status(); }
async function fixture(t, hooks = {}) {
  const dataDir = await directory(t), env = {PATH:''}; let version = '0.85.0', fail = false, invalid = false, verifyFail = false, resets = 0;
  const commands=[];
  const run=async(file,args,options)=>{ commands.push({file,args,options}); if(args.includes('install')) { if(fail) throw Error('install failed'); const prefix=args[args.indexOf('--prefix')+1]; await packageAt(prefix,version); await mkdir(join(prefix,'npm-cache'),{recursive:true}); await writeFile(join(prefix,'npm-cache/download'),'cached package'); await hooks.afterInstall?.(prefix); return ''; } if(args.includes('--help')) return invalid?'unrelated CLI':help; const p=JSON.parse(await readFile(join(dirname(dirname(args[0])), 'package.json'),'utf8')); return p.version; };
  const m=createPiCliManager({dataDir,env,run,verify:async options=>{if(verifyFail)throw Error('RPC incompatible'); await hooks.afterVerify?.(options);},onUpdated:async()=>{resets++; await hooks.afterUpdated?.();},inspect:async()=>{const found=await inspectPi({dataDir,env,run}); return hooks.inspect?hooks.inspect(found):found;},latest:async()=>version,runtime:async()=>({node:process.execPath,npm:'/trusted/npm-cli.js',version:'22.19.0'})});
  t.after(()=>m.close()); return {m,dataDir,env,commands,resets:()=>resets,setVersion:v=>version=v,setFail:v=>fail=v,setInvalid:v=>invalid=v,setVerifyFail:v=>verifyFail=v};
}
test('user can install missing Pi from its fixed registry and rediscover it after restart',async t=>{
  // Given Pi is missing and a supported Node/npm runtime is available.
  const f=await fixture(t); assert.equal((await f.m.status()).canInstall,true);
  // When installation finishes and a new detector reads the managed directory.
  await f.m.install(); const state=await settled(f.m); const detected=await inspectPi({dataDir:f.dataDir,env:f.env,run:async()=> '0.85.0'});
  // Then the verified package is active and only fixed-source, script-free npm arguments ran.
  assert.equal(state.operation.status,'completed'); assert.equal(detected.source,'managed'); assert.equal(detected.version,'0.85.0');
  const install=f.commands.find(c=>c.args.includes('install')); assert.ok(install.args.includes(`${pkg}@0.85.0`)); assert.ok(install.args.includes('--ignore-scripts')); assert.ok(install.args.includes('--registry=https://registry.npmjs.org')); assert.equal(install.options.env.NODE_OPTIONS,undefined);
  assert.equal((await resolvePiExecutable(f.env,f.dataDir)).executable,detected.executable);
});
test('user keeps the old managed Pi when download or compatibility verification fails',async t=>{
  // Given a working managed Pi and an available newer release.
  const f=await fixture(t); await f.m.install(); await settled(f.m); const before=await resolvePiExecutable(f.env,f.dataDir); f.setVersion('0.86.0');
  // When installation fails, or the candidate lacks required CLI flags.
  for(const mode of ['download','help','rpc']) { f.setFail(mode==='download'); f.setInvalid(mode==='help'); f.setVerifyFail(mode==='rpc'); await f.m.update(); const state=await settled(f.m);
  // Then the existing executable and version remain usable and the failure is visible.
    assert.equal(state.operation.status,'failed'); assert.equal(state.version,'0.85.0'); assert.deepEqual(await resolvePiExecutable(f.env,f.dataDir),before); }
});
test('user updates managed Pi only after verification and receives model invalidation',async t=>{
  // Given an installed managed version and a newer stable release.
  const f=await fixture(t); await f.m.install(); await settled(f.m); f.setVersion('0.86.0');
  // When the update succeeds.
  await f.m.update(); const state=await settled(f.m);
  // Then discovery points to the new verified version.
  assert.equal(state.version,'0.86.0'); assert.equal(state.operation.status,'completed'); assert.equal(f.resets(),2); assert.equal(state.canUpdate,false);
});
test('user cannot overwrite a custom or App Pi nor bypass an explicit missing PI_BIN',async t=>{
  // Given explicit custom, App, or missing binary paths.
  const f=await fixture(t);
  for(const path of [await binary(join(f.dataDir,'custom/pi')),await binary(join(f.dataDir,'Pi.app/Contents/Resources/pi')),join(f.dataDir,'absent')]) {
    const m=createPiCliManager({dataDir:f.dataDir,env:{PATH:'',PI_BIN:path},run:async()=> '0.84.2',latest:async()=> '0.85.0'});
    // When the user checks and requests installation or update.
    const state=await m.check();
    // Then unsupported locations are never modified or replaced by a managed fallback.
    assert.equal(state.canInstall,false); assert.equal(state.canUpdate,false); await assert.rejects(m.install()); await assert.rejects(m.update()); m.close();
  }
});
test('user cannot start concurrent Pi operations and closing cancels before activation',async t=>{
  // Given an installation whose package process waits for cancellation.
  const dataDir=await directory(t); let started; const ready=new Promise(r=>started=r);
  const m=createPiCliManager({dataDir,env:{PATH:''},runtime:async()=>({node:process.execPath,npm:'/trusted/npm-cli.js',version:'22.19.0'}),latest:async()=> '0.85.0',run:async(_f,_a,{signal})=> { started(); await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true})); }});
  // When the first operation is active, another request arrives and the service closes.
  await m.install(); await ready; await assert.rejects(m.install(),/正在/); m.close(); const state=await settled(m);
  // Then the second request is rejected and no candidate becomes the active CLI.
  assert.equal(state.operation.status,'failed'); assert.equal(await resolvePiExecutable({PATH:''},dataDir),null); assert.deepEqual(await readdir(join(dataDir,'runtime/cli/pi')),[]);
});
test('user sees only validated registry versions and runtime incompatibility prevents installation',async t=>{
  // Given a registry response with the wrong package identity or a too-old Node runtime.
  const dataDir=await directory(t); let url;
  await assert.rejects(latestPiRelease(async u=>{url=u;return {ok:true,json:async()=>({name:'other',version:'1.0.0'})};}));
  const m=createPiCliManager({dataDir,env:{PATH:''},runtime:async()=>({node:process.execPath,npm:'/npm',version:'22.18.0'}),latest:async()=> '0.85.0'});
  // When installation eligibility is checked.
  const state=await m.status();
  // Then only the fixed registry was queried and an unsupported runtime cannot install Pi.
  assert.equal(url,'https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/latest'); assert.equal(state.canInstall,false); assert.match(state.reason,/22.19/); await assert.rejects(m.install()); m.close();
});
test('user can natively update the original npm prefix even when the current npm default differs',async t=>{
  // Given the official Pi package and npm runtime have distinct verified package layouts.
  const root=await directory(t), prefix=join(root,'prefix'), entry=await packageAt(join(prefix,'lib'),'0.84.2'); await binary(join(prefix,'bin/node')); await npmAt(join(prefix,'bin')); await symlink(entry,join(prefix,'bin/pi'));
  const env={PI_BIN:join(prefix,'bin/pi'),PATH:''}, calls=[];
  const run=async(file,args)=>{calls.push(args);return args.includes('update')?'--self --no-approve':args[0]==='--version'?(file.endsWith('/node')?'v22.19.0':'0.84.2'):'/different/default';};
  // When discovery checks the native self-update capability instead of requiring npm's default prefix.
  const state=await inspectPi({env,run,dataDir:root});
  // Then the original npm installation is eligible and has not executed an upgrade command.
  assert.equal(state.source,'npm'); assert.equal(state.manager,join(prefix,'bin/npm')); assert.equal(state.prefix,prefix); assert.equal(state.nativeUpdate,true);
  assert.ok(calls.some(args=>args.includes('update')&&args.includes('--help'))); assert.ok(calls.every(args=>!args.includes('--self')));
});

test('user can use a verified npm manager from a separate Node installation',async t=>{
  // Given Pi lives in a user prefix while npm and Node live in a separate PATH directory.
  const root=await directory(t), prefix=join(root,'pi-prefix'), bin=join(root,'node-bin');
  const entry=await packageAt(join(prefix,'lib'),'0.84.2'); await mkdir(join(prefix,'bin')); await symlink(entry,join(prefix,'bin/pi'));
  await binary(join(bin,'node')); await npmAt(bin);
  // When discovery proves that this npm owns the Pi prefix and its Node is supported.
  const state=await inspectPi({dataDir:root,env:{PI_BIN:join(prefix,'bin/pi'),PATH:bin},run:async(file,args)=>args.includes('update')?'--self --no-approve':args[0]==='prefix'?prefix:file.endsWith('/node')?'v22.19.0':'0.84.2'});
  // Then the actual npm owns updates without assuming every executable lives in the Pi prefix.
  assert.equal(state.source,'npm'); assert.equal(state.manager,join(bin,'npm')); assert.equal(state.node,join(bin,'node'));
});
test('user updates a proven npm Pi in place and loses stale model trust after a partial failure',async t=>{
  // Given an existing npm Pi, with the package manager able to partially replace its version.
  const dataDir=await directory(t); let version='0.84.2',resets=0,fail=false; const calls=[];
  const m=createPiCliManager({dataDir,env:{PATH:'/node/bin',NODE_OPTIONS:'secret',npm_config_registry:'https://untrusted.invalid'},
    inspect:async()=>({installed:true,version,source:'npm',nativeUpdate:true,executable:'/prefix/bin/pi',manager:'/node/bin/npm',node:'/node/bin/node',prefix:'/prefix',managerEnv:{PATH:'/node/bin',TOKEN:'secret'}}),
    latest:async()=>version==='0.84.2'?'0.85.0':'0.86.0',onUpdated:async()=>{resets++;},verify:async()=>{},
    run:async(file,args,options)=>{calls.push({file,args,options});if(args.includes('--help'))return help;if(args.includes('--version'))return version;version=fail?'0.85.1':'0.85.0';if(fail)throw Error('partial failure');}});
  // When one update succeeds and the following npm process fails after replacing files.
  await m.update(); const first=await settled(m); fail=true; await m.update(); const second=await settled(m);
  // Then the fixed package stays in its original prefix, the failure is visible, and both changes invalidate models.
  assert.equal(first.operation.status,'completed'); assert.equal(second.operation.status,'failed'); assert.equal(second.version,'0.85.1'); assert.equal(resets,2);
  assert.equal(calls[0].file,'/node/bin/node'); assert.deepEqual(calls[0].args,['/prefix/bin/pi','update','--self','--no-approve']);
  assert.equal(first.instructions.command,"'/prefix/bin/pi' update --self --no-approve");
  assert.equal(calls[0].options.env.npm_config_registry,'https://registry.npmjs.org'); assert.equal(calls[0].options.env.npm_config_ignore_scripts,'true'); assert.equal(calls[0].options.env.npm_config_engine_strict,'true');
  assert.notEqual(calls[0].options.env.HOME,process.env.HOME); assert.equal(await readFile(calls[0].options.env.npm_config_userconfig,'utf8').catch(()=> 'cleaned'),'cleaned');
  assert.equal(calls[0].options.env.TOKEN,undefined); assert.equal(calls[0].options.env.NODE_OPTIONS,undefined); assert.match(calls[0].options.env.PI_CODING_AGENT_DIR,/release-/); m.close();
});
test('user keeps explicit Pi selection ahead of an existing managed installation',async t=>{
  // Given both a managed Pi and an explicitly selected custom executable.
  const f=await fixture(t); await f.m.install(); await settled(f.m); const custom=await binary(join(f.dataDir,'chosen/pi'));
  // When resolution occurs with PI_BIN or the managed pointer is tampered outside its private root.
  const explicit=await resolvePiExecutable({...f.env,PI_BIN:custom},f.dataDir);
  await writeFile(join(f.dataDir,'runtime/cli/pi/current.json'),JSON.stringify({release:'../../outside',version:'0.85.0'}));
  // Then the explicit choice wins and an invalid managed path fails without PATH fallback.
  assert.equal(explicit.executable,custom); await assert.rejects(resolvePiExecutable(f.env,f.dataDir),/安装记录/);
});


test('user runs Pi tasks and reads the model catalog from the same installed data directory',async t=>{
  // Given Pi was installed into an isolated service data directory and no explicit binary is selected.
  const f=await fixture(t); await f.m.install(); await settled(f.m); const installed=await resolvePiExecutable(f.env,f.dataDir);
  await writeFile(installed.executable, `process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',s=>{text+=s;if(process.argv.includes('rpc')){for(const line of text.trim().split('\\n')){const req=JSON.parse(line);console.log(JSON.stringify({type:'response',id:req.id,success:true,data:req.type==='get_state'?{model:{id:'vision',provider:'test'}}:{models:[{id:'vision',provider:'test',input:['image']}]}}));}text='';}});process.stdin.on('end',()=>{if(!process.argv.includes('rpc'))console.log(JSON.stringify({type:'message_end',message:{role:'assistant',provider:'test',model:'vision',stopReason:'stop',content:[{type:'text',text:'OK'}]}}));});`);
  const prior=process.env.PI_BIN; delete process.env.PI_BIN; t.after(()=>{if(prior!==undefined)process.env.PI_BIN=prior;});
  // When model discovery and a probe receive the service's explicit data directory.
  const catalog=await readPiCatalog(f.dataDir,f.dataDir); const result=await runPi({input:[],probe:true,dataDir:f.dataDir,modelSettings:{model:'test/vision',accountKey:catalog.accountKey}});
  // Then both operations use the newly installed CLI and agree on its account fingerprint.
  assert.equal(catalog.models[0].model,'test/vision'); assert.equal(result.text,'OK');
});

test('user sees background Pi update checks at most daily and cannot install after closing a pending check',async t=>{
  // Given an installed Pi and a pending release query in a separate missing-Pi manager.
  let time=100000,calls=0; const dataDir=await directory(t);
  const m=createPiCliManager({dataDir,now:()=>time,inspect:async()=>({installed:true,version:'0.84.2',source:'custom',executable:'/pi'}),runtime:async()=>null,latest:async()=>{calls++;return '0.85.0';}});
  // When repeated status requests occur before and after a day, and a pending install is closed.
  await m.status(); await new Promise(r=>setImmediate(r)); await m.status(); assert.equal(calls,1); time+=86400000; await m.status(); await new Promise(r=>setImmediate(r));
  let release,started; const ready=new Promise(r=>started=r);
  const pending=createPiCliManager({dataDir,env:{PATH:''},runtime:async()=>({node:process.execPath,npm:'/npm',version:'22.19.0'}),latest:async()=>{started();return new Promise(r=>release=r);},run:()=>assert.fail('closed manager must not install')});
  const request=pending.install(); await ready; pending.close(); release('0.85.0');
  // Then queries are bounded to once daily and closing prevents any package process from starting.
  assert.equal(calls,2); await assert.rejects(request,/停止/); assert.equal(pending.busy,false); m.close();
});


test('user loses npm Pi model trust after cancelled or failed native updates even without a version change',async t=>{
  // Given an existing npm Pi whose native updater can fail or wait for cancellation without changing its version.
  for (const mode of ['failed','cancelled','timeout']) {
    const dataDir=await directory(t); let resets=0,started; const ready=new Promise(r=>started=r);
    const m=createPiCliManager({dataDir,env:{PATH:''},runtime:async()=>null,latest:async()=> '0.85.0',
      inspect:async()=>({installed:true,version:'0.84.2',source:'npm',nativeUpdate:true,executable:'/prefix/bin/pi',manager:'/runtime/npm',node:'/runtime/node',prefix:'/prefix',managerEnv:{PATH:''}}),
      onUpdated:async()=>{resets++;},run:async(_file,args,{signal})=>{assert.deepEqual(args,['/prefix/bin/pi','update','--self','--no-approve']); started(); if(mode!=='cancelled')throw Error(mode); await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));}});
    // When the native process starts and then errors or the service closes.
    await m.update(); await ready; if(mode==='cancelled')m.close(); const state=await settled(m);
    // Then unchanged version strings cannot preserve stale model trust and temporary configuration is removed.
    assert.equal(state.operation.status,'failed'); assert.equal(state.version,'0.84.2'); assert.equal(resets,1); assert.deepEqual(await readdir(join(dataDir,'runtime/cli/pi')),[]); m.close();
  }
});

test('user sees native update failures when the actual version, location, or supported interfaces drift',async t=>{
  // Given a native updater reporting success while its resulting installation may be incompatible.
  for (const mode of ['version','path','realpath','prefix','node','npm','help','rpc']) {
    const dataDir=await directory(t); let changed=false,resets=0;
    const m=createPiCliManager({dataDir,env:{PATH:''},runtime:async()=>null,latest:async()=> '0.85.0',onUpdated:async()=>{resets++;},
      inspect:async()=>({installed:true,version:changed?'0.85.0':'0.84.2',source:'npm',nativeUpdate:true,executable:changed&&mode==='path'?'/changed/pi':'/prefix/bin/pi',resolved:changed&&mode==='realpath'?'/changed/cli.js':'/prefix/lib/cli.js',manager:'/runtime/npm',node:'/runtime/node',nodeResolved:changed&&mode==='node'?'/other/node':'/canonical/node',managerResolved:changed&&mode==='npm'?'/other/npm-cli.js':'/canonical/npm-cli.js',prefix:changed&&mode==='prefix'?'/changed':'/prefix',managerEnv:{PATH:''}}),
      verify:async()=>{if(mode==='rpc')throw Error('RPC incompatible');},
      run:async(_file,args)=>{if(args.includes('update')){changed=true;return '';} if(args.includes('--help'))return mode==='help'?'unrelated CLI':help;return mode==='version'?'0.86.0':'0.85.0';}});
    // When native self-update exits successfully and Reframe independently checks the installed CLI.
    await m.update(); const state=await settled(m);
    // Then each mismatch remains a visible failure and invalidates prior verification.
    assert.equal(state.operation.status,'failed'); assert.equal(resets,1);m.close();
  }
});

test('user cannot enable native updates using a forged custom help response or mismatched package entry',async t=>{
  // Given custom binaries advertise all self-update flags, but lack a verified npm package identity or runtime.
  const root=await directory(t),prefix=join(root,'prefix'),entry=await packageAt(join(prefix,'lib'),'0.84.2');await binary(join(prefix,'bin/node'));await npmAt(join(prefix,'bin'));await symlink(entry,join(prefix,'bin/pi'));
  const env={PI_BIN:join(prefix,'bin/pi'),PATH:''};const run=async(file,args)=>args.includes('update')?'--self --no-approve':file.endsWith('/node')?'v22.19.0':'0.84.2';
  // When package identity, bin ownership, or npm's package identity does not match the expected installation.
  for(const mode of ['package','bin','npm']) {
    await writeFile(join(prefix,'lib/node_modules',pkg,'package.json'),JSON.stringify({name:mode==='package'?'pretend-pi':pkg,version:'0.84.2',bin:{pi:mode==='bin'?'dist/other.js':'dist/cli.js'}}));
    if(mode==='bin')await binary(join(prefix,'lib/node_modules',pkg,'dist/other.js'));
    if(mode==='npm')await writeFile(join(prefix,'npm-package/package.json'),JSON.stringify({name:'pretend-npm'}));
    const state=await inspectPi({env,run,dataDir:root});
    // Then self-reported help never grants ownership of an updater.
    assert.equal(state.source,'custom'); assert.equal(state.manager,undefined);
  }
});


test('user cancellation stops an isolated native updater process before cleaning its private configuration',async t=>{
  // Given a synthetic CLI process remains active after publishing readiness; no real Pi or npm is invoked.
  const dataDir=await directory(t), executable=join(dataDir,'native-stub.mjs'),ready=join(dataDir,'ready'); let resets=0;
  await writeFile(executable,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`);
  const m=createPiCliManager({dataDir,env:{PATH:''},runtime:async()=>null,latest:async()=> '0.85.0',run:runCliCommand,onUpdated:async()=>{resets++;},
    inspect:async()=>({installed:true,version:'0.84.2',source:'npm',nativeUpdate:true,executable,manager:'/unused/npm',node:process.execPath,prefix:'/unused',managerEnv:{PATH:''}})});
  t.after(()=>m.close());
  // When readiness is observed with a bounded deadline, closing the manager cancels the native process.
  await m.update(); const deadline=Date.now()+5000;let pid;
  while(Date.now()<deadline&&!pid){pid=Number(await readFile(ready,'utf8').catch(()=>''));if(!pid)await new Promise(r=>setTimeout(r,10));}
  assert.ok(pid,'synthetic updater must become ready before cancellation');m.close();const state=await settled(m);
  // Then the real child is stopped, prior model trust is invalidated and temporary settings are removed.
  assert.equal(state.operation.status,'failed');assert.equal(resets,1);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.deepEqual(await readdir(join(dataDir,'runtime/cli/pi')),[]);
});

test('user retains automatic updates for legacy npm Pi only when the verified manager owns the original prefix',async t=>{
  // Given an official legacy Pi package without native self-update flags and a verified npm runtime.
  const root=await directory(t),prefix=join(root,'prefix'),entry=await packageAt(join(prefix,'lib'),'0.80.0');await binary(join(prefix,'bin/node'));await npmAt(join(prefix,'bin'));await symlink(entry,join(prefix,'bin/pi'));
  const env={PI_BIN:join(prefix,'bin/pi'),PATH:''};let npmPrefix=prefix;
  const run=async(file,args)=>args.includes('update')?'update extensions':args.includes('prefix')?npmPrefix:file.endsWith('/node')?'v22.19.0':'0.80.0';
  // When npm's default prefix matches, then changes to a different existing directory.
  const good=await inspectPi({env,run,dataDir:root});npmPrefix=root;const bad=await inspectPi({env,run,dataDir:root});
  // Then only the original verified prefix retains the legacy updater; self-reported capabilities are unnecessary.
  assert.equal(good.source,'npm');assert.equal(good.nativeUpdate,false);assert.equal(good.npmPrefixVerified,true);assert.equal(good.manager,join(prefix,'bin/npm'));
  assert.equal(good.managerResolved,await realpath(join(prefix,'bin/npm')));assert.equal(good.nodeResolved,await realpath(join(prefix,'bin/node')));
  assert.equal(bad.manager,undefined);assert.equal(bad.nativeUpdate,false);assert.match(bad.reason,/prefix/);
});

test('user updates legacy Pi with a fixed npm command and clears trust after unsuccessful writes',async t=>{
  // Given a legacy Pi with proven npm-prefix ownership and canonical npm/Node paths.
  for(const mode of ['success','failure','cancel']) {
    const dataDir=await directory(t);let version='0.80.0',resets=0,started;const ready=new Promise(r=>started=r),calls=[];
    const m=createPiCliManager({dataDir,env:{PATH:'',TOKEN:'secret'},runtime:async()=>null,latest:async()=> '0.85.0',onUpdated:async()=>{resets++;},verify:async()=>{},
      inspect:async()=>({installed:true,version,source:'npm',nativeUpdate:false,npmPrefixVerified:true,executable:'/prefix/bin/pi',prefix:'/prefix',manager:'/links/npm',managerResolved:'/canonical/npm/bin/npm-cli.js',node:'/links/node',nodeResolved:'/canonical/node',managerEnv:{PATH:''}}),
      run:async(file,args,options)=>{calls.push({file,args,options});if(args.includes('--help'))return help;if(args.includes('--version'))return version;started();if(mode==='failure')throw Error('npm write failed');if(mode==='cancel')await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));version='0.85.0';return '';}});
    t.after(()=>m.close());
    // When the fixed fallback installer succeeds, fails without a version change, or is cancelled after starting.
    await m.update();if(mode==='cancel'){await ready;m.close();}const state=await settled(m);
    // Then only the original prefix and pinned official release are targeted with protected configuration.
    assert.equal(state.operation.status,mode==='success'?'completed':'failed');assert.equal(resets,1);
    assert.equal(calls[0].file,'/canonical/node');assert.deepEqual(calls[0].args.slice(0,6),['/canonical/npm/bin/npm-cli.js','install','--global','--prefix','/prefix',`${pkg}@0.85.0`]);
    for(const flag of ['--registry=https://registry.npmjs.org','--ignore-scripts','--engine-strict','--no-audit','--no-fund','--package-lock=false','--save=false'])assert.ok(calls[0].args.includes(flag));
    assert.equal(calls[0].options.env.TOKEN,undefined);assert.ok(calls[0].args.some(a=>a.startsWith('--userconfig=')));assert.ok(calls[0].args.some(a=>a.startsWith('--globalconfig=')));assert.ok(calls[0].args.some(a=>a.startsWith('--cache=')));assert.deepEqual(await readdir(join(dataDir,'runtime/cli/pi')),[]);
  }
});


test('user cannot start a Pi update after the verified Node or npm target changes',async t=>{
  // Given either native or legacy npm update eligibility was checked against stable canonical runtime paths.
  for(const nativeUpdate of [true,false])for(const key of ['nodeResolved','managerResolved']) {
    const dataDir=await directory(t);let inspections=0,resets=0;
    const m=createPiCliManager({dataDir,env:{PATH:''},runtime:async()=>null,latest:async()=> '0.85.0',onUpdated:async()=>{resets++;},run:()=>assert.fail('changed runtime must not launch'),
      inspect:async()=>({installed:true,version:'0.80.0',source:'npm',nativeUpdate,npmPrefixVerified:!nativeUpdate,executable:'/prefix/bin/pi',prefix:'/prefix',manager:'/links/npm',managerResolved:'/canonical/npm-cli.js',node:'/links/node',nodeResolved:'/canonical/node',managerEnv:{PATH:''},...(++inspections>1?{[key]:'/changed/runtime'}:{})})});
    // When the final preflight observes a different canonical Node or npm target.
    await m.update();const state=await settled(m);
    // Then no modifying process starts, and unchanged model trust does not require invalidation.
    assert.equal(state.operation.status,'failed');assert.equal(resets,0);m.close();
  }
});


test('user reclaims only obsolete owned Pi releases and download caches after verified updates',async t=>{
  // Given a fresh managed installation and two subsequent stable releases.
  const f=await fixture(t,{afterVerify:async({dir})=>{await mkdir(join(dir,'pi-home')); await writeFile(join(dir,'verification.json'),'{}'); await writeFile(join(dir,'verification-system.txt'),'verification');}}), root=join(f.dataDir,'runtime/cli/pi');
  // When all three installations finish verification, rediscovery and model invalidation.
  for(const version of ['0.85.0','0.86.0','0.87.0']) {
    f.setVersion(version); await f.m[version==='0.85.0'?'install':'update'](); const state=await settled(f.m);
    // Then only the active release remains, its CLI resolves, and its download cache is gone.
    const pointer=JSON.parse(await readFile(join(root,'current.json'),'utf8'));
    assert.equal(state.operation.status,'completed'); assert.equal(state.version,version);
    assert.deepEqual((await readdir(root)).sort(),['current.json',pointer.release].sort());
    assert.equal((await resolvePiExecutable(f.env,f.dataDir)).executable,state.executable);
    await assert.rejects(lstat(join(root,pointer.release,'npm-cache')),{code:'ENOENT'});
    assert.deepEqual((await readdir(join(root,pointer.release))).sort(),['.reframe-managed.json','node_modules']);
  }
});

test('user keeps unmarked, linked and replaced old Pi directories during successful cleanup',async t=>{
  // Given an old installation whose ownership cannot safely be established at deletion time.
  for(const kind of ['unmarked','symlink','replaced']) {
    const hooks={}, f=await fixture(t,hooks); await f.m.install(); await settled(f.m);
    const root=join(f.dataDir,'runtime/cli/pi'), pointer=JSON.parse(await readFile(join(root,'current.json'),'utf8'));
    const old=join(root,pointer.release), external=join(f.dataDir,'preserved-'+kind);
    if(kind==='unmarked') await rm(join(old,'.reframe-managed.json'),{force:true});
    else hooks.afterUpdated=async()=>{
      await rename(old,external);
      if(kind==='symlink') await symlink(external,old);
      else { await mkdir(old); await writeFile(join(old,'.reframe-managed.json'),await readFile(join(external,'.reframe-managed.json')).catch(()=>'{}')); }
    };
    const unrelated=join(root,'release-user'); await mkdir(unrelated); await writeFile(join(unrelated,'keep'),'user data');
    // When a new managed version activates, cleanup cannot claim ownership by a release-* name alone.
    f.setVersion('0.86.0'); await f.m.update(); const state=await settled(f.m);
    // Then the old/foreign entry and any external target survive, while the new CLI works.
    assert.equal(state.operation.status,'completed'); assert.ok(await lstat(old));
    assert.equal(await readFile(join(unrelated,'keep'),'utf8'),'user data');
    if(kind!=='unmarked') assert.ok(await lstat(join(external,'node_modules')));
    assert.equal((await resolvePiExecutable(f.env,f.dataDir)).version,'0.86.0');
  }
});

test('user keeps the old Pi when an update is cancelled before activation',async t=>{
  // Given a managed version and a candidate blocked in its package process.
  const hooks={}, f=await fixture(t,hooks); await f.m.install(); await settled(f.m);
  const before=await resolvePiExecutable(f.env,f.dataDir), ready=Promise.withResolvers(), release=Promise.withResolvers();
  hooks.afterInstall=async()=>{ready.resolve(); await release.promise;};
  f.setVersion('0.86.0'); await f.m.update(); await ready.promise;
  // When the manager is closed before the candidate is activated.
  f.m.close(); release.resolve(); const state=await settled(f.m);
  // Then cancellation preserves the old executable and removes only the unactivated candidate.
  assert.equal(state.operation.status,'failed'); assert.deepEqual(await resolvePiExecutable(f.env,f.dataDir),before);
  assert.equal((await readdir(join(f.dataDir,'runtime/cli/pi'))).filter(name=>name.startsWith('release-')).length,1);
});

test('user keeps the old Pi after activation when rediscovery, invalidation or cancellation prevents completion',async t=>{
  // Given an old verified version and a candidate which reaches the active pointer.
  for(const failure of ['source','executable','invalidation','cancel']) {
    const hooks={}, f=await fixture(t,hooks); await f.m.install(); await settled(f.m);
    const before=await resolvePiExecutable(f.env,f.dataDir);
    if(failure==='source'||failure==='executable') hooks.inspect=found=>found.version==='0.86.0'?{...found,[failure]:failure==='source'?'custom':'/unexpected/pi'}:found;
    if(failure==='invalidation') hooks.afterUpdated=async()=>{throw Error('cannot refresh model catalog');};
    if(failure==='cancel') hooks.afterUpdated=async()=>f.m.close();
    // When post-activation verification or completion fails.
    f.setVersion('0.86.0'); await f.m.update(); const state=await settled(f.m);
    // Then the old installation is retained, and no rollback is claimed for the new active pointer.
    assert.equal(state.operation.status,'failed',failure); assert.ok(await lstat(before.executable));
    assert.equal((await resolvePiExecutable(f.env,f.dataDir)).version,'0.86.0');
  }
});

test('user keeps a verified Pi update successful when unsafe cache cleanup is refused',async t=>{
  // Given a verified candidate whose private cache has been replaced with an external symlink.
  const hooks={}, f=await fixture(t,hooks); await f.m.install(); await settled(f.m);
  const external=join(f.dataDir,'external-cache'); await mkdir(external); await writeFile(join(external,'keep'),'user data');
  hooks.afterUpdated=async()=>{
    const root=join(f.dataDir,'runtime/cli/pi'), pointer=JSON.parse(await readFile(join(root,'current.json'),'utf8'));
    const cache=join(root,pointer.release,'npm-cache'); await rm(cache,{recursive:true}); await symlink(external,cache);
  };
  // When cleanup rejects the unsafe target after the new version has activated.
  f.setVersion('0.86.0'); await f.m.update(); const state=await settled(f.m);
  // Then activation remains successful, the external data survives, and cleanup reports a warning.
  assert.equal(state.operation.status,'completed'); assert.equal(state.version,'0.86.0'); assert.match(state.operation.cleanupWarning,/清理/);
  assert.equal(await readFile(join(external,'keep'),'utf8'),'user data');
});

test('user retains both Pi installations when the active pointer changes before cleanup',async t=>{
  // Given an old managed version and a candidate that reaches model invalidation.
  const hooks={}, f=await fixture(t,hooks); await f.m.install(); await settled(f.m);
  const root=join(f.dataDir,'runtime/cli/pi'), oldPointer=await readFile(join(root,'current.json'),'utf8');
  const before=await resolvePiExecutable(f.env,f.dataDir); let candidate;
  hooks.afterUpdated=async()=>{
    assert.equal(f.m.busy,true);
    candidate=JSON.parse(await readFile(join(root,'current.json'),'utf8')).release;
    await writeFile(join(root,'current.json'),oldPointer);
  };
  // When another actor restores the previous pointer before cleanup starts.
  f.setVersion('0.86.0'); await f.m.update(); const state=await settled(f.m);
  // Then cleanup is refused without failing the verified installation or deleting either release.
  assert.equal(state.operation.status,'completed'); assert.match(state.operation.cleanupWarning,/清理/);
  assert.deepEqual(await resolvePiExecutable(f.env,f.dataDir),before);
  assert.ok(await lstat(join(root,candidate,'node_modules')));
  for(const name of ['npm-cache','npm-user','npm-global']) assert.ok(await lstat(join(root,candidate,name)));
});
