// Pose list for the guide images; the file names here are the ones a skin's skin.json refers to.
const POSES = ["idle", "blink", "read", "think", "type1", "type2", "question", "wave1", "wave2", "cheer", "error", "sleep"];
const LABELS = {
  idle: "通常", blink: "まばたき", read: "読み込み（横目）", think: "考え中（上を見る）",
  type1: "タイピング1", type2: "タイピング2", question: "呼ぶ（片手を挙げる）", wave1: "手を振る1",
  wave2: "手を振る2", cheer: "完了（バンザイ）", error: "困った", sleep: "休止（目を閉じる）",
};

const root = document.getElementById("root");
const cell = (pose) => `<div class="cell" data-pose="${pose}">${window.PILOT_SVG}<b>${pose}.png<small>${LABELS[pose]}</small></b></div>`;

function setPose(pose, green) {
  document.body.className = green ? "green" : "";
  root.innerHTML = cell(pose);
}

function showSheet() {
  document.body.className = "";
  root.innerHTML = `<div class="sheet">${POSES.map(cell).join("")}</div>`;
}
