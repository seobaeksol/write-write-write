import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';

// Only HTTP boundaries use a stub; real GGUF inference is checked separately.
const feedback = { verdict: 'good', corrected: 'I like coffee.', feedback: ['자연스러운 문장이에요.'], alternative: '다른 표현으로 I enjoy coffee.도 쓸 수 있어요.', next: { korean: '오늘은 날씨가 좋아요.', reference: 'The weather is nice today.' } };
async function fixture(t, review = async () => feedback) {
  const dataDir = await mkdtemp(join(tmpdir(), 'write-write-test-'));
  const options = { port: 0, dataDir, modelPath: new URL('../package.json', import.meta.url), tutorFactory: async () => ({ review, dispose() {} }) };
  const app = await startServer(options);
  await app.ready;
  t.after(async () => {
    await app.close();
    assert.ok(dataDir.startsWith(join(tmpdir(), 'write-write-test-')));
    await rm(dataDir, { recursive: true, force: true });
  });
  const get = async (route) => (await fetch(app.url + route)).json();
  const post = (data, headers = {}) => fetch(app.url + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  return { app, options, get, post };
}

test('writing → feedback → next, and saved prompt survives a restart', async (t) => {
  const { app, options, get, post } = await fixture(t);
  assert.equal((await get('/api/status')).state, 'ready');
  const prompt = await get('/api/prompt');
  const response = await post({ promptId: prompt.id, answer: 'I like coffee.' });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.verdict, 'good');
  assert.equal(result.alternative, feedback.alternative);
  assert.equal(result.nextPrompt, undefined);
  const next = await get('/api/prompt?after=' + prompt.id);
  assert.notEqual(next.id, prompt.id);
  assert.equal(next.reference, undefined);
  assert.deepEqual(await get('/api/prompt?after=' + prompt.id), next);
  assert.deepEqual(await get('/api/prompt?id=' + prompt.id), prompt);
  await app.close();
  const restored = await startServer(options);
  await restored.ready;
  try {
    assert.deepEqual(await (await fetch(restored.url + '/api/prompt?id=' + prompt.id)).json(), prompt);
  } finally { await restored.close(); }

});

test('invalid input and cross-origin requests never run inference', async (t) => {
  let calls = 0;
  const { app, get, post } = await fixture(t, async () => { calls++; return feedback; });
  const prompt = await get('/api/prompt');
  for (const answer of ['', 'x'.repeat(1201), null]) assert.equal((await post({ promptId: prompt.id, answer })).status, 400);
  assert.equal((await post({ promptId: 'expired', answer: 'Hello.' })).status, 404);
  assert.equal((await post({ promptId: prompt.id, answer: 'Hello.' }, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await fetch(app.url + '/package.json')).status, 404);
  assert.equal(calls, 0);
});

test('concurrent review is rejected and a failed inference can be retried', async (t) => {
  t.mock.method(console, 'error', () => {});
  let begin;
  const started = new Promise(resolve => { begin = resolve; });
  let release;
  let calls = 0;
  const { get, post } = await fixture(t, async () => {
    if (++calls === 1) { begin(); await new Promise(resolve => { release = resolve; }); throw new Error('simulated inference failure'); }
    return feedback;
  });
  const prompt = await get('/api/prompt');
  const data = { promptId: prompt.id, answer: 'Hello.' };
  const first = post(data);
  await started;
  assert.equal((await post(data)).status, 429);
  release();
  assert.equal((await first).status, 500);
  assert.equal((await post(data)).status, 200);
});

test('bootstrap reports real progress and keeps practice closed until ready', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'write-write-bootstrap-'));
  let finishLoading;
  const loading = new Promise(resolve => { finishLoading = resolve; });
  const app = await startServer({
    port: 0,
    dataDir,
    modelPath: new URL('../package.json', import.meta.url),
    tutorFactory: async ({ onProgress }) => {
      onProgress({ stage: 'model', progress: 57, message: '테스트 모델 로딩 중' });
      await loading;
      return { review: async () => feedback, dispose() {} };
    },
  });
  t.after(async () => {
    finishLoading();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const during = await (await fetch(app.url + '/api/status')).json();
  assert.deepEqual(during, { state: 'loading', stage: 'model', progress: 57, message: '테스트 모델 로딩 중' });
  assert.equal((await fetch(app.url + '/api/prompt')).status, 503);
  finishLoading();
  await app.ready;
  const ready = await (await fetch(app.url + '/api/status')).json();
  assert.deepEqual(ready, { state: 'ready', stage: 'ready', progress: 100, message: '준비됐어요.' });
});

test('a failed bootstrap explains recovery and can retry initialization', async (t) => {
  t.mock.method(console, 'error', () => {});
  const dataDir = await mkdtemp(join(tmpdir(), 'write-write-retry-'));
  let attempts = 0;
  const app = await startServer({
    port: 0,
    dataDir,
    modelPath: new URL('../package.json', import.meta.url),
    tutorFactory: async () => {
      if (++attempts === 1) throw new Error('simulated startup failure');
      return { review: async () => feedback, dispose() {} };
    },
  });
  await app.ready;
  t.after(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const failed = await (await fetch(app.url + '/api/status')).json();
  assert.equal(failed.state, 'error');
  assert.match(failed.message, /연결하지 못했어요/);
  assert.match(failed.action, /다시 시도/);
  assert.equal((await fetch(app.url + '/api/bootstrap/retry', { method: 'POST' })).status, 202);
  for (let count = 0; count < 20; count++) {
    const status = await (await fetch(app.url + '/api/status')).json();
    if (status.state === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await (await fetch(app.url + '/api/status')).json()).state, 'ready');
  assert.equal(attempts, 2);
});

test('learning API records one event per presentation, caches duplicate submissions, and exports history', async t => {
  let calls=0;
  const {app,get,post}=await fixture(t,async()=>{calls++;return feedback;});
  const prompt=await get('/api/prompt?session=learning-api');
  const body={promptId:prompt.id,answer:'I like coffee.',submissionId:'same-submission',activeMs:4500};
  const first=await (await post(body)).json();
  assert.deepEqual(await (await post(body)).json(),first);
  assert.equal(calls,1);
  const summary=await get('/api/learning');
  assert.equal(summary.completed,1);assert.equal(summary.attempts,1);
  const exported=await get('/api/learning/export');
  assert.equal(exported.tables.attempts[0].active_ms,4500);
  assert.equal(exported.tables.review_events.length,1);
  const report=await fetch(app.url+'/api/learning/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({promptId:prompt.id})});
  assert.equal(report.status,200);assert.equal((await get('/api/learning')).completed,0);
});

test('an occupied port releases the database so desktop fallback can start', async t => {
  const first=await fixture(t);
  const dir=await mkdtemp(join(tmpdir(),'write-port-fallback-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const options={...first.options,dataDir:dir,port:Number(new URL(first.app.url).port)};
  await assert.rejects(startServer(options),{code:'EADDRINUSE'});
  const fallback=await startServer({...options,port:0});
  await fallback.ready;await fallback.close();
});
