// Full-screen overlay: turns AgentWingman's stream into kusa_commenter-style comments.
//   item: { style, kind, text, title }  - one piece of content in a given style
//   feed: { style, kind, text }         - newly generated live text, cut here into short comments
const $ = (id) => document.getElementById(id);
let cfg = { lanes: 9, scrollSpeed: 400, fontSize: 26, opacity: 0.9, maxChars: 40, toastBottom: 230, chatlogWidth: 800, chatlogLines: 12,
  chatlogHoldSeconds: 2, chatlogFadeSeconds: 6, chatlogOpacity: 0.85 };
// headline for live text shown in the banner
const LIVE_TITLE = { think: "思考中", output: "回答" };

function applyConfig(c) {
  cfg = { ...cfg, ...c };
  const r = document.documentElement.style;
  r.setProperty("--font", cfg.fontSize + "px");
  r.setProperty("--alpha", cfg.opacity);
  r.setProperty("--chat-alpha", cfg.chatlogOpacity);
  r.setProperty("--chat-w", cfg.chatlogWidth + "px");
  r.setProperty("--toast-bottom", cfg.toastBottom + "px");
  document.body.classList.toggle("snapshot", !!cfg.snapshot);
}

function el(cls, kind, text) {
  const d = document.createElement("div");
  d.className = `c ${cls} k-${kind}`;
  d.textContent = text;
  return d;
}

// ---------- scroll (lanes, right to left) ----------
let laneFree = [];
function spawnScroll(kind, text) {
  const layer = $("scroll");
  if (layer.childElementCount > cfg.lanes * 4) return; // flooded: skip rather than pile up
  const d = el("scroll", kind, text);
  layer.append(d);
  const W = innerWidth, w = d.offsetWidth;
  const speed = cfg.scrollSpeed * (1 + (Math.random() * 2 - 1) * 0.3);
  const now = performance.now();
  if (laneFree.length !== cfg.lanes) laneFree = Array(cfg.lanes).fill(0);
  let lane = laneFree.findIndex((t) => t <= now);
  if (lane < 0) lane = laneFree.indexOf(Math.min(...laneFree)); // all busy: reuse the one freeing soonest
  laneFree[lane] = now + ((w + 60) / speed) * 1000; // free again once this comment has fully entered
  const top = innerHeight * 0.04, laneH = (innerHeight * 0.8) / cfg.lanes;
  d.style.top = top + lane * laneH + "px";
  const anim = d.animate([{ transform: `translateX(${W}px)` }, { transform: `translateX(${-w - 10}px)` }], { duration: ((W + w) / speed) * 1000, easing: "linear" });
  anim.onfinish = () => d.remove();
}

// ---------- toast (bottom-right) ----------
// Live text keeps one toast per kind and rewrites it as new sentences arrive (instead of a new toast per
// sentence, which pushed each other out); it fades once the text stops coming.
const liveToast = {};
function spawnToast(kind, text, live) {
  const box = $("toasts");
  let t = live ? liveToast[kind] : null;
  if (t && t.el.isConnected && !t.fading) {
    t.el.textContent = text;
  } else {
    while (box.childElementCount >= 4) box.firstElementChild.remove();
    const d = el("toast", kind, text);
    box.append(d);
    d.animate([{ opacity: 0, transform: "translateX(20px)" }, { transform: "none" }], { duration: 400, easing: "ease-out" });
    t = { el: d, fading: false };
    if (live) liveToast[kind] = t;
  }
  clearTimeout(t.timer);
  t.timer = setTimeout(() => {
    t.fading = true;
    const a = t.el.animate([{}, { opacity: 0 }], { duration: 500, fill: "forwards" });
    a.onfinish = () => { t.el.remove(); if (liveToast[kind] === t) delete liveToast[kind]; };
  }, live ? 2500 : 3000);
}

// ---------- chatlog (bottom-left) ----------
// each line stays for chatlogHoldSeconds, then fades out over chatlogFadeSeconds (0 = stays until pushed out)
function spawnChat(kind, text) {
  const box = $("chatlog");
  const d = el("chat", kind, text);
  box.append(d);
  while (box.childElementCount > cfg.chatlogLines) box.firstElementChild.remove();
  if (cfg.chatlogFadeSeconds > 0) {
    const hold = Math.max(0, cfg.chatlogHoldSeconds) * 1000, fade = cfg.chatlogFadeSeconds * 1000;
    const a = d.animate([{}, { opacity: getComputedStyle(d).opacity, offset: hold / (hold + fade) }, { opacity: 0 }], { duration: hold + fade, fill: "forwards" });
    a.onfinish = () => d.remove();
  }
}

// ---------- banner (middle) ----------
// Signals queue up one after another. Live text never queues: it rewrites the banner that is showing
// (or the one waiting), so a long answer cannot build up a backlog.
const bannerQueue = [];
let bannerCur = null, bannerTimer = null;
function setBanner(b) {
  $("bannerTitle").textContent = b.title || b.text;
  $("bannerText").textContent = b.title ? b.text || "" : "";
}
function holdBanner(ms) {
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    $("banner").classList.add("out");
    bannerTimer = setTimeout(() => { $("banner").className = "banner"; bannerCur = null; nextBanner(); }, 300);
  }, ms);
}
function spawnBanner(kind, title, text, live) {
  const b = { kind, title, text, live };
  if (live) {
    if (bannerCur && bannerCur.live && bannerCur.kind === kind && !$("banner").classList.contains("out")) {
      setBanner(b);
      holdBanner(cfg.bannerMs || 2600);
      return;
    }
    const waiting = bannerQueue.find((q) => q.live && q.kind === kind);
    if (waiting) { Object.assign(waiting, b); return; }
  }
  bannerQueue.push(b);
  if (!bannerCur) nextBanner();
}
function nextBanner() {
  const b = bannerQueue.shift();
  if (!b) return;
  bannerCur = b;
  const box = $("banner");
  box.className = `banner show k-${b.kind}`;
  setBanner(b);
  // restart the entrance animation
  const band = box.querySelector(".band");
  band.style.animation = "none"; void band.offsetWidth; band.style.animation = "";
  holdBanner(cfg.bannerMs || 2600);
}

function show(style, kind, text, title, live = false) {
  if (!text && !title) return;
  const line = title ? `${title}${text ? "：" + text : ""}` : text;
  if (style === "scroll") spawnScroll(kind, line);
  else if (style === "toast") spawnToast(kind, live ? `${LIVE_TITLE[kind] || ""}${LIVE_TITLE[kind] ? "：" : ""}${text}` : line, live);
  else if (style === "chatlog") spawnChat(kind, line);
  else if (style === "banner") spawnBanner(kind, title || (live ? LIVE_TITLE[kind] : undefined), text, live);
}

// ---------- live text: cut into short comments ----------
const buffers = {};
function cut(buf, max) {
  // prefer sentence ends, then commas / spaces, then a hard cut
  const m = buf.slice(0, max + 1).match(/^[\s\S]*?[。．！？!?\n]|^[\s\S]*?[.](?=\s)/);
  if (m && m[0].trim().length >= 4) return m[0].length;
  if (buf.length < max) return 0;
  const soft = Math.max(buf.lastIndexOf("、", max), buf.lastIndexOf(",", max), buf.lastIndexOf(" ", max));
  return soft > max * 0.5 ? soft + 1 : max;
}
function feed({ style, kind, text }) {
  const b = (buffers[kind] = buffers[kind] || { text: "", style, timer: null });
  b.text += text;
  b.style = style;
  let n;
  while ((n = cut(b.text, cfg.maxChars)) > 0) {
    const piece = b.text.slice(0, n).trim();
    b.text = b.text.slice(n);
    if (piece) show(style, kind, piece, undefined, true);
  }
  clearTimeout(b.timer); // a pause in generation flushes what is left
  b.timer = setTimeout(() => { const piece = b.text.trim(); b.text = ""; if (piece) show(b.style, kind, piece, undefined, true); }, 1500);
}

window.ov.onConfig(applyConfig);
window.ov.onItem((it) => show(it.style, it.kind, it.text, it.title));
window.ov.onFeed(feed);
// --overlay-matrix test helpers: how many pieces of text are visible right now, and a reset
window.awOverlayVisible = () => {
  let n = 0;
  for (const e of document.querySelectorAll(".c")) if (e.textContent.trim() && Number(getComputedStyle(e).opacity) > 0.3) n++;
  if ($("banner").classList.contains("show")) n++;
  return n;
};
window.awOverlayClear = () => location.reload();

window.ov.ready();
