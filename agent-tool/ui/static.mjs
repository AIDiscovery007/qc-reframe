import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const require = createRequire(new URL('../../browser-extension/package.json', import.meta.url));
const postcss = require('postcss');
const valueParser = require('postcss-value-parser');
const ts = require('typescript');
const exec = promisify(execFile);
const sourceRoots = ['browser-extension/entrypoints', 'browser-extension/lib'];
const styleEntries = new Set(['browser-extension/entrypoints/popup/main.tsx', 'browser-extension/entrypoints/workspace/main.tsx']);
const canonicalFile = 'browser-extension/entrypoints/popup/style.css';
const isSource = file => /\.(?:css|[cm]?tsx?)$/.test(file);

async function filesUnder(root, directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? filesUnder(root, `${directory}/${entry.name}`) : entry.isFile() && isSource(entry.name) ? [`${directory}/${entry.name}`] : []))).flat();
}

async function changedLines(root, base) {
  const git = async args => (await exec('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout;
  // Comparing the base directly with the working tree includes staged and unstaged edits.
  const tracked = (await git(['diff', '--name-only', '-z', '--no-renames', base, '--', ...sourceRoots])).split('\0').filter(Boolean);
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...sourceRoots])).split('\0').filter(Boolean);
  const lines = new Map(untracked.filter(isSource).map(file => [file, null]));
  for (const file of tracked.filter(isSource)) {
    const patch = await git(['diff', '--no-ext-diff', '--no-renames', '--unified=0', base, '--', file]);
    const added = new Set();
    for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(match[1]), count = Number(match[2] ?? 1);
      for (let line = start; line < start + count; line++) added.add(line);
    }
    lines.set(file, added);
  }
  return lines;
}

function opaqueColor(text) {
  const value = text.toLowerCase().trim();
  const hex = value.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/);
  if (hex) {
    let digits = hex[1];
    if (digits.length < 5) digits = [...digits].map(char => char + char).join('');
    if (digits.length === 8 && digits.slice(6) !== 'ff') return null;
    return `#${digits.slice(0, 6)}`;
  }
  const rgb = value.match(/^rgba?\(([^()]*)\)$/);
  if (!rgb) return null;
  const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4 || parts.some(part => !/^\d*\.?\d+%?$/.test(part))) return null;
  if (parts[3] && Number(parts[3].replace('%', '')) !== (parts[3].endsWith('%') ? 100 : 1)) return null;
  const bytes = parts.slice(0, 3).map(part => Math.round(Number(part.replace('%', '')) * (part.endsWith('%') ? 2.55 : 1)));
  return bytes.every(byte => byte >= 0 && byte <= 255) ? `#${bytes.map(byte => byte.toString(16).padStart(2, '0')).join('')}` : null;
}

function propertyName(node) {
  return node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : null;
}

function dynamicNames(expression) {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (!ts.isTemplateExpression(expression) || expression.templateSpans.length !== 1) return [];
  const span = expression.templateSpans[0];
  if (!ts.isIdentifier(span.expression)) return [];
  // Resolve the common Object.entries({...}) loop without accepting arbitrary wildcard names.
  for (let parent = expression.parent; parent; parent = parent.parent) {
    if (!ts.isForOfStatement(parent) || !ts.isVariableDeclarationList(parent.initializer)) continue;
    const binding = parent.initializer.declarations[0]?.name;
    const call = parent.expression;
    if (!binding || !ts.isArrayBindingPattern(binding) || propertyName(binding.elements[0]?.name) !== span.expression.text || !ts.isCallExpression(call)) continue;
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.getText() !== 'Object.entries' || !call.arguments[0] || !ts.isObjectLiteralExpression(call.arguments[0])) continue;
    return call.arguments[0].properties.map(property => propertyName(property.name)).filter(Boolean).map(key => expression.head.text + key + span.literal.text);
  }
  return [];
}

function inspectTypeScript(text, file, definitions, values, imports, unresolved) {
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const line = node => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
  const value = node => {
    if (node && ts.isStringLiteralLike(node)) values.push({ file, line: line(node), value: node.text });
  };
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push({ file, line: line(node), path: node.moduleSpecifier.text });
    if (ts.isCallExpression(node)) {
      if ((node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) imports.push({ file, line: line(node), path: node.arguments[0].text });
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setProperty' && node.arguments[0]) {
        const names = dynamicNames(node.arguments[0]);
        for (const name of names) if (name.startsWith('--')) definitions.add(name);
        if (!names.length) unresolved.push({ file, line: line(node), expression: node.arguments[0].getText(ast) });
        value(node.arguments[1]);
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      // Limit value checks to inline style objects and explicitly typed CSSProperties objects.
      let inline = false;
      for (let parent = node.parent; parent && !ts.isStatement(parent); parent = parent.parent) {
        if (ts.isJsxAttribute(parent) && parent.name.getText(ast) === 'style' || (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) && /(?:^|\.)CSSProperties$/.test(parent.type.getText(ast)) || ts.isVariableDeclaration(parent) && parent.type && /(?:^|\.)CSSProperties$/.test(parent.type.getText(ast))) inline = true;
      }
      if (inline) {
        if (name?.startsWith('--')) definitions.add(name);
        value(node.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return ast.parseDiagnostics;
}

/** Static source diagnostics. Local token existence is checked; CSS cascade applicability is not inferred. */
export async function checkStyles({ root, changed = false, base = 'HEAD' }) {
  root = resolve(root);
  const files = (await Promise.all(sourceRoots.map(directory => filesUnder(root, directory)))).flat().sort();
  const additions = changed ? await changedLines(root, base) : null;
  const selected = file => !changed || additions.has(file);
  const definitions = new Set(), colors = new Map(), values = [], imports = [], unresolved = [], findings = [];
  const add = (ruleId, severity, item, message, expected, actual) => {
    // Removing a token can break consumers whose files were not changed.
    if (selected(item.file) || ruleId === 'UI-TOKEN-DEFINED') findings.push({ ruleId, severity, file: item.file, line: item.line, message, expected, actual });
  };
  for (const file of files) {
    const text = await readFile(join(root, file), 'utf8');
    if (!file.endsWith('.css')) {
      const errors = inspectTypeScript(text, file, definitions, values, imports, unresolved);
      for (const error of errors) add('UI-CSS-IMPORT', 'error', { file, line: text.slice(0, error.start).split('\n').length }, `TypeScript parse failed: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`, 'Parseable TypeScript source', 'Syntax error');
      continue;
    }
    let ast;
    try { ast = postcss.parse(text, { from: join(root, file) }); }
    catch (error) {
      add('UI-TOKEN-DEFINED', 'error', { file, line: error.line ?? 1 }, `CSS parse failed: ${error.reason}`, 'Parseable CSS source', 'Syntax error');
      continue;
    }
    ast.walkDecls(decl => {
      if (decl.prop.startsWith('--')) definitions.add(decl.prop);
      const canonical = file === canonicalFile && decl.parent.type === 'rule' && decl.parent.selectors.includes(':root') && decl.parent.selectors.every(selector => [':root', ':host'].includes(selector)) && decl.prop.startsWith('--');
      const color = canonical && opaqueColor(decl.value);
      if (color && !colors.has(color)) colors.set(color, decl.prop);
      values.push({ file, line: decl.source.start.line + (decl.raws.between ?? '').split('\n').length - 1, value: decl.value, canonical });
    });
  }
  for (const item of imports) {
    if (!/\.css(?:[?#]|$)/i.test(item.path) || styleEntries.has(item.file)) continue;
    if (item.file === 'browser-extension/entrypoints/content.ts' && /\?inline(?:&|$)/.test(item.path)) continue;
    add('UI-CSS-IMPORT', 'error', item, 'Shared modules must not load CSS; import it through the UI entry or the popup stylesheet.', 'CSS imports only in popup/main.tsx or workspace/main.tsx; content.ts permits ?inline for Shadow DOM', item.path);
  }
  for (const item of values) {
    valueParser(item.value).walk(node => {
      if (node.type === 'string' || node.type === 'comment' || node.type === 'function' && node.value.toLowerCase() === 'url') return false;
      const current = { ...item, line: item.line + item.value.slice(0, node.sourceIndex).split('\n').length - 1 };
      if (node.type === 'function' && node.value.toLowerCase() === 'var') {
        const name = node.nodes.find(child => child.type === 'word')?.value;
        const fallback = node.nodes.some(child => child.type === 'div' && child.value === ',');
        if (name?.startsWith('--') && !fallback && !definitions.has(name)) add('UI-TOKEN-DEFINED', 'error', current, `Custom property ${name} has no known definition or fallback.`, 'A CSS/TypeScript custom-property definition, or var(--name, fallback)', name);
      }
      if (item.canonical) return;
      const literal = node.type === 'word' ? node.value : node.type === 'function' && /^rgba?$/i.test(node.value) ? valueParser.stringify(node) : null;
      const token = literal && colors.get(opaqueColor(literal));
      if (token) {
        const endLine = current.line + item.value.slice(node.sourceIndex, node.sourceEndIndex).split('\n').length - 1;
        const added = changed && (additions.get(item.file) === null || [...(additions.get(item.file) ?? [])].some(line => line >= current.line && line <= endLine));
        add('UI-TOKEN-COLOR', added ? 'error' : 'warning', current, `Color ${literal} duplicates ${token}${added ? ' on an added line' : ' (existing literal; advisory)'}.`, `var(${token})`, literal);
        return false;
      }
    });
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.ruleId.localeCompare(b.ruleId));
  return { findings, coverage: {
    mode: changed ? 'changed' : 'all', base: changed ? base : null, filesScanned: files.length,
    filesChecked: files.filter(selected).length, tokenReferenceFilesChecked: files.length, tokenDefinitions: definitions.size, canonicalColors: colors.size,
    sourceRoots, styleEntries: [...styleEntries], unresolvedDynamicProperties: unresolved,
    limitations: ['Token existence is repository-wide, not a proof of cascade/inheritance at runtime; references are checked across all sources even in changed mode.', 'Dynamic names are resolved only for literals and Object.entries object-key loops.', 'Color comparison covers opaque hex/rgb equivalents of :root tokens in popup/style.css; existing literals are warnings.', 'CSS-in-JS templates and arbitrary runtime styles are not evaluated.'],
  } };
}
