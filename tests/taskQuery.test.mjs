// task-7bdb94445321 follow-up — proves the tag DSL engine (src/tagDsl.mjs) is
// reusable for a DIFFERENT record shape via the parameterized field catalogue
// (parse opts.fields) + accessor (evaluate opts.fieldValue). This is the
// mechanism src/components/newhome/taskQuery.ts uses to query the roster; here
// we exercise the engine directly with a task-shaped schema (the TS module
// itself can't be imported by the .mjs test runner without a transpile step).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, evaluate } from '../src/tagDsl.mjs';

// A task-flavored catalogue + accessor, mirroring taskQuery.buildTaskQuerySchema.
const FIELDS = {
  title: 'string',
  status: 'string',
  who: 'string',
  repeatable: 'bool',
  priority: 'number',
  due: 'time',
  // a "custom" field
  insurance: 'string',
};

function fieldValue(field, row) {
  switch (field) {
    case 'title':
      return row.title;
    case 'status':
      return row.status;
    case 'who':
      return row.who;
    case 'repeatable':
      return !!row.repeatable;
    case 'priority':
      return row.priority;
    case 'due':
      return row.due; // epoch ms
    case 'insurance':
      return row.custom?.insurance;
    default:
      return undefined;
  }
}

const NOW = 1_000_000_000_000; // fixed clock
const run = (query, row) =>
  evaluate(parse(query, { fields: FIELDS }), row, { fieldValue, now: NOW });

test('boolean combination over task fields (and / or / not)', () => {
  const t = { status: 'needs', who: 'agent', repeatable: true };
  assert.equal(run('status = needs and repeatable', t), true);
  assert.equal(run('status = done or repeatable', t), true);
  assert.equal(run('not repeatable', t), false);
  assert.equal(run('status = needs and who = human', t), false);
});

test('bool-field truthiness shorthand', () => {
  assert.equal(run('repeatable', { repeatable: true }), true);
  assert.equal(run('repeatable', { repeatable: false }), false);
});

test('in (...) and numeric comparison', () => {
  assert.equal(run('status in (needs, failed)', { status: 'failed' }), true);
  assert.equal(run('status in (needs, failed)', { status: 'done' }), false);
  assert.equal(run('priority >= 2', { priority: 3 }), true);
  assert.equal(run('priority >= 2', { priority: 1 }), false);
});

test('time field with relative now offset', () => {
  const soon = { due: NOW + 3 * 24 * 60 * 60 * 1000 };
  const later = { due: NOW + 30 * 24 * 60 * 60 * 1000 };
  assert.equal(run('due < now+7d', soon), true);
  assert.equal(run('due < now+7d', later), false);
  // a missing time field does not match a bounded comparison
  assert.equal(run('due < now+7d', {}), false);
});

test('regex match (~) and a custom field', () => {
  assert.equal(run('insurance ~ pend', { custom: { insurance: 'pending' } }), true);
  assert.equal(run('insurance = pending', { custom: { insurance: 'pending' } }), true);
  assert.equal(run('insurance = pending', { custom: { insurance: 'approved' } }), false);
});

test('unknown field is rejected at parse time', () => {
  assert.throws(() => parse('bogus = 1', { fields: FIELDS }), /unknown field/);
});

test('default (file) catalogue still works unchanged', () => {
  // Back-compat: no opts.fields => the file FIELDS; no opts.fieldValue => the
  // built-in file accessor.
  assert.equal(evaluate(parse('size > 1KB'), { size: 2048 }), true);
  assert.equal(evaluate(parse('is_dir'), { is_dir: true }), true);
});
