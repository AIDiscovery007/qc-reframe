import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { checkStyles } from '../../agent-tool/ui/static.mjs';

const exec = promisify(execFile);
const popup = 'browser-extension/entrypoints/popup/';
async function fixture(t, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'reframe-ui-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (file, text) => { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), text); };
  const git = (...args) => exec('git', args, { cwd: root });
  await git('init', '-q');
  await write(`${popup}style.css`, ':root, :host { --yellow: #ffd440; --ink: #26241f; }\n');
  for (const [file, text] of Object.entries(files)) await write(file, text);
  await git('add', '.');
  await git('-c', 'user.name=UI Test', '-c', 'user.email=ui-test@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture');
  return { root, write, git };
}

test('AST inspection rejects missing variables and shared CSS imports with precise source locations', async t => {
  const { root } = await fixture(t, {
    [`${popup}Widget.tsx`]: '// import "./fake.css"\nimport "./widget.css";\nexport const Widget = () => <p style={{color: "var(--absent)"}}>ok</p>;',
    [`${popup}widget.css`]: '.widget {\n color: var(--missing);\n}',
  });
  const { findings, coverage } = await checkStyles({ root });
  assert.deepEqual(findings.map(({ ruleId, file, line }) => [ruleId, file, line]), [
    ['UI-TOKEN-DEFINED', `${popup}widget.css`, 2],
    ['UI-CSS-IMPORT', `${popup}Widget.tsx`, 2],
    ['UI-TOKEN-DEFINED', `${popup}Widget.tsx`, 3],
  ].sort((a, b) => a[1].localeCompare(b[1]) || a[2] - b[2]));
  assert.ok(findings.every(item => item.severity === 'error' && item.expected && item.actual));
  assert.equal(coverage.canonicalColors, 2);
  assert.match(coverage.limitations.join(' '), /not a proof of cascade/);
});

test('fallbacks, local tokens, comments, content strings and URLs do not cause false findings', async t => {
  const { root } = await fixture(t, {
    [`${popup}good.css`]: `/* color: var(--fake); background: #ffd440 */
.a { --local: 2px; width: var(--local); height: var(--optional, var(--other, 1px));
 content: "var(--fake) #ffd440"; background-image: url("image-#ffd440-var(--fake)"); color: var(--ink); }
.b { margin: var(--optional,); }`,
    [`${popup}main.tsx`]: 'import "./style.css";',
    'browser-extension/entrypoints/workspace/main.tsx': 'import "./local.css";',
    'browser-extension/entrypoints/content.ts': 'import css from "./popup/style.css?inline";',
    'browser-extension/lib/text.ts': 'const example = "import \\\"./oops.css\\\" var(--fake) #ffd440";',
    'browser-extension/bridge/excluded.ts': 'import "./bad.css";',
  });
  assert.deepEqual((await checkStyles({ root })).findings, []);
});

test('dynamic CSS imports and non-inline content imports respect the shared module boundary', async t => {
  const { root } = await fixture(t, {
    'browser-extension/lib/Widget.tsx': 'import("./lazy.css");\nrequire("./required.css");\nexport {default} from "./export.css";',
    'browser-extension/entrypoints/content.ts': 'import "./popup/style.css";',
  });
  const { findings } = await checkStyles({ root });
  assert.equal(findings.length, 4);
  assert.ok(findings.every(item => item.ruleId === 'UI-CSS-IMPORT'));
});

test('literal setProperty, inline CSSProperties and Object.entries template writes define dynamic tokens', async t => {
  const { root } = await fixture(t, {
    'browser-extension/lib/geometry.tsx': `el.style.setProperty('--left', '2px');
for (const [key, value] of Object.entries({top: 1, width: 2})) el.style.setProperty(\x60--box-\x24{key}\x60, value);
const style: React.CSSProperties = { '--height': '4px', color: 'var(--ink)' };
const view = <p style={{ '--gap': '1px', margin: 'var(--gap)' } as React.CSSProperties}/>;`,
    [`${popup}geometry.css`]: '.a { left:var(--left);top:var(--box-top);width:var(--box-width);height:var(--height);gap:var(--gap); }',
  });
  const { findings, coverage } = await checkStyles({ root });
  assert.deepEqual(findings, []);
  assert.deepEqual(coverage.unresolvedDynamicProperties, []);
});

test('canonical color equivalents warn in full scans and error only on added lines in changed scans', async t => {
  const { root, write, git } = await fixture(t, {
    [`${popup}colors.css`]: '.old { color:#ffd440; }\n.keep { padding:2px; }\n',
  });
  await write(`${popup}colors.css`, '.old { color:#ffd440; }\n.keep { padding:2px; }\n.new { color:\n rgb(255 212 64 / 100%); }\n');
  await git('add', `${popup}colors.css`);
  await write(`${popup}colors.css`, '.old { color:#ffd440; }\n.keep { padding:2px; }\n.new { color:\n rgb(255 212 64 / 100%); }\n.extra { color:#26241fff; }\n');
  const all = await checkStyles({ root });
  assert.equal(all.findings.length, 3);
  assert.ok(all.findings.every(item => item.severity === 'warning'));
  const changed = await checkStyles({ root, changed: true });
  assert.deepEqual(changed.findings.map(item => [item.line, item.severity]), [[1, 'warning'], [4, 'error'], [5, 'error']]);
  assert.equal(changed.coverage.filesChecked, 1);
});

test('changed RGB components anywhere within a multiline color node count as an added literal', async t => {
  const existing = '.old { color: rgb(\n 255 212 64\n); }\n';
  const { root, write } = await fixture(t, {
    [`${popup}multiline.css`]: '.a { color: rgb(\n 1 2 3\n); }\n' + existing,
  });
  await write(`${popup}multiline.css`, '.a { color: rgb(\n 255 212 64\n); }\n' + existing);
  const { findings } = await checkStyles({ root, changed: true });
  assert.deepEqual(findings.map(item => [item.ruleId, item.line, item.severity]), [
    ['UI-TOKEN-COLOR', 1, 'error'],
    ['UI-TOKEN-COLOR', 4, 'warning'],
  ]);
  assert.ok((await checkStyles({ root })).findings.every(item => item.severity === 'warning'));
});

test('untracked files are checked, deleted files are skipped, and renamed files do not break diff handling', async t => {
  const { root, write, git } = await fixture(t, {
    [`${popup}gone.css`]: '.gone {color:var(--ink)}',
    [`${popup}rename me.css`]: '.old {color:var(--ink)}',
  });
  await rm(join(root, `${popup}gone.css`));
  await rename(join(root, `${popup}rename me.css`), join(root, `${popup}renamed space.css`));
  await git('add', '-A');
  await write('browser-extension/lib/new.tsx', 'import "./bad.css";\nconst view = <p style={{ color: "#ffd440" }}/>;');
  const { findings, coverage } = await checkStyles({ root, changed: true });
  assert.deepEqual(findings.map(item => [item.ruleId, item.severity]), [['UI-CSS-IMPORT', 'error'], ['UI-TOKEN-COLOR', 'error']]);
  assert.equal(coverage.filesChecked, 2);
  await assert.rejects(checkStyles({ root, changed: true, base: 'missing-ref' }), /missing-ref/);
});

test('unresolved dynamic property names are disclosed rather than treated as wildcard definitions', async t => {
  const { root } = await fixture(t, {
    'browser-extension/lib/dynamic.ts': 'el.style.setProperty(name, value);',
    [`${popup}unknown.css`]: '.a { color:var(--unproved); }',
  });
  const { findings, coverage } = await checkStyles({ root });
  assert.equal(findings[0].ruleId, 'UI-TOKEN-DEFINED');
  assert.equal(coverage.unresolvedDynamicProperties[0].expression, 'name');
});

test('removing a token checks unchanged consumers and plain data objects cannot define CSS tokens', async t => {
  const { root, write } = await fixture(t, {
    [`${popup}consumer.css`]: '.a { color:var(--ink);background:var(--pretend); }',
    'browser-extension/lib/data.ts': 'const data = { "--pretend": "red" };',
  });
  await write(`${popup}style.css`, ':root, :host { --yellow:#ffd440; }');
  const { findings, coverage } = await checkStyles({ root, changed: true });
  assert.deepEqual(findings.map(item => item.actual), ['--ink', '--pretend']);
  assert.equal(coverage.filesChecked, 1);
  assert.equal(coverage.tokenReferenceFilesChecked, 3);
});
