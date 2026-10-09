import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectNode } from './test-impact.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'reframe-impact-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, text) => { await mkdir(join(root, name, '..'), { recursive: true }); await writeFile(join(root, name), text); };
  return { root, put };
}

test('user（开发者）得到每个测试文件实际执行来源，包括继承环境的子进程', async t => {
  // Given two independent tests, one also executes a child process.
  const f = await fixture(t);
  await f.put('a.mjs', 'export const a = 1;');
  await f.put('b.mjs', 'export const b = 2;');
  await f.put('child.mjs', 'export const child = 3;');
  await f.put('a.test.mjs', `import {a} from './a.mjs'; import {execFileSync} from 'node:child_process'; import assert from 'node:assert/strict'; assert.equal(a,1); execFileSync(process.execPath,['child.mjs']);`);
  await f.put('b.test.mjs', `import {b} from './b.mjs'; import assert from 'node:assert/strict'; assert.equal(b,2);`);
  // When the public collector executes each test.
  const result = await collectNode({ root: f.root, tests: ['a.test.mjs', 'b.test.mjs'], directory: join(f.root, 'evidence') });
  // Then only that test's observed execution is associated with it.
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.deepEqual(result.tests.map(item => [item.id, item.executed]), [
    ['a.test.mjs', ['a.mjs', 'a.test.mjs', 'child.mjs']], ['b.test.mjs', ['b.mjs', 'b.test.mjs']],
  ]);
});

test('user（开发者）选择核心、关联旧项和新改测试，并知道哪些推迟', async t => {
  // Given a complete, successful index whose reliable source has passed shadow comparison.
  const { selectTests } = await import('./test-impact.mjs');
  const index = { schema: 1, status: 'passed', complete: true, createdAt: new Date().toISOString(), environment: 'fixture', commit: 'abc', shadow: ['known.mjs'], tests: [
    { id: 'core.test.mjs', executed: ['core.mjs'], dependencies: [] },
    { id: 'old.test.mjs', executed: ['known.mjs'], dependencies: [] },
    { id: 'other.test.mjs', executed: ['other.mjs'], dependencies: [] },
  ] };
  // When known code and one test are modified.
  const result = selectTests({ index, environment: 'fixture', changes: [{ status: 'M', file: 'known.mjs' }, { status: 'M', file: 'new.test.mjs' }], tests: ['core.test.mjs', 'old.test.mjs', 'other.test.mjs', 'new.test.mjs'], core: ['core.test.mjs'], reliable: ['known.mjs'] });
  // Then affected and new behavior remains tested, while unrelated old tests are explicit.
  assert.equal(result.mode, 'selected');
  assert.deepEqual(result.selected, ['core.test.mjs', 'new.test.mjs', 'old.test.mjs']);
  assert.deepEqual(result.deferred, ['other.test.mjs']);
});

test('user（开发者）遇到未知、失效或不完整索引时仍获得全量而非空选', async () => {
  // Given a previously successful index and a core plus an old mapped test.
  const { selectTests } = await import('./test-impact.mjs');
  const index = { schema: 1, status: 'passed', complete: true, createdAt: new Date().toISOString(), environment: 'fixture', shadow: ['known.mjs'], tests: [{ id: 'old.test.mjs', executed: ['known.mjs'], dependencies: [] }] };
  const input = { index, environment: 'fixture', changes: [{ status: 'M', file: 'known.mjs' }], tests: ['old.test.mjs'], core: [], reliable: ['known.mjs'] };
  // When evidence or any changed path is uncertain, even alongside a known source.
  for (const change of [
    { index: null }, { index: { ...index, status: 'failed' } }, { index: { ...index, complete: false } },
    { index: { ...index, createdAt: '2020-01-01' } }, { environment: 'other-platform' },
    { changes: [...input.changes, { status: 'M', file: 'unknown.mjs' }] },
    { changes: [{ status: 'A', file: 'known.mjs' }] }, { changes: [{ status: 'D', file: 'known.mjs' }] },
    { changes: [{ status: 'R', file: 'known.mjs' }] }, { tests: ['old.test.mjs', 'unindexed.test.mjs'] },
  ]) {
    // Then all current tests are selected and the reason is visible.
    const result = selectTests({ ...input, ...change });
    assert.equal(result.mode, 'full', JSON.stringify(change));
    assert.deepEqual(result.selected, [...(change.tests || input.tests)].sort());
    assert.ok(result.fallback);
  }
});

test('user（开发者）只有成功完整且来源稳定的采集可以刷新索引，并先做shadow对照', async t => {
  // Given a prior index kept on disk and a complete Node/browser inventory.
  const { publishIndex } = await import('./test-impact.mjs');
  const { readFile } = await import('node:fs/promises');
  const f = await fixture(t), output = join(f.root, 'index.json');
  const record = { id: 'one.test.mjs', status: 'passed', skipped: 0, todo: 0, executed: ['known.mjs'], dependencies: [] };
  const input = { output, commit: 'abc', environment: 'fixture', before: { 'known.mjs': 'hash' }, after: { 'known.mjs': 'hash' }, tests: [record], expected: ['one.test.mjs'], validations: { static: true, types: true, gate: true }, reliable: ['known.mjs'] };
  // When first complete collection and then an independent full collection agree.
  const first = await publishIndex(input);
  assert.deepEqual(first.shadow, []);
  const second = await publishIndex({ ...input, previous: first });
  assert.deepEqual(second.shadow, ['known.mjs']);
  const saved = await readFile(output, 'utf8');
  // Then incomplete/failed/cancelled/drifted collections cannot replace it.
  for (const change of [{ tests: [] }, { tests: [{ ...record, status: 'failed' }] }, { validations: { gate: false } }, { after: {} }, { cancelled: true }]) {
    await assert.rejects(publishIndex({ ...input, ...change }));
    assert.equal(await readFile(output, 'utf8'), saved);
  }
});

test('user（开发者）将browser执行范围映射回源码，缺map明确为未知', async t => {
  // Given one bundle with two source lines, only the first executed.
  const { mapBrowserCoverage } = await import('./test-impact.mjs');
  const f = await fixture(t);
  await f.put('src/a.ts', 'export const a = 1;'); await f.put('src/b.ts', 'export const b = 2;');
  await f.put('build/app.js', 'a();\nb();');
  await f.put('build/app.js.map', JSON.stringify({ version: 3, sources: ['../src/a.ts', '../src/b.ts'], names: [], mappings: 'AAAA;ACAA' }));
  const entries = [{ url: 'http://127.0.0.1/app.js', source: 'a();\nb();', functions: [{ ranges: [{ startOffset: 0, endOffset: 9, count: 1 }, { startOffset: 5, endOffset: 9, count: 0 }] }] }, { url: 'http://127.0.0.1/unknown.js', source: 'x()', functions: [{ ranges: [{ startOffset: 0, endOffset: 3, count: 1 }] }] }];
  // When coverage is decoded through the public mapping interface.
  const result = await mapBrowserCoverage(entries, { root: f.root, buildDirectory: join(f.root, 'build'), origin: 'http://127.0.0.1' });
  // Then executed and conservative loaded dependencies are distinct, missing maps aren't zero impact.
  assert.deepEqual(result.executed, ['src/a.ts']);
  assert.deepEqual(result.dependencies, ['src/a.ts', 'src/b.ts']);
  assert.ok(result.unknown.some(item => item.includes('unknown.js')));
  // A product eval cannot borrow an existing bundle URL/source map for unrelated bytes.
  const forged = await mapBrowserCoverage([{...entries[0], source: 'evil();\n//# sourceURL=http://127.0.0.1/app.js'}], {root:f.root,buildDirectory:join(f.root,'build'),origin:'http://127.0.0.1'});
  assert.equal(forged.unknown.length,1);
  assert.deepEqual(forged.executed,[]);
  assert.deepEqual(forged.dependencies,[]);
});

test('user（开发者）不能把coverage构建来源与普通构建混为同一证据', async () => {
  // Given the same source files in normal and coverage build modes.
  const { sourceState } = await import('./ui/inventory.mjs');
  const old = process.env.REFRAME_TEST_COVERAGE;
  try {
    delete process.env.REFRAME_TEST_COVERAGE;
    const normal = await sourceState();
    // When selecting coverage mode without editing any source.
    process.env.REFRAME_TEST_COVERAGE = '1';
    const coverage = await sourceState();
    // Then evidence identities differ, so no-build reuse cannot cross modes.
    assert.notEqual(normal.hash, coverage.hash);
    assert.equal(normal.buildMode, 'normal');
    assert.equal(coverage.buildMode, 'coverage');
  } finally { if (old === undefined) delete process.env.REFRAME_TEST_COVERAGE; else process.env.REFRAME_TEST_COVERAGE = old; }
});

test('user（维护者）真实Node跳过或todo不能被发布为完整可信索引', async t => {
  // Given an actual test file containing a passing, skipped and todo test.
  const f = await fixture(t);
  await f.put('skip.test.mjs', "import test from 'node:test'; test('pass',()=>{}); test.skip('unsupported',()=>{}); test.todo('pending');");
  // When collecting successful Node execution.
  const result = await collectNode({ root: f.root, tests: ['skip.test.mjs'], directory: join(f.root, 'evidence') });
  // Then skipped/todo counts remain explicit and cannot refresh the index.
  assert.equal(result.tests[0].skipped, 1);
  assert.equal(result.tests[0].todo, 1);
  const { publishIndex } = await import('./test-impact.mjs');
  await assert.rejects(publishIndex({ output: join(f.root, 'index.json'), commit: 'abc', environment: 'fixture', before: {}, after: {}, tests: result.tests, expected: ['skip.test.mjs'], validations: {static:true,types:true,gate:true}, reliable: [] }));
});

test('user（开发者）新增readFile和匿名VM测试、缺map场景在下次源码变更时仍必跑', async t => {
  // Given a new test which reads source into an anonymous VM, plus an unmapped browser script.
  const f=await fixture(t); await f.put('known.mjs','1+1');
  await f.put('new.test.mjs',"import {readFileSync} from 'node:fs'; import vm from 'node:vm'; import assert from 'node:assert/strict'; assert.equal(vm.runInNewContext(readFileSync('known.mjs','utf8')),2);");
  const result=await collectNode({root:f.root,tests:['new.test.mjs'],directory:join(f.root,'evidence')});
  const {withConservativeDependencies}=await import('./test-policy.mjs');
  const {selectTests}=await import('./test-impact.mjs');
  // When full collection stores conservative dependencies, including unknown coverage.
  const records=[...result.tests,{id:'browser:missing-map',executed:[],unknown:['app.js: missing map']}].map(item=>withConservativeDependencies(item,['known.mjs']));
  const index={schema:1,status:'passed',complete:true,createdAt:new Date().toISOString(),environment:'fixture',shadow:['known.mjs'],tests:records};
  // Then a later source change selects both, even though neither observed that source URL.
  const selected=selectTests({index,environment:'fixture',tests:records.map(item=>item.id),core:[],reliable:['known.mjs'],changes:[{file:'known.mjs',status:'M'}]});
  assert.deepEqual(selected.selected,['browser:missing-map','new.test.mjs']);
});

test('user（开发者）已审阅浏览器执行域可排除bridge依赖，但新fixture或实际映射不能被忽略', async () => {
  // Given unknown browser injection code in the exact reviewed frontend/preview domain.
  const {withConservativeDependencies,browserDomain,reviewedBrowserDomain}=await import('./test-policy.mjs');
  const {snapshot}=await import('./test-run.mjs');
  const files=await snapshot(process.cwd());
  assert.equal(browserDomain(files),reviewedBrowserDomain);
  const backend='browser-extension/bridge/task-runtime.mjs';
  // When backend changes outside that frozen domain, unknown page scripts need only frontend conservatism.
  const isolated=withConservativeDependencies({id:'browser:scene',executed:[],unknown:['anonymous']},undefined,true);
  assert.ok(!isolated.dependencies.includes(backend));
  assert.ok(isolated.dependencies.includes('browser-extension/lib/operation-policy.ts'));
  // A changed/new fixture invalidates the proof, and actual execution edges always take precedence.
  const altered={...files,'browser-extension/tests/new.browser.js':{mode:'100644',oid:'new',type:'blob'}};
  assert.notEqual(browserDomain(altered),reviewedBrowserDomain);
  for (const file of ['browser-extension/entrypoints/popup/App.tsx', 'browser-extension/lib/generation-session.ts', 'agent-tool/preview.mjs', 'agent-tool/ui/runner.mjs', 'browser-extension/package-lock.json']) {
    assert.notEqual(browserDomain({...files, [file]: {mode:'100644',oid:'changed',type:'blob'}}), reviewedBrowserDomain, file);
  }
  assert.ok(withConservativeDependencies({id:'browser:scene',executed:[],unknown:['anonymous']}).dependencies.includes(backend));
  assert.ok(withConservativeDependencies({id:'browser:scene',executed:[backend],dependencies:[backend],unknown:['anonymous']},undefined,true).dependencies.includes(backend));
});

test('user（开发者）只信任进程登记且内容和来源一致的harness，伪造名字与嵌套eval仍未知', async t => {
  // Given an out-of-page receipt for a harness which calls a product function.
  const { createHash } = await import('node:crypto');
  const { mapBrowserCoverage } = await import('./test-impact.mjs');
  const hash = text => createHash('sha256').update(text).digest('hex');
  const f = await fixture(t), origin = 'http://127.0.0.1:1234';
  await f.put('tool.mjs', 'harness generator'); await f.put('product.ts', 'export const run = () => 1;');
  const source = 'run(); eval("nested()");\n//# sourceURL=trusted-tool.js';
  const receipt = { url: origin + '/preview.js', sha256: hash(source), sources: [
    { file: 'tool.mjs', sha256: hash('harness generator') },
    { file: 'product.ts', sha256: hash('export const run = () => 1;') },
  ] };
  const entry = { scriptId: '1', url: receipt.url, source, functions: [] };
  // When identical delivered bytes and source hashes are verified through the mapper.
  const options = { root: f.root, buildDirectory: join(f.root, 'build'), origin, receipts: [receipt] };
  const mapped = await mapBrowserCoverage([entry, { ...entry, scriptId: '2', url: '', source: 'nested()' }], options);
  // Then harness attribution preserves product dependencies, while nested evaluation stays unknown.
  assert.deepEqual(mapped.dependencies, ['product.ts', 'tool.mjs']);
  assert.equal(mapped.attribution[0].classification, 'harness');
  assert.equal(mapped.attribution[1].classification, 'unknown');
  assert.equal(mapped.unknown.length, 1);
  // A copied sourceURL/name, changed body, or changed source cannot inherit the receipt.
  const forged = await mapBrowserCoverage([{ ...entry, source: 'malicious();\n//# sourceURL=trusted-tool.js' }], options);
  assert.equal(forged.unknown.length, 1);
  assert.equal(forged.attribution[0].classification, 'unknown');
  await f.put('product.ts', 'changed');
  assert.equal((await mapBrowserCoverage([entry], options)).unknown.length, 1);
});

test('user（开发者）实际预览发送的七种脚本都有可验证来源，不再作为缺map未知项', async t => {
  // Given the real synthetic preview process and an IPC channel owned by this test.
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { mapBrowserCoverage } = await import('./test-impact.mjs');
  const child = spawn(process.execPath, ['agent-tool/preview.mjs'], { env: { ...process.env, PREVIEW_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode === null && !child.signalCode) { const exit = once(child, 'exit'); child.kill(); await exit; } });
  const receipts = []; child.on('message', item => receipts.push(item));
  const origin = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(Error('Preview startup timeout')), 20000);
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/UI preview: (http:\/\/127\.0\.0\.1:\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(Error(`Preview exited ${code}`)); });
  });
  // When collecting the exact bytes from every supported fixture route.
  const paths = ['/preview.js', ...['settings-recovery','end-to-end','generation-actions','auto-style','image-order','creation-context'].map(name => `/${name}-regression.js`)];
  const entries = [];
  for (const path of paths) { const response = await fetch(origin + path); assert.equal(response.status, 200); entries.push({ url: origin + path, source: await response.text(), functions: [] }); }
  const result = await mapBrowserCoverage(entries, { root: process.cwd(), buildDirectory: join(process.cwd(), 'browser-extension/.output/chrome-mv3'), origin, receipts });
  // Then all seven are attributed while both serialized product dependencies remain explicit.
  assert.equal(result.unknown.length, 0, JSON.stringify(result.unknown));
  assert.equal(result.attribution.filter(item => item.classification === 'harness').length, 7);
  assert.ok(result.dependencies.includes('browser-extension/lib/operation-policy.ts'));
  assert.ok(result.dependencies.includes('browser-extension/bridge/image-order.mjs'));
  for (const name of paths.slice(1)) assert.ok(result.dependencies.includes('browser-extension/tests/' + name.slice(1).replace('-regression.js', '.browser.js')));
});

test('user（开发者）缺少coverage脚本文本只记未知，其他正常脚本继续映射', async t => {
  // Given one unavailable script and one genuine mapped bundle.
  const { mapBrowserCoverage } = await import('./test-impact.mjs');
  const f=await fixture(t), origin='http://127.0.0.1';
  await f.put('build/app.js','a();');
  await f.put('build/app.js.map',JSON.stringify({version:3,sources:['../src/a.ts'],names:[],mappings:'AAAA'}));
  // When Playwright omits source for the first entry.
  const result=await mapBrowserCoverage([{scriptId:'missing',url:origin+'/missing.js',functions:[]},
    {scriptId:'normal',url:origin+'/app.js',source:'a();',functions:[{ranges:[{startOffset:0,endOffset:4,count:1}]}]}],
    {root:f.root,buildDirectory:join(f.root,'build'),origin});
  // Then the missing source remains conservative without discarding valid mapping evidence.
  assert.equal(result.unknown.length,1);
  assert.match(result.unknown[0],/source unavailable/);
  assert.deepEqual(result.executed,['src/a.ts']);
  assert.deepEqual(result.attribution.map(item=>item.classification),['unknown','mapped']);
});
