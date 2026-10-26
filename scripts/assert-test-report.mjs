#!/usr/bin/env node
/**
 * Fail CI unless a Vitest JSON report shows every test passed with zero
 * skipped/todo tests, and every required test file actually ran.
 *
 * Usage: node scripts/assert-test-report.mjs <report.json> [requiredFile ...]
 *   requiredFile may be "path" or "path:pattern" (pattern = substring that at
 *   least one passed test's full name must contain).
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

const [reportPath, ...required] = process.argv.slice(2);
if (!reportPath) {
  console.error('usage: assert-test-report.mjs <report.json> [requiredFile[:pattern] ...]');
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const errors = [];

const files = report.testResults.map((r) => {
  const tests = r.assertionResults;
  const count = (s) => tests.filter((t) => t.status === s).length;
  return {
    file: relative(process.cwd(), r.name),
    tests,
    passed: count('passed'),
    failed: count('failed'),
    skipped: tests.filter((t) => ['skipped', 'pending', 'todo', 'disabled'].includes(t.status)).length,
  };
});

console.log('Suite results:');
for (const f of files) {
  console.log(`  ${f.file}: ${f.passed} passed, ${f.failed} failed, ${f.skipped} skipped`);
}
console.log(
  `Total: ${report.numPassedTests} passed, ${report.numFailedTests} failed, ` +
    `${report.numPendingTests} skipped, ${report.numTodoTests} todo (of ${report.numTotalTests})`
);

if (!report.success) errors.push('report.success is false');
if (report.numFailedTests > 0) errors.push(`${report.numFailedTests} failed tests`);
if (report.numPendingTests > 0) errors.push(`${report.numPendingTests} skipped tests (skips are not allowed)`);
if (report.numTodoTests > 0) errors.push(`${report.numTodoTests} todo tests (placeholders are not allowed)`);
if (report.numTotalTests === 0) errors.push('no tests ran');

for (const f of files) {
  if (f.skipped > 0) errors.push(`${f.file}: ${f.skipped} skipped`);
  if (f.tests.length === 0) errors.push(`${f.file}: no tests`);
}

for (const spec of required) {
  const [file, pattern] = spec.split(':');
  const f = files.find((x) => x.file === file);
  if (!f) {
    errors.push(`required test file did not run: ${file}`);
    continue;
  }
  if (f.passed === 0) errors.push(`required test file has no passing tests: ${file}`);
  if (pattern && !f.tests.some((t) => t.status === 'passed' && t.fullName.includes(pattern))) {
    errors.push(`required test "${pattern}" did not pass in ${file}`);
  }
}

if (errors.length > 0) {
  console.error('\nTest report check FAILED:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('\nTest report check passed: 0 failed, 0 skipped.');
