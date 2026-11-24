// Example --drive script for tools/addon-harness.js: a fake ComfyUI server (no GPU) that runs three jobs.
//   node tools/addon-harness.js addons/comfyui --settings "{\"url\":\"http://127.0.0.1:18768\"}" --seconds 10 --drive tools/examples/drive-comfyui.js --expect-online
// Environment: HARNESS_PORT (default 18768), COMFY_LEGACY=1 (a server from before /api/jobs),
//              COMFY_SCENARIO=error (the second job fails with an out-of-memory error)
// The responses copy the shape of ComfyUI 0.40.0 (server.py /api/jobs, /queue, /history, /system_stats).
const http = require("http");

const txt2img = {
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sdxl\\animagineXL40_v4Opt.safetensors" }, _meta: { title: "Load Checkpoint" } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 4 }, _meta: { title: "Empty Latent Image" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "1girl, silver hair, standing in a flower field at sunset, masterpiece", clip: ["4", 1] }, _meta: { title: "CLIP Text Encode (Prompt)" } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "lowres, bad anatomy", clip: ["4", 1] }, _meta: { title: "CLIP Text Encode (Negative)" } },
  "10": { class_type: "PrimitiveInt", inputs: { value: 25 }, _meta: { title: "steps" } },
  "3": { class_type: "KSampler", inputs: { seed: 1, steps: ["10", 0], cfg: 6, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] }, _meta: { title: "KSampler" } },
  "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] }, _meta: { title: "VAE Decode" } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["8", 0] }, _meta: { title: "Save Image" } },
};
const i2v = {
  "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.2_i2v_high_noise_14B_fp8.safetensors", weight_dtype: "default" } },
  "2": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "lightx2v_4step.safetensors", strength_model: 1, model: ["1", 0] } },
  "3": { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl_fp8.safetensors", type: "wan" } },
  "4": { class_type: "LoadImage", inputs: { image: "start.png" } },
  "5": { class_type: "CLIPTextEncode", inputs: { text: "the girl turns around and waves", clip: ["3", 0] } },
  "6": { class_type: "WanImageToVideo", inputs: { width: 832, height: 480, length: 81, batch_size: 1, positive: ["5", 0], start_image: ["4", 0] } },
  "7": { class_type: "KSamplerAdvanced", inputs: { steps: 4, positive: ["6", 0], model: ["2", 0] } },
  "8": { class_type: "CreateVideo", inputs: { fps: 16 } },
  "9": { class_type: "SaveVideo", inputs: { filename_prefix: "video/wan" } },
};

module.exports = async (log) => {
  const port = Number(process.env.HARNESS_PORT || 18768);
  const legacy = process.env.COMFY_LEGACY === "1";
  const failSecond = process.env.COMFY_SCENARIO === "error";
  const t0 = Date.now() + 3200; // the addon looked before this server was up and tries again 3 s later
  const jobs = [
    { id: "aaaaaaaa-0000-4000-8000-000000000001", wf: "wf-txt2img", prompt: txt2img, start: 500, end: 1800, outputs: { "9": { images: [1, 2, 3, 4].map((n) => ({ filename: `ComfyUI_0000${n}_.png`, subfolder: "", type: "output" })) } } },
    { id: "aaaaaaaa-0000-4000-8000-000000000002", wf: "wf-txt2img", prompt: txt2img, start: 1800, end: 3000, fail: failSecond, outputs: failSecond ? {} : { "9": { images: [{ filename: "ComfyUI_00005_.png", subfolder: "", type: "output" }] } } },
    { id: "aaaaaaaa-0000-4000-8000-000000000003", wf: "wf-i2v", prompt: i2v, start: 3000, end: 4200, outputs: { "9": { images: [{ filename: "wan_00001_.mp4", subfolder: "video", type: "output" }], animated: [true] } } },
  ];
  const now = () => Date.now() - t0;
  const queueItem = (j, i) => [i, j.id, j.prompt, { client_id: "browser", create_time: t0, workflow_metadata: { workflow_id: j.wf } }, ["9"]];
  const historyItem = (j) => ({
    prompt: queueItem(j, 0),
    outputs: j.outputs,
    status: {
      status_str: j.fail ? "error" : "success", completed: !j.fail,
      messages: [["execution_start", { prompt_id: j.id, timestamp: t0 + j.start }],
        j.fail
          ? ["execution_error", { prompt_id: j.id, node_id: "3", node_type: "KSampler", exception_type: "torch.OutOfMemoryError", exception_message: "Allocation on device \nThis error means you ran out of memory on your GPU.", timestamp: t0 + j.end }]
          : ["execution_success", { prompt_id: j.id, timestamp: t0 + j.end }]],
    },
  });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const t = now();
    const running = jobs.filter((j) => j.start <= t && t < j.end);
    const pending = jobs.filter((j) => t >= 300 && j.start > t);
    const done = jobs.filter((j) => j.end <= t);
    const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (u.pathname === "/system_stats") return send(200, { system: { os: "win32", comfyui_version: "0.40.0-fake" }, devices: [{ name: "cuda:0 fake", type: "cuda", vram_total: 17074749440, vram_free: 9e9 }] });
    if (u.pathname === "/prompt") return send(200, { exec_info: { queue_remaining: running.length + pending.length } });
    if (u.pathname === "/queue") return send(200, { queue_running: running.map(queueItem), queue_pending: pending.map(queueItem) });
    if (u.pathname.startsWith("/history/")) {
      const j = done.find((x) => x.id === decodeURIComponent(u.pathname.slice(9)));
      return send(200, j ? { [j.id]: historyItem(j) } : {});
    }
    if (u.pathname === "/api/jobs" && !legacy) {
      const st = (u.searchParams.get("status") || "").split(",");
      let list = [...running.map((j) => ({ id: j.id, status: "in_progress", workflow_id: j.wf })), ...pending.map((j) => ({ id: j.id, status: "pending", workflow_id: j.wf })),
        ...done.map((j) => ({ id: j.id, status: j.fail ? "failed" : "completed", workflow_id: j.wf, execution_start_time: t0 + j.start, execution_end_time: t0 + j.end }))];
      list = list.filter((j) => !st[0] || st.includes(j.status)).filter((j) => !u.searchParams.get("workflow_id") || j.workflow_id === u.searchParams.get("workflow_id"));
      const limit = Number(u.searchParams.get("limit")) || list.length;
      return send(200, { jobs: list.slice(0, limit), pagination: { offset: 0, limit: limit || null, total: list.length, has_more: limit < list.length } });
    }
    send(404, { error: "not found" });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  log(`fake ComfyUI on ${port}${legacy ? " (legacy, no /api/jobs)" : ""}${failSecond ? ", job 2 fails" : ""}`);
  setTimeout(() => { log("fake ComfyUI stops"); server.close(); server.closeAllConnections(); }, 3200 + 5200);
};
