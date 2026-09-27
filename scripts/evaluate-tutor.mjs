// Optional live check: node scripts/evaluate-tutor.mjs [LM Studio model ID]
import { createLMStudioTutor } from '../src/lm-studio.mjs';
const cases = [
  { name: 'correct alternative', korean: '나는 어제 커피 한 잔을 샀어요.', reference: 'I bought a cup of coffee yesterday.', answer: 'I bought a coffee yesterday.', expected: 'good' },
  { name: 'agreement', korean: '나는 차를 좋아해요.', reference: 'I like tea.', answer: 'I likes tea.', expected: 'revise' },
  { name: 'past tense', korean: '나는 어제 공원에 갔어요.', reference: 'I went to the park yesterday.', answer: 'I go to the park yesterday.', expected: 'revise' },
  { name: 'different meaning', korean: '나는 어제 집에 있었어요.', reference: 'I stayed home yesterday.', answer: 'I went out yesterday.', expected: 'revise' },
  { name: 'typo', korean: '나는 사과를 좋아해요.', reference: 'I like apples.', answer: 'I like aples.', expected: 'revise' },
  { name: 'equivalent wording', korean: '도와주셔서 감사합니다.', reference: 'Thank you for your help.', answer: 'Thanks for helping me.', expected: 'good' },
];
const tutor = await createLMStudioTutor({ endpoint: 'http://127.0.0.1:1234', modelId: process.argv[2] || 'google/gemma-4-e4b' });
try {
  for (const { name, expected, ...input } of cases) {
    try {
      const result = await tutor.review(input);
      const passed = result.verdict === expected;
      if (!passed) process.exitCode = 1;
      console.log(JSON.stringify({ name, passed, ...result, next: undefined }));
    } catch (error) { process.exitCode = 1; console.error(name, error); }
  }
} finally { await tutor.dispose(); }
