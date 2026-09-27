import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { listModels, createLMStudioTutor, normalizeEndpoint } from '../src/lm-studio.mjs';

const result = { verdict: 'good', corrected: 'I like coffee.', feedback: ['잘 썼어요.'] };
test('LM Studio lists only LLMs, sends isolated structured requests, and rejects invalid feedback', async t => {
  const requests = [];
  let invalid = false;
  let failOnce = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/models') return res.end(JSON.stringify({ models: [
      { type: 'llm', key: 'model-a', display_name: 'Model A', format: 'mlx' },
      { type: 'embedding', key: 'embed' },
    ] }));
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const failThisTime = invalid || failOnce;
    failOnce = false;
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(failThisTime ? { ...result, verdict: 'unknown' } : result) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await listModels(endpoint)).map(m => m.id), ['model-a']);
  const tutor = await createLMStudioTutor({ endpoint, modelId: 'model-a' });
  const input = { korean: '커피를 좋아해요.', reference: 'I like coffee.', answer: 'I like coffee.' };
  assert.equal((await tutor.review(input)).verdict, 'good');
  await tutor.review(input);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, 'model-a');
  assert.equal(requests[1].messages.length, 2);
  assert.deepEqual(JSON.parse(requests[0].messages[1].content), input);
  assert.equal(requests[0].response_format.json_schema.strict, true);
  failOnce = true;
  const beforeRetry = requests.length;
  assert.equal((await tutor.review(input)).verdict, 'good');
  assert.equal(requests.length, beforeRetry + 2);
  assert.match(requests.at(-1).messages[0].content, /previous attempt failed validation/);
  assert.equal(requests.at(-1).messages.length, 2);
  invalid = true;
  const beforeFailure = requests.length;
  await assert.rejects(tutor.review(input), /피드백 형식/);
  assert.equal(requests.length, beforeFailure + 2);
  await tutor.dispose();
  await assert.rejects(tutor.review(input), /변경/);
  await assert.rejects(createLMStudioTutor({ endpoint, modelId: 'embed' }), /없어요/);
});

test('endpoint stays local and rejects credentials, redirects targets, and arbitrary paths', () => {
  assert.equal(normalizeEndpoint('http://localhost:1234/v1'), 'http://localhost:1234');
  for (const value of ['https://example.com', 'http://192.168.0.1', 'http://localhost/admin', 'http://user:pass@localhost', 'file:///tmp/test']) {
    assert.throws(() => normalizeEndpoint(value));
  }
});

test('model selection persists, releases bundled tutor, blocks races, and recovers from offline LM Studio', async t => {
  t.mock.method(console, 'error', () => {});
  const dataDir = await mkdtemp(join(tmpdir(), 'write-models-'));
  let disposed = 0;
  let release;
  let started;
  let offline = false;
  const reviewing = new Promise(resolve => { started = resolve; });
  const options = {
    port: 0, dataDir, modelPath: new URL('../package.json', import.meta.url),
    tutorFactory: async () => ({ dispose() { disposed++; }, async review() {
      started(); await new Promise(resolve => { release = resolve; });
      return { ...result, next: { korean: '다음', reference: 'Next.' } };
    } }),
    modelLister: async () => [{ id: 'model-a' }],
    lmTutorFactory: async () => { if (offline) throw new Error('LM Studio offline'); return { review() {}, dispose() {} }; },
  };
  let app = await startServer(options);
  t.after(async () => { release?.(); await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  await app.ready;
  const post = (route, data, headers = {}) => fetch(app.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  const selection = { provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234', modelId: 'model-a' };
  const prompt = await (await fetch(app.url + '/api/prompt')).json();
  const pending = post('/api/review', { promptId: prompt.id, answer: 'I like coffee.' });
  await reviewing;
  assert.equal((await post('/api/settings', selection)).status, 409);
  release(); await pending;
  assert.equal((await post('/api/settings', selection, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post('/api/settings', { ...selection, modelId: 'missing' })).status, 400);
  assert.equal((await post('/api/settings', selection)).status, 202);
  async function settle() {
    for (let i = 0; i < 100; i++) {
      const status = await (await fetch(app.url + '/api/status')).json();
      if (status.state !== 'loading') return status;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('model switch did not finish');
  }
  assert.equal((await settle()).state, 'ready');
  assert.equal(disposed, 1);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'settings.json'), 'utf8')), selection);
  await app.close();
  offline = true;
  app = await startServer(options); await app.ready;
  assert.equal((await settle()).state, 'error');
  assert.equal((await (await fetch(app.url + '/api/settings')).json()).modelId, 'model-a');
  assert.equal((await post('/api/settings', { ...selection, provider: 'bundled' })).status, 202);
  assert.equal((await settle()).state, 'ready');
  assert.equal((await (await fetch(app.url + '/api/settings')).json()).provider, 'bundled');
});
