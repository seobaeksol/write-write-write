export const DAY = 86_400_000;
export const POLICY_VERSION = 'interval-ladder-v1';
export const INTERVALS = [1, 3, 7, 14, 30, 60];
export const SKILLS = ['past-tense', 'future', 'perfect', 'conditionals', 'requests', 'comparison', 'sentence-building'];
export const SKILL_LABELS = { 'past-tense': '과거 시제', future: '미래 표현', perfect: '완료 시제', conditionals: '조건 표현', requests: '부탁과 질문', comparison: '비교 표현', 'sentence-building': '기본 문장 구성' };

// Seed metadata is deliberately modest: these are editable heuristics, not CEFR scores.
export function describeExample(reference) {
  const rules = [
    ['conditionals', /\bif\b/i], ['perfect', /\b(?:have|has) (?:been|finished|lost|heard|seen|decided|made|done)\b/i],
    ['requests', /^(?:could|would|can|may) (?:you|i|we)\b/i],
    ['past-tense', /\b(?:yesterday|last|ago|was|were|went|bought|woke|forgot|told|tried)\b/i],
    ['future', /\b(?:will|going to|tomorrow|next)\b/i], ['comparison', /\b(?:than|more|less|most|better)\b/i],
  ];
  const skills = rules.filter(([, pattern]) => pattern.test(reference)).map(([skill]) => skill);
  if (!skills.length) skills.push('sentence-building');
  const words = reference.split(/\s+/).length;
  return { skill: skills[0], tags: skills, difficulty: Math.min(3, 1 + Number(words > 10) + Number(words > 16 || skills.includes('conditionals'))), topic: 'everyday' };
}

export function schedule(previous, { verdict, assisted, difficult, at, completedCount }) {
  const old = previous || { stage: 'new', step: -1, due_at: 0, successes: 0, lapses: 0 };
  // Practising ahead of schedule never advances or postpones the scheduled review.
  if ((old.due_at > at || (old.after_count || 0) > completedCount - 1) && verdict === 'good') return { ...old, last_review: at };
  if (verdict === 'revise') return {
    ...old, stage: 'relearning', step: -1, due_at: at + 10 * 60_000,
    after_count: completedCount + 3, last_review: at, lapses: old.lapses + 1,
  };
  const step = assisted || difficult ? 0 : Math.min(old.step + 1, INTERVALS.length - 1);
  return { ...old, stage: assisted || difficult ? 'learning' : 'review', step,
    due_at: at + INTERVALS[step] * DAY, after_count: 0, last_review: at,
    successes: old.successes + Number(!assisted),
  };
}
