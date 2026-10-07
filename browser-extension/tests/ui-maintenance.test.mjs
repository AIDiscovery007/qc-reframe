import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { reviewExceptions, checkChange } from '../../agent-tool/ui/maintenance.mjs';

const finding = { ruleId: 'UI-TOKEN-COLOR', file: 'a.css', line: 2, expected: 'var(--ink)', actual: '#26241f', severity: 'warning' };
const entry = { ...finding, owner: 'design team', reason: 'scoped migration', reviewCondition: 'replace after shared token migration', expires: '2026-11-01' };
test('precise advisory exceptions remain visible and expire without suppressing errors', () => {
  const valid = reviewExceptions([finding], [entry], '2026-10-07');
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.findings[0].severity, 'warning');
  assert.equal(valid.findings[0].exception.owner, entry.owner);
  assert.match(reviewExceptions([finding], [entry], '2026-11-01').errors.join(), /到期/);
  assert.match(reviewExceptions([{ ...finding, severity: 'error' }], [entry], '2026-10-07').errors.join(), /不能放行/);
  assert.match(reviewExceptions([{ ...finding, line: 3 }], [entry], '2026-10-07').errors.join(), /失效/);
  assert.match(reviewExceptions([finding], [entry, entry], '2026-10-07').errors.join(), /重复/);
  for (const mutation of [{ file: '*.css' }, { reason: '' }, { owner: '' }, { expires: '2026-02-30' }, { reviewCondition: '' }]) {
    assert.ok(reviewExceptions([finding], [{ ...entry, ...mutation }], '2026-10-07').errors.length);
  }
});

test('design change records reject stale content, missing files and paths outside their root', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ui-change-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'style.css'), 'original');
  const record = { schemaVersion: 1, intent: 'Reuse semantic token', reviewStatus: 'proposed', rules: [], scenarios: [], files: [{ path: 'style.css', sha256: createHash('sha256').update('original').digest('hex') }] };
  assert.equal((await checkChange(record, directory)).status, 'passed');
  await writeFile(join(directory, 'style.css'), 'modified');
  assert.equal((await checkChange(record, directory)).status, 'failed');
  for (const path of ['missing.css', '../outside.css']) {
    assert.equal((await checkChange({ ...record, files: [{ ...record.files[0], path }] }, directory)).status, 'failed');
  }
});
