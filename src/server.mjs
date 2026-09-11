import http from 'node:http';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createPrompt } from './prompts.mjs';

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
  tutorFactory = async (options) => (await import('./tutor.mjs')).createTutor(options),
} = {}) {
  await mkdir(dataDir, { recursive: true });
  const savedPath = path.join(dataDir, 'prompts.json');
  let prompts = new Map();
  try { prompts = new Map(JSON.parse(await readFile(savedPath, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') console.warn('문장 기록을 새로 시작합니다.'); }
  let saveChain = Promise.resolve();
  async function remember(prompt) {
    prompts.set(prompt.id, prompt);
    if (prompts.size > 256) prompts.delete(prompts.keys().next().value);
    const data = JSON.stringify([...prompts]);
    saveChain = saveChain.catch(() => {}).then(async () => {
      await writeFile(`${savedPath}.tmp`, data);
      await rename(`${savedPath}.tmp`, savedPath);
    });
    await saveChain;
    return { id: prompt.id, korean: prompt.korean };
  }
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
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { state, stage, progress, message, ...(action ? { action } : {}) });
      if (req.method === 'POST' && url.pathname === '/api/bootstrap/retry') {
        if (state === 'loading') return json(res, 202, { state, stage, progress, message });
        if (state === 'ready') return json(res, 200, { state, stage, progress, message });
        void initialize();
        return json(res, 202, { state, stage, progress, message });
      }
      if (req.method === 'GET' && url.pathname === '/api/prompt') {
        if (state !== 'ready') throw fail(503, message);
        const id = url.searchParams.get('id');
        if (id) {
          const prompt = prompts.get(id);
          if (!prompt) throw fail(404, '이전 문장이 만료됐어요. 새 문장을 시작해 주세요.', 'PROMPT_EXPIRED');
          return json(res, 200, { id, korean: prompt.korean });
        }
        return json(res, 200, await remember(createPrompt()));
      }
      if (req.method === 'POST' && url.pathname === '/api/review') {
        if (state !== 'ready') throw fail(503, message);
        if (busy) throw fail(429, '앞 문장을 확인하고 있어요. 잠시 후 다시 시도해 주세요.');
        if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'JSON 형식으로 보내 주세요.');
        let body = '';
        req.setEncoding('utf8');
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 8192) throw fail(413, '한 번에 한두 문장만 작성해 주세요.');
        }
        let data;
        try { data = JSON.parse(body); } catch { throw fail(400, '입력 내용을 다시 확인해 주세요.'); }
        if (!data || typeof data.promptId !== 'string' || typeof data.answer !== 'string' || !data.answer.trim() || data.answer.length > 1200) {
          throw fail(400, '영어 문장을 1~1,200자로 작성해 주세요.');
        }
        const prompt = prompts.get(data.promptId);
        if (!prompt) throw fail(404, '이전 문장이 만료됐어요. 새 문장을 시작해 주세요.', 'PROMPT_EXPIRED');
        // Check again after reading the body: two simultaneous requests must not share a context.
        if (busy) throw fail(429, '앞 문장을 확인하고 있어요. 잠시 후 다시 시도해 주세요.');
        busy = true;
        try {
          activeReview = tutor.review({ korean: prompt.korean, reference: prompt.reference, answer: data.answer.trim() });
          const result = await activeReview;
          const nextPrompt = await remember({ id: randomUUID(), ...result.next });
          return json(res, 200, { verdict: result.verdict, corrected: result.corrected, feedback: result.feedback, nextPrompt });
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
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  async function initialize() {
    if (startup && state === 'loading') return startup;
    state = 'loading';
    stage = 'resources';
    progress = 8;
    message = '앱 리소스를 확인하고 있어요.';
    action = undefined;
    startup = (async () => {
    try {
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
      console.error('Local model:', error);
    }
    })();
    return startup;
  }
  const ready = initialize();
  return {
    url, ready,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await startup;
      await activeReview?.catch(() => {});
      await tutor?.dispose();
      await saveChain.catch(() => {});
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
