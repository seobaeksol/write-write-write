import http from 'node:http';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openLearningStore } from './learning-store.mjs';
import { createLearningWorker } from './learning-worker.mjs';
import { normalizeEndpoint, listModels, createLMStudioTutor } from './lm-studio.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/icon.png', ['icon.png', 'image/png']],
]);

export async function startServer({
  port = 3210,
  host = '127.0.0.1',
  dataDir = path.join(root, '.data'),
  modelPath,
  lmTutorFactory = createLMStudioTutor,
  modelLister = listModels,
  tutorFactory = async (options) => (await import('./tutor.mjs')).createTutor(options),
} = {}) {
  await mkdir(dataDir, { recursive: true });
  const settingsPath = path.join(dataDir, 'settings.json');
  let selection = { provider: 'bundled', endpoint: 'http://127.0.0.1:1234', modelId: '' };
  try {
    const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
    if (['bundled', 'lmstudio'].includes(saved.provider) && typeof saved.modelId === 'string') {
      selection = { provider: saved.provider, endpoint: normalizeEndpoint(saved.endpoint), modelId: saved.modelId };
    }
  } catch (error) { if (error.code !== 'ENOENT') console.warn('모델 설정을 기본값으로 시작합니다.'); }
  let switching = false;
  let closing = false;
  const learning = openLearningStore(dataDir);
  let worker;
  let closed = false;
  let state = 'loading';
  let stage = 'resources';
  let progress = 8;
  let message = '앱 리소스를 확인하고 있어요.';
  let action;
  let tutor;
  let startup;
  let busy = false;
  let activeReview;
  const allowedNames = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (host === '0.0.0.0') {
    for (const group of Object.values(networkInterfaces())) {
      for (const address of group ?? []) if (address.family === 'IPv4') allowedNames.add(address.address);
    }
  }
  const json = (res, status, data) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const fail = (status, error, code) => Object.assign(new Error(error), { status, code });
  async function readJson(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'JSON 형식으로 보내 주세요.');
    let body = '';
    for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) throw fail(413, '입력 내용이 너무 길어요.'); }
    try { return JSON.parse(body); } catch { throw fail(400, '입력 내용을 확인해 주세요.'); }
  }
  function localOnly(req) {
    if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw fail(403, '학습 데이터 관리는 이 컴퓨터에서 해 주세요.');
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const base = new URL(`http://${req.headers.host}`);
      if (!allowedNames.has(base.hostname) || Number(base.port || 80) !== server.address().port) {
        throw fail(403, '허용되지 않은 주소입니다.');
      }
      if (req.headers.origin && req.headers.origin !== base.origin) throw fail(403, '앱 화면에서 다시 시도해 주세요.');
      const url = new URL(req.url, base);
      if (req.method === 'POST' && url.pathname === '/api/activity') { await worker?.foreground(); return json(res,200,{ ok: true }); }
      if (url.pathname.startsWith('/api/learning')) {
        localOnly(req);
        if (req.method === 'GET' && url.pathname === '/api/learning') return json(res, 200, learning.stats());
        if (req.method === 'GET' && url.pathname === '/api/learning/export') return json(res, 200, learning.exportData());
        if (req.method === 'POST') {
          const data = await readJson(req);
          if (busy || switching || closing) throw fail(409, '현재 작업이 끝난 뒤 다시 시도해 주세요.');
          await worker?.foreground();
          if (busy || switching || closing) throw fail(409, '현재 작업이 끝난 뒤 다시 시도해 주세요.');
          if (url.pathname === '/api/learning/reset' && data?.confirmation === 'RESET') { learning.reset(); return json(res,200,{ reset: true }); }
          if (url.pathname === '/api/learning/generation' && typeof data?.enabled === 'boolean') { learning.setGeneration(data.enabled); return json(res,200,{ enabled: data.enabled }); }
          if (url.pathname === '/api/learning/report' && typeof data?.promptId === 'string') return json(res,200,learning.report(data.promptId));
          throw fail(400, '학습 설정을 확인해 주세요.');
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/prompt/reveal') {
        const data = await readJson(req);
        if (typeof data?.promptId !== 'string') throw fail(400,'문장을 확인해 주세요.');
        return json(res,200,learning.reveal(data.promptId));
      }
      if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, { ...selection, state });
      if (req.method === 'GET' && url.pathname === '/api/models') {
        let endpoint;
        try { endpoint = normalizeEndpoint(url.searchParams.get('endpoint') || selection.endpoint); }
        catch { throw fail(400, '이 컴퓨터의 LM Studio 서버 주소를 입력해 주세요.'); }
        try { return json(res, 200, { models: await modelLister(endpoint) }); }
        catch (error) { throw fail(503, error.message); }
      }
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        // Settings control the host's AI runtime; only the host can change them in LAN mode.
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw fail(403, '모델 설정은 앱이 실행 중인 컴퓨터에서 변경해 주세요.');
        if (busy || switching || state === 'loading' || closing) throw fail(409, '현재 작업이 끝난 뒤 모델을 변경해 주세요.');
        if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'JSON 형식으로 보내 주세요.');
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 4096) throw fail(413, '설정이 너무 길어요.');
        }
        let next;
        try {
          const data = JSON.parse(body);
          if (!['bundled', 'lmstudio'].includes(data.provider) || typeof data.modelId !== 'string' || data.modelId.length > 512 || (data.provider === 'lmstudio' && !data.modelId.trim())) throw new Error();
          next = { provider: data.provider, endpoint: normalizeEndpoint(data.endpoint), modelId: data.provider === 'lmstudio' ? data.modelId : '' };
        } catch { throw fail(400, '모델과 로컬 서버 주소를 확인해 주세요.'); }
        if (busy || switching || state === 'loading' || closing) throw fail(409, '현재 작업이 끝난 뒤 모델을 변경해 주세요.');
        switching = true;
        try {
          await worker?.foreground();
          if (next.provider === 'lmstudio') {
            const models = await modelLister(next.endpoint);
            if (!models.some(model => model.id === next.modelId)) throw fail(400, '목록에서 사용할 모델을 선택해 주세요.');
          }
          selection = next;
          void initialize(true);
          return json(res, 202, { ...selection, state });
        } catch (error) { throw error.status ? error : fail(503, error.message); }
        finally { switching = false; }
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { state, stage, progress, message, ...(action ? { action } : {}) });
      if (req.method === 'POST' && url.pathname === '/api/bootstrap/retry') {
        if (state === 'loading' || switching || closing) return json(res, 202, { state, stage, progress, message });
        if (state === 'ready') return json(res, 200, { state, stage, progress, message });
        void initialize();
        return json(res, 202, { state, stage, progress, message });
      }
      if (req.method === 'GET' && url.pathname === '/api/prompt') {
        if (state !== 'ready' || switching || closing) throw fail(503, message);
        await worker?.foreground();
        const id = url.searchParams.get('id');
        if (id) {
          const prompt = learning.presentation(id);
          if (!prompt) throw fail(404, '이전 문장이 만료됐어요. 새 문장을 시작해 주세요.', 'PROMPT_EXPIRED');
          return json(res, 200, learning.publicPrompt(prompt));
        }
        if (busy) throw fail(409, '피드백이 끝난 뒤 다음 문장으로 이동해 주세요.');
        const session = url.searchParams.get('session') || 'default';
        if (session.length > 100) throw fail(400, '세션을 확인해 주세요.');
        return json(res, 200, learning.select(session, url.searchParams.get('after'), url.searchParams.get('skip') === 'true'));
      }
      if (req.method === 'POST' && url.pathname === '/api/review') {
        if (state !== 'ready' || switching || closing) throw fail(503, message);
        if (busy) throw fail(429, '앞 문장을 확인하고 있어요. 잠시 후 다시 시도해 주세요.');
        const data = await readJson(req);
        if (!data || typeof data.promptId !== 'string' || typeof data.answer !== 'string' || !data.answer.trim() || data.answer.length > 1200 ||
            (data.submissionId !== undefined && (typeof data.submissionId !== 'string' || !data.submissionId || data.submissionId.length > 100)) ||
            (data.activeMs !== undefined && (!Number.isFinite(data.activeMs) || data.activeMs < 0 || data.activeMs > 3_600_000)) ||
            (data.assisted !== undefined && typeof data.assisted !== 'boolean') || (data.difficult !== undefined && typeof data.difficult !== 'boolean')) {
          throw fail(400, '영어 문장을 1~1,200자로 작성해 주세요.');
        }
        const prompt = learning.presentation(data.promptId);
        if (!prompt) throw fail(404, '이전 문장이 만료됐어요. 새 문장을 시작해 주세요.', 'PROMPT_EXPIRED');
        if (state !== 'ready' || switching || closing) throw fail(503, message);
        if (busy) throw fail(429, '앞 문장을 확인하고 있어요. 잠시 후 다시 시도해 주세요.');
        busy = true;
        let submission;
        let result;
        let recorded = false;
        const model = selection.provider === 'lmstudio' ? selection.modelId : 'bundled-qwen3-4b';
        try {
          await worker?.foreground();
          const id = data.submissionId || randomUUID();
          submission = learning.beginAttempt({ id, promptId: prompt.id, answer: data.answer.trim(), activeMs: data.activeMs, assisted: data.assisted, difficult: data.difficult });
          if (submission.cached) return json(res, 200, submission.cached);
          activeReview = tutor.review({ korean: prompt.korean, reference: prompt.reference, answer: data.answer.trim() });
          const output = await activeReview;
          result = { verdict: output.verdict, corrected: output.corrected, feedback: output.feedback, ...(output.alternative ? { alternative: output.alternative } : {}) };
          learning.finishAttempt(id, result, model);
          recorded = true;
          return json(res, 200, result);
        } catch (error) {
          if (submission?.id && !recorded) learning.failAttempt(submission.id, error, model);
          throw error;
        } finally { busy = false; activeReview = undefined; }
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [filename, type] = assets.get(url.pathname);
        const content = await readFile(path.join(root, 'public', filename));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        return res.end(content);
      }
      throw fail(404, '페이지를 찾을 수 없어요.');
    } catch (error) {
      if (!error.status) console.error(error);
      json(res, error.status ?? 500, { error: error.status ? error.message : '피드백을 완성하지 못했어요. 작성한 문장을 그대로 두고 다시 시도해 주세요.', ...(error.code ? { code: error.code } : {}) });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
  } catch (error) { learning.close(); throw error; }
  const url = `http://127.0.0.1:${server.address().port}`;
  async function initialize(persist = true) {
    if (startup && state === 'loading') return startup;
    state = 'loading';
    stage = 'resources';
    progress = 8;
    message = '앱 리소스를 확인하고 있어요.';
    action = undefined;
    startup = (async () => {
    try {
      await tutor?.dispose();
      tutor = undefined;
      if (selection.provider === 'lmstudio') {
        stage = 'engine';
        message = 'LM Studio에 연결하고 있어요.';
        tutor = await lmTutorFactory(selection);
      } else {
      if (!modelPath) {
        const config = JSON.parse(await readFile(path.join(root, 'models/model.json'), 'utf8'));
        modelPath = process.env.WRITE_MODEL_PATH || path.join(root, 'models', config.filename);
      }
      await stat(modelPath);
      progress = 18;
      message = '필요한 리소스를 모두 확인했어요.';
      tutor = await tutorFactory({ modelPath, onProgress(update) {
        if (update?.stage) stage = update.stage;
        if (Number.isFinite(update?.progress)) progress = Math.max(progress, Math.min(99, Math.round(update.progress)));
        if (update?.message) message = update.message;
      } });
      }
      if (persist) {
        await writeFile(`${settingsPath}.tmp`, JSON.stringify(selection));
        await rename(`${settingsPath}.tmp`, settingsPath);
      }
      state = 'ready';
      stage = 'ready';
      progress = 100;
      message = '준비됐어요.';
    } catch (error) {
      state = 'error';
      const missing = error.code === 'ENOENT';
      const invalidConfig = error instanceof SyntaxError && stage === 'resources';
      const lowMemory = /memory|allocate|allocation/i.test(`${error.name} ${error.message}`);
      if (missing) {
        message = '작문에 필요한 언어 모델 파일을 찾지 못했어요.';
        action = '개발 환경이라면 npm run setup을 실행한 뒤 다시 시도해 주세요. 설치된 앱이라면 앱을 다시 설치해 주세요.';
      } else if (invalidConfig) {
        message = '앱의 모델 설정 파일을 읽지 못했어요.';
        action = '앱 파일이 손상되었을 수 있어요. 개발 환경이라면 모델 설정을 확인하고, 설치된 앱이라면 다시 설치해 주세요.';
      } else if (lowMemory) {
        message = '언어 모델을 불러올 메모리가 부족해요.';
        action = '메모리를 많이 사용하는 다른 앱을 닫은 뒤 다시 시도해 주세요.';
      } else {
        message = stage === 'engine' ? '이 기기에서 로컬 AI 엔진을 시작하지 못했어요.'
          : stage === 'model' ? '언어 모델을 불러오지 못했어요.'
            : '작문 코치와 연결하지 못했어요.';
        action = '다시 시도해 주세요. 계속 실패하면 앱을 완전히 종료한 뒤 다시 실행해 주세요.';
      }
      if (selection.provider === 'lmstudio') {
        message = error.message;
        action = 'LM Studio에서 로컬 서버를 켜거나, 모델 설정에서 기본 모델을 선택해 주세요.';
      }
      console.error('Local model:', error);
    }
    })();
    return startup;
  }
  const ready = initialize();
  worker = createLearningWorker({ store: learning, getTutor: () => tutor,
    getModel: () => selection.provider === 'lmstudio' ? selection.modelId : 'bundled-qwen3-4b',
    canRun: () => state === 'ready' && !busy && !switching && !closing,
  });
  return {
    url, ready,
    async close() {
      if (closed) return;
      closed = true;
      closing = true;
      await worker.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await startup;
      await activeReview?.catch(() => {});
      await tutor?.dispose();
      learning.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const lan = process.argv.includes('--lan');
  const app = await startServer({ host: lan ? '0.0.0.0' : '127.0.0.1', port: Number(process.env.PORT || 3210) });
  console.log(`작문 연습: ${app.url}`);
  if (lan) {
    for (const group of Object.values(networkInterfaces())) {
      for (const address of group ?? []) if (address.family === 'IPv4' && !address.internal) console.log(`같은 Wi-Fi: http://${address.address}:${new URL(app.url).port}`);
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
