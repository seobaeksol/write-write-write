import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openLearningStore } from '../src/learning-store.mjs';
import { schedule, DAY } from '../src/learning-policy.mjs';
import { createLearningWorker, validateCandidate } from '../src/learning-worker.mjs';

function fixture(t, legacy) {
  const dir = mkdtempSync(join(tmpdir(), 'learning-test-'));
  if (legacy) writeFileSync(join(dir,'prompts.json'),JSON.stringify(legacy));
  let at = 1_800_000_000_000;
  let store = openLearningStore(dir, { now: () => at });
  t.after(() => { store.close(); rmSync(dir,{recursive:true,force:true}); });
  return { get store() { return store; }, dir, advance(ms) { at+=ms; }, restart() { store.close(); store = openLearningStore(dir,{now:()=>at}); } };
}
const good = { verdict: 'good', corrected: 'A sentence.', feedback: ['잘 썼어요.'] };
const bad = { verdict: 'revise', corrected: 'A corrected sentence.', feedback: ['과거형을 써요.'] };
function answer(store, prompt, result, extras = {}) {
  const id = randomUUID();
  store.beginAttempt({id,promptId:prompt.id,answer:'A sentence.',...extras});
  store.finishAttempt(id,result,'test-model');
  return id;
}

test('intervals grow only on independent due successes; failures require time and intervening practice', () => {
  let state;
  let at=100;
  for (const days of [1,3,7,14,30,60,60]) {
    state=schedule(state,{verdict:'good',at,completedCount:1});
    assert.equal(state.due_at-at,days*DAY);
    at=state.due_at;
  }
  const early=schedule(state,{verdict:'good',at:at-100,completedCount:2});
  assert.equal(early.due_at,state.due_at); assert.equal(early.step,state.step);
  const failed=schedule(state,{verdict:'revise',at,completedCount:10});
  assert.equal(failed.stage,'relearning'); assert.equal(failed.after_count,13);
  assert.equal(failed.due_at,at+600_000);
  assert.equal(schedule(failed,{verdict:'good',at:at+700_000,completedCount:12}).stage,'relearning');
  const hard=schedule(state,{verdict:'good',difficult:true,at,completedCount:11});
  assert.equal(hard.due_at,at+DAY);
});

test('imports all builtins and old presentation IDs without inventing history, once only', t => {
  const f=fixture(t,[['old-id',{korean:'특별한 문장이에요.',reference:'This is a special sentence.'}]]);
  assert.equal(f.store.stats().examples,121);
  assert.equal(f.store.presentation('old-id').korean,'특별한 문장이에요.');
  assert.equal(f.store.stats().completed,0);
  assert.ok(existsSync(join(f.dir,'prompts.json.before-sqlite.bak')));
  f.restart(); assert.equal(f.store.stats().examples,121);
});

test('idempotent submissions, corrections and model retries count correctly across restarts', t => {
  const f=fixture(t);const s=f.store;const p=s.select();
  s.beginAttempt({id:'failure',promptId:p.id,answer:'A sentence.'});
  s.failAttempt('failure',new Error('offline'),'stub');
  assert.equal(s.stats().completed,0);
  s.beginAttempt({id:'failure',promptId:p.id,answer:'A sentence.'});
  s.finishAttempt('failure',bad,'stub');
  assert.deepEqual(s.beginAttempt({id:'failure',promptId:p.id,answer:'A sentence.'}).cached,bad);
  answer(s,p,good);
  assert.equal(s.stats().completed,1);
  assert.equal(s.stats().firstAttemptAccuracy,0);
  assert.equal(s.stats().attempts,2);
  const state=JSON.parse(s.exportData().tables.learner_example_state[0].state);
  assert.equal(state.stage,'relearning');
  assert.throws(()=>s.beginAttempt({id:'failure',promptId:p.id,answer:'Different.'}),/제출 번호/);
  f.restart();assert.equal(f.store.stats().completed,1);
  assert.equal(f.store.exportData().tables.evaluations.length,3);
});

test('due selection, stable next requests, assistance and disputed grades', t => {
  const f=fixture(t);const s=f.store;const p=s.select('one');answer(s,p,good);
  const next=s.select('one',p.id);assert.deepEqual(s.select('one',p.id),next);
  f.advance(DAY);
  const due=s.select('two');assert.equal(due.korean,p.korean);assert.equal(due.reason,'review');
  s.reveal(due.id);answer(s,due,good);
  const event=s.exportData().tables.review_events.at(-1);assert.equal(event.assisted,1);
  s.report(due.id);assert.equal(s.stats().completed,1);
  assert.equal(s.exportData().tables.review_events.at(-1).disputed,1);
});

test('pending attempt recovers after a crash; generated duplicates and reports are handled', t => {
  const f=fixture(t);const p=f.store.select();f.store.beginAttempt({id:'pending',promptId:p.id,answer:'Hello.'});
  f.restart();f.store.beginAttempt({id:'pending',promptId:p.id,answer:'Hello.'});f.store.finishAttempt('pending',good,'stub');
  const candidate={korean:'바닷가에서 작은 조개를 주웠어요.',reference:'I picked up a small shell on the beach.',skill:'past-tense',difficulty:2,topic:'travel'};
  assert.ok(f.store.addCandidate(candidate,{model:'stub'}));assert.equal(f.store.addCandidate(candidate,{}),null);
  f.store.reset();assert.equal(f.store.stats().completed,0);assert.equal(f.store.stats().generated,1);
  f.restart();assert.equal(f.store.stats().completed,0);
});

test('jobs persist checkpoints and bounded failure backoff', t => {
  const f=fixture(t);f.store.enqueue('generate',{skill:'past-tense'},'job');
  assert.equal(f.store.claimJob().id,'job');f.store.checkpoint('job',{candidate:'saved'});
  f.restart();assert.deepEqual(f.store.claimJob().checkpoint,{candidate:'saved'});
  for(let i=0;i<3;i++) { f.store.finishJob('job',new Error('invalid'));f.advance(DAY);if(i<2) assert.equal(f.store.claimJob().id,'job'); }
  assert.equal(f.store.claimJob(),null);
  assert.equal(f.store.exportData().tables.jobs[0].status,'failed');
});

test('generation validates content then publishes; foreground abort does not count as a failed job', async () => {
  const target={skill:'past-tense',difficulty:2};
  const candidate={...target,korean:'나는 어제 바닷가를 걸었어요.',reference:'I walked along the beach yesterday.',topic:'travel'};
  assert.throws(()=>validateCandidate({...candidate,reference:'한국어'},target));
  let nextJob={id:'job',kind:'generate',payload:target};const outcomes=[];const added=[];
  const store={claimJob:()=>{const j=nextJob;nextJob=null;return j;},stats:()=>({generationEnabled:true}),generationTarget:()=>target,checkpoint(){},addCandidate:c=>added.push(c),finishJob:(...args)=>outcomes.push(args)};
  let calls=0;
  const worker=createLearningWorker({store,getTutor:()=>({structured:async()=>++calls===1?candidate:{approved:true,reason:'Valid'}}),getModel:()=> 'stub',canRun:()=>true,idleMs:0});
  await worker.tick();assert.equal(added.length,1);assert.equal(calls,2);await worker.close();
  nextJob={id:'abort',kind:'generate',payload:target};
  let began;const started=new Promise(r=>began=r);
  const interrupted=createLearningWorker({store,getTutor:()=>({structured:({signal})=>new Promise((resolve,reject)=>{began();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})}),getModel:()=> 'stub',canRun:()=>true,idleMs:0});
  const running=interrupted.tick();await started;await interrupted.foreground();await running;
  assert.equal(outcomes.at(-1)[2],true);assert.equal(added.length,1);await interrupted.close();
});

test('one database has one runtime owner; cold-start selection is level 2 and assisted practice is excluded from skill estimates', t => {
  const f=fixture(t);
  assert.throws(()=>openLearningStore(f.dir),/다른 앱/);
  const p=f.store.select();assert.equal(p.difficulty,2);assert.equal(p.reason,'new');
  f.store.reveal(p.id);answer(f.store,p,good);f.store.analyze();
  assert.equal(f.store.stats().skills.length,0);
});

test('background coverage analysis detects a real catalog gap and adds a validated generated example', async t => {
  const f=fixture(t);const s=f.store;
  let p=s.select('coverage');
  for(let i=0;i<120;i++) {
    answer(s,p,good);
    p=s.select('coverage',p.id);
  }
  s.analyze();
  // Drain pending summary jobs; test the coverage trigger with the persisted store.
  let job;while((job=s.claimJob())) s.finishJob(job.id);
  const target=s.generationTarget();assert.ok(target);
  let calls=0;
  const candidate={korean:'이웃에게 빌린 우산을 돌려주었어요.',reference:'I returned the umbrella I borrowed from my neighbor.',skill:target.skill,difficulty:target.difficulty,topic:'neighbors'};
  const worker=createLearningWorker({store:s,getTutor:()=>({structured:async()=>++calls===1?candidate:{approved:true,reason:'Valid'}}),getModel:()=> 'test',canRun:()=>true,idleMs:0});
  await worker.tick();await worker.tick();await worker.close();
  assert.equal(s.stats().generated,1);
  assert.equal(s.exportData().tables.example_versions.at(-1).provenance.includes('generate-v1'),true);
  const generated=s.exportData().tables.examples.find(row=>row.source==='generated');
  const view=s.select('generated-test');
  assert.equal(view.source,'generated');
  s.report(view.id);assert.equal(s.exportData().tables.examples.find(row=>row.id===generated.id).status,'suspended');
});
