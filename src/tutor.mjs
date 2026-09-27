import { getLlama, LlamaChatSession, QwenChatWrapper } from 'node-llama-cpp';
import { systemPrompt, schema, validateReview, retryInstruction } from './tutor-response.mjs';

/** Load the bundled GGUF once. The caller must serialize review() calls. */
export async function createTutor({ modelPath, onProgress = () => {} }) {
  // Runtime never downloads a model or builds llama.cpp; installation supplies both.
  onProgress({ stage: 'engine', progress: 24, message: 'AI 엔진을 준비하고 있어요.' });
  const llama = await getLlama({ build: 'never', skipDownload: true, progressLogs: false });
  let model;
  let context;
  let session;
  try {
    onProgress({ stage: 'model', progress: 32, message: '언어 모델을 메모리에 불러오고 있어요.' });
    model = await llama.loadModel({
      modelPath,
      onLoadProgress(value) {
        onProgress({
          stage: 'model',
          progress: 32 + Math.round(Math.max(0, Math.min(1, value)) * 48),
          message: '언어 모델을 메모리에 불러오고 있어요.',
        });
      },
    });
    onProgress({ stage: 'tutor', progress: 86, message: '작문 코치와 대화 환경을 만들고 있어요.' });
    context = await model.createContext({ contextSize: 4096 });
    const grammar = await llama.createGrammarForJsonSchema(schema);
    session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      chatWrapper: new QwenChatWrapper({ thoughts: 'modelInitiated' }),
      systemPrompt,
    });
    onProgress({ stage: 'tutor', progress: 96, message: '작문 코치 연결을 확인하고 있어요.' });
    let disposed = false;

    return {
      async review({ korean, reference, answer }) {
        if (disposed) throw new Error('영어 선생님이 종료되었어요. 프로그램을 다시 실행해 주세요.');
        session.resetChatHistory();
        const signal = AbortSignal.timeout(120_000);
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const response = await session.prompt(JSON.stringify({ korean, reference, answer }) + (attempt ? retryInstruction : ''), {
              grammar,
              temperature: 0.1,
              topP: 0.9,
              topK: 20,
              maxTokens: 1200,
              budgets: { thoughtTokens: 0 },
              signal,
            });
            const result = grammar.parse(response);
            return validateReview(result, { korean, answer });
          } catch (error) {
            if (attempt === 1 || signal.aborted) {
              throw new Error('피드백을 끝까지 만들지 못했어요. 잠시 후 다시 시도해 주세요.', { cause: error });
            }
          } finally {
            // Endless practice stays bounded in memory and never includes past answers.
            session.resetChatHistory();
          }
        }
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        session.dispose();
        await context.dispose();
        await model.dispose();
        await llama.dispose();
      },
    };
  } catch (error) {
    session?.dispose();
    await context?.dispose();
    await model?.dispose();
    await llama.dispose();
    throw error;
  }
}
