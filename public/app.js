(() => {
  "use strict";

  const storageKey = "write-write-write.practice.v1";
  const byId = (id) => document.getElementById(id);
  const ui = {
    bootstrap: byId("bootstrap"), bootstrapCard: byId("bootstrap-card"), bootstrapTitle: byId("bootstrap-title"),
    bootstrapMessage: byId("bootstrap-message"), bootstrapProgress: byId("bootstrap-progress"),
    bootstrapProgressBar: byId("bootstrap-progress-bar"), bootstrapProgressValue: byId("bootstrap-progress-value"),
    bootstrapSteps: [...document.querySelectorAll("#bootstrap-steps li")], bootstrapError: byId("bootstrap-error"),
    bootstrapErrorReason: byId("bootstrap-error-reason"), bootstrapHelp: byId("bootstrap-help"),
    bootstrapErrorAction: byId("bootstrap-error-action"), bootstrapRetry: byId("bootstrap-retry"), practice: byId("practice"),
    prompt: byId("prompt"), answer: byId("answer"), form: byId("writing-form"),
    submit: byId("submit"), submitLabel: byId("submit-label"), submitArrow: byId("submit-arrow"),
    spinner: byId("submit-spinner"), connection: byId("connection"), connectionLabel: byId("connection-label"),
    notice: byId("notice"), noticeMessage: byId("notice-message"), retryConnection: byId("retry-connection"),
    error: byId("error"), quietNote: byId("quiet-note"), feedback: byId("feedback"),
    feedbackHeading: byId("feedback-heading"), verdictIcon: byId("verdict-icon"),
    corrected: byId("corrected"), correctionLabel: byId("correction-label"),
    points: byId("feedback-points"), rewrite: byId("rewrite"), next: byId("next"), freshPrompt: byId("fresh-prompt"),
  };
  // randomUUID requires HTTPS (or localhost); LAN HTTP still supports getRandomValues.
  function createId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  let settingsLoading = false;
  const sessionId = (() => { try { let id = sessionStorage.getItem('practice.session'); if (!id) { id = createId(); sessionStorage.setItem('practice.session', id); } return id; } catch { return createId(); } })();
  let assisted = false;
  let pendingSubmission = null;
  let lastActivityPing = 0;
  let activeMs = 0;
  let activeSince = null;
  let prompt = null;
  let review = null;
  let state = "loading";
  let busy = false;
  let statusTimer;
  let checkingStatus = false;
  let draftTimer;
  let promptValidated = false;
  let promptExpired = false;
  const stages = ["resources", "engine", "model", "tutor"];

  const validPrompt = (value) => value && (typeof value.id === "string" || typeof value.id === "number") && typeof value.korean === "string" && value.korean.trim();
  const validReview = (value) => value && ["good", "revise"].includes(value.verdict) && typeof value.corrected === "string" && value.corrected.trim() && Array.isArray(value.feedback) && value.feedback.every((point) => typeof point === "string");

  function trackTime() {
    if (activeSince !== null) activeMs = Math.min(3_600_000, activeMs + performance.now() - activeSince);
    activeSince = state === 'ready' && !busy && !review && !document.hidden && !byId('learning-dialog').open && !byId('settings-dialog').open ? performance.now() : null;
  }
  function save() {
    trackTime();
    clearTimeout(draftTimer);
    try {
      localStorage.setItem(storageKey, JSON.stringify({ prompt, answer: ui.answer.value, review, pendingSubmission, activeMs, assisted, difficult: byId("felt-difficult").checked }));
    } catch { /* Practice works even when browser storage is unavailable. */ }
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (!validPrompt(saved?.prompt)) return;
      prompt = saved.prompt;
      pendingSubmission = saved.pendingSubmission || null;
      activeMs = Number.isFinite(saved.activeMs) ? saved.activeMs : 0;
      ui.answer.value = typeof saved.answer === "string" ? saved.answer.slice(0, 1200) : "";
      review = validReview(saved.review) ? saved.review : null;
      assisted = !!saved.assisted || !!review;
      byId("felt-difficult").checked = !!saved.difficult;
      renderPrompt();
      renderReview();
    } catch { /* An old or incomplete draft must not prevent opening the app. */ }
  }

  function renderPrompt() {
    const reasonLabels = { new: '새 문장', review: '복습할 문장', relearning: '다시 연습할 문장', explore: '조금 새로운 도전', 'extra-practice': '추가 연습', restored: '이어서 연습' };
    byId('practice-context').textContent = prompt ? `${reasonLabels[prompt.reason] || '영어로 써 보세요'} · ${prompt.difficulty ? '난이도 ' + prompt.difficulty : '영어 작문'}` : '영어로 써 보세요';
    ui.prompt.textContent = prompt?.korean || "첫 문장을 준비하고 있어요.";
    ui.answer.disabled = !prompt || busy;
    updateSubmit();
  }

  function updateSubmit() {
    byId("settings-save").disabled = busy || state === "loading" || settingsLoading;
    ui.submit.disabled = busy || state !== "ready" || !prompt || promptExpired || !ui.answer.value.trim();
    ui.submitLabel.textContent = busy ? "문장을 읽고 있어요" : "피드백 받기";
    ui.spinner.hidden = !busy;
    ui.submitArrow.hidden = busy;
    ui.form.setAttribute("aria-busy", String(busy));
    ui.rewrite.disabled = busy;
    ui.next.disabled = busy;
    ui.freshPrompt.hidden = !promptExpired;
    ui.freshPrompt.disabled = busy;
    byId('skip-prompt').disabled = busy || state !== 'ready';
    byId('reveal-answer').disabled = busy || state !== 'ready';
    byId('report-feedback').disabled = busy;
    byId('felt-difficult').disabled = busy || !!review;
    trackTime();
  }

  function renderReview() {
    ui.feedback.hidden = !review;
    ui.quietNote.hidden = !!review;
    if (!review) return;
    byId("alternative").hidden = !review.alternative;
    byId("alternative-text").textContent = typeof review.alternative === "string" ? review.alternative : "";
    const good = review.verdict === "good";
    ui.feedback.dataset.verdict = review.verdict;
    ui.feedbackHeading.textContent = good ? "뜻을 잘 전달했어요." : "조금만 다듬어 볼까요?";
    ui.verdictIcon.textContent = good ? "✓" : "↗";
    ui.correctionLabel.textContent = good ? "자연스러운 표현" : "이렇게 고쳐 써 보세요";
    ui.corrected.textContent = review.corrected;
    ui.points.replaceChildren(...review.feedback.map((point) => {
      const item = document.createElement("li");
      item.textContent = point;
      return item;
    }));
  }

  function showError(message) {
    ui.error.textContent = message || "";
    ui.error.hidden = !message;
  }

  function renderBootstrap(status) {
    const failed = status.state === "error";
    const ready = status.state === "ready";
    const value = Math.max(0, Math.min(100, Number(status.progress) || (ready ? 100 : 0)));
    const activeIndex = status.stage === "ready" ? stages.length : Math.max(0, stages.indexOf(status.stage));
    ui.bootstrap.hidden = ready;
    ui.practice.hidden = !ready;
    ui.bootstrapMessage.hidden = failed;
    ui.bootstrapProgress.hidden = failed;
    ui.bootstrapProgressValue.hidden = failed;
    ui.bootstrapProgress.setAttribute("aria-valuenow", String(value));
    ui.bootstrapProgressBar.style.width = `${value}%`;
    ui.bootstrapProgressValue.textContent = `${value}%`;
    ui.bootstrapMessage.textContent = status.message || "앱을 준비하고 있어요.";
    ui.bootstrapError.hidden = !failed;
    ui.bootstrapTitle.textContent = failed ? "준비 중 문제가 생겼어요." : "작문 연습을 준비하고 있어요.";
    ui.bootstrapErrorReason.textContent = failed ? status.message || "알 수 없는 문제로 앱을 시작하지 못했어요." : "";
    ui.bootstrapHelp.hidden = !failed || !status.action;
    ui.bootstrapErrorAction.textContent = status.action || "";
    ui.bootstrapRetry.disabled = !failed;
    for (const [index, item] of ui.bootstrapSteps.entries()) {
      item.dataset.status = failed && index === activeIndex ? "error" : index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
    }
    if (failed) ui.bootstrapTitle.focus({ preventScroll: true });
  }

  function setState(nextState, message, status = {}) {
    state = nextState;
    ui.connection.dataset.state = state;
    ui.connectionLabel.textContent = state === "ready" ? "로컬 AI" : state === "loading" ? "AI 준비 중" : "연결 확인";
    ui.notice.hidden = state === "ready" || !ui.bootstrap.hidden;
    ui.noticeMessage.textContent = state === "loading"
      ? message || "영어 코치를 준비하고 있어요. 잠시만 기다려 주세요."
      : message || "영어 코치에 연결하지 못했어요. 프로그램이 실행 중인지 확인해 주세요.";
    ui.retryConnection.hidden = state !== "error";
    renderBootstrap({ state, message, ...status });
    updateSubmit();
  }

  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(path, { cache: "no-store", ...options });
    } catch {
      throw new Error("연결이 잠시 끊겼어요. 입력한 문장은 그대로 남아 있어요. 다시 시도해 주세요.");
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error("응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요."); }
    if (!response.ok) {
      const error = new Error(data.error || "잠시 후 다시 시도해 주세요.");
      error.status = response.status;
      error.code = data.code;
      throw error;
    }
    return data;
  }

  async function checkStatus() {
    if (checkingStatus) return;
    clearTimeout(statusTimer);
    checkingStatus = true;
    try {
      const status = await request("/api/status");
      if (!["loading", "ready", "error"].includes(status.state)) throw new Error("AI 상태를 확인하지 못했어요. 다시 연결해 주세요.");
      if (status.state === "ready" && !prompt) {
        const nextPrompt = await request(`/api/prompt?session=${encodeURIComponent(sessionId)}`);
        if (!validPrompt(nextPrompt)) throw new Error("연습 문장을 불러오지 못했어요. 다시 연결해 주세요.");
        prompt = nextPrompt;
        promptValidated = true;
        renderPrompt();
        save();
      } else if (status.state === "ready" && !promptValidated) {
        try {
          await request(`/api/prompt?id=${encodeURIComponent(prompt.id)}`);
          promptValidated = true;
        } catch (error) {
          if (error.status !== 404) throw error;
          markPromptExpired();
        }
      }
      setState(status.state, status.message, status);
      if (status.state === "loading") statusTimer = setTimeout(checkStatus, 2000);
    } catch (error) {
      if (error.status === 503) {
        setState("loading", "앱과 다시 연결하고 있어요.", { stage: "resources", progress: 5 });
        statusTimer = setTimeout(checkStatus, 2000);
      } else {
        setState("error", error.message);
      }
    } finally {
      checkingStatus = false;
    }
  }

  function markPromptExpired() {
    promptExpired = true;
    review = null;
    renderReview();
    showError("저장된 연습 문장을 찾지 못했어요. 새 문장을 받아 계속해 주세요. 입력한 내용은 유지돼요.");
    updateSubmit();
    save();
  }

  async function submit(event) {
    event?.preventDefault();
    if (busy || state !== "ready" || !prompt || promptExpired || !ui.answer.value.trim()) return;
    trackTime();
    busy = true;
    showError("");
    review = null;
    renderReview();
    ui.answer.disabled = true;
    updateSubmit();
    save();
    try {
      const answer = ui.answer.value.trim();
      if (!pendingSubmission || pendingSubmission.promptId !== prompt.id || pendingSubmission.answer !== answer) {
        pendingSubmission = { id: createId(), promptId: prompt.id, answer };
      }
      save();
      const result = await request("/api/review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptId: prompt.id, answer, submissionId: pendingSubmission.id, assisted, activeMs: Math.round(activeMs), difficult: byId('felt-difficult').checked }),
      });
      if (!validReview(result)) throw new Error("피드백을 완성하지 못했어요. 같은 문장으로 다시 시도해 주세요.");
      review = result;
      assisted = true;
      pendingSubmission = null;
      renderReview();
      save();
      ui.feedbackHeading.focus({ preventScroll: true });
      ui.feedback.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "nearest" });
    } catch (error) {
      showError(error.status === 429 ? "영어 코치가 다른 문장을 읽고 있어요. 잠시 후 다시 시도해 주세요." : error.message);
      if (error.status === 404 && error.code === "PROMPT_EXPIRED") markPromptExpired();
      if (error.status === 503) {
        setState("loading");
        void checkStatus();
      }
    } finally {
      busy = false;
      ui.answer.disabled = !prompt;
      updateSubmit();
    }
  }

  ui.form.addEventListener("submit", submit);
  ui.answer.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  });
  ui.answer.addEventListener("input", () => {
    if (Date.now() - lastActivityPing > 15_000) {
      lastActivityPing = Date.now();
      void request('/api/activity', { method: 'POST' }).catch(() => {});
    }
    if (review) { review = null; renderReview(); }
    if (!promptExpired) showError("");
    updateSubmit();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(save, 200);
  });
  ui.rewrite.addEventListener("click", () => {
    review = null;
    renderReview();
    save();
    ui.answer.focus();
  });
  async function nextSentence(skip = false) {
    if ((!review && !skip) || busy || !prompt) return;
    busy = true;
    updateSubmit();
    try {
      const fresh = await request(`/api/prompt?session=${encodeURIComponent(sessionId)}&after=${encodeURIComponent(prompt.id)}&skip=${skip === true}`);
      if (!validPrompt(fresh)) throw new Error('새 문장을 불러오지 못했어요. 다시 시도해 주세요.');
      prompt = fresh;
      promptValidated = true;
      promptExpired = false;
      review = null;
      pendingSubmission = null;
      activeMs = 0;
      assisted = false;
      activeSince = null;
      byId('felt-difficult').checked = false;
      byId('revealed-reference').hidden = true;
      ui.answer.value = '';
      ui.answer.style.height = '';
      showError('');
      renderPrompt();
      renderReview();
      save();
      window.scrollTo({ top: 0, behavior: 'instant' });
    } catch (error) { showError(error.message); }
    finally { busy = false; renderPrompt(); ui.answer.focus({ preventScroll: true }); }
  }
  ui.next.addEventListener("click", () => void nextSentence());
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
        event.defaultPrevented || byId("settings-dialog").open || byId("learning-dialog").open || !review || busy) return;
    // Keep Enter's normal activation on explicitly focused buttons and links.
    if (event.target.closest("button, a") && event.target !== ui.next) return;
    event.preventDefault();
    if (!event.repeat) nextSentence();
  });
  ui.freshPrompt.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    updateSubmit();
    try {
      const fresh = await request(`/api/prompt?session=${encodeURIComponent(sessionId)}`);
      if (!validPrompt(fresh)) throw new Error("새 문장을 불러오지 못했어요. 다시 시도해 주세요.");
      prompt = fresh;
      promptValidated = true;
      promptExpired = false;
      review = null;
      showError("");
      renderPrompt();
      renderReview();
      save();
    } catch (error) {
      showError(error.message);
    } finally {
      busy = false;
      renderPrompt();
      ui.answer.focus();
    }
  });
  ui.retryConnection.addEventListener("click", () => { setState("loading"); void checkStatus(); });
  ui.bootstrapRetry.addEventListener("click", async () => {
    if (state !== "error") return;
    ui.bootstrapRetry.disabled = true;
    setState("loading", "다시 준비를 시작하고 있어요.", { stage: "resources", progress: 5 });
    try {
      await request("/api/bootstrap/retry", { method: "POST" });
      void checkStatus();
    } catch (error) {
      setState("error", error.message, { stage: "resources", progress: 5, action: "앱을 완전히 종료한 뒤 다시 실행해 주세요." });
    }
  });
  const settingsDialog = byId("settings-dialog");
  const provider = byId("model-provider");
  const endpoint = byId("lm-endpoint");
  const modelSelect = byId("lm-model");
  const settingsMessage = byId("settings-message");
  let modelRequest = 0;
  let preferredModel = "";
  async function refreshModels() {
    const revision = ++modelRequest;
    const wanted = modelSelect.value || preferredModel;
    settingsMessage.textContent = "LM Studio 모델 목록을 확인하고 있어요.";
    modelSelect.replaceChildren();
    try {
      const data = await request(`/api/models?endpoint=${encodeURIComponent(endpoint.value)}`);
      if (revision !== modelRequest) return;
      for (const model of data.models) {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = `${model.name}${model.format ? " · " + model.format.toUpperCase() : ""}`;
        modelSelect.append(option);
      }
      if ([...modelSelect.options].some(option => option.value === wanted)) modelSelect.value = wanted;
      settingsMessage.textContent = data.models.length ? "사용할 모델을 선택하고 적용해 주세요." : "다운로드한 대화 모델이 없어요. LM Studio에서 모델을 다운로드해 주세요.";
    } catch (error) {
      if (revision === modelRequest) settingsMessage.textContent = error.message;
    }
  }
  byId("model-settings").addEventListener("click", async () => {
    settingsDialog.showModal();
    trackTime();
    settingsLoading = true;
    updateSubmit();
    try {
      const saved = await request("/api/settings");
      provider.value = saved.provider;
      endpoint.value = saved.endpoint;
      endpoint.disabled = provider.value !== "lmstudio";
      preferredModel = saved.modelId;
      modelSelect.replaceChildren();
      byId("lm-settings").hidden = provider.value !== "lmstudio";
      settingsMessage.textContent = "선택은 다음 실행에도 유지돼요.";
      if (provider.value === "lmstudio") await refreshModels();
    } catch (error) { settingsMessage.textContent = error.message; }
    finally { settingsLoading = false; updateSubmit(); }
  });
  byId("settings-close").addEventListener("click", () => settingsDialog.close());
  provider.addEventListener("change", () => {
    byId("lm-settings").hidden = provider.value !== "lmstudio";
    endpoint.disabled = provider.value !== "lmstudio";
    if (provider.value === "lmstudio") void refreshModels();
  });
  endpoint.addEventListener("input", () => { modelRequest++; modelSelect.replaceChildren(); });
  byId("models-refresh").addEventListener("click", () => void refreshModels());
  byId("settings-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || state === "loading" || settingsLoading) return;
    if (provider.value === "lmstudio" && !modelSelect.value) {
      settingsMessage.textContent = "목록을 새로고침하고 모델을 선택해 주세요.";
      return;
    }
    settingsLoading = true;
    updateSubmit();
    save();
    try {
      await request("/api/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider.value, endpoint: provider.value === "bundled" ? "http://127.0.0.1:1234" : endpoint.value, modelId: modelSelect.value }),
      });
      settingsDialog.close();
      setState("loading", "선택한 모델을 준비하고 있어요.");
      void checkStatus();
    } catch (error) { settingsMessage.textContent = error.message; }
    finally { settingsLoading = false; updateSubmit(); }
  });
  const learningDialog = byId('learning-dialog');
  async function loadLearning() {
    const data = await request('/api/learning');
    byId('learning-summary').textContent = `${data.completed}개 학습 · 복습 대기 ${data.due}개 · 첫 시도 정답률 ${data.firstAttemptAccuracy === null ? '아직 기록 없음' : Math.round(data.firstAttemptAccuracy * 100) + '%'} · 생성 문장 ${data.generated}개`;
    byId('generation-enabled').checked = data.generationEnabled;
    byId('learning-skills').replaceChildren(...data.skills.map(skill => {
      const item = document.createElement('li');
      item.textContent = `${skill.label}: ${Math.round(skill.accuracy * 100)}% · 서로 다른 ${skill.distinct_examples}개 문장${skill.distinct_examples < 5 ? ' (자료 수집 중)' : ''}`;
      return item;
    }));
    byId('learning-history').replaceChildren(...data.history.map(row => {
      const item = document.createElement('li');
      const sentence = document.createElement('strong'); sentence.textContent = row.korean;
      const answer = document.createElement('p'); answer.textContent = `${row.answer} · ${row.result.verdict === 'good' ? '정답' : '다시 연습'} · 제출 ${row.number}회차`;
      item.append(sentence, answer); return item;
    }));
  }
  byId('learning-open').addEventListener('click', async () => {
    learningDialog.showModal();
    trackTime();
    byId('learning-message').textContent = '';
    try { await loadLearning(); } catch (error) { byId('learning-message').textContent = error.message; }
  });
  learningDialog.addEventListener('close', trackTime);
  settingsDialog.addEventListener('close', trackTime);
  byId('learning-close').addEventListener('click', () => learningDialog.close());
  byId('generation-enabled').addEventListener('change', async event => {
    try { await request('/api/learning/generation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: event.target.checked }) }); }
    catch (error) { event.target.checked = !event.target.checked; byId('learning-message').textContent = error.message; }
  });
  byId('learning-export').addEventListener('click', async () => {
    try {
      const data = await request('/api/learning/export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'writing-learning-history.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { byId('learning-message').textContent = error.message; }
  });
  byId('learning-reset').addEventListener('click', async () => {
    if (!confirm('답안 기록과 복습 일정을 모두 삭제할까요? 먼저 내보내기로 보관할 수 있어요.')) return;
    try {
      await request('/api/learning/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: 'RESET' }) });
      prompt = null; review = null; assisted = false; pendingSubmission = null; activeMs = 0; activeSince = null; ui.answer.value = '';
      renderReview(); save(); learningDialog.close(); await checkStatus();
    } catch (error) { byId('learning-message').textContent = error.message; }
  });
  byId('skip-prompt').addEventListener('click', () => void nextSentence(true));
  byId('reveal-answer').addEventListener('click', async () => {
    if (!prompt || busy) return;
    try {
      const data = await request('/api/prompt/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ promptId: prompt.id }) });
      assisted = true;
      save();
      byId('revealed-reference').textContent = data.reference;
      byId('revealed-reference').hidden = false;
    } catch (error) { showError(error.message); }
  });
  byId('report-feedback').addEventListener('click', async () => {
    if (!prompt || busy) return;
    try {
      await request('/api/learning/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ promptId: prompt.id }) });
      showError('이 판정은 학습 수준과 복습 계산에서 제외했어요.');
    } catch (error) { showError(error.message); }
  });
  window.addEventListener("pagehide", save);
  window.addEventListener("online", () => { if (state === "error") void checkStatus(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save();
    else if (state !== "ready") void checkStatus();
  });

  if (/Mac|iPhone|iPad/.test(navigator.platform)) {
    byId("keyboard-hint").firstElementChild.textContent = "⌘";
  }
  restore();
  renderBootstrap({ state: "loading", stage: "resources", progress: 5, message: "앱 리소스를 확인하고 있어요." });
  void checkStatus();
})();
