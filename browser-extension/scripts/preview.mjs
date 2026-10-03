// Visual QA of the built popup; this harness never invokes Codex.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import sharp from "sharp";
import { galleryAsset, gallerySetup, galleryMessages } from "./gallery-preview.mjs";

const port = Number(process.env.PREVIEW_PORT || 43188);
const root = resolve(".output/chrome-mv3");
const result = {
  title: "暖纸底几何叠色",
  observations: [
    "暖米色纸底承托几何色块。",
    "橄榄绿与陶土红形成克制的对比。",
    "轮廓清晰，表面带细微印刷颗粒。",
  ],
  promptZh:
    "以 [SUBJECT] 为主体，提炼为简洁而可辨识的几何形状。采用暖米色纸张底色，大面积橄榄绿色块构成视觉中心，以少量陶土红横向形体形成遮挡与节奏。保留宽松留白，使用平涂色面与轻微纸张颗粒，避免写实立体塑形。",
  promptEn:
    "Depict [SUBJECT] through simple, recognizable geometric forms on warm cream paper. Build a central mass in muted olive green, balanced by a small terracotta shape. Use generous negative space, flat color planes, crisp silhouettes, and subtle paper grain.",
  negativePrompt: "避免镜面高光、强烈渐变和繁复背景。",
  uncertainties: ["无法确定原始制作软件或生成模型。"],
};
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="400"><rect width="320" height="400" fill="#e8e1c9"/><circle cx="160" cy="175" r="95" fill="#5b6f4c"/><rect x="55" y="232" width="210" height="63" fill="#bb6c51"/></svg>';
const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const gallery = Object.fromEntries(await Promise.all(["reference", "subject", "result"].map(async role => [role, `data:image/png;base64,${(await readFile(new URL(`../docs/gallery/watercolor-mug/${role}.png`, import.meta.url))).toString("base64")}`])));
const person = `data:image/png;base64,${(await readFile(new URL("../docs/gallery/watercolor-portrait/subject.png", import.meta.url))).toString("base64")}`;
// Optional local image pair for visual comparison only; never load project records or write assets.
const alignment = await Promise.all([process.env.PREVIEW_INPUT_IMAGE || 'docs/gallery/urban-poster/reference.png', process.env.PREVIEW_RESULT_IMAGE || 'docs/gallery/urban-poster/result.png'].map(async path => {
  const bytes = await readFile(path), metadata = await sharp(bytes).metadata();
  return { image: `data:image/${metadata.format};base64,${bytes.toString('base64')}`, width: metadata.width, height: metadata.height };
}));
const job = {
  id: "preview",
  mode: "style",
  status: "completed",
  stage: "逆向完成",
  createdAt: new Date().toISOString(),
  sourceUrl: "https://example.com/reference",
  capture: "original",
  result,
};

createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403);
      res.end();
      return;
    }
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    res.setHeader("Cache-Control", "no-store");
    if (galleryAsset(path, res)) return;
    if (path === "/hover-preview") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end('<html><head><meta charset="UTF-8"><title>QC-Reframe · 动态避让预览</title></head><body style="margin:0"><iframe title="悬浮避让示例" src="/hover-fixture" style="display:block;width:100%;height:100vh;border:0"></iframe></body></html>');
      return;
    }
    if (path === "/hover-fixture") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<html><head><meta charset="UTF-8"><script src="/preview.js"></script><style>
        body{margin:0;padding:24px;background:#fffaef;color:#141111;font:14px system-ui;min-height:140vh}
        h1{font-size:20px}select{padding:8px;margin-bottom:16px;max-width:100%}
        .card{position:relative;width:min(520px,100%);border-radius:24px;overflow:hidden}
        .card img{display:block;width:100%;height:auto}.card button{position:absolute;border:0;border-radius:24px;padding:14px 18px;font:700 14px system-ui;cursor:pointer}
        .save{right:12px;top:12px;background:#e60023;color:white}.board{left:12px;top:12px;background:#fff}
        .share{bottom:12px;right:12px;background:#fff}.board{display:none}.card[data-layout="crowded"] .board{display:block}
        .card[data-layout="delayed"] .save{display:none}.card[data-layout="delayed"].entered .save{display:block}
        .card[data-layout="small"]{width:95px}.card[data-layout="small"] .save,.card[data-layout="small"] .share{display:none}
        .card[data-layout="blocked"] .save{inset:0;border-radius:0}.status{margin:12px 0}
      </style></head><body><h1>动态避让 · 示例页面</h1><p>仅测试悬浮选图，不调用 Codex</p>
        <label>布局 <select id="layout"><option value="save">右上保存按钮</option><option value="crowded">两侧操作按钮</option><option value="delayed">保存按钮延迟出现</option><option value="small">窄图片</option><option value="blocked">图片被控件占满</option></select></label>
        <div class="card" data-layout="save">${'<div>'.repeat(12)}<img alt="避让测试图" src="${image}">${'</div>'.repeat(12)}<button class="board">我的图板 ▾</button><button class="save">保存</button><button class="share">分享 ↑</button></div>
        <p class="status" role="status">网站按钮尚未点击</p>
        <script>
          const card=document.querySelector('.card');
          document.querySelector('#layout').onchange=e=>{card.dataset.layout=e.target.value;card.classList.remove('entered')};
          let reveal;card.onpointerenter=()=>{reveal=setTimeout(()=>card.classList.add('entered'),600)};
          card.onpointerleave=()=>{clearTimeout(reveal);card.classList.remove('entered')};
          card.querySelectorAll('button').forEach(button=>button.onclick=()=>document.querySelector('.status').textContent='网站按钮可用：'+button.textContent);
        </script><script src="/content-scripts/content.js"></script></body></html>`);
      return;
    }
    if (path === "/panel-preview") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      // Keep installed top-frame extensions from covering the build under test.
      const query = new URL(req.url, "http://127.0.0.1").search || "?state=projects";
      res.end(`<html><head><meta charset="UTF-8"><title>QC-Reframe · 浮层预览</title></head><body style="margin:0"><iframe title="插件浮层示例" src="/content-preview${query.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" style="display:block;width:100%;height:100vh;border:0"></iframe></body></html>`);
      return;
    }
    if (path === "/collection-preview") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      const query = new URL(req.url, "http://127.0.0.1").search.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
      res.end(`<html><head><meta charset="UTF-8"><title>Reframe · 收集交互预览</title></head><body style="margin:0"><iframe title="收集交互示例" src="/content-preview${query}" style="display:block;width:100%;height:100vh;border:0"></iframe></body></html>`);
      return;
    }
    if (path === "/preview.js") {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      res.end(`
        const state = new URLSearchParams(location.search).get('state') || 'result';
        const previewOptions = new URLSearchParams(location.search);
        const motion = previewOptions.get('motion');
        if (motion === 'full' || motion === 'reduce') {
          const nativeMatchMedia = window.matchMedia.bind(window);
          window.matchMedia = query => {
            const media = nativeMatchMedia(query);
            if(query === '(prefers-reduced-motion: reduce)')Object.defineProperty(media,'matches',{value:motion==='reduce'});
            return media;
          };
        }
        if(previewOptions.get('fx')==='unavailable') {
          const nativeGetContext=HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext=function(type,...args){return type.startsWith('webgl')?null:nativeGetContext.call(this,type,...args)};
        }
        const job = ${JSON.stringify(job)};
        if (state === 'running') { job.status='running';job.stage='Codex 正在观察图片…';delete job.result; }
        if (state === 'failed') { job.status='failed';job.error='Codex 连接失败，请检查登录状态后重试';delete job.result; }
        if (state.startsWith('generation') || state==='alignment') {
          job.reenact={basePrompt:'保留图 1 主体，迁移图 2 风格'};
          job.result.promptZh=job.result.promptZh.replace('[SUBJECT]','图 1 的主体');
          job.result.promptEn=job.result.promptEn.replace('[SUBJECT]','the subject in image 1');
          if(state==='generation-completed'||state==='alignment')job.generations=[{id:'preview-generation',createdAt:job.createdAt,prompt:job.result.promptZh,negativePrompt:job.result.negativePrompt,model:'preview-vision',status:'completed',stage:'图片已生成',language:'zh',extension:'png'}];
        }
        const alignment = ${JSON.stringify(alignment)};
        if(state==='alignment') {
          job.mode='recreate';job.instruction='分析参考图的主体、内容、构图、配色、光影与材质，生成可用于文生图的完整提示词。';
          job.result.title='双画布对齐示例';
          job.generations=Array.from({length:Math.min(12,Math.max(1,Number(previewOptions.get('results'))||1))},(_,i)=>({...job.generations[0],id:'alignment-result-'+i}));
        }
        const gallery = ${JSON.stringify(gallery)};
        const template = state==='alignment'?alignment[0].image:state === 'gallery' || state.startsWith('multi') ? gallery.reference : ${JSON.stringify(image)};
        const subject = state === 'gallery' ? gallery.subject : template;
        const projectId='a'.repeat(64), secondId='b'.repeat(64);
        job.projectId=projectId;
        const reenact={...structuredClone(job),id:'reenact-preview',mode:'reenact',reenact:{basePrompt:'只用于主体重演的指令'},generations:[],result:{...job.result,title:'主体重演独立提示词',promptZh:'以主体重演路径的图 1 为主体，按照图 2 重演动作与构图。',promptEn:'Reenact the template with the subject in image 1.'}};
        if(state==='projects'||state==='gallery') {
          job.reenact={basePrompt:'只用于提取风格的指令'};
          job.result.promptZh='以提取风格路径的图 1 为主体，仅迁移图 2 的视觉风格。';
          job.generations=[{id:'preview-generation',createdAt:job.createdAt,prompt:job.result.promptZh,negativePrompt:job.result.negativePrompt,model:'preview-vision',status:'completed',stage:'图片已生成',language:'zh',extension:'png'}];
        }
        if(state==='gallery') {job.result.title='午后，一杯水彩';job.reenact.basePrompt='保留图 1 的主体、结构和构图，仅迁移图 2 的画法。';job.result.promptZh='将图 1 的陶瓷杯完整重绘为水彩插画。保留杯子的形状、右侧把手、原始构图，以及墙面从右上到左下的斜向光影。\\n\\n仅从图 2 提取透明水彩叠染、暖金与蓝灰的冷暖关系、纸张细颗粒及自然晕染边缘。杯身以棕橙和赭色为主，受光面薄洗暖金，暗部叠加克制的蓝灰。\\n\\n保持木桌纹理与落地投影。杯口、把手内缘和接触面保留必要的清晰度，不引入参考图中的人物与装饰。';job.generations[0].prompt=job.result.promptZh;}
        if(state.startsWith('multi')) {
          job.mode='multi-reenact';job.reenact={basePrompt:'让人物手持杯子，重演参考图的姿态与水彩画风。',subjects:[{id:'person',subjectImage:${JSON.stringify(person)},role:'人物',detail:'保留五官、短发与身份特征'},{id:'cup',subjectImage:gallery.subject,role:'物品',detail:'保留杯型、颜色与把手'}]};
          job.result={...job.result,title:'水彩里的日常',promptZh:'图 1 提供人物身份，图 2 提供杯子，图 3 为参考模板。让人物手持杯子，统一水彩画风、透视与光照。',promptEn:'Image 1 provides the person, image 2 the mug, and image 3 the template. Depict the person holding the mug, with unified watercolor style, perspective and lighting.'};
          if(state==='multi-running'){job.status='running';job.stage='正在逆向…';delete job.result;}
          if(state==='multi-failed'){job.status='failed';job.error='示例：连接中断，请重试';delete job.result;}
        }
        if(['style','recreate','reenact'].includes(previewOptions.get('mode')))job.mode=previewOptions.get('mode');
        if(previewOptions.get('keepResult')==='1')job.result=${JSON.stringify(result)};
        if (previewOptions.has('reminder')) {job.id='11111111-1111-4111-8111-111111111111';if(job.generations?.length)job.generations[0].id='22222222-2222-4222-8222-222222222222';}
        if (/^[a-f0-9-]{36}$/.test(previewOptions.get('task') || '')) job.id=previewOptions.get('task');
        if (/^[a-f0-9-]{36}$/.test(previewOptions.get('generation') || '') && job.generations?.length) job.generations[0].id=previewOptions.get('generation');
        const older={...structuredClone(job),id:'older-style',createdAt:'2026-09-01T00:00:00Z',result:{...job.result,title:'早期风格版本',promptZh:'早期版本：保留原始构图，迁移平涂质感。'},generations:[]};
        const projects=[{id:projectId,title:state.startsWith('multi')?'水彩里的日常':state==='gallery'?'午后，一杯水彩':'暖纸底几何模板',createdAt:job.createdAt,updatedAt:job.createdAt,sourceUrl:job.sourceUrl,capture:'original',jobs:state.endsWith('-new')?[]:state==='projects'?[job,reenact,older]:state==='alignment'?[job,older]:[job]},
          {id:secondId,title:'另一个空白项目',createdAt:job.createdAt,updatedAt:job.createdAt,sourceUrl:'https://example.com/second',capture:'original',jobs:[]}];
        if(state==='library') {
          const count=Math.min(1000,Math.max(0,Number(previewOptions.get('count')??61)||0));
          projects.splice(0,projects.length,...Array.from({length:count},(_,index)=>{
            const id=(index+1).toString(16).padStart(64,'0'), createdAt=new Date(Date.now()-index*60000).toISOString();
            const sample={...structuredClone(job),id:'sample-job-'+index,projectId:id,createdAt,result:{...job.result,title:'示例 · '+['水彩静物','几何海报','人物插画'][index%3]+' '+String(index+1).padStart(3,'0')}};
            if(index%3===0)sample.generations=[{id:'sample-generation-'+index,createdAt,status:'completed',stage:'图片已生成',language:'zh',extension:'png'}];
            return {id,title:sample.result.title,createdAt,updatedAt:createdAt,sourceUrl:'https://example.com/sample/'+index,capture:'original',jobs:index%5===4?[]:[sample]};
          }));
        }
        ${gallerySetup}
        let showHiddenProjects=false;
        let visibilityFailed=false, scopeFailed=false;
        if(previewOptions.has('hidden')) projects.slice(0,Number(previewOptions.get('hidden'))||1).forEach(p=>p.hidden=true);
        const visibleProjects=()=>projects.filter(p=>showHiddenProjects||!p.hidden);
        let projectsRevision=1;
        projects.forEach(project=>project.revision='preview-1');
        const touch=(project)=>{projectsRevision++;if(project){project.revision='preview-'+projectsRevision;project.updatedAt=new Date().toISOString();}};
        const summary=(project)=>{
          const {jobs,image,...metadata}=project;
          const completed=jobs.flatMap(job=>(job.generations||[]).filter(g=>g.status==='completed').map(g=>({jobId:job.id,generationId:g.id,createdAt:g.createdAt}))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
          return {...metadata,cover:completed?{jobId:completed.jobId,generationId:completed.generationId}:undefined,busy:jobs.some(j=>j.status==='running'||j.generations?.some(g=>g.status==='running')),jobCount:jobs.length,modes:Object.fromEntries(['style','recreate','reenact','multi-reenact'].flatMap(mode=>{const item=jobs.find(j=>j.mode===mode);return item?[[mode,{status:item.status,hasImage:!!item.generations?.some(g=>g.status==='completed')}]]:[]}))};
        };
        const collected=new Map();
        let failedPage=false;
        const projectPage=async(message)=>{
          if(message.limit>12){
            await new Promise(resolve=>setTimeout(resolve,Math.min(10000,Math.max(0,Number(previewOptions.get('listDelay'))||0))));
            if(!failedPage&&Number(previewOptions.get('failPage'))===message.page){failedPage=true;throw new Error('示例：项目加载失败，请重试');}
          }
          const query=(message.q||'').trim().toLocaleLowerCase();
          const filtered=visibleProjects().filter(p=>(message.status!=='unstarted'||!p.jobs.length)&&[p.title,p.sourceUrl].some(value=>value.toLocaleLowerCase().includes(query))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
          const pageSize=message.limit||24,page=Math.min(Math.max(1,message.page||1),Math.max(1,Math.ceil(filtered.length/pageSize)));
          return {items:filtered.slice((page-1)*pageSize,page*pageSize).map(summary),total:filtered.length,page,pageSize,revision:'preview-'+projectsRevision};
        };
        const selection=(project)=>({id:project.id,projectId:project.id,image:project.image||template,capture:'original',sourceUrl:project.sourceUrl});
        const data={preferences:{token:state==='empty'?'':'preview',mode:previewOptions.get('mode')|| (state==='alignment'?'recreate':state.startsWith('multi')?'multi-reenact':state.startsWith('reenact')?'reenact':'style')},selection:state==='empty'||state==='library'||state==='works'?undefined:selection(projects[0])};
        if(previewOptions.has('reference') && data.selection) {
          data.selection.image='';
          setTimeout(()=>{
            if(previewOptions.get('reference')==='failed')data.selection.error='示例：参考图读取失败';
            else data.selection.image=template;
          },Number(previewOptions.get('referenceDelay'))||5000);
        }
        const handoff = new URLSearchParams(location.search).has('handoff') ? JSON.parse(sessionStorage.getItem('workspace-draft') || 'null') : null;
        if(handoff){projects.splice(0,projects.length,...handoff.projects);Object.assign(data,handoff.data);}
        const findJob=(id)=>projects.flatMap(p=>p.jobs).find(j=>j.id===id);
        const models={accountLabel:'ChatGPT · 预览',selected:state==='models-new'?null:'preview-vision',reasoningEffort:state==='models-new'?undefined:'medium',models:[{model:'preview-vision',label:'Vision Model',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:['low','medium','high','xhigh'].map(reasoningEffort=>({reasoningEffort})),status:state==='models-new'?'unverified':'verified'},{model:'preview-unavailable',label:'Unavailable Model',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],status:'unverified'}]};
        const cli={detectedAt:new Date().toISOString(),installed:true,version:'0.100.0',latestVersion:'0.101.0',executable:'/example/bin/codex',source:'npm',canUpdate:true,updateAvailable:true,command:'npm install -g @openai/codex@latest'};
        if(new URLSearchParams(location.search).get('cli')==='standalone')Object.assign(cli,{source:'standalone',version:'0.159.2',latestVersion:'0.159.2',canUpdate:false,updateAvailable:false,command:'/example/bin/codex update'});
        if(new URLSearchParams(location.search).get('cli')==='custom')Object.assign(cli,{source:'custom',latestVersion:null,canUpdate:false,updateAvailable:false,command:null,reason:'此安装来源无法安全自动升级，请通过原安装方式更新。'});
        const listeners = new Set();
        const notifyMotion = () => listeners.forEach(fn=>fn({type:'alchemy:motion-changed'},{id:'preview'},()=>{}));
        addEventListener('storage',event=>{if(event.key==='preview-motion-preference')notifyMotion();});
        // Match real content-script restrictions: all motion access goes through runtime messages.
        globalThis.chrome = {storage:{local:{
          get:async()=>{throw new Error('Access to storage is not allowed from this context.');},
          set:async()=>{throw new Error('Access to storage is not allowed from this context.');}
        }},runtime:{id:'preview',getManifest:()=>({name:'QC-Reframe preview',version:'0.1.18'}),onMessage:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},sendMessage:async(message)=>{
          if(message.type.startsWith('alchemy:reminder-')) {
            const preferences=JSON.parse(localStorage.getItem('preview-reminders')||'{"sound":false,"tone":"soft","volume":30}');
            if(message.type==='alchemy:reminder-settings')localStorage.setItem('preview-reminders',JSON.stringify(message.preferences));
            if(message.type==='alchemy:reminder-test')return {error:'界面预览不播放声音；请在实际扩展中试听。'};
            const generation=previewOptions.get('reminderTask')==='image'?job.generations?.[0]:undefined;
            const notice={id:generation?.id||job.id,jobId:job.id,projectId,mode:job.mode,generationId:generation?.id,status:(generation||job).status,createdAt:job.createdAt,hidden:!!projects.find(p=>p.id===projectId)?.hidden};
            const readKey='preview-reminder-read:'+ (previewOptions.get('case')||'default')+':'+notice.id;
            if(message.type==='alchemy:reminder-read'&&message.ids?.includes(notice.id)||message.type==='alchemy:reminder-view'&&message.visible&&message.seen?.includes(notice.id))localStorage.setItem(readKey,'true');
            const unread=previewOptions.has('reminder')&&!localStorage.getItem(readKey)?[notice]:[];
            if(message.type==='alchemy:reminder-open') {
              if(message.id!=='all'&&!unread.some(item=>item.id===message.id))return {error:'这条提醒已查看或项目已隐藏，请在任务中心查看。'};
              const target=new URL('/workspace.html',location.origin);
              target.search=new URLSearchParams(previewOptions);
              for(const key of ['tasks','task','generation'])target.searchParams.delete(key);
              if(message.id==='all')target.searchParams.set('tasks','unread');
              else {target.searchParams.set('task',notice.jobId);if(notice.generationId)target.searchParams.set('generation',notice.generationId);}
              window.open(target.href,'_blank');
            }
            const toastKey='preview-reminder-toast:'+readKey;
            return {ok:true,value:{unread,preferences:message.preferences||preferences,desktop:previewOptions.has('notificationDenied')?'denied':'granted',audioSupported:true,connectionError:'',audioError:'',toast:message.type==='alchemy:reminder-view'&&message.visible&&previewOptions.get('reminder')==='toast'&&!sessionStorage.getItem(toastKey)&&(sessionStorage.setItem(toastKey,'true'),true)?unread:undefined}};
          }
          if(message.type==='alchemy:get-motion-preference')return {ok:true,value:localStorage.getItem('preview-motion-preference')||'system'};
          if(message.type==='alchemy:set-motion-preference'){
            if(previewOptions.get('motionSave')==='failed')return {error:'示例：保存失败'};
            localStorage.setItem('preview-motion-preference',message.preference);notifyMotion();return {ok:true};
          }
          if(['alchemy:project-reference','alchemy:reference','alchemy:generation-image'].includes(message.type)&&document.querySelector('.image-preview-dialog[open]')) {
            if(previewOptions.get('imagePreview')==='fail')throw new Error('预览：原图读取失败');
            if(previewOptions.get('imagePreview')==='delay')await new Promise(resolve=>setTimeout(resolve,2500));
          }
          if(message.type==='alchemy:quick-draft'){const key=location.pathname.includes('popup')?'quick-popup':'quick-panel';if(message.context){sessionStorage.setItem(key,JSON.stringify({...message.context,draft:message.draft}));return {ok:true};}return {ok:true,value:JSON.parse(sessionStorage.getItem(key)||'null')};}
          if(message.type==='alchemy:open-workspace'){sessionStorage.setItem('workspace-draft',JSON.stringify({...message.context,draft:message.draft,projects,data}));location.href='/workspace.html?state='+state+'&handoff=preview';return {ok:true};}
          if(message.type==='alchemy:workspace-handoff'){sessionStorage.removeItem('workspace-draft');return {ok:true,value:handoff};}
          if(message.type==='alchemy:upload-reference'){if(new URLSearchParams(location.search).get('swap')==='failed')return {error:'互换失败（预览），请重试'};let p=projects.find(p=>(p.image||template)===message.image);if(!p){p={id:crypto.randomUUID(),title:'上传的参考图',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),sourceUrl:'',capture:'original',jobs:[],image:message.image};projects.unshift(p);touch(p);}data.selection={...selection(p),image:message.image};return {ok:true,value:data.selection};}
          if(message.type==='alchemy:query'&&message.path==='/cli/status')return {ok:true,value:structuredClone(cli)};
          if(message.type==='alchemy:cli-check'){cli.detectedAt=new Date().toISOString();if(cli.command)cli.checkedAt=cli.detectedAt;return {ok:true,value:structuredClone(cli)};}
          if(message.type==='alchemy:cli-update'){cli.operation={status:'running',stage:'正在升级（预览）'};setTimeout(()=>{cli.version=cli.latestVersion;cli.updateAvailable=false;cli.operation={status:'completed',stage:'升级完成（预览）'};models.selected=null;},2500);return {ok:true,value:structuredClone(cli)};}
          if(message.type==='alchemy:connect'){data.preferences.token='preview';return {ok:true,value:{ready:true}};}
          if(message.type==='alchemy:state')return {ok:true,value:structuredClone({preferences:{paired:!!data.preferences.token,mode:data.preferences.mode,showHiddenProjects},selection:!showHiddenProjects&&projects.find(p=>p.id===data.selection?.projectId)?.hidden?undefined:data.selection})};
          if(message.type==='alchemy:models-refresh'||(message.type==='alchemy:query'&&message.path==='/models'))return {ok:true,value:structuredClone(models)};
          if(message.type==='alchemy:model-verify'){
            models.verification={model:message.model,reasoningEffort:message.reasoningEffort,status:'running'};
            setTimeout(()=>{
              if(message.model==='preview-unavailable'){models.verification={model:message.model,reasoningEffort:message.reasoningEffort,status:'failed',error:'该模型当前无法调用，请选择其他模型并验证。'};models.models[1].status='unavailable';}
              else {models.selected=message.model;models.reasoningEffort=message.reasoningEffort;models.models[0].status='verified';models.verification={model:message.model,reasoningEffort:message.reasoningEffort,status:'completed'};}
            },1800);
            return {ok:true,value:structuredClone(models)};
          }
          if(message.type==='alchemy:show-hidden-projects'){
            if(previewOptions.has('scopeDelay'))await new Promise(resolve=>setTimeout(resolve,Math.min(3000,Number(previewOptions.get('scopeDelay'))||0)));
            if(previewOptions.get('scope')==='failed-once'&&!scopeFailed){scopeFailed=true;return {error:'示例：查看范围更新失败，请重试'};}
            showHiddenProjects=message.show;return {ok:true,value:showHiddenProjects};
          }
          if(message.type==='alchemy:set-project-hidden'){
            if(previewOptions.get('visibility')==='failed'||previewOptions.get('visibility')==='failed-once'&&!visibilityFailed){visibilityFailed=true;return {error:'示例：隐藏状态保存失败，请重试'};}
            if(previewOptions.has('visibilityDelay'))await new Promise(resolve=>setTimeout(resolve,Math.min(3000,Number(previewOptions.get('visibilityDelay'))||0)));
            const updated=projects.filter(p=>message.ids.includes(p.id)&&!!p.hidden!==message.hidden);
            if(previewOptions.get('visibility')==='partial')updated.splice(1);
            updated.forEach(p=>{p.hidden=message.hidden;touch(p);});
            return {ok:true,value:{updatedIds:updated.map(p=>p.id),hidden:message.hidden,revision:'preview-'+projectsRevision}};
          }
          if(message.type==='alchemy:projects')return {ok:true,value:await projectPage(message)};
          if(message.type==='alchemy:project'){
            const project=projects.find(p=>p.id===message.id);
            if(!project)return {error:'项目不存在'};
            return {ok:true,value:message.revision===project.revision?{unchanged:true,revision:project.revision}:structuredClone({...summary(project),jobs:project.jobs})};
          }
          if(message.type==='alchemy:project-thumbnail') {
            const project=projects.find(p=>p.id===message.id),cover=!message.reference&&summary(project).cover;
            return {ok:true,value:{image:cover?(state==='alignment'?alignment[1].image:state==='gallery'?gallery.result:template):project.image||template,source:cover?{kind:'generation',jobId:cover.jobId,generationId:cover.generationId}:{kind:'reference'}}};
          }
          ${galleryMessages}
          if(message.type==='alchemy:generation-thumbnail')return {ok:true,value:{image:state==='alignment'?alignment[1].image:state==='gallery'?gallery.result:template,source:{kind:'generation',jobId:message.id,generationId:message.generationId}}};
          if(message.type==='alchemy:query')return {ok:true,value:structuredClone(message.path==='/health'?{ready:true,hiddenProjectIds:projects.filter(p=>p.hidden).map(p=>p.id),visibleActive:visibleProjects().flatMap(p=>p.jobs).reduce((n,j)=>n+Number(j.status==='running')+(j.generations||[]).filter(g=>g.status==='running').length,0),projectsRevision:'preview-'+projectsRevision,skill:'alchemy · 预览',model:models.selected,modelBusy:models.verification?.status==='running',active:models.verification?.status==='running'?1:projects.some(p=>p.jobs.some(j=>j.status==='running'||j.generations?.some(g=>g.status==='running')))?1:0}:message.path==='/jobs'?visibleProjects().flatMap(p=>p.jobs):message.path==='/projects'?visibleProjects().map(summary):message.path.startsWith('/projects/')?structuredClone({...summary(projects.find(p=>p.id===message.path.split('/')[2])),jobs:projects.find(p=>p.id===message.path.split('/')[2]).jobs}):findJob(message.path.split('/')[2]))};
          if(message.type==='alchemy:delete-projects') {
            if(state==='delete-failed')return {error:'本机服务暂时不可用，请重试'};
            if(projects.some(p=>message.ids.includes(p.id)&&summary(p).busy))return {error:'所选项目仍在逆向或生图'};
            await new Promise(resolve=>setTimeout(resolve,500));
            for(let i=projects.length-1;i>=0;i--)if(message.ids.includes(projects[i].id))projects.splice(i,1);
            touch();
            if(message.ids.includes(data.selection?.projectId))data.selection=undefined;
            return {ok:true,value:{deletedIds:message.ids}};
          }
          if(message.type==='alchemy:mode'){data.preferences.mode=message.mode;return {ok:true};}
          if(message.type==='alchemy:project-reference'||message.type==='alchemy:open-project') {
            const next=selection(projects.find(p=>p.id===message.id));
            if(message.type==='alchemy:open-project')data.selection=next;
            return {ok:true,value:next};
          }
          if(message.type==='alchemy:reference') {
            const saved=findJob(message.id);
            return {ok:true,value:{...selection(projects.find(p=>p.id===saved.projectId)),jobId:saved.id,reenact:saved.reenact?(saved.mode==='multi-reenact'?{...saved.reenact,subjects:saved.generations?.at(-1)?.subjects||saved.reenact.subjects}:{...saved.reenact,subjectImage:subject}):undefined,generationSubjectImage:saved.generations?.at(-1)?.subjectImage}};
          }
          if(message.type==='alchemy:start') {
            await new Promise(resolve=>setTimeout(resolve,Math.min(10000,Math.max(0,Number(previewOptions.get('startDelay'))||0))));
            const project=projects.find(p=>p.id===message.projectId);
            const next={id:'preview-'+Date.now(),projectId:project.id,mode:message.mode,status:'running',stage:'正在逆向…',createdAt:new Date().toISOString(),sourceUrl:project.sourceUrl,capture:'original',instruction:message.instruction,reenact:message.reenact?structuredClone(message.reenact):undefined};
            project.jobs.unshift(next);touch(project);data.selection={...selection(project),jobId:next.id,reenact:structuredClone(message.reenact)};
            setTimeout(()=>{if(next.status==='running'){next.status='completed';next.stage='逆向完成';next.result={...${JSON.stringify(result)},title:message.mode+' 新提示词',promptZh:'当前路径 '+message.mode+' 的独立提示词',promptEn:'Use the supplied subjects and reference template.'};touch(project);}},1500);
            return {ok:true,value:{selection:data.selection,job:structuredClone(next)}};
          }
          if(message.type==='alchemy:cancel'){
            await new Promise(resolve=>setTimeout(resolve,Math.min(10000,Math.max(0,Number(previewOptions.get('cancelDelay'))||0))));
            if(previewOptions.get('cancel')==='failed')throw new Error('示例：取消失败，请重试');
            const saved=findJob(message.id);saved.status='cancelled';touch(projects.find(p=>p.id===saved.projectId));return {ok:true,value:structuredClone(saved)};}
          if(message.type==='alchemy:generation-file-action')throw new Error('界面预览不会打开本机文件，请在扩展中使用。');
          if(message.type==='alchemy:generation-reference')return {ok:true,value:{image:findJob(message.id).generations.find(g=>g.id===message.generationId)?.subjectImage||template,subjects:findJob(message.id).generations.find(g=>g.id===message.generationId)?.subjects}};
          if(message.type==='alchemy:generation-image') {
            if(previewOptions.get('fx')==='image-error')throw new Error('预览：图片读取失败');
            return {ok:true,value:{image:state==='alignment'?alignment[1].image:state==='gallery'?gallery.result:template,path:'/example/QC-Reframe/'+message.generationId+'-generated.png',...(state==='alignment'?{width:alignment[1].width,height:alignment[1].height}:state==='gallery'?{}:{width:320,height:400})}};
          }
          if(message.type==='alchemy:save-prompt') {
            const job=findJob(message.id);
            job.result={...job.result,promptZh:message.promptZh,promptEn:message.promptEn,negativePrompt:message.negativePrompt};touch(projects.find(p=>p.id===job.projectId));
            return {ok:true,value:job};
          }
          if(message.type==='alchemy:generate') {
            await new Promise(resolve=>setTimeout(resolve,Math.min(60000,Math.max(0,Number(previewOptions.get('generationStartDelay'))||0))));
            if(previewOptions.get('generationStart')==='failed')return {error:'示例：生成请求提交失败，请重试'};
            const saved=findJob(message.id);
            const generation={id:'preview-'+Date.now(),status:'running',stage:'正在生成图片…',language:message.language,extension:'png',createdAt:new Date().toISOString(),prompt:message.language==='zh'?saved.result.promptZh:saved.result.promptEn,negativePrompt:saved.result.negativePrompt,model:models.selected,subjectImage:message.subjectImage,subjects:message.subjects?structuredClone(message.subjects):undefined,aspectRatio:message.aspectRatio};
            saved.generations||=[];saved.generations.push(generation);touch(projects.find(p=>p.id===saved.projectId));
            setTimeout(()=>{if(generation.status==='running'){
              generation.status=previewOptions.get('fx')==='failed'?'failed':'completed';
              generation.stage=generation.status==='failed'?'预览：生图失败':'图片已生成';
              if(generation.status==='failed')generation.error=generation.stage;
              touch(projects.find(p=>p.id===saved.projectId));
            }},Math.min(60000,Math.max(1000,Number(previewOptions.get('generationDelay'))||5000)));
            return {ok:true,value:structuredClone(saved)};
          }
          if(message.type==='alchemy:generation-cancel') {
            const saved=findJob(message.id), generation=saved.generations.find(item=>item.id===message.generationId);
            generation.status='cancelled';generation.stage='已取消';touch(projects.find(p=>p.id===saved.projectId));return {ok:true,value:structuredClone(saved)};
          }
          if(message.type==='alchemy:collect'){
            if(state==='invalidated')throw new Error('Extension context invalidated.');
            const outcome=document.querySelector('#collect-outcome')?.value||previewOptions.get('collect')||'success';
            await new Promise(resolve=>setTimeout(resolve,outcome==='slow'?4500:800));
            if(outcome==='failed')return {error:'示例：图片读取失败，请重试'};
            const existing=collected.get(message.target.src);
            if(existing)return {ok:true,value:{projectId:existing,created:false}};
            const id=String(projects.length+1).padStart(64,'0'),createdAt=new Date().toISOString();
            const project={id,title:'已收集的示例图片',createdAt,updatedAt:createdAt,sourceUrl:'https://example.com/collected',capture:'original',jobs:[],image:message.target.src};
            projects.unshift(project);touch(project);collected.set(message.target.src,id);
            return {ok:true,value:{projectId:id,created:true}};
          }
          if(message.type==='alchemy:select'){
            if(state==='invalidated')throw new Error('Extension context invalidated.');
            listeners.forEach(fn=>fn({type:'alchemy:show'},{},()=>{}));return {ok:true};
          }
          return {error:'界面预览不会执行逆向，请在扩展中使用。'};
        }}};
      `);
      return;
    }
    if (path === "/content-preview") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><head><meta charset="UTF-8"><script src="/preview.js"></script><style>body{margin:0;padding:28px;background:#fffaef;color:#141111;font:14px/1.6 system-ui}h1{font-size:22px}select{padding:8px;border:1px solid;border-radius:6px;background:#fffdf8;font:inherit}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:24px;max-width:1000px;margin-top:24px}.card img{display:block;width:100%;height:auto;border-radius:16px}.card p{margin:8px 0}button{font:inherit}</style></head><body><h1>收集参考图 · 交互预览</h1><button type="button" onclick="chrome.runtime.sendMessage({type:'alchemy:select'})">打开示例面板</button><p>示例数据，不保存真实图片、不调用 Codex。将鼠标移到图片，点击 Reframe logo，展开图片图标（立即逆向）、加号（加入 Reframe）与分栏窗口（打开工作台）；按钮始终位于图片内。</p><label>模拟结果 <select id="collect-outcome"><option value="success">正常保存</option><option value="slow">慢速保存</option><option value="failed">保存失败</option></select></label><div class="grid">${[image, ...["#27ccf3", "#fe7da8"].map(color => `data:image/svg+xml;base64,${Buffer.from(svg.replaceAll("#5b6f4c", color)).toString("base64")}`)].map((src, index) => `<div class="card"><img width="320" height="400" alt="示例参考图 ${index + 1}" src="${src}"><p>参考图 ${index + 1} · 再次点击可验证去重反馈</p></div>`).join("")}</div><script src="/content-scripts/content.js"></script></body></html>`);
      return;
    }
    const file = resolve(root, "." + (path === "/" ? "/popup.html" : path));
    if (!file.startsWith(root + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    let content = await readFile(file);
    const type =
      {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css",
        ".png": "image/png",
        ".svg": "image/svg+xml",
      }[extname(file)] || "application/octet-stream";
    if (extname(file) === ".html")
      content = Buffer.from(
        content
          .toString()
          .replace(
            "<head>",
            '<head><script src="/preview.js"></script><style>html:not(.workspace-page) body{max-width:400px;margin:0 auto!important;box-shadow:0 0 0 1px #e0e3d9}.workspace-page .workspace-app{height:calc(100dvh - 28px)}#preview-notice{padding:8px 16px;background:#e6ebdc;color:#687959;text-align:center;font:10px system-ui}</style>',
          )
          .replace(
            "<body>",
            '<body><div id="preview-notice">界面预览 · 示例数据 · 不执行逆向</div>',
          ),
      );
    if (path === '/popup.html' && new URL(req.url, 'http://127.0.0.1').searchParams.has('panelClip'))
      content = Buffer.from(content.toString().replace('</head>', '<style>#root{position:fixed;top:12px;right:12px;width:400px;height:620px;overflow:auto;border-radius:20px;background:#fffefa;box-shadow:0 4px 24px #0002}</style></head>'));
    res.writeHead(200, { "Content-Type": type });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("请先运行 npm run build");
  }
}).listen(Number(process.env.PREVIEW_PORT || 43188), "127.0.0.1", () =>
  console.log(
    `UI preview: http://127.0.0.1:${process.env.PREVIEW_PORT || 43188}/?state=result (empty / running / failed / models-new)`,
  ),
);
