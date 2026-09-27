import { DatabaseSync } from 'node:sqlite';
import { existsSync, copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { builtinExamples } from './prompts.mjs';
import { describeExample, schedule, POLICY_VERSION, SKILL_LABELS, DAY } from './learning-policy.mjs';

const encode = JSON.stringify;
const decode = value => value ? JSON.parse(value) : null;
const canonical = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

export function openLearningStore(dataDir, { now = Date.now } = {}) {
  let storeClosed = false;
  const filename = path.join(dataDir, 'learning.sqlite');
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) { db.close(); throw new Error('학습 데이터가 더 최신 버전이에요. 앱을 업데이트해 주세요.'); }
  if (version === 0 && existsSync(filename) && db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n) {
    db.exec(`VACUUM INTO '${filename.replaceAll("'", "''")}.before-v1-${now()}'`);
  }
  db.exec('CREATE TABLE IF NOT EXISTS runtime_owner(id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL)');
  const ownerToken = randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    const owner = db.prepare('SELECT * FROM runtime_owner WHERE id=1').get();
    if (owner) {
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('이 학습 데이터는 다른 앱에서 사용 중이에요. 먼저 다른 앱을 종료해 주세요.');
    }
    db.prepare('INSERT OR REPLACE INTO runtime_owner VALUES(1,?,?)').run(process.pid, ownerToken);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS learners(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
    INSERT OR IGNORE INTO learners VALUES('local', ${now()});
    CREATE TABLE IF NOT EXISTS examples(id TEXT PRIMARY KEY, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, fingerprint TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS example_versions(id TEXT PRIMARY KEY, example_id TEXT NOT NULL REFERENCES examples(id), korean TEXT NOT NULL, reference TEXT NOT NULL, version INTEGER NOT NULL, provenance TEXT NOT NULL, UNIQUE(example_id, version));
    CREATE TABLE IF NOT EXISTS example_metadata(example_id TEXT PRIMARY KEY REFERENCES examples(id), difficulty INTEGER NOT NULL, skill TEXT NOT NULL, tags TEXT NOT NULL, topic TEXT NOT NULL, version TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, learner_id TEXT NOT NULL REFERENCES learners(id), started_at INTEGER NOT NULL, last_active INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS presentations(id TEXT PRIMARY KEY, learner_id TEXT NOT NULL REFERENCES learners(id), session_id TEXT REFERENCES sessions(id), version_id TEXT NOT NULL REFERENCES example_versions(id), reason TEXT NOT NULL, shown_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', next_id TEXT REFERENCES presentations(id), assistance INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, presentation_id TEXT NOT NULL REFERENCES presentations(id), answer TEXT NOT NULL, number INTEGER NOT NULL, active_ms INTEGER, assisted INTEGER NOT NULL, difficult INTEGER NOT NULL, created_at INTEGER NOT NULL, status TEXT NOT NULL, UNIQUE(presentation_id, number));
    CREATE TABLE IF NOT EXISTS evaluations(id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), status TEXT NOT NULL, result TEXT, error_code TEXT, model TEXT NOT NULL, prompt_version TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS review_events(id TEXT PRIMARY KEY, presentation_id TEXT NOT NULL UNIQUE REFERENCES presentations(id), example_id TEXT NOT NULL REFERENCES examples(id), verdict TEXT NOT NULL, assisted INTEGER NOT NULL, difficult INTEGER NOT NULL, at INTEGER NOT NULL, completed_count INTEGER NOT NULL, before_state TEXT, after_state TEXT NOT NULL, algorithm TEXT NOT NULL, disputed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS learner_example_state(learner_id TEXT NOT NULL REFERENCES learners(id), example_id TEXT NOT NULL REFERENCES examples(id), state TEXT NOT NULL, PRIMARY KEY(learner_id, example_id));
    CREATE TABLE IF NOT EXISTS learner_skill_state(learner_id TEXT NOT NULL REFERENCES learners(id), skill TEXT NOT NULL, evidence INTEGER NOT NULL, distinct_examples INTEGER NOT NULL, accuracy REAL NOT NULL, mastery REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(learner_id, skill));
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, checkpoint TEXT, attempts INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT);
    CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS attempts_presentation ON attempts(presentation_id);
    CREATE INDEX IF NOT EXISTS events_example ON review_events(example_id, at);
    CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status, due_at);
    PRAGMA user_version=1;
  `);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function addExample({ id, korean, reference, source = 'generated', metadata = describeExample(reference), provenance = {} }) {
    const fingerprint = canonical(korean);
    const existing = get('SELECT id FROM examples WHERE fingerprint=?', fingerprint);
    if (existing) {
      if (source === 'builtin') {
        const current = get('SELECT * FROM example_versions WHERE example_id=? ORDER BY version DESC LIMIT 1', existing.id);
        if (current.reference !== reference) {
          const version = current.version + 1;
          run('INSERT INTO example_versions VALUES(?,?,?,?,?,?)', `${existing.id}:${version}`, existing.id, korean, reference, version, encode(provenance));
        }
      }
      return null;
    }
    id ||= `${source}-${createHash('sha256').update(korean).digest('hex').slice(0, 20)}`;
    run('INSERT INTO examples VALUES(?,?,?,?,?)', id, source, 'active', now(), fingerprint);
    run('INSERT INTO example_versions VALUES(?,?,?,?,?,?)', `${id}:1`, id, korean, reference, 1, encode(provenance));
    run('INSERT INTO example_metadata VALUES(?,?,?,?,?,?)', id, metadata.difficulty, metadata.skill, encode(metadata.tags || [metadata.skill]), metadata.topic || 'everyday', 'heuristic-v1');
    return id;
  }
  transaction(() => {
    for (const example of builtinExamples) addExample({ ...example, source: 'builtin', provenance: { collection: 'builtin-v1' } });
    // Preserve old IDs so localStorage drafts remain addressable. No invented past grades.
    if (!get("SELECT value FROM preferences WHERE key='legacy-imported'")) {
      const legacy = path.join(dataDir, 'prompts.json');
      if (existsSync(legacy)) {
        let rows;
        try { rows = JSON.parse(readFileSync(legacy, 'utf8')); } catch { rows = []; }
        if (!existsSync(`${legacy}.before-sqlite.bak`)) copyFileSync(legacy, `${legacy}.before-sqlite.bak`);
        for (const row of Array.isArray(rows) ? rows : []) {
          if (!Array.isArray(row)) continue;
          const [oldId, item] = row;
          if (typeof oldId !== 'string' || typeof item?.korean !== 'string' || typeof item?.reference !== 'string') continue;
          let example = get('SELECT id FROM examples WHERE fingerprint=?', canonical(item.korean));
          if (!example) example = { id: addExample({ ...item, id: undefined, source: 'legacy' }) };
          run("INSERT OR IGNORE INTO presentations(id,learner_id,version_id,reason,shown_at) VALUES(?,'local',?,'restored',?)", oldId, `${example.id}:1`, now());
        }
      }
      run("INSERT INTO preferences VALUES('legacy-imported','true')");
    }
    // Interrupted evaluations can retry the same submission; they are not failures of recall.
    run("UPDATE attempts SET status='error' WHERE status='pending'");
    run("UPDATE jobs SET status='pending' WHERE status='running'");
  });
  const completedCount = () => get('SELECT count(*) n FROM review_events WHERE disputed=0').n;
  const itemState = id => decode(get("SELECT state FROM learner_example_state WHERE learner_id='local' AND example_id=?", id)?.state);
  function writeState(id, state) {
    run("INSERT INTO learner_example_state VALUES('local',?,?) ON CONFLICT(learner_id,example_id) DO UPDATE SET state=excluded.state", id, encode(state));
  }
  function catalog() {
    return all(`SELECT e.*,v.id version_id,v.korean,v.reference,m.difficulty,m.skill,m.tags,m.topic,s.state
      FROM examples e JOIN example_versions v ON v.example_id=e.id
      JOIN example_metadata m ON m.example_id=e.id
      LEFT JOIN learner_example_state s ON s.example_id=e.id AND s.learner_id='local'
      WHERE e.status='active' AND v.version=(SELECT max(version) FROM example_versions WHERE example_id=e.id)`)
      .map(row => ({ ...row, state: decode(row.state) }));
  }
  function presentation(id) {
    return get(`SELECT p.*,v.example_id,v.korean,v.reference,m.skill,m.difficulty,e.source,e.status example_status
      FROM presentations p JOIN example_versions v ON v.id=p.version_id
      JOIN example_metadata m ON m.example_id=v.example_id JOIN examples e ON e.id=v.example_id WHERE p.id=?`, id);
  }
  function publicPrompt(row) {
    return { id: row.id, korean: row.korean, reason: row.reason, difficulty: row.difficulty, skill: row.skill, source: row.source };
  }
  function enqueue(kind, payload = {}, id = `${kind}:${randomUUID()}`) {
    run("INSERT OR IGNORE INTO jobs(id,kind,status,payload,due_at,updated_at) VALUES(?,?,'pending',?,?,?)", id, kind, encode(payload), now(), now());
  }
  function analyze() {
    // Each distinct example has equal weight in mastery, so memorising one item
    // cannot overwhelm evidence from unfamiliar examples. Assisted/early practice
    // stays in history but is not evidence of independent transfer.
    const rows = all(`SELECT skill,sum(n) n,count(*) distinct_n,sum(good) good,avg(rate) rate FROM (
      SELECT m.skill,r.example_id,count(*) n,
        sum(CASE WHEN r.verdict='good' THEN 1 ELSE 0 END) good,
        avg(CASE WHEN r.verdict='good' THEN 1.0 ELSE 0.0 END) rate
      FROM review_events r JOIN example_metadata m ON m.example_id=r.example_id
      JOIN presentations p ON p.id=r.presentation_id
      WHERE r.disputed=0 AND r.assisted=0 AND p.reason!='extra-practice'
      GROUP BY m.skill,r.example_id) GROUP BY skill`);
    run('DELETE FROM learner_skill_state');
    for (const row of rows) run("INSERT INTO learner_skill_state VALUES('local',?,?,?,?,?,?)", row.skill, row.n, row.distinct_n, row.good / row.n, (row.rate * row.distinct_n + 2) / (row.distinct_n + 4), now());
    return rows;
  }
  function select(sessionId = 'default', after = null, skip = false) {
    return transaction(() => {
      const prior = after ? presentation(after) : null;
      if (after && !prior) throw fail('이전 문장을 찾지 못했어요.', 404);
      if (prior?.next_id) return publicPrompt(presentation(prior.next_id));
      if (prior && !skip && !get("SELECT id FROM attempts WHERE presentation_id=? AND status='complete'", after)) throw fail('먼저 피드백을 받거나 건너뛰기를 선택해 주세요.');
      if (!after) {
        const open = get("SELECT id FROM presentations WHERE session_id=? AND status='open' ORDER BY shown_at DESC LIMIT 1", sessionId);
        if (open) return publicPrompt(presentation(open.id));
      }
      const count = completedCount();
      const recent = all('SELECT v.example_id FROM presentations p JOIN example_versions v ON v.id=p.version_id ORDER BY p.shown_at DESC,p.rowid DESC LIMIT 3').map(row => row.example_id);
      const skills = all('SELECT * FROM learner_skill_state');
      const pool = catalog().filter(row => row.id !== prior?.example_id);
      const due = pool.filter(row => row.state && row.state.due_at <= now() && (row.state.after_count || 0) <= count);
      const unseen = pool.filter(row => !row.state && !recent.includes(row.id) && !get('SELECT id FROM presentations WHERE version_id=? AND status=?', row.version_id, 'open'));
      const mastery = skill => skills.find(row => row.skill === skill);
      const difficultyTarget = skill => { const m = mastery(skill); return !m || m.distinct_examples < 5 ? 2 : m.mastery >= .8 ? 3 : m.mastery < .5 ? 1 : 2; };
      const suitable = unseen.sort((a, b) => {
        const rank = row => Math.abs(row.difficulty - difficultyTarget(row.skill)) * 3 + (mastery(row.skill)?.mastery ?? .5) + Number(row.source === 'generated') * .2;
        return rank(a) - rank(b) || a.id.localeCompare(b.id);
      });
      const urgent = due.filter(row => row.state.stage === 'relearning').sort((a,b) => a.state.due_at-b.state.due_at)[0];
      const review = due.sort((a,b) => a.state.due_at-b.state.due_at)[0];
      // 6 of 10 slots prefer review, 3 targeted new examples, 1 exploration.
      const slot = count % 10;
      const exploration = unseen.filter(row => row.difficulty <= difficultyTarget(row.skill) + 1);
      let chosen = urgent || ((slot < 6 || due.length >= 20) ? review : null);
      let reason = urgent ? 'relearning' : 'review';
      if (!chosen) { chosen = slot === 9 ? exploration[count % Math.max(1, exploration.length)] : suitable[0]; reason = slot === 9 ? 'explore' : 'new'; }
      if (!chosen && review) { chosen = review; reason = 'review'; }
      if (!chosen) {
        chosen = pool.filter(row => !recent.includes(row.id)).sort((a,b) => (a.state?.due_at || 0)-(b.state?.due_at || 0))[0] || pool[0];
        reason = 'extra-practice';
      }
      if (!chosen) throw fail('사용할 수 있는 문장이 없어요.', 503);
      run("INSERT INTO sessions VALUES(?,'local',?,?) ON CONFLICT(id) DO UPDATE SET last_active=excluded.last_active", sessionId, now(), now());
      const id = randomUUID();
      run("INSERT INTO presentations(id,learner_id,session_id,version_id,reason,shown_at) VALUES(?,'local',?,?,?,?)", id, sessionId, chosen.version_id, reason, now());
      if (prior) run('UPDATE presentations SET status=?,next_id=? WHERE id=?', skip ? 'skipped' : 'complete', id, after);
      return publicPrompt(presentation(id));
    });
  }
  function beginAttempt({ id, promptId, answer, activeMs, assisted = false, difficult = false }) {
    return transaction(() => {
      const previous = get('SELECT * FROM attempts WHERE id=?', id);
      if (previous) {
        if (previous.presentation_id !== promptId || previous.answer !== answer) throw fail('이미 사용한 제출 번호예요. 새 답안으로 다시 시도해 주세요.');
        if (previous.status === 'complete') return { cached: decode(get("SELECT result FROM evaluations WHERE attempt_id=? AND status='complete' ORDER BY rowid DESC LIMIT 1", id).result) };
        if (previous.status === 'pending') throw fail('앞 답안을 확인하고 있어요.');
        if (presentation(promptId)?.status !== 'open') throw fail('이미 끝낸 문장이에요. 다음 문장에서 계속해 주세요.');
        run("UPDATE attempts SET status='pending' WHERE id=?", id);
        return { id };
      }
      const p = presentation(promptId);
      if (!p) throw fail('이전 문장이 만료됐어요. 새 문장을 시작해 주세요.', 404);
      if (p.status !== 'open') throw fail('이미 끝낸 문장이에요. 다음 문장에서 계속해 주세요.');
      const number = get('SELECT count(*) n FROM attempts WHERE presentation_id=?', promptId).n + 1;
      const seenFeedback = get("SELECT id FROM attempts WHERE presentation_id=? AND status='complete'", promptId);
      run('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?,?)', id, promptId, answer, number, activeMs ?? null, Number(assisted || !!seenFeedback || !!p.assistance), Number(difficult), now(), 'pending');
      return { id };
    });
  }
  function finishAttempt(id, result, model) {
    return transaction(() => {
      const attempt = get('SELECT * FROM attempts WHERE id=?', id);
      if (attempt.status !== 'pending') throw fail('제출 상태가 바뀌었어요.');
      const p = presentation(attempt.presentation_id);
      run("INSERT INTO evaluations VALUES(?,?,'complete',?,NULL,?,'teacher-v2',?)", randomUUID(), id, encode(result), model, now());
      run("UPDATE attempts SET status='complete' WHERE id=?", id);
      if (!get('SELECT id FROM review_events WHERE presentation_id=?', p.id)) {
        const before = itemState(p.example_id);
        const event = { verdict: result.verdict, assisted: attempt.assisted, difficult: attempt.difficult, at: now(), completedCount: completedCount() + 1 };
        const next = schedule(before, event);
        run('INSERT INTO review_events VALUES(?,?,?,?,?,?,?,?,?,?,?,0)', randomUUID(), p.id, p.example_id, result.verdict, attempt.assisted, attempt.difficult, event.at, event.completedCount, encode(before), encode(next), POLICY_VERSION);
        writeState(p.example_id, next);
        enqueue('analyze', {}, `analyze:${completedCount()}`);
      }
      return result;
    });
  }
  function failAttempt(id, error, model) {
    transaction(() => {
      run("UPDATE attempts SET status='error' WHERE id=? AND status='pending'", id);
      run("INSERT INTO evaluations VALUES(?,?,'error',NULL,? ,?,'teacher-v2',?)", randomUUID(), id, error.code || error.name || 'MODEL_ERROR', model, now());
    });
  }
  function report(id) {
    return transaction(() => {
      const p = presentation(id);
      if (!p) throw fail('문장을 찾지 못했어요.', 404);
      run('UPDATE review_events SET disputed=1 WHERE presentation_id=?', id);
      run("UPDATE presentations SET status='reported' WHERE id=?", id);
      // Rebuild only this item's schedule from undisputed immutable events.
      let state = null;
      for (const row of all('SELECT * FROM review_events WHERE example_id=? AND disputed=0 ORDER BY at,rowid', p.example_id)) state = schedule(state, { ...row, completedCount: row.completed_count });
      if (state) writeState(p.example_id, state);
      else run('DELETE FROM learner_example_state WHERE example_id=?', p.example_id);
      if (p.source === 'generated') run("UPDATE examples SET status='suspended' WHERE id=?", p.example_id);
      analyze();
      return { reported: true };
    });
  }
  function stats() {
    const count = completedCount();
    const good = get("SELECT count(*) n FROM review_events WHERE disputed=0 AND verdict='good' AND assisted=0").n;
    return {
      completed: count, firstAttemptAccuracy: count ? good / count : null,
      due: catalog().filter(row => row.state && row.state.due_at <= now() && (row.state.after_count || 0) <= count).length,
      attempts: get("SELECT count(*) n FROM attempts WHERE status='complete'").n,
      examples: get('SELECT count(*) n FROM examples').n,
      generated: get("SELECT count(*) n FROM examples WHERE source='generated' AND status='active'").n,
      skills: all('SELECT * FROM learner_skill_state ORDER BY mastery').map(row => ({ ...row, label: SKILL_LABELS[row.skill] || row.skill })),
      history: all(`SELECT p.id,p.korean,a.answer,a.number,a.active_ms,e.result,e.created_at FROM attempts a
        JOIN (SELECT p.id,v.korean FROM presentations p JOIN example_versions v ON v.id=p.version_id) p ON p.id=a.presentation_id
        JOIN evaluations e ON e.attempt_id=a.id WHERE e.status='complete' ORDER BY e.created_at DESC LIMIT 20`).map(row => ({ ...row, result: decode(row.result) })),
      jobs: all('SELECT kind,status,count(*) count FROM jobs GROUP BY kind,status'),
      generationEnabled: decode(get("SELECT value FROM preferences WHERE key='generation'")?.value) !== false,
    };
  }
  function generationTarget() {
    if (completedCount() < 10 || decode(get("SELECT value FROM preferences WHERE key='generation'")?.value) === false) return null;
    if (get("SELECT count(*) n FROM examples WHERE source='generated' AND created_at>?", now()-DAY).n >= 3) return null;
    const pool = catalog();
    for (const skill of all('SELECT * FROM learner_skill_state WHERE distinct_examples>=3 ORDER BY mastery')) {
      const difficulty = skill.mastery < .5 ? 1 : skill.mastery >= .8 ? 3 : 2;
      const unseen = pool.filter(row => row.skill === skill.skill && row.difficulty === difficulty && !get('SELECT id FROM presentations WHERE version_id=?', row.version_id));
      if (unseen.length < 3) return { skill: skill.skill, difficulty, mastery: skill.mastery, exclusions: pool.filter(row => row.skill === skill.skill).slice(-20).map(row => row.korean) };
    }
    return null;
  }
  function claimJob() {
    return transaction(() => {
      const job = get("SELECT * FROM jobs WHERE status='pending' AND due_at<=? ORDER BY CASE kind WHEN 'analyze' THEN 0 ELSE 1 END,due_at LIMIT 1", now());
      if (!job) return null;
      run("UPDATE jobs SET status='running',updated_at=? WHERE id=?", now(), job.id);
      return { ...job, payload: decode(job.payload), checkpoint: decode(job.checkpoint) };
    });
  }
  function finishJob(id, error, interrupted = false) {
    const job = get('SELECT * FROM jobs WHERE id=?', id);
    const attempts = job.attempts + Number(!!error && !interrupted);
    run('UPDATE jobs SET status=?,attempts=?,due_at=?,updated_at=?,error=? WHERE id=?', error ? (attempts >= 3 ? 'failed' : 'pending') : 'complete', attempts, now() + (interrupted ? 60_000 : error ? 60_000 * 2 ** attempts : 0), now(), error ? String(error.message).slice(0, 200) : null, id);
  }
  function addCandidate(candidate, provenance) {
    return transaction(() => {
      const similar = catalog().some(row => {
        const a = canonical(row.korean), b = canonical(candidate.korean);
        const grams = text => new Set(Array.from({ length: Math.max(0, text.length-1) }, (_, i) => text.slice(i,i+2)));
        const x = grams(a), y = grams(b);
        return a === b || [...x].filter(v => y.has(v)).length / Math.max(1, new Set([...x,...y]).size) > .8;
      });
      if (similar) return null;
      return addExample({ ...candidate, metadata: { skill: candidate.skill, difficulty: candidate.difficulty, tags: [candidate.skill], topic: candidate.topic }, provenance });
    });
  }
  function exportData() {
    const tables = ['learners','examples','example_versions','example_metadata','sessions','presentations','attempts','evaluations','review_events','learner_example_state','learner_skill_state','jobs','preferences'];
    return { version: 1, exportedAt: now(), tables: Object.fromEntries(tables.map(table => [table, all(`SELECT * FROM ${table}`)])) };
  }
  function reset() {
    // Export remains available separately; reset is explicitly confirmed by the client.
    transaction(() => {
      for (const table of ['evaluations','attempts','review_events','learner_example_state','learner_skill_state']) run(`DELETE FROM ${table}`);
      run('UPDATE presentations SET next_id=NULL');
      for (const table of ['presentations','sessions','jobs']) run(`DELETE FROM ${table}`);
    });
  }
  return { select, presentation, publicPrompt, beginAttempt, finishAttempt, failAttempt, report, stats, analyze, enqueue,
    generationTarget, claimJob, finishJob, addCandidate, exportData, reset,
    reveal(id) { const p = presentation(id); if (!p) throw fail('문장을 찾지 못했어요.',404); run('UPDATE presentations SET assistance=1 WHERE id=?',id); return { reference: p.reference }; },
    checkpoint(id, value) { run('UPDATE jobs SET checkpoint=?,updated_at=? WHERE id=?', encode(value), now(), id); },
    setGeneration(enabled) { run("INSERT INTO preferences VALUES('generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", encode(enabled)); },
    close() { if (!storeClosed) { run('DELETE FROM runtime_owner WHERE token=?', ownerToken); db.close(); storeClosed = true; } },
  };
}
