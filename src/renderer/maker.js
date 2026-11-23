// "動画からキャラクターを作る": builds an AgentWingman character from videos, animated images or image
// sequences, entirely in this window (no Python, ComfyUI or ffmpeg). Same idea as SpriteForge_Wingman's
// pack step: remove the background, line every state's feet up with idle's, cut all frames with one
// square frame, and write transparent PNG frames plus skin.json (saved by the main process).
const $ = (id) => document.getElementById(id);

const STATES = [
  ["idle", "待機（必須）", "ふだんの動き（呼吸・まばたき）"],
  ["thinking", "思考中", "考えている動き（読込中にも使います）"],
  ["writing", "作業中", "タイピングなど（回答作成中にも使います）"],
  ["question", "質問", "呼ぶ・手を挙げる"],
  ["approval", "承認待ち", "手を振る"],
  ["complete", "完了", "喜ぶ・バンザイ"],
  ["error", "エラー", "困る・あわてる"],
  ["offline", "休止", "眠る・目を閉じる（灰色で表示）"],
];
const OUT = 320;       // output frame size (square)
const MAX_SEC = 6;     // longest clip used per state
const WORK_MAX = 480;  // sources are scaled down to this before processing (speed, memory)
const ALPHA_T = 40;    // pixels more opaque than this count as the character
const VIDEO_EXT = /\.(webm|mp4|m4v|mov|mkv|avi)$/i;
const MIME = { gif: "image/gif", webp: "image/webp", png: "image/png", apng: "image/apng", jpg: "image/jpeg", jpeg: "image/jpeg", bmp: "image/bmp" };

const slots = {}; // state -> File[]

// ---------- UI ----------
function buildRows() {
  const tbody = $("slots");
  for (const [id, label, hint] of STATES) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="name"><b>${label}</b><small>${hint}</small></td>
      <td><div class="drop" id="drop-${id}" tabindex="0">ファイルを選ぶ／ここへドロップ</div></td>
      <td><canvas class="thumb" id="thumb-${id}" width="144" height="144"></canvas></td>
      <td><span class="st" id="st-${id}"></span></td>`;
    tbody.append(tr);
    const drop = tr.querySelector(".drop");
    drop.addEventListener("click", (e) => { if (e.target.classList.contains("clear")) return; pickFor = id; $("picker").value = ""; $("picker").click(); });
    drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); drop.click(); } });
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files.length) setSlot(id, [...e.dataTransfer.files]); });
  }
}
let pickFor = null;
$("picker").addEventListener("change", () => { if (pickFor && $("picker").files.length) setSlot(pickFor, [...$("picker").files]); });
$("bg").addEventListener("change", () => { $("bgColor").hidden = $("bg").value !== "color"; });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

function setSlot(id, files) {
  if (files) slots[id] = files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  else delete slots[id];
  const drop = $(`drop-${id}`), f = slots[id];
  drop.classList.toggle("has", !!f);
  drop.innerHTML = f ? `${escapeHtml(f.length > 1 ? `連番 ${f.length} 枚（${f[0].name} …）` : f[0].name)} <button class="clear" title="外す">×</button>` : "ファイルを選ぶ／ここへドロップ";
  if (f) drop.querySelector(".clear").addEventListener("click", (e) => { e.stopPropagation(); setSlot(id, null); });
  status(id, "");
  const thumb = $(`thumb-${id}`);
  thumb.getContext("2d").clearRect(0, 0, thumb.width, thumb.height);
  $("make").disabled = !slots.idle;
}
const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function status(id, text, kind = "") { const s = $(`st-${id}`); s.textContent = text; s.className = "st " + kind; }
function message(text, kind = "") { $("msg").textContent = text; $("msg").className = "msg " + kind; }

// ---------- decoding: every source becomes a stream of ImageData at a fixed frame rate ----------
function workSize(w, h) {
  const k = Math.min(1, WORK_MAX / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
function toImageData(src, w, h) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(src, 0, 0, w, h);
  return g.getImageData(0, 0, w, h);
}
const mimeOf = (f) => f.type || MIME[(f.name.split(".").pop() || "").toLowerCase()] || "";

async function* videoFrames(file, fps) {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true; v.preload = "auto"; v.src = url;
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error("動画を読み込めません（この形式に未対応の可能性があります。WebM か MP4 にしてみてください）")); });
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? Math.min(v.duration, MAX_SEC) : MAX_SEC;
    const { w, h } = workSize(v.videoWidth, v.videoHeight);
    const n = Math.max(1, Math.floor(dur * fps + 1e-6));
    for (let i = 0; i < n; i++) {
      const t = Math.min(i / fps + 0.001, Number.isFinite(v.duration) ? Math.max(0, v.duration - 0.001) : i / fps);
      await new Promise((res) => {
        const done = () => { v.removeEventListener("seeked", done); res(); };
        v.addEventListener("seeked", done);
        v.currentTime = t;
        setTimeout(done, 3000);
      });
      yield toImageData(v, w, h);
    }
  } finally {
    v.removeAttribute("src"); v.load();
    URL.revokeObjectURL(url);
  }
}

async function* imageFrames(file, fps) {
  const type = mimeOf(file);
  const canDecode = "ImageDecoder" in window && type && (await ImageDecoder.isTypeSupported(type).catch(() => false));
  if (!canDecode) { // still image the simple way
    const bmp = await createImageBitmap(file);
    const { w, h } = workSize(bmp.width, bmp.height);
    yield toImageData(bmp, w, h);
    bmp.close();
    return;
  }
  const dec = new ImageDecoder({ data: await file.arrayBuffer(), type });
  try {
    await dec.tracks.ready;
    const count = (dec.tracks.selectedTrack && dec.tracks.selectedTrack.frameCount) || 1;
    // the animation's own timeline (each frame has its own duration), then sampled at our frame rate
    const list = [];
    let t = 0;
    for (let i = 0; i < count && t < MAX_SEC; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const d = count > 1 ? Math.max(0.02, (image.duration || 100000) / 1e6) : 0;
      list.push({ image, start: t, end: t + d });
      t += d;
    }
    const { w, h } = workSize(list[0].image.displayWidth, list[0].image.displayHeight);
    const n = count > 1 ? Math.max(1, Math.round(Math.min(t, MAX_SEC) * fps)) : 1;
    for (let k = 0; k < n; k++) {
      const time = k / fps;
      const f = list.find((x) => time >= x.start && time < x.end) || list[list.length - 1];
      yield toImageData(f.image, w, h);
    }
    for (const x of list) x.image.close();
  } finally {
    dec.close();
  }
}

async function* sequenceFrames(files, fps) {
  let size = null;
  for (const f of files.slice(0, MAX_SEC * fps)) {
    const bmp = await createImageBitmap(f);
    size = size || workSize(bmp.width, bmp.height);
    yield toImageData(bmp, size.w, size.h);
    bmp.close();
  }
}

function framesOf(files, fps) {
  if (files.length > 1) return sequenceFrames(files, fps);
  const f = files[0];
  return VIDEO_EXT.test(f.name) || (f.type || "").startsWith("video/") ? videoFrames(f, fps) : imageFrames(f, fps);
}

// ---------- background ----------
// border pixels decide: mostly transparent -> already cut out; mostly one colour -> that colour is the background
function analyzeBackground(img) {
  const { width: w, height: h, data: d } = img;
  let total = 0, clear = 0;
  const buckets = new Map();
  const visit = (x, y) => {
    const i = (y * w + x) * 4;
    total++;
    if (d[i + 3] < 200) { clear++; return; }
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2];
    buckets.set(key, b);
  };
  for (let x = 0; x < w; x++) { visit(x, 0); visit(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { visit(0, y); visit(w - 1, y); }
  if (clear / total > 0.5) return { mode: "keep" };
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  if (!best || best.n / total < 0.5) return { mode: "keep", unsure: true }; // the border is not one solid colour
  return { mode: "key", color: [best.r / best.n, best.g / best.n, best.b / best.n].map(Math.round) };
}

// removes the background colour with a soft edge and colour-spill removal (same as the app's chroma key)
function keyOut(px, [kr, kg, kb], tol) {
  const green = kg > kr && kg > kb, blue = kb > kr && kb > kg, magenta = kr > kg && kb > kg;
  for (let i = 0; i < px.length; i += 4) {
    const dr = px[i] - kr, dg = px[i + 1] - kg, db = px[i + 2] - kb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist < tol) { px[i + 3] = 0; continue; }
    if (dist < tol * 2) {
      px[i + 3] = Math.min(px[i + 3], Math.round((255 * (dist - tol)) / tol));
      if (green) px[i + 1] = Math.min(px[i + 1], Math.max(px[i], px[i + 2]));
      else if (blue) px[i + 2] = Math.min(px[i + 2], Math.max(px[i], px[i + 1]));
      else if (magenta) { const m = px[i + 1]; px[i] = Math.min(px[i], m + 40); px[i + 2] = Math.min(px[i + 2], m + 40); }
    }
  }
}

function bbox(img) {
  const { width: w, height: h, data: d } = img;
  let l = w, t = h, r = -1, b = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (d[row + x * 4 + 3] > ALPHA_T) {
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        if (y > b) b = y;
      }
    }
  }
  return r < 0 ? null : { l, t, r: r + 1, b: b + 1 };
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ---------- building ----------
// ---------- video output (needs ffmpeg: found on PATH, or downloaded on request) ----------
let ffmpeg = { source: "none" };
function showFfmpeg(s) {
  ffmpeg = s;
  const ok = !!s.vp9;
  $("ffStatus").textContent = ok
    ? `使える ffmpeg: ${s.source === "downloaded" ? "ダウンロード済み" : "このPCにあるもの"}（${s.version}）`
    : "動画で書き出すには ffmpeg が必要です（このPCには見つかりませんでした）";
  $("ffStatus").className = "st " + (ok ? "ok" : "");
  $("ffGet").hidden = ok;
  $("video").disabled = !ok;
  if (ok && !$("video").dataset.touched) { $("video").checked = true; $("fps").value = "24"; } // video is the better default
}
$("video").addEventListener("change", () => { $("video").dataset.touched = "1"; if ($("video").checked) $("fps").value = "24"; });
$("ffGet").addEventListener("click", async () => {
  $("ffGet").disabled = true;
  $("ffProg").hidden = false;
  $("ffStatus").textContent = "ダウンロードの準備中…";
  try {
    const s = await window.wingmanMaker.ffmpegDownload();
    if (s.cancelled) $("ffStatus").textContent = "ダウンロードをやめました";
    else showFfmpeg(s);
  } catch (e) {
    $("ffStatus").textContent = "ダウンロードできませんでした: " + e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    $("ffStatus").className = "st bad";
  } finally {
    $("ffGet").disabled = false;
    $("ffProg").hidden = true;
  }
});
window.wingmanMaker.onFfmpegProgress(({ got, total }) => {
  $("ffProg").max = total || 1;
  $("ffProg").value = got;
  $("ffStatus").textContent = `ダウンロード中… ${Math.round(got / 1048576)} / ${Math.round((total || 0) / 1048576)} MB`;
});
window.wingmanMaker.ffmpegStatus().then(showFfmpeg);

function options() {
  const hex = $("bgColor").value;
  return {
    video: $("video").checked && !!ffmpeg.vp9,
    name: $("name").value.trim() || "マイキャラクター",
    bg: $("bg").value,
    color: [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)),
    tol: Number($("tol").value),
    fps: Number($("fps").value),
    pingpong: $("pingpong").checked,
  };
}

async function make(opt = options()) {
  const ids = STATES.map(([id]) => id).filter((id) => slots[id]);
  if (!slots.idle) throw new Error("待機の素材が必要です");
  const prog = $("prog");
  prog.hidden = false; prog.value = 0; prog.max = ids.length * 2;
  const info = {};

  // pass 1: background, where the character is in every frame
  for (const id of ids) {
    status(id, "読み込み中…");
    const bg = { mode: opt.bg === "keep" ? "keep" : opt.bg === "color" ? "key" : null, color: opt.color };
    const boxes = [];
    let size = null, n = 0;
    for await (const img of framesOf(slots[id], opt.fps)) {
      if (!bg.mode) Object.assign(bg, analyzeBackground(img)); // auto: decided from the first frame
      if (bg.mode === "key") keyOut(img.data, bg.color, opt.tol);
      size = size || { w: img.width, h: img.height };
      const b = bbox(img);
      if (b) boxes.push(b);
      n++;
    }
    if (!boxes.length) throw Object.assign(new Error("キャラクターが見つかりません（背景を抜きすぎているかもしれません。「抜く強さ」を下げてください）"), { state: id });
    info[id] = { bg, boxes, size, n };
    status(id, `${n} コマ${bg.mode === "key" ? `、背景 rgb(${bg.color.join(",")}) を除去` : bg.unsure ? "、背景はそのまま（単色ではありません）" : ""}`);
    prog.value++;
  }

  // line up: each state scaled to idle's frame height, feet on idle's feet, centred on idle's centre
  const idle = info.idle;
  const place = {};
  for (const id of ids) {
    const s = info[id];
    const scale = idle.size.h / s.size.h;
    const ground = Math.max(...s.boxes.map((b) => b.b)) * scale;
    const cx = median(s.boxes.map((b) => (b.l + b.r) / 2)) * scale;
    place[id] = { scale, ground, cx };
  }
  for (const id of ids) {
    place[id].dx = place.idle.cx - place[id].cx;
    place[id].dy = place.idle.ground - place[id].ground;
  }
  // one square frame around every frame of every state, feet near the bottom
  let L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
  for (const id of ids) {
    const { scale, dx, dy } = place[id];
    for (const b of info[id].boxes) {
      L = Math.min(L, b.l * scale + dx); R = Math.max(R, b.r * scale + dx);
      T = Math.min(T, b.t * scale + dy); B = Math.max(B, b.b * scale + dy);
    }
  }
  const side = Math.max(R - L, B - T) * 1.06;
  const crop = { x: (L + R) / 2 - side / 2, y: B + side * 0.02 - side, side };

  // pass 2: cut out every frame and encode it
  const out = {};
  for (const id of ids) {
    status(id, "書き出し中…");
    const s = info[id], p = place[id];
    const k = OUT / crop.side;
    const files = [];
    const src = new OffscreenCanvas(s.size.w, s.size.h);
    const sg = src.getContext("2d");
    let i = 0;
    for await (const img of framesOf(slots[id], opt.fps)) {
      if (s.bg.mode === "key") keyOut(img.data, s.bg.color, opt.tol);
      sg.putImageData(img, 0, 0);
      const c = new OffscreenCanvas(OUT, OUT);
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.setTransform(k * p.scale, 0, 0, k * p.scale, (p.dx - crop.x) * k, (p.dy - crop.y) * k);
      g.drawImage(src, 0, 0);
      const name = `${id}_${String(i).padStart(3, "0")}.png`;
      files.push({ name, data: new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer()) });
      if (i === 0) drawThumb(id, c);
      i++;
    }
    const names = files.map((f) => f.name);
    const order = opt.pingpong && names.length > 2 ? [...names, ...names.slice(1, -1).reverse()] : names;
    out[id] = { files, order };
    status(id, `${files.length} コマ ✓`, "ok");
    prog.value++;
  }
  prog.hidden = true;
  if (opt.video) message("動画に書き出し中…");
  return window.wingmanMaker.save({ name: opt.name, fps: opt.fps, size: OUT, states: out, video: !!opt.video });
}

function drawThumb(id, canvas) {
  const t = $(`thumb-${id}`), g = t.getContext("2d");
  g.clearRect(0, 0, t.width, t.height);
  g.drawImage(canvas, 0, 0, t.width, t.height);
}

$("make").addEventListener("click", async () => {
  $("make").disabled = true;
  message("作成中…（動画の長さによっては1分ほどかかります）");
  try {
    const r = await make();
    const video = r.videos ? `動画 ${r.videos} 本、` : "";
    message(`できました（${video}予備の PNG 付き）。「${r.name}」に切り替えました（保存先: ${r.dir}）${r.warnings && r.warnings.length ? "\n注意: " + r.warnings.join(" / ") : ""}`, r.warnings && r.warnings.length ? "bad" : "ok");
  } catch (e) {
    if (e.state) status(e.state, "失敗", "bad");
    message(`作れませんでした: ${e.message}`, "bad");
  } finally {
    $("make").disabled = !slots.idle;
    $("prog").hidden = true;
  }
});

buildRows();

// test hook (used only by `--maker-test`): load files from disk paths and build with the given options
window.makerTest = async (paths, opt) => {
  for (const [id, list] of Object.entries(paths)) {
    const files = [];
    for (const p of list) {
      const f = await window.wingmanMaker.readFile(p);
      files.push(new File([f.data], f.name, { type: MIME[(f.name.split(".").pop() || "").toLowerCase()] || (VIDEO_EXT.test(f.name) ? "video/webm" : "") }));
    }
    setSlot(id, files);
  }
  return make({ ...options(), ...opt });
};
