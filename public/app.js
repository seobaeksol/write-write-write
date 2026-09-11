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
  const validReview = (value) => value && ["good", "revise"].includes(value.verdict) && typeof value.corrected === "string" && value.corrected.trim() && Array.isArray(value.feedback) && value.feedback.every((point) => typeof point === "string") && validPrompt(value.nextPrompt);

  function save() {
    clearTimeout(draftTimer);
    try {
      localStorage.setItem(storageKey, JSON.stringify({ prompt, answer: ui.answer.value, review }));
    } catch { /* Practice works even when browser storage is unavailable. */ }
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (!validPrompt(saved?.prompt)) return;
      prompt = saved.prompt;
      ui.answer.value = typeof saved.answer === "string" ? saved.answer.slice(0, 1200) : "";
      review = validReview(saved.review) ? saved.review : null;
      renderPrompt();
      renderReview();
    } catch { /* An old or incomplete draft must not prevent opening the app. */ }
  }

  function renderPrompt() {
    ui.prompt.textContent = prompt?.korean || "첫 문장을 준비하고 있어요.";
    ui.answer.disabled = !prompt || busy;
    updateSubmit();
  }

  function updateSubmit() {
    ui.submit.disabled = busy || state !== "ready" || !prompt || promptExpired || !ui.answer.value.trim();
    ui.submitLabel.textContent = busy ? "문장을 읽고 있어요" : "피드백 받기";
    ui.spinner.hidden = !busy;
    ui.submitArrow.hidden = busy;
    ui.form.setAttribute("aria-busy", String(busy));
    ui.rewrite.disabled = busy;
    ui.next.disabled = busy;
    ui.freshPrompt.hidden = !promptExpired;
    ui.freshPrompt.disabled = busy;
  }

  function renderReview() {
    ui.feedback.hidden = !review;
    ui.quietNote.hidden = !!review;
    if (!review) return;
    const good = review.verdict === "good";
    ui.feedback.dataset.verdict = review.verdict;
    ui.feedbackHeading.textContent = good ? "뜻을 잘 전달했어요." : "조금만 다듬어 볼까요?";
    ui.verdictIcon.textContent = good ? "✓" : "↗";
    ui.correctionLabel.textContent = good ? "자연스러운 표현" : "이렇게 쓰면 더 자연스러워요";
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
        const nextPrompt = await request("/api/prompt");
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
    busy = true;
    showError("");
    review = null;
    renderReview();
    ui.answer.disabled = true;
    updateSubmit();
    save();
    try {
      const result = await request("/api/review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptId: prompt.id, answer: ui.answer.value.trim() }),
      });
      if (!validReview(result)) throw new Error("피드백을 완성하지 못했어요. 같은 문장으로 다시 시도해 주세요.");
      review = result;
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
  function nextSentence() {
    if (!review || busy) return;
    prompt = review.nextPrompt;
    promptValidated = true;
    promptExpired = false;
    review = null;
    ui.answer.value = "";
    ui.answer.style.height = "";
    showError("");
    renderPrompt();
    renderReview();
    save();
    ui.prompt.focus({ preventScroll: true });
    ui.answer.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  ui.next.addEventListener("click", nextSentence);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
        event.defaultPrevented || !review || busy) return;
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
      const fresh = await request("/api/prompt");
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
