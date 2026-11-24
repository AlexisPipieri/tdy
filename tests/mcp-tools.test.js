'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../src/task-store');
const { createTools } = require('../src/mcp-tools');

const NOW = new Date(2026, 10, 24, 10, 0);   // Tue Nov 24 2026, 10:00 local

function setup({ tasks = [], projects = [], prefs = {} } = {}) {
  const store = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'tdy-mcp-')));
  store.write({ tasks, projects });
  const { call } = createTools(store, { readPrefs: () => prefs, now: () => NOW });
  const json = (name, args) => {
    const r = call(name, args);
    assert.ok(!r.isError, r.text);
    return JSON.parse(r.text);
  };
  return { store, call, json };
}

const task = (id, extra = {}) => ({
  id, title: id, bucket: 'anytime', completed: false, createdAt: '2026-11-01T09:00:00.000Z', completedAt: null,
  projectId: null, deadline: null, ...extra,
});

test('list_tasks returns open tasks only, with today, and filters', () => {
  const { json } = setup({
    projects: [{ id: 'w', name: 'Work', color: '#000' }],
    tasks: [
      task('a', { bucket: 'today', projectId: 'w', deadline: '2026-11-20' }),
      task('b', { deadline: '2026-11-30' }),
      task('c', { completed: true, completedAt: '2026-11-23T10:00:00.000Z' }),
    ],
  });
  const all = json('list_tasks', {});
  assert.equal(all.today, '2026-11-24');
  assert.deepEqual(all.tasks.map(t => t.id), ['a', 'b']);
  assert.equal(all.tasks[0].label, 'Work');
  assert.deepEqual(json('list_tasks', { bucket: 'anytime' }).tasks.map(t => t.id), ['b']);
  assert.deepEqual(json('list_tasks', { label: 'work' }).tasks.map(t => t.id), ['a']);
  assert.deepEqual(json('list_tasks', { label: 'nope' }).tasks, []);
  assert.deepEqual(json('list_tasks', { overdue: true }).tasks.map(t => t.id), ['a']);
  assert.deepEqual(json('list_tasks', { due_before: '2026-11-30' }).tasks.map(t => t.id), ['a', 'b']);
});

test('list_completed defaults to the last 7 days, oldest first', () => {
  const { json } = setup({
    tasks: [
      task('recent', { completed: true, completedAt: new Date(2026, 10, 23, 18).toISOString() }),
      task('older',  { completed: true, completedAt: new Date(2026, 10, 18, 9).toISOString() }),
      task('old',    { completed: true, completedAt: new Date(2026, 10, 10, 9).toISOString() }),
      task('open'),
    ],
  });
  const r = json('list_completed', {});
  assert.equal(r.since, '2026-11-17');
  assert.deepEqual(r.tasks.map(t => t.id), ['older', 'recent']);
  assert.deepEqual(json('list_completed', { since: '2026-11-01', until: '2026-11-18' }).tasks.map(t => t.id), ['old', 'older']);
});

test('add_tasks follows the add-position setting and keeps the batch order', () => {
  for (const [prefs, expected] of [[{}, ['x', 'n1', 'n2']], [{ newTaskPosition: 'top' }, ['n1', 'n2', 'x']]]) {
    const { call, store } = setup({ tasks: [task('x')], prefs });
    const r = call('add_tasks', { tasks: [{ title: 'n1' }, { title: 'n2', bucket: 'today', deadline: '2026-12-01' }] });
    assert.ok(!r.isError, r.text);
    const saved = store.read().tasks;
    assert.deepEqual(saved.map(t => t.title), expected);
    const n2 = saved.find(t => t.title === 'n2');
    assert.equal(n2.bucket, 'today');
    assert.equal(n2.deadline, '2026-12-01');
  }
});

test('labels are matched case-insensitively and created once', () => {
  const { call, store, json } = setup({ projects: [{ id: 'w', name: 'Work', color: '#000' }] });
  const r = call('add_tasks', { tasks: [{ title: 'a', label: 'work' }, { title: 'b', label: 'Home' }, { title: 'c', label: 'home' }] });
  assert.match(r.text, /new label: Home/);
  const data = store.read();
  assert.deepEqual(data.projects.map(p => p.name), ['Work', 'Home']);
  assert.deepEqual(json('list_labels', {}), [{ name: 'Work', open_tasks: 1 }, { name: 'Home', open_tasks: 2 }]);
});

test('invalid input is reported as an error and nothing is written', () => {
  const { call, store } = setup({ tasks: [task('x')] });
  for (const args of [
    { tasks: [] },
    { tasks: [{ title: ' ' }] },
    { tasks: [{ title: 'a', deadline: '2026-02-30' }] },
    { tasks: [{ title: 'a', deadline: 'tomorrow' }] },
    { tasks: [{ title: 'a', bucket: 'later' }] },
  ]) {
    assert.equal(call('add_tasks', args).isError, true, JSON.stringify(args));
  }
  assert.equal(call('update_task', { id: 'missing', title: 'y' }).isError, true);
  assert.equal(call('nope', {}).isError, true);
  assert.equal(store.read().tasks.length, 1);
});

test('complete, reopen, update and delete', () => {
  const { call, store } = setup({ tasks: [task('a'), task('b'), task('c', { bucket: 'today' })] });
  call('complete_task', { id: 'a' });
  let a = store.read().tasks.find(t => t.id === 'a');
  assert.equal(a.completed, true);
  assert.equal(a.completedAt, NOW.toISOString());

  call('update_task', { id: 'a', completed: false });
  a = store.read().tasks.find(t => t.id === 'a');
  assert.equal(a.completed, false);
  assert.equal(a.completedAt, null);

  call('update_task', { id: 'b', title: 'renamed', deadline: '2026-12-24', label: 'Home', bucket: 'today' });
  const b = store.read().tasks.find(t => t.id === 'b');
  assert.equal(b.title, 'renamed');
  assert.equal(b.deadline, '2026-12-24');
  assert.equal(b.bucket, 'today');
  call('update_task', { id: 'b', deadline: '', label: '' });
  const b2 = store.read().tasks.find(t => t.id === 'b');
  assert.equal(b2.deadline, null);
  assert.equal(b2.projectId, null);

  call('delete_task', { id: 'c' });
  assert.deepEqual(store.read().tasks.map(t => t.id), ['a', 'b']);
});

test('position moves a task within the open tasks of its bucket', () => {
  const { call, store } = setup({
    tasks: [task('t1', { bucket: 'today' }), task('a1'), task('a2'), task('t2', { bucket: 'today' }), task('a3')],
  });
  call('update_task', { id: 'a3', position: 'top' });
  assert.deepEqual(store.read().tasks.map(t => t.id), ['t1', 'a3', 'a1', 'a2', 't2']);
  call('update_task', { id: 't1', position: 'bottom' });
  assert.deepEqual(store.read().tasks.map(t => t.id), ['a3', 'a1', 'a2', 't2', 't1']);
});
