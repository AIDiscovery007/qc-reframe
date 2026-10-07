import test from 'node:test';
import assert from 'node:assert/strict';
import { verify } from './runner.mjs';

for (const scenario of ['example-long-instruction', 'example-narrow-input', 'example-narrow-result']) {
  test(`runner combines geometry and state checks without sending interaction rules to geometry: ${scenario}`, { timeout: 45000 }, async () => {
    const result = await verify({ scenario, build: false });
    assert.equal(result.status, 'passed', JSON.stringify(result.scenarios.flatMap(item => item.checks.filter(check => check.status === 'failed'))));
    const checks = result.scenarios[0].checks;
    assert.ok(checks.some(check => check.ruleId === 'UI-LAYOUT-CANVAS' && check.status === 'passed'));
    assert.ok(checks.some(check => check.ruleId === 'UI-EXAMPLE-STATE' && check.status === 'passed'));
  });
}
