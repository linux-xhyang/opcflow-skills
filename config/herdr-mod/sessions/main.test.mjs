import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '')
  .replace('export default class Sessions', 'class Sessions');
const id = '01a1e430-bb9e-76d1-b5aa-4b6200e8ed6a';
const row = { cli: 'traex', id, title: 'task', cwd: '/work', path: '/old/fragment.jsonl', machine: null };

function fixture(execImpl) {
  const calls = [];
  const jobs = [];
  const timers = [];
  const space = { id: 'space', name: 'Project', active: true, folder: '/work', machine: null };
  const Sessions = runInNewContext(source + '\nSessions;', {
    View: class {},
    spaces: () => [space], panes: () => [],
    appHome: () => '/app',
    exec: async (...args) => { calls.push(args); return execImpl(...args); },
    run: () => {},
  });
  const view = new Sessions();
  Object.assign(view, {
    sessions: [row], scanGeneration: 0, loading: false, refreshPending: false,
    showArchived: false, actionKey: null, currentKey: null,
    pendingDelete: null, actionError: null, error: null,
  });
  const cx = { notify() {}, timer: { after(ms, fn) { timers.push({ ms, fn }); } }, spawn(fn) { jobs.push(fn(cx)); } };
  async function drain() { while (jobs.length) await jobs.shift(); }
  return { view, cx, calls, space, drain, timers };
}

const success = { code: 0, stdout: '{"sessions":[],"warnings":[]}', stderr: '' };

test('delete needs two clicks and passes a logical ID rather than a fragment path', async () => {
  const f = fixture(() => success);
  f.view.requestDelete(row, f.cx);
  assert.equal(f.calls.length, 0);
  // A changed physical path still represents the same confirmed logical thread.
  f.view.requestDelete({ ...row, path: '/new/fragment.jsonl' }, f.cx);
  await f.drain();
  const argv = Array.from(f.calls[0][1]);
  assert.deepEqual(argv.slice(-3), ['--delete', 'traex', id]);
  assert.equal(argv.includes(row.path), false);
  assert.equal(f.view.sessions.length, 0);
  assert.equal(f.calls.length, 2); // The official action followed by a fresh list.
});

test('a dependency rejection remains visible and does not remove the row', async () => {
  const f = fixture(() => ({ code: 1, stdout: '', stderr: 'history is referenced' }));
  f.view.requestDelete(row, f.cx);
  f.view.requestDelete(row, f.cx);
  await f.drain();
  assert.equal(f.view.sessions.length, 1);
  assert.match(f.view.actionError, /referenced/);
  assert.equal(f.view.actionKey, null);
  assert.equal(f.calls.length, 1);
});

test('archive and unarchive pass logical IDs and refresh the selected list', async () => {
  for (const action of ['archive', 'unarchive']) {
    const f = fixture(() => success);
    f.view.showArchived = action === 'unarchive';
    f.view.manageSession(row, action, f.cx);
    await f.drain();
    assert.deepEqual(Array.from(f.calls[0][1]).slice(-3), [`--${action}`, 'traex', id]);
    assert.equal(f.calls.length, 2);
    assert.equal(Array.from(f.calls[1][1]).includes('--archived'), action === 'unarchive');
  }
});

test('a scan in flight before deletion cannot reintroduce the deleted row', async () => {
  let resolveOld;
  const oldScan = new Promise(resolve => { resolveOld = resolve; });
  let scans = 0;
  const f = fixture((_command, argv) => {
    if (Array.from(argv).includes('--delete')) return success;
    scans += 1;
    return scans === 1 ? oldScan : success;
  });
  f.view.refresh(f.cx);
  f.view.requestDelete(row, f.cx);
  f.view.requestDelete(row, f.cx);
  // Let the successful mutation queue a replacement scan before the old one ends.
  await new Promise(resolve => setImmediate(resolve));
  resolveOld({ code: 0, stdout: JSON.stringify({ sessions: [row], warnings: [] }), stderr: '' });
  await f.drain();
  assert.equal(scans, 2);
  assert.equal(f.view.sessions.length, 0);
});

test('current and remote sessions cannot be deleted or archived', async () => {
  const f = fixture(() => success);
  f.view.currentKey = `traex:${id}`;
  f.view.requestDelete(row, f.cx);
  f.view.manageSession(row, 'archive', f.cx);
  assert.equal(f.calls.length, 0);
  f.view.currentKey = null;
  f.space.machine = 'remote';
  const remote = { ...row, machine: 'remote' };
  f.view.requestDelete(remote, f.cx);
  f.view.manageSession(remote, 'archive', f.cx);
  assert.equal(f.calls.length, 0);
});

test('list warnings are shown without losing other CLI sessions', async () => {
  const other = { ...row, cli: 'claude' };
  const f = fixture(() => ({ code: 0, stdout: JSON.stringify({
    sessions: [other], warnings: ['TRAE unavailable'],
  }), stderr: '' }));
  f.view.refresh(f.cx);
  await f.drain();
  assert.equal(f.view.sessions[0].cli, 'claude');
  assert.match(f.view.error, /TRAE unavailable/);
});

test('a slow remote scan finishes loading without an automatic refresh queue', async () => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const f = fixture(() => response);
  f.space.machine = 'remote';
  f.view.scannerSource = async () => 'encoded-scanner';
  f.view.refresh(f.cx);
  // The ten-second periodic refresh fires while the previous remote call waits.
  f.view.refresh(f.cx);
  finish(success);
  await f.drain();
  assert.equal(f.view.loading, false);
  assert.equal(f.calls.length, 1, 'the timer must not immediately start another remote scan');
});

test('a disconnected remote call leaves loading at the UI deadline and ignores late output', async () => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const f = fixture(() => response);
  f.space.machine = 'remote';
  f.view.scannerSource = async () => 'encoded-scanner';
  f.view.refresh(f.cx);
  const deadline = f.timers.find(timer => timer.ms === 35000);
  assert.ok(deadline, 'a remote call must have a UI deadline independent of exec');
  deadline.fn(f.cx);
  assert.equal(f.view.loading, false);
  assert.match(f.view.error, /超时/);
  finish(success);
  await f.drain();
  assert.match(f.view.error, /超时/);
});
