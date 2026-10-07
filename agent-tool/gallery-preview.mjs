// Public artwork and synthetic fixtures for the built gallery's visual QA only.
import { createRequire } from "node:module";
const sharp = createRequire(new URL("../browser-extension/package.json", import.meta.url))("sharp");
import { readFile } from 'node:fs/promises';
const names = ['街头字形海报','水彩咖啡日记','光影人物习作','赤色机甲档案','山野之间','蓝色时刻','无界形状','柔软物质','慢生活手记','白日梦'];
const sizes = [[1049,1499],[1109,1419],[1024,1536],[941,1672],[1600,1000],[1200,1200],[1800,900],[1000,1400],[1600,900],[1200,1200]];
const folders = ['urban-poster','watercolor-mug','watercolor-portrait','red-mecha'];
const originals = await Promise.all(folders.map(name => readFile(new URL(`../browser-extension/docs/gallery/${name}/result.png`, import.meta.url))));
const thumbs = await Promise.all(originals.map(image => sharp(image).resize({width:480,height:480,fit:'inside'}).webp({quality:80}).toBuffer()));
export function galleryAsset(path, res) {
  const match = path.match(/^\/gallery-fixture\/(thumb|original)\/([0-9])$/);
  if (!match) return false;
  const index = Number(match[2]), full = match[1] === 'original';
  if (index < 4) { res.setHeader('Content-Type', full ? 'image/png' : 'image/webp'); res.end(full ? originals[index] : thumbs[index]); }
  else {
    const [width,height] = sizes[index], color = ['#b75536','#142d34','#17457a','#932f55','#637e4b','#6c5ca2'][index-4];
    res.setHeader('Content-Type','image/svg+xml');
    res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1600 1200" preserveAspectRatio="none"><rect width="1600" height="1200" fill="#ede5d4"/><circle cx="1150" cy="370" r="230" fill="#d8a965"/><path d="M-100 1050 Q400 210 820 700T1800 470V1300H-100Z" fill="${color}"/><text x="90" y="360" font-size="150" fill="${color}" font-family="Georgia">${['Quiet forms.','Blue hour.','Beyond.','Soft matter.','Slow living.','Daydream.'][index-4]}</text></svg>`);
  }
  return true;
}
export const gallerySetup = `
  const galleryNames=${JSON.stringify(names)},gallerySizes=${JSON.stringify(sizes)};
  if(state==='works') {
    projects.splice(0,projects.length,...galleryNames.map((title,index)=>({id:(index+1).toString(16).padStart(64,'0'),title,createdAt:job.createdAt,updatedAt:job.createdAt,sourceUrl:'https://example.com/gallery/'+index,capture:'original',jobs:[]})));
    const count=Math.min(10000,Math.max(0,Number(previewOptions.get('count')??36)));
    for(let index=0;index<count;index++) {
      const sample=index*7%10,project=projects[sample],createdAt=new Date(Date.now()-index*60000).toISOString();
      const mode=['recreate','style','reenact','multi-reenact'][index%4];
      project.jobs.push({...structuredClone(job),id:'gallery-job-'+index,projectId:project.id,mode,createdAt,result:{...job.result,title:project.title},generations:[{id:'gallery-generation-'+index,status:'completed',createdAt,language:'zh',extension:'png',stage:'图片已生成',sample}]});
    }
  }
`;
export const galleryMessages = `
  if(message.type==='alchemy:gallery') {
    const visible=visibleProjects(), all=visible.flatMap(project=>{
      const versions=new Map();
      return [...project.jobs].reverse().flatMap(job=>{const version=(versions.get(job.mode)||0)+1;versions.set(job.mode,version);return (job.generations||[]).filter(g=>g.status==='completed').map(g=>{
        const [width,height]=gallerySizes[g.sample??0];return {id:g.id,projectId:project.id,projectTitle:project.title,hidden:!!project.hidden,jobId:job.id,generationId:g.id,mode:job.mode,version,title:job.result.title,createdAt:g.createdAt,width,height};
      });});
    });
    const filtered=all.filter(w=>(!message.projectId||w.projectId===message.projectId)&&(!message.search||(w.title+' '+w.projectTitle).includes(message.search.trim()))&&(message.ratio==='all'||(message.ratio==='square'?w.width===w.height:message.ratio==='portrait'?w.width<w.height:w.width>w.height))).sort((a,b)=>(message.sort==='oldest'?1:-1)*a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
    const result={items:filtered.slice(message.offset,message.offset+message.limit),total:filtered.length,totalWorks:all.length,projectCount:visible.filter(p=>p.jobs.some(j=>j.generations?.length)).length,projects:visible.filter(p=>p.jobs.some(j=>j.generations?.length)).map(p=>({id:p.id,title:p.title})),revision:'preview-'+projectsRevision,offset:message.offset,limit:message.limit};
    await new Promise(resolve=>setTimeout(resolve,Number(previewOptions.get('galleryDelay'))||0));
    if(previewOptions.get('galleryFail')==='once'&&!failedPage){failedPage=true;return {error:'示例：画廊读取失败，请重试'};}
    return {ok:true,value:result};
  }
  if(state==='works'&&['alchemy:generation-thumbnail','alchemy:generation-image'].includes(message.type)) {
    const generation=findJob(message.id)?.generations.find(g=>g.id===message.generationId);
    if(!generation)return {error:'生成记录已不存在'};
    if(previewOptions.get('galleryImageFail')==='1'&&message.type==='alchemy:generation-image')return {error:'示例：图片读取失败'};
    const [width,height]=gallerySizes[generation.sample];
    return {ok:true,value:{image:'/gallery-fixture/'+(message.type==='alchemy:generation-image'?'original':'thumb')+'/'+generation.sample,width,height}};
  }
`;
