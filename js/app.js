/*
 * 猜碰撞 — investor demo controller.
 *
 * Hard rules (from the demo plan):
 *  - A model card shows a verdict only when it came from a real run: the offline
 *    batch exported by tools/build_blind_test.py. Otherwise it shows the obviously
 *    fake placeholder □□□.
 *  - Every accuracy on screen is read from data/facts.js (the evidence bundle).
 *  - Future frames are drawn by the physics engine and labelled as such.
 */
(function () {
  "use strict";

  const P = window.WM.physics;
  const R = window.WM.render;
  const CFG = P.CFG;
  const LAST_CONTEXT = CFG.contextFrames - 1; // frame index 31
  const LAST_FRAME = P.TOTAL_FRAMES - 1; // frame index 47
  const MODELS = ["dsl", "baseline"];

  const D = window.DEMO_DATA || {};
  const FACTS = D.facts || null;
  const BLIND = D.blindTest || null;
  const CLIPS = (D.clevrerClips && D.clevrerClips.clips) || [];
  const MODEL_CHECK = D.modelCheck || null;

  const params = new URLSearchParams(location.search);
  const UITEST = params.get("uitest") === "1";
  const HIDDEN = new Set((params.get("hide") || "").split(",").map((s) => s.trim()).filter(Boolean));
  const CONTEXT_MS = 2000; // 32 frames at 2x real time (the data runs at 8 fps)
  const REVEAL_MS = 2000; // 16 frames at real time

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ---------------- facts & formatting ---------------- */

  const FX = FACTS ? Object.assign({}, FACTS, {
    gap: { toy2dTest: FACTS.toy2d.replay.dsl.accuracy - FACTS.toy2d.replay.baseline.accuracy },
  }) : null;

  function fact(path) {
    return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), FX);
  }
  function fmt(value, how) {
    if (value === undefined || value === null) return "—";
    switch (how) {
      case "pct0": return `${Math.round(value * 100)}%`;
      case "pct1": return `${(value * 100).toFixed(1)}%`;
      case "pp": return `${(value * 100).toFixed(1)} 个百分点`;
      case "M": return `${(value / 1e6).toFixed(2)}M`;
      default: return typeof value === "number" ? value.toLocaleString("zh-CN") : String(value);
    }
  }
  const pct1 = (v) => fmt(v, "pct1");
  const pct0 = (v) => fmt(v, "pct0");

  /* ---------------- state ---------------- */

  function newRound() {
    return { phase: "setup", scene: null, preds: null, ctxFrame: 0, revFrame: LAST_CONTEXT, token: 0, scored: false };
  }

  const app = {
    tab: "blind",
    blind: { index: 0, items: [], dropped: [], round: newRound() },
    clipIndex: 0,
    clipRevealed: false,
    score: loadScore(),
  };

  // Blind items are replayed once; any disagreement with the export is dropped, never shown.
  (BLIND && BLIND.items ? BLIND.items : []).forEach((item) => {
    const scene = P.classify(item.ball, item.obstacle, item.velocity);
    if (scene.status === P.STATUS.OK && scene.label === item.label && scene.firstCollision === item.first_collision_frame) {
      item._scene = scene;
      app.blind.items.push(item);
    } else {
      app.blind.dropped.push(item.sample_id);
      console.warn("blind item disagrees with physics, dropped:", item.sample_id, scene);
    }
  });

  function cur() { return app.blind; }
  function currentItem() { return app.blind.items[app.blind.index] || null; }

  function currentScene(mode) {
    if (mode.round.scene) return mode.round.scene;
    const item = currentItem();
    return item ? item._scene : null;
  }

  function sceneInputs() {
    const item = currentItem();
    if (!item) return { ball: null, obstacle: null, angle: 0 };
    return { ball: item.ball, obstacle: item.obstacle, angle: (Math.atan2(item.velocity[1], item.velocity[0]) * 180) / Math.PI };
  }

  // Survives an accidental reload; fake UI-test rounds never mix into the real tally.
  // `ids` = questions already counted, so revisiting a question never counts it twice.
  const SCORE_KEY = UITEST ? "wm-demo-score-uitest" : "wm-demo-score";
  function emptyScore() {
    return { dsl: { c: 0, n: 0 }, baseline: { c: 0, n: 0 }, ids: [] };
  }
  function loadScore() {
    try {
      const raw = sessionStorage.getItem(SCORE_KEY);
      if (raw) return Object.assign(emptyScore(), JSON.parse(raw));
    } catch (e) { /* storage unavailable */ }
    return emptyScore();
  }
  function saveScore() {
    try { sessionStorage.setItem(SCORE_KEY, JSON.stringify(app.score)); } catch (e) { /* ignore */ }
  }

  /* ---------------- animation ---------------- */

  const anim = { raf: 0, timer: 0, finish: null };
  function animate(ms, onFrame) {
    stopAnim();
    return new Promise((resolve) => {
      const t0 = performance.now();
      anim.finish = () => {
        cancelAnimationFrame(anim.raf);
        clearTimeout(anim.timer);
        anim.raf = 0;
        anim.finish = null;
        onFrame(1);
        resolve();
      };
      // rAF is throttled in hidden/background windows; never let a round stall on it.
      anim.timer = setTimeout(() => { if (anim.finish) anim.finish(); }, ms + 150);
      const step = (now) => {
        // rAF's timestamp is the frame start and can precede t0; clamp so frame indices never go negative.
        const p = Math.max(0, Math.min(1, (now - t0) / ms));
        if (p >= 1) { anim.finish(); return; }
        onFrame(p);
        anim.raf = requestAnimationFrame(step);
      };
      anim.raf = requestAnimationFrame(step);
    });
  }
  // Jump the running animation to its end state (used on tab switch / reset).
  function stopAnim() { if (anim.finish) anim.finish(); }

  /* ---------------- predictions ---------------- */

  // Deliberately unrelated to the answer and visibly stamped; only with ?uitest=1.
  function fakePreds(scene) {
    const seed = scene.sim.states[0][0] * 12.9898 + scene.sim.states[0][1] * 78.233;
    const out = {};
    MODELS.forEach((key, i) => {
      const x = Math.sin(seed + i * 3.7) * 43758.5453;
      out[key] = { kind: "fake", label: x - Math.floor(x) >= 0.5 ? 1 : 0, note: "UI 测试假数据，不是模型输出" };
    });
    return out;
  }

  function predictBlind(item, scene) {
    if (UITEST) return fakePreds(scene);
    const out = {};
    MODELS.forEach((key) => {
      const m = item.models && item.models[key];
      if (m && (m.label === 0 || m.label === 1)) {
        out[key] = { kind: "real", label: m.label, note: "", runId: m.run_id };
      } else {
        out[key] = { kind: "none", note: BLIND && BLIND.status === "practice" ? "练习卷没有模型判断" : "该题缺少离线结果" };
      }
    });
    return out;
  }

  /* ---------------- round flow ---------------- */

  let roundSeq = 0;

  async function guess() {
    const mode = cur();
    const r = mode.round;
    if (r.phase !== "setup") return;
    const scene = currentScene(mode);
    if (!scene || scene.status !== P.STATUS.OK) return;
    const token = ++roundSeq;
    const item = currentItem();
    Object.assign(r, { token, scene, itemId: item.sample_id, phase: "watching", ctxFrame: 0 });
    const pending = Promise.resolve(predictBlind(item, scene));
    renderAll();
    await animate(CONTEXT_MS, (p) => {
      r.ctxFrame = Math.min(LAST_CONTEXT, Math.floor(p * CFG.contextFrames));
      if (cur() !== mode) return;
      drawArena();
      renderCards();
      renderArenaNote();
    });
    const preds = await pending;
    if (r.token !== token) return;
    r.preds = preds;
    r.phase = "guessed";
    renderAll();
  }

  async function reveal() {
    const mode = cur();
    const r = mode.round;
    if (r.phase !== "guessed") return;
    r.phase = "revealing";
    r.revFrame = LAST_CONTEXT;
    renderAll();
    await animate(REVEAL_MS, (p) => {
      r.revFrame = LAST_CONTEXT + Math.round(p * CFG.futureFrames);
      if (cur() === mode) drawReveal();
    });
    r.phase = "revealed";
    scoreRound(r);
    renderAll();
  }

  function scoreRound(r) {
    if (r.scored) return;
    r.scored = true;
    if (app.score.ids.includes(r.itemId)) return;
    app.score.ids.push(r.itemId);
    MODELS.forEach((key) => {
      const p = r.preds && r.preds[key];
      if (!p || p.kind === "none") return;
      app.score[key].n += 1;
      if (p.label === r.scene.label) app.score[key].c += 1;
    });
    saveScore();
  }

  function next() {
    if (app.blind.items.length) selectQuestion((app.blind.index + 1) % app.blind.items.length);
  }

  // Any of the questions can be opened at any time, except mid-animation (a half-played
  // round must not be scored against the question picked next).
  function selectQuestion(i) {
    const mode = app.blind;
    if (mode.round.phase === "watching" || mode.round.phase === "revealing") return;
    stopAnim();
    mode.index = i;
    mode.round = newRound();
    renderAll();
  }

  function primaryAction() {
    const phase = cur().round.phase;
    if (app.tab === "video") return;
    if (phase === "setup") guess();
    else if (phase === "guessed") reveal();
    else if (phase === "revealed") next();
  }

  function setTab(tab) {
    if (HIDDEN.has(tab) || tab === app.tab) return;
    stopAnim();
    app.tab = tab;
    renderAll();
  }

  /* ---------------- drawing ---------------- */

  function drawArena() {
    const mode = cur();
    const r = mode.round;
    const canvas = $("#arena");
    const { ctx, s } = R.setupCanvas(canvas);
    const inp = sceneInputs();
    if (!inp.ball) { R.drawWorld(ctx, s, null, null); return; }
    const scene = currentScene(mode);
    const states = scene && scene.sim ? scene.sim.states : [];
    if (r.phase === "setup") {
      R.drawWorld(ctx, s, null, inp.obstacle);
      if (states.length > 1) {
        const ok = scene.status === P.STATUS.OK;
        R.drawPath(ctx, s, states, 0, LAST_CONTEXT, { color: ok ? "rgba(27,29,32,0.55)" : "rgba(180,35,24,0.85)", dash: [0.8, 1.2], width: 0.5 });
        if (ok) R.drawGhost(ctx, s, states[LAST_CONTEXT], "rgba(27,29,32,0.5)");
        // Where it goes wrong: the contact inside the context, or the last frame before the wall.
        else if (scene.status === P.STATUS.CONTEXT_COLLISION) R.drawGhost(ctx, s, states[scene.firstCollision], "rgba(180,35,24,0.9)");
        else if (scene.status === P.STATUS.WALL) R.drawGhost(ctx, s, states[states.length - 1], "rgba(180,35,24,0.9)");
      }
      R.drawBall(ctx, s, inp.ball);
      R.drawArrow(ctx, s, inp.ball, inp.angle, { handle: false });
      return;
    }
    const t = r.phase === "watching" ? r.ctxFrame : LAST_CONTEXT;
    R.drawWorld(ctx, s, null, inp.obstacle);
    R.drawPath(ctx, s, states, 0, t, { color: "rgba(27,29,32,0.45)", dash: [0.8, 1.2], width: 0.5 });
    R.drawBall(ctx, s, states[t]);
  }

  function drawReveal() {
    const mode = cur();
    const r = mode.round;
    const { ctx, s } = R.setupCanvas($("#reveal"));
    const inp = sceneInputs();
    const cover = $("#reveal-cover");
    const coverText = $("#reveal-cover-text");
    if (!inp.obstacle || r.phase === "setup" || r.phase === "watching" || !r.scene) {
      R.drawWorld(ctx, s, null, inp.obstacle, { obstacleAlpha: 0.35 });
      cover.hidden = false;
      coverText.textContent = r.phase === "watching" ? "模型正在看前 32 帧……" : "先点「让模型猜」";
      return;
    }
    const states = r.scene.sim.states;
    const t = r.phase === "guessed" ? LAST_CONTEXT : r.phase === "revealing" ? r.revFrame : LAST_FRAME;
    R.drawWorld(ctx, s, null, inp.obstacle);
    R.drawPath(ctx, s, states, 0, LAST_CONTEXT, { color: "rgba(27,29,32,0.32)", dash: [0.8, 1.2], width: 0.5 });
    if (t > LAST_CONTEXT) R.drawPath(ctx, s, states, LAST_CONTEXT, t, { color: "rgba(219,55,63,0.9)", width: 0.7 });
    const fc = r.scene.firstCollision;
    if (fc !== null && t >= fc) R.drawContactMark(ctx, s, states[fc]);
    R.drawBall(ctx, s, states[t]);
    cover.hidden = r.phase !== "guessed";
    coverText.textContent = "后 16 帧会发生什么？";
  }

  /* ---------------- rendering: stage ---------------- */

  function renderTabs() {
    $$(".tab").forEach((btn) => {
      btn.hidden = HIDDEN.has(btn.dataset.tab);
      btn.setAttribute("aria-selected", String(btn.dataset.tab === app.tab));
    });
    const video = app.tab === "video";
    $("#stage").hidden = video;
    $("#video-panel").hidden = !video;
    $("#scorebar").hidden = video;
  }

  function renderInputTools() {
    const tools = $("#input-tools");
    tools.innerHTML = "";
    const n = app.blind.items.length;
    const idx = document.createElement("span");
    idx.className = "tag";
    idx.textContent = n ? `第 ${app.blind.index + 1} / ${n} 题` : "没有题目";
    tools.appendChild(idx);
    const src = document.createElement("span");
    const official = BLIND && BLIND.status === "official";
    src.className = official ? "tag" : "tag warn";
    src.textContent = official ? `正式测试集 · 种子 ${BLIND.source.seed}` : "练习卷 · 仅彩排";
    tools.appendChild(src);
  }

  // All questions at once: pick any. A question already revealed this session is marked
  // (no answer shown on the button), and it will not be counted again.
  function renderPicker() {
    const picker = $("#q-picker");
    const busy = app.blind.round.phase === "watching" || app.blind.round.phase === "revealing";
    picker.innerHTML = "";
    app.blind.items.forEach((item, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "q-btn";
      b.textContent = String(i + 1);
      const seen = app.score.ids.includes(item.sample_id);
      if (seen) b.classList.add("seen");
      b.setAttribute("aria-pressed", String(i === app.blind.index));
      b.title = `第 ${i + 1} 题${seen ? " · 本场已揭晓" : ""}`;
      b.disabled = busy && i !== app.blind.index;
      b.addEventListener("click", () => { if (i !== app.blind.index || app.blind.round.phase === "revealed") selectQuestion(i); });
      picker.appendChild(b);
    });
  }

  function renderStatus() {
    const el = $("#scene-status");
    const mode = cur();
    const r = mode.round;
    const scene = currentScene(mode);
    let cls = "info", icon = "", text = "";
    if (!scene) {
      cls = "bad"; icon = "✗"; text = "没有可用的测试题：运行 tools/build_blind_test.py 导出。";
    } else if (r.phase === "setup") {
      text = "题目已固定。虚线是模型会看到的前 32 帧。";
    } else if (r.phase === "watching") {
      text = "物理引擎正在播放前 32 帧，两个模型看的是同一段画面。";
    } else if (r.phase === "guessed") {
      text = "两个模型都只看了前 32 帧。点「播放后 16 帧」揭晓。";
    } else if (r.phase === "revealing") {
      text = "播放后 16 帧……";
    } else {
      text = "点「下一题」继续，或在上方任选一题。";
    }
    el.className = `scene-status ${cls}`;
    el.innerHTML = icon ? `<span class="icon">${icon}</span><span></span>` : "<span></span>";
    el.lastChild.textContent = text;
  }

  function renderHint() {
    const el = $("#input-hint");
    if (BLIND && BLIND.status === "official") {
      el.textContent = `从正式测试集里按记录在案的随机种子 ${BLIND.source.seed} 抽了 ${BLIND.source.n} 题，不挑题；两个模型的判断是离线跑批的结果。`;
    } else {
      el.textContent = "练习卷：题目按训练分布由本地生成器抽样，物理结果真实；没有模型判断，只用于彩排。";
    }
  }

  function renderArenaNote() {
    const note = $("#arena-note");
    const r = cur().round;
    if (r.phase === "watching") {
      note.hidden = false;
      note.textContent = `模型正在看：第 ${r.ctxFrame + 1} / 32 帧`;
    } else if (r.phase !== "setup") {
      note.hidden = false;
      note.textContent = "模型只看到这里（前 32 帧）";
    } else {
      note.hidden = true;
    }
  }

  function renderCards() {
    const mode = cur();
    const r = mode.round;
    MODELS.forEach((key) => {
      const card = $(`.col-model .model-card[data-model="${key}"]`);
      fillCard(card, r.phase, r.phase === "watching" ? r.ctxFrame / LAST_CONTEXT : 0, r.preds && r.preds[key],
        r.phase === "revealed" ? r.scene.label : null);
    });
    const tag = $("#model-tag");
    if (UITEST) tag.textContent = "UI 测试";
    else tag.textContent = BLIND && BLIND.status === "official" ? "" : "练习卷 · 无模型结果";
    tag.hidden = !tag.textContent;
  }

  // Shared by stage cards and CLEVRER clip cards.
  function fillCard(card, phase, progress, pred, truth) {
    const verdict = $('[data-role="verdict"]', card);
    const mark = $('[data-role="mark"]', card);
    const note = $('[data-role="note"]', card);
    const prog = $('[data-role="progress"]', card);
    card.classList.remove("right", "wrong", "fake");
    mark.hidden = true;
    prog.hidden = true;
    verdict.className = "verdict";
    if (phase === "setup") {
      verdict.classList.add("pending");
      verdict.textContent = "等待出题";
      note.textContent = "";
      return;
    }
    if (phase === "watching") {
      verdict.classList.add("pending");
      verdict.textContent = "正在看前 32 帧……";
      note.textContent = "";
      prog.hidden = false;
      prog.firstElementChild.style.width = `${Math.round(progress * 100)}%`;
      return;
    }
    if (!pred || pred.kind === "none") {
      verdict.classList.add("placeholder");
      verdict.textContent = "□□□";
      note.textContent = pred ? pred.note : "暂无结果";
      return;
    }
    // The models answer a yes/no question; no confidence is shown.
    verdict.textContent = pred.label === 1 ? "会撞" : "不会撞";
    note.textContent = pred.note || "";
    if (pred.kind === "fake") card.classList.add("fake");
    if (truth !== null && truth !== undefined) {
      const right = pred.label === truth;
      mark.hidden = false;
      mark.className = `mark ${right ? "ok" : "bad"}`;
      mark.textContent = right ? "✓ 答对" : "✗ 答错";
      card.classList.add(right ? "right" : "wrong");
    }
  }

  function renderTruth() {
    const mode = cur();
    const r = mode.round;
    const box = $("#truth");
    const value = $("#truth-value");
    const detail = $("#truth-detail");
    if (r.phase !== "revealed") {
      box.classList.add("waiting");
      value.textContent = r.phase === "revealing" ? "播放中……" : "揭晓后显示";
      detail.textContent = "";
      return;
    }
    box.classList.remove("waiting");
    const fc = r.scene.firstCollision;
    if (r.scene.label === 1) {
      value.textContent = "会撞";
      detail.textContent = `第 ${fc + 1} 帧首次接触（后 16 帧里的第 ${fc - LAST_CONTEXT} 帧）`;
    } else {
      const gap = P.minGap(r.scene.sim.states, sceneInputs().obstacle, 0, P.TOTAL_FRAMES);
      value.textContent = "不会撞";
      detail.textContent = gap < 2.5 ? `擦肩而过：最近只差 ${gap.toFixed(1)} 像素` : `最近相距 ${gap.toFixed(1)} 像素`;
    }
  }

  function renderButtons() {
    const mode = cur();
    const r = mode.round;
    const scene = currentScene(mode);
    $("#btn-guess").disabled = !(r.phase === "setup" && scene && scene.status === P.STATUS.OK);
    $("#btn-reveal").disabled = r.phase !== "guessed";
    const nextBtn = $("#btn-next");
    const busy = r.phase === "watching" || r.phase === "revealing";
    const n = app.blind.items.length;
    nextBtn.textContent = n && app.blind.index === n - 1 ? "回到第 1 题" : "下一题";
    nextBtn.disabled = busy || n < 2;
  }

  function renderScore() {
    $("#score-dsl").textContent = `${app.score.dsl.c}/${app.score.dsl.n}`;
    $("#score-baseline").textContent = `${app.score.baseline.c}/${app.score.baseline.n}`;
    $("#scorebar .score-main").title = "只统计有真实模型输出的题";
    const ref = $("#score-ref");
    if (!FX) { ref.textContent = "缺少 data/facts.js：运行 tools/build_facts.py"; return; }
    const v = FX.toy2d;
    ref.innerHTML = "";
    const strong = document.createElement("strong");
    strong.textContent = "整体准确率（屏幕上这两个模型，2D 验证集）";
    // Headline = the search's validation set (metrics.json → toy_2d.*.validation), with its real size,
    // class split and metric; the independent test-set result stays in the appendix.
    ref.append(strong,
      `：我们 ${pct1(v.dsl.validation.balanced_accuracy)} · 对照 ${pct1(v.baseline.validation.balanced_accuracy)}` +
      `（搜索用的验证集 ${v.dsl.validation.n} 题，会撞 ${v.dsl.validation.positives} / 不会撞 ${v.dsl.validation.negatives}，平衡准确率）`);
  }

  function renderStage() {
    renderInputTools();
    renderPicker();
    renderStatus();
    renderHint();
    renderArenaNote();
    renderCards();
    renderTruth();
    renderButtons();
    renderScore();
    drawArena();
    drawReveal();
  }

  /* ---------------- rendering: video tab ---------------- */

  function cardTemplate(key) {
    const card = $(`.col-model .model-card[data-model="${key}"]`).cloneNode(true);
    return card;
  }

  function renderVideo() {
    const tabs = $("#clip-tabs");
    tabs.innerHTML = "";
    const clipName = (clip, i) => (clip.role === "scored" ? `片段 ${i}` : `示例画面${clip.split === "train" ? " · 训练集" : ""}`);
    if (CLIPS.length === 1) {
      // One clip: a label, not a switch that switches nothing.
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = clipName(CLIPS[0], 0);
      tabs.appendChild(tag);
    } else {
      CLIPS.forEach((clip, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = clipName(clip, i);
        b.setAttribute("aria-pressed", String(i === app.clipIndex));
        if (i === app.clipIndex) b.style.borderColor = "var(--model)";
        b.addEventListener("click", () => { app.clipIndex = i; app.clipRevealed = false; renderVideo(); });
        tabs.appendChild(b);
      });
    }
    const clip = CLIPS[app.clipIndex];
    const wrap = $("#clip-media-wrap");
    $$("img, video", wrap).forEach((el) => el.remove());
    if (clip) {
      const isVideo = /\.(mp4|webm)$/i.test(clip.media);
      const media = document.createElement(isVideo ? "video" : "img");
      // The frame takes the clip's own aspect ratio, so it never shows bars around it.
      const fit = (w, h) => { if (w && h) $("#clip-figure").style.setProperty("--ar", String(w / h)); };
      if (isVideo) media.addEventListener("loadedmetadata", () => fit(media.videoWidth, media.videoHeight));
      else media.addEventListener("load", () => fit(media.naturalWidth, media.naturalHeight));
      media.src = clip.media;
      if (isVideo) Object.assign(media, { autoplay: true, loop: true, muted: true, playsInline: true });
      else media.alt = clip.caption;
      wrap.prepend(media);
      $("#clip-badge").textContent = clip.role === "scored" ? "数据集原始画面，不是模型生成" : "数据集原始画面（训练集），不是模型预测";
      $("#clip-caption").textContent = clip.caption;
    } else {
      $("#clip-caption").textContent = "没有可播放的片段。";
    }
    const scored = clip && clip.role === "scored";
    $("#clip-scored").hidden = !scored;
    if (scored) {
      const cards = $("#clip-cards");
      cards.innerHTML = "";
      MODELS.forEach((key) => {
        const card = cardTemplate(key);
        const m = clip.models[key];
        const pred = m ? { kind: "real", label: m.label, note: "" } : { kind: "none", note: "该片段缺少模型判断" };
        fillCard(card, "guessed", 0, pred, app.clipRevealed ? clip.label : null);
        cards.appendChild(card);
      });
      const truth = $("#clip-truth");
      truth.classList.toggle("waiting", !app.clipRevealed);
      $(".truth-value", truth).textContent = app.clipRevealed ? (clip.label === 1 ? "会撞" : "不会撞") : "揭晓后显示";
      $("#btn-clip-reveal").disabled = app.clipRevealed;
    }

    if (!FX) return;
    const c = FX.clevrer;
    const bars = $("#clevrer-bars");
    bars.innerHTML = "";
    [["我们的结构", c.dsl.validation.accuracy, "bar-model"], ["对照组结构", c.baseline.validation.accuracy, "bar-base"]].forEach(([label, v, cls]) => {
      const row = document.createElement("div");
      row.className = `bar-row ${cls === "bar-model" ? "is-model" : "is-base"}`;
      row.innerHTML = `<span></span><span class="bar-track"><i class="${cls}"></i><span class="chance" title="瞎猜 50%"></span></span><b></b>`;
      row.firstChild.textContent = label;
      row.querySelector("i").style.width = `${(v * 100).toFixed(1)}%`;
      row.lastChild.textContent = pct1(v);
      bars.appendChild(row);
    });
    const facts = $("#clevrer-facts");
    facts.innerHTML = "";
    [
      `验证集 ${c.dsl.validation.n} 段（会撞 / 不会撞各 ${c.dsl.validation.positives} 段），${c.seeds}；测试集尚未评估`,
      `${c.transfer}`,
      `上游可训练参数：我们 ${fmt(c.dsl.upstream_params, "M")} · 对照 ${fmt(c.baseline.upstream_params, "M")}`,
      `${c.domain_note}（CLEVRER，Yi et al., ICLR 2020，CC0）`,
    ].forEach((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      facts.appendChild(li);
    });
    $("#clevrer-callout").textContent =
      `先说清楚：这组任务上我们的正确率约 ${pct0(c.dsl.validation.accuracy)}，平均每 5 题错 1 题；` +
      `对照约 ${pct0(c.baseline.validation.accuracy)}，对二选一的题来说已经接近瞎猜。`;
    $("#clevrer-source").textContent = `来源：${FX.sources.metrics.snapshot_date} 证据包 metrics.json → clevrer.models.*.validation`;
  }

  /* ---------------- readiness, ribbon, appendix ---------------- */

  function readiness() {
    let blind;
    const items = app.blind.items;
    const missingPreds = items.filter((it) => !MODELS.every((k) => it.models && it.models[k])).length;
    if (UITEST) blind = { level: "warn", text: "UI 测试模式：卡片显示假数据" };
    else if (!items.length) blind = { level: "bad", text: "没有题目：运行 tools/build_blind_test.py" };
    else if (!BLIND || BLIND.status !== "official") blind = { level: "warn", text: `练习卷 ${items.length} 题（物理结果真实，无模型判断），只能彩排` };
    else if (missingPreds) blind = { level: "warn", text: `随机测试集 ${items.length} 题，其中 ${missingPreds} 题缺少模型判断` };
    else blind = { level: "ok", text: `随机测试集 ${items.length} 题（种子 ${BLIND.source.seed}；${BLIND.source.dsl_run_id} / ${BLIND.source.baseline_run_id}）` };
    if (app.blind.dropped.length) blind = { level: "bad", text: `${blind.text}；${app.blind.dropped.length} 题与物理引擎不一致已剔除` };

    const scored = CLIPS.filter((c) => c.role === "scored").length;
    const video = scored >= 2
      ? { level: "ok", text: `${scored} 段验证集片段，带两个模型的逐条判断` }
      : { level: "warn", text: scored ? `只有 ${scored} 段带判断的片段（方案要求 2 段）` : "只有 1 段示例画面（训练集，不评分）；验证集片段与逐条判断未导入。按方案的备用做法：只放画面、口头说整体准确率" };
    let models;
    const mc = MODEL_CHECK;
    if (!mc) models = { level: "warn", text: "还没有运行 tools/verify_models.py" };
    else if (mc.frames_identical && mc.agreement.dsl === mc.n && mc.agreement.baseline === mc.n) {
      models = { level: "ok", text: `通过（${mc.checked_on}）：服务端重新渲染的 ${mc.n} 题画面与原始测试帧逐字节一致；两个模型 ${mc.n * 2} 个判断与交接预测完全一致；单次推理中位 ${mc.latency_ms.median} ms（${mc.environment.device}，torch ${mc.environment.torch}）` };
    } else {
      models = { level: "bad", text: `未通过（${mc.checked_on}）：画面一致 ${mc.frames_identical}，判断一致 ${mc.agreement.dsl}/${mc.agreement.baseline} / ${mc.n}` };
    }
    return { blind, video, models };
  }

  function renderReadiness() {
    const ready = readiness();
    const tbody = $("#ready-table tbody");
    tbody.innerHTML = "";
    [["① 随机测试集", ready.blind], ["② 三维视频", ready.video],
      ["模型输入与交接一致性", ready.models]].forEach(([name, st]) => {
      const tr = document.createElement("tr");
      const label = { ok: "就绪", warn: "未就绪", bad: "不可用", "": "检测中" }[st.level];
      tr.innerHTML = `<td></td><td><span class="status-pill"><span class="dot ${st.level}"></span>${label}</span></td><td></td>`;
      tr.firstChild.textContent = name;
      tr.lastChild.textContent = st.text;
      tbody.appendChild(tr);
    });
    renderRibbon(ready);
  }

  // The ribbon marks screens that would show placeholders or fake data.
  function renderRibbon(ready) {
    let text = "";
    if (UITEST && app.tab !== "video") {
      text = "UI 测试模式：卡片上是假数据，绝不能上台。去掉网址里的 ?uitest=1。";
    } else if (app.tab === "blind" && ready.blind.level !== "ok") {
      text = `${ready.blind.text}。卡片会出现占位符 □□□；随机测试集用 tools/build_blind_test.py 导出。`;
    }
    $("#ribbon").hidden = !text;
    $("#ribbon-text").textContent = text;
  }

  function renderFacts() {
    $$("[data-fact]").forEach((el) => { el.textContent = fmt(fact(el.dataset.fact), el.dataset.fmt); });
    const subs = {
      dslSub: FX ? `DSL 搜索得到的编码器 · 约 ${fmt(FX.toy2d.dsl.upstream_params, "M")} 参数` : "DSL 搜索得到的编码器",
      baselineSub: FX ? `按同规模复现的 V-JEPA 式对照（不是公开大模型）· 约 ${fmt(FX.toy2d.baseline.upstream_params, "M")} 参数` : "按同规模复现的 V-JEPA 式对照",
    };
    $$("[data-fact-text]").forEach((el) => { el.textContent = subs[el.dataset.factText] || ""; });
    if (!FX) return;
    const t = FX.toy2d, c = FX.clevrer, rp = FX.toy2d.replay;
    const rows = [
      [`2D 测试集（屏幕上的模型）${pct1(rp.dsl.accuracy)} / ${pct1(rp.baseline.accuracy)}`,
        `准确率（= 平衡准确率）。${rp.what}；${rp.dsl.n} 题（会撞 ${rp.dsl.positives} / 不会撞 ${rp.dsl.negatives}），未参与挑选。${rp.environment}`,
        rp.source],
      [`2D 测试集（历史记录）${pct1(t.dsl.test.accuracy)} / ${pct1(t.baseline.test.accuracy)}`,
        `原始训练运行记录的同一份测试集结果。${rp.discrepancy_note}。${t.seeds}`,
        "metrics.json → toy_2d.champion.test / toy_2d.baseline.test"],
      [`2D 验证集 ${pct1(t.dsl.validation.balanced_accuracy)} / ${pct1(t.baseline.validation.balanced_accuracy)}`,
        `平衡准确率。验证集 ${t.dsl.validation.n} 题（会撞 ${t.dsl.validation.positives} / 不会撞 ${t.dsl.validation.negatives}）。${t.selection_bias_note}。2026-09-23 周会汇报的 98.10% / 71.91% 就是这组`,
        "metrics.json → toy_2d.*.validation"],
      ["2D 分类别（屏幕上的模型）",
        `会撞的题答对：我们 ${pct1(rp.dsl.collision_recall)} · 对照 ${pct1(rp.baseline.collision_recall)}；不会撞的题答对：我们 ${pct1(rp.dsl.no_collision_recall)} · 对照 ${pct1(rp.baseline.no_collision_recall)}`,
        "由 predictions.jsonl 与测试集标签计算"],
      ...(MODEL_CHECK ? [["擦肩而过（测试集里不会撞的题，按最近间隙分档）", nearMissText(), `tools/verify_models.py，${MODEL_CHECK.checked_on}`]] : []),
      [`CLEVRER ${pct1(c.dsl.validation.accuracy)} / ${pct1(c.baseline.validation.accuracy)}`,
        `准确率（= 平衡准确率）。验证集 ${c.dsl.validation.n} 段（各 ${c.dsl.validation.positives}），测试集未评估。${c.transfer}。${c.seeds}`,
        "metrics.json → clevrer.models.*.validation"],
      ["参数量",
        `2D：我们 ${fmt(t.dsl.upstream_params)} · 对照 ${fmt(t.baseline.upstream_params)}（上游 encoder + predictor）；CLEVRER：我们 ${fmt(c.dsl.upstream_params)} · 对照 ${fmt(c.baseline.upstream_params)}；读出头另计 ${fmt(t.dsl.readout_params)}`,
        `${t.baseline.source}；metrics.json → clevrer`],
      ["搜索规模", `${t.search.audited_candidates} 个已审计候选、${t.search.groups} 组（${t.search.run_id}）`, "metrics.json → toy_2d.campaign"],
    ];
    const tbody = $("#facts-table tbody");
    tbody.innerHTML = "";
    rows.forEach((cells) => {
      const tr = document.createElement("tr");
      cells.forEach((text) => { const td = document.createElement("td"); td.textContent = text; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    $("#facts-foot").textContent = `metrics.json sha256 ${FX.sources.metrics.sha256.slice(0, 16)}… · 快照日期 ${FX.sources.metrics.snapshot_date}；predictions.jsonl sha256 ${rp.predictions_sha256.slice(0, 16)}…。所有结果均为单次运行，尚无多种子重复。`;
  }

  function nearMissText() {
    return MODEL_CHECK.near_miss_buckets.map((b) => {
      const range = b.gap_to === null ? `≥ ${b.gap_from} 像素` : `${b.gap_from}–${b.gap_to} 像素`;
      return `${range}（${b.n} 题）：我们 ${b.dsl_correct} · 对照 ${b.baseline_correct}`;
    }).join("；");
  }

  function renderDiagram() {
    const slot = $("#diagram-slot");
    const node = (x, y, w, label, sub, tone) => {
      const fill = tone === "motion" ? "#eef4ff" : tone === "out" ? "#f3f3f0" : "#fff";
      const stroke = tone === "motion" ? "#2563eb" : "#8d9399";
      return `<g><rect x="${x}" y="${y}" width="${w}" height="40" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>` +
        `<text x="${x + w / 2}" y="${y + (sub ? 17 : 25)}" text-anchor="middle" font-size="13" fill="#1b1d20">${label}</text>` +
        (sub ? `<text x="${x + w / 2}" y="${y + 32}" text-anchor="middle" font-size="11" fill="#6b7076">${sub}</text>` : "") + "</g>";
    };
    const line = (d, label, lx, ly) => `<path d="${d}" fill="none" stroke="#3c4046" stroke-width="1.3" marker-end="url(#ah)"/>` +
      (label ? `<text x="${lx}" y="${ly}" font-size="11" fill="#3c4046">${label}</text>` : "");
    slot.innerHTML = `<svg class="diagram" viewBox="0 0 900 400" role="img" aria-label="结构示意图">
      <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#3c4046"/></marker></defs>
      <text x="16" y="22" font-size="14" font-weight="700" fill="#1b1d20">我们搜出来的结构 · 单个 Cell（串联 2 次，权重独立）</text>
      <g transform="translate(0,18)">
      ${node(16, 44, 104, "Content", "原始特征")}
      ${node(160, 44, 128, "自注意力", "时空")}
      ${node(340, 44, 128, "交叉注意力", "Q 来自 content")}
      ${node(720, 44, 160, "Σ/√2", "Content 输出", "out")}
      ${node(16, 150, 104, "Motion", "相邻时刻相减", "motion")}
      ${node(150, 150, 110, "时间卷积", "", "motion")}
      ${node(290, 150, 110, "空间卷积", "", "motion")}
      ${node(430, 150, 128, "自注意力", "时间轴", "motion")}
      ${node(590, 150, 110, "特征 MLP", "", "motion")}
      ${node(730, 150, 150, "Σ/√2", "Motion 输出", "out")}
      ${line("M120,64 L158,64")}${line("M288,64 L338,64")}${line("M468,64 L718,64")}
      ${line("M68,44 C68,20 790,20 798,42")}
      ${line("M120,170 L148,170")}${line("M260,170 L288,170")}${line("M400,170 L428,170")}${line("M558,170 L588,170")}${line("M700,170 L728,170")}
      ${line("M68,190 C68,222 640,222 645,192")}
      ${line("M345,190 C345,236 800,236 805,192")}
      ${line("M360,150 L400,86", "K, V", 384, 126)}
      <text x="16" y="262" font-size="14" font-weight="700" fill="#1b1d20">对照组：V-JEPA 式 Block（按同规模复现）</text>
      </g>
      <g transform="translate(0,18)">
      ${node(16, 282, 150, "Patch Embedding", "+ 位置编码")}
      ${node(200, 282, 150, "LN → 自注意力", "时空轴")}
      ${node(384, 282, 90, "+", "残差", "out")}
      ${node(506, 282, 120, "LN → MLP", "")}
      ${node(658, 282, 70, "+", "残差", "out")}
      ${node(760, 282, 124, "×2 → LN", "编码表示", "out")}
      ${line("M166,302 L198,302")}${line("M350,302 L382,302")}${line("M474,302 L504,302")}${line("M626,302 L656,302")}${line("M728,302 L758,302")}
      ${line("M91,322 C91,350 425,350 429,324")}${line("M429,322 C429,350 690,350 693,324")}
      </g>
    </svg>`;
    if (FX) {
      $("#diagram-note").textContent = `示意图，不是源文件。motion = 相邻时间块的 patch 特征相减（第 0 块为 0，不是光流，也没有额外信息）；每个 Unit 都带 Pre-LN + 残差，多路输入求和后除以 √输入数；两者后面接相同结构的 Predictor 和 readout。依据：${FX.champion_cell.source}；2026-09-23 周会接线图。`;
    }
  }

  /* ---------------- input ---------------- */

  function bindControls() {
    $$(".tab").forEach((btn) => btn.addEventListener("click", () => setTab(btn.dataset.tab)));
    $("#btn-guess").addEventListener("click", guess);
    $("#btn-reveal").addEventListener("click", reveal);
    $("#btn-next").addEventListener("click", next);
    $("#btn-score-reset").addEventListener("click", () => {
      app.score = emptyScore();
      saveScore();
      renderScore();
      renderPicker();
    });
    $("#btn-clip-reveal").addEventListener("click", () => { app.clipRevealed = true; renderVideo(); });
    $$("[data-open]").forEach((btn) => btn.addEventListener("click", () => openDialog(btn.dataset.open)));
    $$("dialog [data-close]").forEach((btn) => btn.addEventListener("click", () => btn.closest("dialog").close()));
    $$("dialog").forEach((dlg) => dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }));

    // Capture phase: Space / PageDown (what presentation clickers send) always mean "next step",
    // even when a previously clicked button still has focus.
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if ($$("dialog").some((d) => d.open)) return;
      const k = e.key.toLowerCase();
      if (k === " " || k === "spacebar" || k === "pagedown") {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) primaryAction();
        return;
      }
      if (k === "1") setTab("blind");
      else if (k === "2") setTab("video");
      else if (k === "p") openDialog("presenter");
      else if (k === "a") openDialog("appendix");
    }, true);
    // Keyup of Space would otherwise "click" the focused button.
    document.addEventListener("keyup", (e) => {
      if (e.key === " " && !$$("dialog").some((d) => d.open)) e.preventDefault();
    }, true);
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (app.tab !== "video") renderStage(); }, 80);
    });
  }

  function openDialog(id) {
    const dlg = document.getElementById(id);
    if (!dlg || dlg.open) return;
    if (id === "appendix") renderReadiness();
    dlg.showModal();
  }

  /* ---------------- boot ---------------- */

  function renderAll() {
    renderTabs();
    if (app.tab === "video") renderVideo();
    else renderStage();
    renderReadiness();
  }

  function boot() {
    const firstVisible = ["blind", "video"].find((t) => !HIDDEN.has(t)) || "blind";
    app.tab = firstVisible;
    bindControls();
    renderFacts();
    renderDiagram();
    renderAll();
  }

  boot();
})();
