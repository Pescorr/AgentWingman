// Merges every running addon's report into one view for the character.
// Priority: a signal waiting for the user (newest first) > live activity (thinking/writing > reading > running) > idle.

const LABEL = {
  offline: "接続なし",
  idle: "待機中",
  reading: "プロンプト読込中",
  thinking: "思考中",
  writing: "回答作成中",
  running: "作業中",
  question: "質問があります",
  approval: "承認待ち",
  complete: "タスク完了",
  error: "エラー",
};
const RANK = { thinking: 4, writing: 4, reading: 3, running: 2 };
const COMPLETE_FADE_MS = 10 * 60 * 1000; // an old "completed" task stops counting as news

const present = (v) => v !== null && v !== undefined && v !== "";

function combine(states) {
  const now = Date.now();
  const online = states.filter((s) => s.online);
  const live = (s) => s.signal && !(s.signal.kind === "complete" && now - s.signal.ts > COMPLETE_FADE_MS);

  let lead = null, mood = online.length ? "idle" : "offline";
  const waiting = online.filter(live).sort((a, b) => b.signal.ts - a.signal.ts);
  if (waiting.length) {
    lead = waiting[0];
    mood = lead.signal.kind;
  } else {
    const busy = online.filter((s) => RANK[s.activity]).sort((a, b) => RANK[b.activity] - RANK[a.activity] || b.updatedAt - a.updatedAt);
    if (busy.length) {
      lead = busy[0];
      mood = lead.activity;
    }
  }

  // fields come from the leading addon first, then from any other addon that knows them
  const pick = (k) => {
    if (lead && present(lead[k])) return lead[k];
    const other = online.find((s) => present(s[k]));
    return other ? other[k] : null;
  };
  let tail = "", tailKind = null;
  if (lead && lead.signal && mood === lead.signal.kind) {
    tail = lead.signal.text || lead.tail || "";
    tailKind = mood === "question" ? "question" : null;
  } else if (lead) {
    tail = lead.tail || "";
    tailKind = lead.tailKind || null;
  }

  return {
    mood,
    label: LABEL[mood] || mood,
    tail: String(tail).replace(/\s+/g, " ").trim(),
    tailKind,
    role: pick("role"),
    mode: pick("mode"),
    model: pick("model"),
    title: pick("title"),
    tokS: lead ? lead.tokS : null,
    contextTokens: pick("contextTokens"),
    sources: states.map((s) => ({ name: s.short, on: !!s.online, note: s.note || null })),
  };
}

// Sample views for --demo and --snapshot (example text, not real data)
const SRC = [{ name: "STRATA", on: true }, { name: "HOOK", on: true }];
const base = { mode: "roo-execute", role: "MAIN", model: "qwen3.8-flash-next-iq3_s", contextTokens: 48210, tokS: null, sources: SRC };
const DEMO_STATES = {
  idle: { ...base, mood: "idle", label: LABEL.idle, tail: "" },
  reading: { ...base, mood: "reading", label: LABEL.reading, tail: "" },
  thinking: { ...base, mood: "thinking", label: LABEL.thinking, tokS: 61.4, tailKind: "think",
    tail: "The user wants the duplicated helpers merged. formatDate exists in three files; the api one pins UTC, so I should check which callers rely on that before" },
  writing: { ...base, mood: "writing", label: LABEL.writing, tokS: 58.9, tailKind: "output",
    tail: "重複していた formatDate を src/utils/date.ts に集約し、呼び出し元を置き換えます。" },
  running: { ...base, mood: "running", label: LABEL.running, tail: "npm test" },
  question: { ...base, mood: "question", label: LABEL.question, tailKind: "question", tail: "UTC固定とローカル時刻、どちらに統一しますか？" },
  approval: { ...base, mood: "approval", label: LABEL.approval, tail: "git push origin feature/merge-utils" },
  complete: { ...base, mood: "complete", label: LABEL.complete, tail: "重複関数を統合し、テスト42件すべて通過しました。" },
  error: { ...base, mood: "error", label: LABEL.error, tail: "API request failed: connection refused (127.0.0.1:8080)" },
  truncation: { ...base, mood: "running", label: LABEL.running, role: "SUB 1", mode: "roo-investigate", tail: "", demoEvent: "truncation" },
  offline: { mood: "offline", label: LABEL.offline, tail: "", sources: [{ name: "STRATA", on: false }] },
};

module.exports = { combine, DEMO_STATES, LABEL };
