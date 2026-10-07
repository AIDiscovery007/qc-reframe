import test from 'node:test';
import assert from 'node:assert/strict';
import { exampleScenarios, exampleCoverage, renderExamples, prepareExample, checkExample } from '../../agent-tool/ui/examples.mjs';
import { components, rules, scenarios } from '../../agent-tool/ui/catalog.mjs';

test('representative examples declare states, production ownership and runnable preview paths', () => {
  const states = new Set(exampleScenarios.flatMap(item => item.states));
  for (const state of ['empty', 'loading', 'busy', 'failed', 'disabled', 'long-text', 'narrow', 'keyboard', 'dialog', 'focus']) assert.ok(states.has(state), state);
  assert.equal(new Set(exampleScenarios.map(item => item.id)).size, exampleScenarios.length);
  for (const item of exampleScenarios) {
    assert.ok(scenarios.includes(item));
    assert.ok(/^\/(workspace|popup)\.html\?state=/.test(item.path));
    assert.ok(item.components.every(name => components.some(component => component.name === name)));
    assert.ok(item.rules.every(id => rules.some(rule => rule.id === id)));
    assert.ok(item.steps && item.viewport.width && item.viewport.height);
  }
  assert.ok(exampleCoverage.every(item => item.source && item.examples.length && /Representative/.test(item.scope)));
});

test('example navigation contains real preview links and states its limits', () => {
  const html = renderExamples({ baseURL: 'http://127.0.0.1:54321' });
  for (const item of exampleScenarios) assert.ok(html.includes(item.id));
  assert.equal((html.match(/<a href=/g) || []).length, exampleScenarios.length);
  assert.ok(html.includes('http://127.0.0.1:54321/workspace.html?state=alignment&amp;reference=pending'));
  assert.ok(html.includes('headless'));
  assert.ok(!html.includes('<script'));
});

test('navigation refuses remote URLs or embedded credentials', () => {
  for (const baseURL of ['https://example.com', 'http://localhost:1234', 'file:///tmp/example.html', 'http://user:pass@127.0.0.1:1234']) assert.throws(() => renderExamples({ baseURL }), /local preview/);
});

test('unknown examples cannot silently pass or prepare another page', async () => {
  await assert.rejects(prepareExample({}, 'unknown'), /Unknown component example/);
  await assert.rejects(checkExample({}, { id: 'example-workspace-empty', example: '' }), /Unknown component example/);
});
