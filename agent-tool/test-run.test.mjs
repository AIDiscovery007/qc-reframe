import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshot, loadIndex, changesBetween } from './test-run.mjs';

test('user（开发者）只复用来源可核验的祖先索引，新文件与删除仍参与影响判断', async t => {
  // Given a real Git baseline, an ignored local file and a complete saved index.
  const root = mkdtempSync(join(tmpdir(), 'reframe-run-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const git = (...args) => execFileSync('git', args, {cwd:root,encoding:'utf8'}).trim();
  git('init','-b','main'); git('config','user.email','fixture@example.invalid'); git('config','user.name','fixture');
  writeFileSync(join(root,'.gitignore'),'local\nindex.json\n'); writeFileSync(join(root,'a.mjs'),'export const a=1;');
  git('add','.'); git('commit','-qm','baseline');
  const files = await snapshot(root), commit = git('rev-parse','HEAD');
  const index = {schema:1,status:'passed',complete:true,commit,files};
  const path = join(root,'index.json'); writeFileSync(path,JSON.stringify(index));
  // When reading provenance and modifying current source alongside ignored user data.
  assert.equal((await loadIndex(path,root)).commit,commit);
  writeFileSync(join(root,'a.mjs'),'export const a=2;'); writeFileSync(join(root,'new.mjs'),'new'); writeFileSync(join(root,'local'),'private');
  const changes = changesBetween(files,await snapshot(root));
  assert.deepEqual(changes,[{file:'a.mjs',status:'M'},{file:'new.mjs',status:'A'}]);
  rmSync(join(root,'a.mjs'));
  assert.equal(changesBetween(files,await snapshot(root))[0].status,'D');
  // Then a forged source snapshot cannot pass as that successful commit's evidence.
  writeFileSync(path,JSON.stringify({...index,files:{}}));
  assert.equal(await loadIndex(path,root),null);
});

test('user（开发者）LANG变化会改变真实环境指纹并拒绝旧环境选测', async () => {
  // Given the installed Chromium/fonts and the current repository without launching a browser.
  const {run}=await import('./test-run.mjs');
  const {fileURLToPath}=await import('node:url');
  const root=fileURLToPath(new URL('../',import.meta.url)), old=process.env.LANG;
  try {
    const first=await run({root,planOnly:true});
    // When the process locale changes, then evidence cannot silently reuse the same environment.
    process.env.LANG='reframe-fixture-different-locale';
    const second=await run({root,planOnly:true});
    assert.notEqual(first.environment,second.environment);
  } finally {if(old===undefined)delete process.env.LANG;else process.env.LANG=old;}
});

test('user（维护者）相同字体内容跨安装位置与mtime复用索引，真实内容变化失效', async t => {
  // Given two temporary font installations with identical files and different paths/timestamps.
  const { mkdir, writeFile, utimes, symlink } = await import('node:fs/promises');
  const { fontContentInventory } = await import('./ui/evidence.mjs');
  const root = mkdtempSync(join(tmpdir(), 'reframe-fonts-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  for (const name of ['first','second']) {
    await mkdir(join(root,name)); await writeFile(join(root,name,'font.ttf'),'font-data');
    await symlink('font.ttf',join(root,name,'linked.ttf'));
  }
  await utimes(join(root,'second','font.ttf'),new Date(0),new Date(0));
  // When computing portable content identities, installation metadata does not change the result.
  const original=await fontContentInventory([join(root,'first')]);
  assert.equal(original,await fontContentInventory([join(root,'second')]));
  // Then a same-size font replacement with preserved timestamps still invalidates the identity.
  await writeFile(join(root,'second','font.ttf'),'new--data');
  await utimes(join(root,'second','font.ttf'),new Date(0),new Date(0));
  assert.notEqual(original,await fontContentInventory([join(root,'second')]));
});
