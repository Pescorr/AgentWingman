// Shared by the llama.cpp addons: separate thinking from the answer in streamed text.
// (Folders starting with "_" are not loaded as addons.)

// For servers that leave <think>...</think> in the content. Handles tags split across chunks.
class ThinkSplitter {
  constructor() { this.inThink = false; this.pending = ""; }
  push(text, out) {
    let s = this.pending + text;
    this.pending = "";
    while (s) {
      const tag = this.inThink ? "</think>" : "<think>";
      const i = s.indexOf(tag);
      if (i >= 0) {
        out(this.inThink, s.slice(0, i));
        s = s.slice(i + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // keep a possible partial tag at the end for the next chunk
      let cut = s.length;
      for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) if (tag.startsWith(s.slice(-k))) { cut = s.length - k; break; }
      out(this.inThink, s.slice(0, cut));
      this.pending = s.slice(cut);
      s = "";
    }
  }
}

module.exports = { ThinkSplitter };
