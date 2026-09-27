import { systemPrompt, schema, validateReview, retryInstruction } from './tutor-response.mjs';

export function normalizeEndpoint(value = 'http://127.0.0.1:1234') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !['/', '/v1', '/v1/'].includes(url.pathname)) {
    throw new Error('LM Studio 주소는 이 컴퓨터의 http://127.0.0.1:1234 형식으로 입력해 주세요.');
  }
  return url.origin;
}

async function call(endpoint, route, options = {}) {
  try {
    const response = await fetch(normalizeEndpoint(endpoint) + route, {
      signal: AbortSignal.timeout(5000), redirect: 'error', ...options,
    });
    if (!response.ok) throw new Error(`LM Studio HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    throw Object.assign(new Error('LM Studio 연결 또는 응답에 문제가 있어요. Developer에서 서버를 켜고 주소와 모델을 확인해 주세요.', { cause: error }), { status: 502 });
  }
}

export async function listModels(endpoint) {
  const data = await call(endpoint, '/api/v1/models');
  if (!Array.isArray(data.models)) throw new Error('LM Studio 모델 목록을 읽지 못했어요. LM Studio를 업데이트해 주세요.');
  return data.models.filter(model => model.type === 'llm' && typeof model.key === 'string').map(model => ({
    id: model.key, name: model.display_name || model.key, format: model.format,
    reasoningOff: model.capabilities?.reasoning?.allowed_options?.includes('off') || false,
  }));
}

export async function createLMStudioTutor({ endpoint, modelId }) {
  const model = (await listModels(endpoint)).find(model => model.id === modelId);
  if (!model) throw new Error('선택한 모델이 LM Studio에 없어요. 설정에서 모델 목록을 새로고침해 주세요.');
  let disposed = false;
  return {
    async review(input) {
      if (disposed) throw new Error('모델이 변경됐어요. 다시 시도해 주세요.');
      const signal = AbortSignal.timeout(180_000);
      for (let attempt = 0; attempt < 2; attempt++) {
        const data = await call(endpoint, '/v1/chat/completions', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal,
          body: JSON.stringify({
            model: modelId, stream: false, temperature: 0.1, max_tokens: 1200,
            ...(model.reasoningOff ? { reasoning_effort: 'none' } : {}),
            messages: [{ role: 'system', content: systemPrompt + (attempt ? retryInstruction : '') }, { role: 'user', content: JSON.stringify(input) }],
            response_format: { type: 'json_schema', json_schema: { name: 'writing_feedback', strict: true, schema } },
          }),
        });
        try {
          return validateReview(JSON.parse(data.choices?.[0]?.message?.content), input);
        } catch (error) {
          if (attempt === 0 && !signal.aborted) continue;
          throw Object.assign(new Error('이 모델의 피드백 형식을 읽지 못했어요. 다시 시도하거나 다른 모델을 선택해 주세요.', { cause: error }), { status: 502 });
        }
      }
    },
    async dispose() { disposed = true; },
  };
}
