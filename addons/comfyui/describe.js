// Turns what ComfyUI reports into short Japanese sentences.
// describe(): a queued workflow (API format: { nodeId: { class_type, inputs, _meta } }) -> what it makes.
// result():   a /history item -> how it ended (files written, error, time taken).
// Both read node types and literal inputs only, so workflows full of custom nodes still get a sentence,
// just with fewer details.

const MODEL_FILE = /\.(safetensors|ckpt|gguf|pt|pth|bin|sft|onnx)$/i;
const VIDEO_FILE = /\.(mp4|webm|mov|mkv|gif|avi)$/i;
const AUDIO_FILE = /\.(wav|mp3|flac|ogg|m4a|opus)$/i;

const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const baseName = (f) => String(f).split(/[\\/]/).pop().replace(MODEL_FILE, "");

function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

function describe(prompt, { promptChars = 40 } = {}) {
  const nodes = Object.entries(prompt || {}).map(([id, n]) => ({ id, type: String((n && n.class_type) || ""), title: String((n && n._meta && n._meta.title) || ""), inputs: (n && n.inputs) || {} }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // a linked input is [sourceNodeId, slot]; a primitive node at the other end gives its literal value
  const val = (v, depth = 0) => {
    if (Array.isArray(v) && v.length === 2 && byId.has(String(v[0]))) {
      if (depth > 3) return undefined;
      const src = byId.get(String(v[0]));
      for (const k of ["value", "int", "float", "string", "number"]) if (k in src.inputs) return val(src.inputs[k], depth + 1);
      return undefined;
    }
    return v;
  };
  const num = (v) => { const x = val(v); return typeof x === "number" && isFinite(x) ? x : null; };

  // what it makes
  const types = nodes.map((n) => n.type).join(" ");
  let kind = "画像";
  if (/SaveAudio|TTS|AudioCombine|F5|VibeVoice/i.test(types)) kind = "音声";
  else if (/Save3D|SaveGLB|Mesh|Hunyuan3D|TripoSR/i.test(types)) kind = "3Dモデル";
  else if (/Video|AnimateDiff|LTXV|Wan.*(I2V|T2V|ToVideo)|VHS_/i.test(types) ||
    nodes.some((n) => ["fps", "frame_rate", "num_frames"].some((k) => num(n.inputs[k]) !== null))) kind = "動画";

  const samplers = nodes.filter((n) => /^KSampler(Advanced)?$|SamplerCustom/i.test(n.type) ||
    (/Sampler/i.test(n.type) && !/Select|Scheduler/i.test(n.type) && "steps" in n.inputs));
  const verb = samplers.length ? "生成中" : /Upscale/i.test(types) ? "アップスケール中" : "処理中";

  // models: file names on loader nodes; LoRA / VAE / text encoders are told apart by key or node type
  let model = null;
  const loras = new Set();
  for (const n of nodes.filter((x) => /Load/i.test(x.type))) {
    for (const [k, v] of Object.entries(n.inputs)) {
      if (typeof v !== "string" || !MODEL_FILE.test(v)) continue;
      if (/lora/i.test(k + n.type)) loras.add(v);
      else if (!model && !/vae|clip|text_enc|t5|encoder|audio|upscale/i.test(k)) model = baseName(v);
    }
  }

  const steps = [...new Set(nodes.filter((n) => samplers.includes(n) || /Scheduler/i.test(n.type)).map((n) => num(n.inputs.steps)).filter((x) => x))];

  let size = null;
  for (const n of [...nodes].sort((a, b) => /Latent|Empty/i.test(b.type) - /Latent|Empty/i.test(a.type))) {
    const w = num(n.inputs.width), h = num(n.inputs.height);
    if (w && h) { size = `${w}×${h}`; break; }
  }
  let frames = null;
  for (const n of nodes) {
    const f = num(n.inputs.length) || num(n.inputs.num_frames) || num(n.inputs.frame_count);
    if (f && kind === "動画" && /Video|Latent|Wan|LTX|Hunyuan/i.test(n.type)) { frames = f; break; }
  }
  const images = nodes.filter((n) => /^LoadImage/i.test(n.type)).length;
  const videos = nodes.filter((n) => /LoadVideo/i.test(n.type)).length;

  // the positive prompt: the text encoder wired to a sampler's "positive", else the first one with text
  const positiveIds = new Set(samplers.map((s) => Array.isArray(s.inputs.positive) ? String(s.inputs.positive[0]) : null).filter(Boolean));
  const encoders = nodes.filter((n) => /TextEncode|Prompt/i.test(n.type) && !/negative|ネガ/i.test(n.title));
  encoders.sort((a, b) => positiveIds.has(b.id) - positiveIds.has(a.id));
  let text = null;
  for (const n of encoders) {
    for (const k of ["text", "prompt", "text_g", "positive"]) {
      const t = val(n.inputs[k]);
      if (typeof t === "string" && t.trim()) { text = t.replace(/\s+/g, " ").trim(); break; }
    }
    if (text) break;
  }

  const parts = [];
  if (model) parts.push(short(model, 28) + (loras.size ? ` + LoRA${loras.size > 1 ? loras.size : ""}` : ""));
  if (size) parts.push(size + (frames ? `・${frames}フレーム` : ""));
  if (steps.length) parts.push(`${steps.join("/")}ステップ${samplers.length > 1 ? `×${samplers.length}` : ""}`);
  if (images) parts.push(`入力画像${images}枚`);
  if (videos) parts.push(`入力動画${videos}本`);
  if (text) parts.push(`「${short(text, promptChars)}」`);
  if (!parts.length) parts.push(`${nodes.length}ノード`);
  return { text: `${kind}を${verb}：${parts.join("・")}`, kind, model };
}

// item: one value of GET /history/{id} -> { status, files, fileKind, last, error, ms }
function result(item) {
  const messages = (item && item.status && item.status.messages) || [];
  let start = null, end = null, error = null, interrupted = false;
  for (const m of messages) {
    if (!Array.isArray(m) || !m[1]) continue;
    if (m[0] === "execution_start") start = m[1].timestamp;
    if (["execution_success", "execution_error", "execution_interrupted"].includes(m[0])) end = m[1].timestamp;
    if (m[0] === "execution_error") error = m[1];
    if (m[0] === "execution_interrupted") interrupted = true;
  }
  const status = interrupted ? "interrupted" : error || (item && item.status && item.status.status_str === "error") ? "error" : "success";

  const count = { 画像: 0, 動画: 0, 音声: 0 };
  let last = null;
  for (const out of Object.values((item && item.outputs) || {})) {
    for (const [k, list] of Object.entries(out || {})) {
      if (!Array.isArray(list)) continue;
      for (const f of list) {
        if (!f || typeof f.filename !== "string" || f.type === "temp") continue;
        const kind = VIDEO_FILE.test(f.filename) || /gif|video/i.test(k) ? "動画" : AUDIO_FILE.test(f.filename) || /audio/i.test(k) ? "音声" : "画像";
        count[kind]++;
        last = f.filename;
      }
    }
  }
  const files = Object.entries(count).filter(([, n]) => n).map(([k, n]) => `${k}${n}${k === "動画" ? "本" : k === "音声" ? "件" : "枚"}`).join("・");

  let errorText = null;
  if (error) {
    const type = String(error.exception_type || "").split(".").pop();
    const msg = String(error.exception_message || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
    errorText = `${error.node_type || "ノード"}${error.node_id ? `（#${error.node_id}）` : ""}でエラー：${short([type, msg].filter(Boolean).join(" ") || "原因不明", 120)}`;
  }
  return { status, files, last, error: errorText, ms: start && end ? end - start : null };
}

module.exports = { describe, result, mmss };
