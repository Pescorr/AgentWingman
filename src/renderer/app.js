// Renders the view from the main process, plays the character (built-in SVG or an image skin) and the signals.
const $ = (id) => document.getElementById(id);
const body = document.body;
const pilot = $("pilot");

const ALERT_MOODS = new Set(["question", "approval", "complete", "error"]);
const BUBBLE = {
  question: "質問です！",
  approval: "承認おねがい！",
  complete: "完了しました！",
  error: "エラー発生！",
};
const EVENT_BUBBLE = {
  truncation: "コンテキスト圧縮…",
  "subtask-start": "サブタスク出撃！",
  "subtask-return": "サブタスク帰還",
};
// same defaults as src/skins.js, used by the built-in pilot
const BUILTIN_MOTION = { idle: "breathe", reading: "scan", thinking: "breathe", writing: "breathe", running: "breathe", question: "hop", approval: "breathe", complete: "jump", error: "shake", offline: "dim" };
const BUILTIN_EFFECT = { thinking: "dots", question: "mark", complete: "stars", error: "sweat" };
const COMPACT_AFTER_MS = 20000; // the panel folds away when nothing has happened for a while

let sound = true;
let mood = null;
let alertTimer, bubbleTimer, compactTimer, eventTimer;

// ---------- sound: short synthesized cues, distinct from Zoocode's own ----------
let ac = null;
function tone(freq, start, dur, type = "square", vol = 0.05) {
  ac = ac || new AudioContext();
  const t = ac.currentTime + start, o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur + 0.02);
}
const CUES = {
  question: () => { tone(880, 0, .09); tone(1320, .11, .16); },
  approval: () => { tone(988, 0, .07); tone(988, .12, .07); tone(988, .24, .07); },
  complete: () => { [523, 659, 784, 1046].forEach((f, i) => tone(f, i * .08, .18, "triangle", .06)); },
  error: () => { tone(160, 0, .35, "sawtooth", .05); tone(120, .2, .35, "sawtooth", .05); },
  truncation: () => { tone(1400, 0, .25, "sine", .04); tone(700, .08, .3, "sine", .04); },
  "subtask-start": () => { tone(660, 0, .08); tone(990, .09, .1); },
  "subtask-return": () => { tone(990, 0, .08); tone(660, .09, .1); },
};
function cue(name) {
  if (!sound || !CUES[name]) return;
  try { CUES[name](); } catch {}
}

// ---------- bubble ----------
function say(text, ms) {
  const b = $("bubble");
  b.textContent = text;
  b.classList.add("show");
  clearTimeout(bubbleTimer);
  if (ms) bubbleTimer = setTimeout(() => b.classList.remove("show"), ms);
}
function hush() {
  $("bubble").classList.remove("show");
  body.classList.remove("alert");
}

// ---------- character: built-in SVG or image skin ----------
let skin = null;
let skinUrls = new Map();          // image file name -> blob URL (after chroma key, if any)
let frameTimer = null, frameIdx = 0, playing = null;
const failedVideos = new Set(); // videos this browser could not play; their state falls back to frames

function keyOut(px, hex, tol) {
  // removes the solid background colour an image AI was asked to paint, with a soft edge and spill removal
  const kr = parseInt(hex.slice(1, 3), 16), kg = parseInt(hex.slice(3, 5), 16), kb = parseInt(hex.slice(5, 7), 16);
  const green = kg > kr && kg > kb, blue = kb > kr && kb > kg, magenta = kr > kg && kb > kg;
  for (let i = 0; i < px.length; i += 4) {
    const dr = px[i] - kr, dg = px[i + 1] - kg, db = px[i + 2] - kb;
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    if (d < tol) { px[i + 3] = 0; continue; }
    if (d < tol * 2) {
      px[i + 3] = Math.min(px[i + 3], Math.round(255 * (d - tol) / tol));
      if (green) px[i + 1] = Math.min(px[i + 1], Math.max(px[i], px[i + 2]));
      else if (blue) px[i + 2] = Math.min(px[i + 2], Math.max(px[i], px[i + 1]));
      else if (magenta) { const m = px[i + 1]; px[i] = Math.min(px[i], m + 40); px[i + 2] = Math.min(px[i + 2], m + 40); }
    }
  }
}

// the character's files come from wingman-skin:// as they are needed; only chroma-keyed images are read
// up front, because their background has to be removed first
async function toUrl(name, img, s) {
  const url = s.base + name.split("/").map(encodeURIComponent).join("/");
  // videos carry their own transparency; GIFs would lose their animation through the canvas
  if (!s.chromaKey || img.mime === "image/gif" || img.mime.startsWith("video/")) return url;
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext("2d");
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  keyOut(d.data, s.chromaKey, s.chromaTolerance);
  g.putImageData(d, 0, 0);
  return URL.createObjectURL(await new Promise((r) => c.toBlob(r, "image/png")));
}

async function setSkin(s) {
  clearInterval(frameTimer);
  for (const u of skinUrls.values()) if (u.startsWith("blob:")) URL.revokeObjectURL(u);
  skinUrls = new Map();
  preloaded = new Map();
  playing = null;
  if (!s) {
    skin = null;
    pilot.classList.remove("sprite-mode");
    pilot.style.width = "";
    $("art").innerHTML = window.PILOT_SVG;
  } else {
    const urls = new Map();
    for (const [name, img] of Object.entries(s.images)) urls.set(name, await toUrl(name, img, s));
    skin = s;
    skinUrls = urls;
    pilot.classList.add("sprite-mode");
    pilot.style.width = Math.round(140 * s.size[0] / s.size[1]) + "px";
    $("art").innerHTML = '<div class="sprite" id="sprite"></div>';
  }
  applyState();
  window.wingman.skinReady();
}

function applyState() {
  if (!mood) return;
  const st = skin ? skin.states[mood] || skin.states.idle : { motion: BUILTIN_MOTION[mood], effect: BUILTIN_EFFECT[mood] };
  pilot.dataset.motion = st.motion || "none";
  pilot.dataset.effect = skin && !skin.effects ? "" : st.effect || "";
  if (skin && playing !== mood) {
    playing = mood;
    playState(st);
  }
}

function playState(st) {
  clearInterval(frameTimer);
  const el = $("sprite");
  if (!el) return;
  const old = el.querySelector("video");
  if (st.video && !failedVideos.has(st.video)) {
    el.style.backgroundImage = "";
    el.style.transform = "";
    const v = old || document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.loop = st.loop;
    v.onerror = () => {
      failedVideos.add(st.video);
      v.remove();
      if (playing === mood) playState(st); // fall back to the frames
    };
    if (v.dataset.key !== st.video) { // reading/running often reuse thinking/writing's video: keep it playing
      v.pause();
      v.src = skinUrls.get(st.video);
      v.dataset.key = st.video;
    }
    if (!old) el.append(v);
    v.play().catch(() => {});
    return;
  }
  if (old) { old.pause(); old.remove(); }
  playFrames(st);
}

// frames are loaded per state, when that state first plays without a video, and kept decoded so the
// loop never flickers; a state that has a video never loads its frames
let preloaded = new Map(); // url -> HTMLImageElement
let framesLoading = Promise.resolve();
function preload(st) {
  const urls = [...new Set(st.frames.map((f) => skinUrls.get(f.image)))].filter((u) => u && !preloaded.has(u));
  return Promise.all(urls.map((u) => {
    const im = new Image();
    im.src = u;
    preloaded.set(u, im);
    return im.decode().catch(() => {});
  }));
}

async function playFrames(st) {
  if (!st.frames.length) return;
  const token = playing;
  await (framesLoading = preload(st));
  if (playing !== token || !$("sprite")) return; // the state changed while loading
  clearInterval(frameTimer);
  frameIdx = 0;
  drawFrame(st.frames[0]);
  if (st.frames.length < 2) return;
  frameTimer = setInterval(() => {
    if (!st.loop && frameIdx === st.frames.length - 1) { clearInterval(frameTimer); return; }
    frameIdx = (frameIdx + 1) % st.frames.length;
    drawFrame(st.frames[frameIdx]);
  }, 1000 / st.fps);
}

function drawFrame(f) {
  const el = $("sprite");
  if (!el || !f) return;
  el.style.backgroundImage = `url("${skinUrls.get(f.image)}")`;
  if (f.cols > 1 || f.rows > 1) {
    el.style.backgroundSize = `${f.cols * 100}% ${f.rows * 100}%`;
    el.style.backgroundPosition = `${f.cols > 1 ? (f.col / (f.cols - 1)) * 100 : 0}% ${f.rows > 1 ? (f.row / (f.rows - 1)) * 100 : 0}%`;
  } else {
    el.style.backgroundSize = "contain";
    el.style.backgroundPosition = "center bottom";
  }
  el.style.transform = f.x || f.y || f.scale !== 1 ? `translate(${f.x}%, ${f.y}%) scale(${f.scale})` : "";
}

// ---------- launcher: shortcut tiles while nothing is running ----------
const quiet = (m) => m === "idle" || m === "offline";
let launcher = { enabled: false, autoShow: false, idleSeconds: 30, items: [] };
let launcherOpen = false, idleSince = Date.now(), dismissedThisIdle = false;

function tile(className, iconHtml, label, title) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tile " + className;
  b.innerHTML = iconHtml;
  const s = document.createElement("span");
  s.textContent = label;
  b.append(s);
  if (title) b.title = title;
  return b;
}

function renderLauncher() {
  const nodes = launcher.items.map((it, i) => {
    const b = tile(it.missing ? "missing" : "", it.icon ? '<img alt="">' : '<i class="ph">▢</i>', it.label, it.missing ? `見つかりません: ${it.path}` : it.path);
    if (it.icon) b.querySelector("img").src = it.icon;
    b.addEventListener("click", () => { window.wingman.launcherOpen(i); setLauncher(false); });
    b.addEventListener("contextmenu", (e) => { e.preventDefault(); window.wingman.launcherMenu(i); });
    return b;
  });
  const add = tile("add", '<i class="ph">＋</i>', "追加", "アプリ・ファイル・フォルダを追加（右クリックで各タイルの編集）");
  add.addEventListener("click", () => window.wingman.launcherAdd());
  nodes.push(add);
  if (!launcher.items.length) {
    const hint = document.createElement("div");
    hint.className = "lhint";
    hint.textContent = "アプリやフォルダをここへドラッグするか、＋で追加";
    nodes.push(hint);
  }
  $("lgrid").replaceChildren(...nodes);
}

let launcherByClick = false; // opened by clicking the character: stays open until closed, even when work starts
function setLauncher(open, byClick = false) {
  launcherOpen = !!open && launcher.enabled;
  launcherByClick = launcherOpen && byClick;
  body.classList.toggle("launcher-open", launcherOpen);
  if (launcherOpen) $("bubble").classList.remove("show");
}

setInterval(() => {
  if (!launcher.enabled || !launcher.autoShow || launcherOpen || dismissedThisIdle || !quiet(mood)) return;
  if (Date.now() - idleSince >= launcher.idleSeconds * 1000) setLauncher(true);
}, 1000);

const lz = $("launcher");
lz.addEventListener("dragover", (e) => { e.preventDefault(); lz.classList.add("drop"); });
lz.addEventListener("dragleave", () => lz.classList.remove("drop"));
lz.addEventListener("drop", (e) => {
  e.preventDefault();
  lz.classList.remove("drop");
  const paths = Array.from(e.dataTransfer.files, (f) => window.wingman.pathOf(f)).filter(Boolean);
  if (paths.length) window.wingman.launcherDrop(paths);
  else say("追加できませんでした（ファイルの場所が分かりません）", 4000);
});

// ---------- view ----------
function fmtTokens(n) {
  if (n == null) return "—";
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

function render(v) {
  if (v.mood !== mood) {
    const prev = mood;
    mood = v.mood;
    body.dataset.mood = mood;
    applyState();
    if (quiet(mood) && !quiet(prev)) { idleSince = Date.now(); dismissedThisIdle = false; }
    if (!quiet(mood) && !launcherByClick) setLauncher(false); // work started: the auto-opened launcher gets out of the way
    if (ALERT_MOODS.has(mood)) {
      body.classList.add("alert");
      clearTimeout(alertTimer);
      alertTimer = setTimeout(() => body.classList.remove("alert"), 2500);
      // waiting states keep their bubble until answered; the others fade on their own
      say(BUBBLE[mood], mood === "question" || mood === "approval" ? 0 : 8000);
      if (prev !== null) cue(mood);
    } else {
      hush();
    }
  }

  $("label").textContent = v.label;
  $("role").textContent = v.role || "—";
  $("mode").textContent = v.mode || "—";
  $("model").textContent = v.model || "—";
  $("tok").textContent = v.tokS ? `${Number(v.tokS).toFixed(1)} tok/s` : "";
  $("ctx").textContent = `CTX ${fmtTokens(v.contextTokens)}`;
  const text = v.tail || "";
  $("tailText").textContent = text.length > 1200 ? "…" + text.slice(-1200) : text;
  $("tail").className = "tail " + (v.tailKind || "");
  const src = $("src");
  src.replaceChildren(...(v.sources || []).map((s) => {
    const el = document.createElement("span");
    el.innerHTML = `<i class="${s.on ? "on" : ""}"></i>`;
    el.append(s.name);
    if (s.note) el.title = s.note;
    return el;
  }));
  if (!v.sources || !v.sources.length) src.textContent = "アドオン未選択";

  // fold the panel away when idle for a while; hovering brings it back
  clearTimeout(compactTimer);
  if (quiet(mood)) compactTimer = setTimeout(() => body.classList.add("compact"), COMPACT_AFTER_MS);
  else body.classList.remove("compact");
}

function onEvent(ev) {
  const text = ev.text || EVENT_BUBBLE[ev.type];
  if (!text) return;
  const cls = "ev-" + ev.type;
  body.classList.add(cls);
  clearTimeout(eventTimer);
  eventTimer = setTimeout(() => body.classList.remove(cls), 3500);
  if (!ALERT_MOODS.has(mood)) say(text, 3500); // never cover a question or approval
  cue(CUES[ev.type] ? ev.type : "subtask-start"); // addon-defined events get a short blip
}

function applySettings(s) {
  if ("sound" in s) sound = s.sound;
  if (s.snapshot) body.classList.add("snapshot");
  if (s.tailLines) document.documentElement.style.setProperty("--tail-lines", s.tailLines);
  if (s.show) {
    const rows = ["tags", "state", "thinking", "footer"];
    for (const key of [...rows, "character"]) body.classList.toggle("hide-" + key, !s.show[key]);
    body.classList.toggle("hide-hud", s.show.panel === false || !rows.some((k) => s.show[k]));
  }
}

// ---------- mouse: the main process passes clicks through except over these areas ----------
// It polls the cursor against these rectangles (page CSS pixels), which also works while a file is dragged in.
let lastRects = "";
function reportHitRects() {
  const rects = [];
  for (const el of [$("hud"), pilot, $("launcher")]) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05) continue;
    if (el === $("launcher") && !launcherOpen) continue;
    rects.push({ x: Math.floor(r.left), y: Math.floor(r.top), w: Math.ceil(r.width), h: Math.ceil(r.height) });
  }
  const key = JSON.stringify(rects);
  if (key !== lastRects) { lastRects = key; window.wingman.hitRects(rects); }
}
setInterval(reportHitRects, 150); // panels fold, slide and resize; cheap enough to just keep checking
new ResizeObserver(reportHitRects).observe(document.body);

// a file dropped anywhere but a drop target must not replace the page
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

let press = null, dragging = false, resizing = false;
for (const grip of document.querySelectorAll(".grip")) {
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId); // keep receiving the release even outside the window
    resizing = true;
    body.classList.add("resizing");
    window.wingman.resizeStart(grip.dataset.edge);
  });
  grip.addEventListener("pointerup", () => {
    if (!resizing) return;
    resizing = false;
    body.classList.remove("resizing");
    window.wingman.resizeEnd();
  });
}
// the character and the panel both move the window; a click without moving acknowledges the signal
for (const el of [pilot, $("hud")]) {
  // right-click: the same menu as the tray icon
  el.addEventListener("contextmenu", (e) => { e.preventDefault(); window.wingman.showMenu(); });
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.classList.contains("grip")) return; // only the left button clicks and drags
    press = { x: e.screenX, y: e.screenY };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (press && !dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
      dragging = true;
      window.wingman.dragStart();
    }
  });
  el.addEventListener("pointerup", () => {
    if (dragging) window.wingman.dragEnd();
    else if (press && el === pilot && launcher.enabled) {
      // the character opens and closes the launcher at any time (and the click also acknowledges a signal)
      hush();
      if (launcherOpen) dismissedThisIdle = true;
      setLauncher(!launcherOpen, true);
    } else if (press) hush();
    press = null;
    dragging = false;
  });
}

window.addEventListener("error", (e) => console.error(e.message, e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => console.error("unhandled:", e.reason && (e.reason.stack || e.reason)));

// --snapshot helper: resolves once a state's video has a frame on screen (rewound to its first frame when `still`)
window.awSnapReady = async (still) => {
  const v = document.querySelector("#sprite video");
  if (!v) { await framesLoading; await new Promise(requestAnimationFrame); return; }
  if (v.readyState < 2) await new Promise((r) => { v.addEventListener("loadeddata", r, { once: true }); setTimeout(r, 3000); });
  if (still) {
    v.pause();
    v.currentTime = 0;
    await new Promise((r) => { v.addEventListener("seeked", r, { once: true }); setTimeout(r, 1000); });
  }
};

$("art").innerHTML = window.PILOT_SVG;
window.wingman.onView(render);
window.wingman.onEvent(onEvent);
window.wingman.onSettings(applySettings);
window.wingman.onSkin(setSkin);
window.wingman.onNotice((text) => say(text, 6000));
window.wingman.onLauncher((l) => {
  launcher = l;
  renderLauncher();
  if (!l.enabled) setLauncher(false);
  if (l.forceOpen) setLauncher(true);
});
window.wingman.ready();
