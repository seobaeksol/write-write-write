import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReview } from '../src/tutor-response.mjs';

const input = { korean: '나는 커피를 좋아해요.', answer: 'I like coffee.' };
const praise = 'I 다음에 like를 써서 주어와 동사를 정확히 연결했어요. 좋아하는 것을 자연스럽게 표현했네요.';
test('specific praise survives and good verdict preserves original wording', () => {
  const result = validateReview({ verdict: 'good', corrected: 'I enjoy coffee.', feedback: [praise] }, input);
  assert.equal(result.corrected, input.answer);
  assert.deepEqual(result.feedback, [praise]);
});
test('optional expression stays separate from required correction', () => {
  const alternative = '다른 표현으로는 “I enjoy coffee.”도 쓸 수 있어요.';
  const result = validateReview({ verdict: 'good', corrected: input.answer, feedback: [praise], alternative }, input);
  assert.equal(result.alternative, alternative);
  assert.equal(result.verdict, 'good');
});
test('contradictory revisions and unusable explanations trigger retry instead of canned feedback', () => {
  assert.throws(() => validateReview({ verdict: 'revise', corrected: input.answer, feedback: [praise] }, input), /grading/);
  for (const reason of ['', 'Good job!', input.korean, '가'.repeat(501)]) {
    assert.throws(() => validateReview({ verdict: 'good', corrected: input.answer, feedback: [reason] }, input), /explanation/);
  }
});

test('English-only alternatives do not reject valid teacher feedback', () => {
  const answer = "I'm late to go to work for missing the bus";
  const corrected = 'I was a little late for work because I missed the bus.';
  const alternative = 'I missed the bus, so I was a little late for work.';
  const feedback = ['과거의 일이므로 I was를 써요. 이유는 because I missed the bus로 설명할 수 있어요.'];
  const result = validateReview({ verdict: 'revise', corrected, alternative, feedback }, { korean: '버스를 놓쳐서 회사에 조금 늦었어요.', answer });
  assert.equal(result.alternative, alternative);
  assert.deepEqual(result.feedback, feedback);
});

test('unusable optional suggestions are omitted without losing core feedback', () => {
  for (const alternative of [null, 42, {}, 'x'.repeat(301), '다른 표현도 있어요.', input.answer]) {
    const result = validateReview({ verdict: 'good', corrected: input.answer, feedback: [praise], alternative }, input);
    assert.equal(result.alternative, undefined);
    assert.deepEqual(result.feedback, [praise]);
  }
});
