# AI エージェント向け：AgentWingman アドオン作成ガイド

この資料は、**AI エージェント（ローカル LLM・Claude Code など）が、新しい AI エンジンや開発エージェントに
AgentWingman を対応させるアドオンを、自分で調査・実装・検証する** ための手順書です。
人間が読んでも分かるように書いていますが、主な読み手は AI です。

最後の「[依頼文の雛形](#10-ai-に頼むときの依頼文の雛形)」をそのまま AI に渡せば作業を始められます。

---

## 0. 最初に必ず読むファイル

| ファイル | 内容 |
|---|---|
| `ADDONS.md` | アドオンの API（`ctx.update` / `ctx.event` / `ctx.notice`）の正式な説明 |
| `addons/_template/` | 最小のアドオン雛形 |
| `src/addons.js` | アドオンの読み込み・起動・停止（`ctx` の実体） |
| `src/state.js` | 複数アドオンの報告を1つの表示にまとめる規則 |
| このファイル | 調査のしかた、方式の選び方、守ること、落とし穴、検証、完成の条件 |

---

## 1. AgentWingman の仕組み（要点だけ）

- 本体は「キャラクター・パネル・オーバーレイ」を描くだけ。**何を表示するかはアドオンが決める**
- アドオンは `addons/<id>/addon.json` と `index.js`。`exports.activate = (ctx) => { ...; return stop; }`
- アドオンは見張る相手の状態を読み取り、`ctx.update({...})` で伝える。本体は全アドオンの報告をまとめて表示する
  - 優先順位: 合図（`signal`）＞ 思考中・回答中 ＞ 読込中 ＞ 作業中 ＞ 待機中
- アドオンは本体（Electron のメインプロセス）の中で Node.js として動く。npm パッケージは使わない（同梱できないため）。Node.js 標準モジュールと `fetch` だけで書く

### ctx.update で伝えられること

| 項目 | 値 | 意味 |
|---|---|---|
| `online` | true / false | 相手が動いているか（false のアドオンは表示の判定から外れる） |
| `activity` | `idle` `reading` `thinking` `writing` `running` | いま何をしているか |
| `signal` | `{ kind, text }` / `null` | **ユーザーを呼ぶ合図**。`question` `approval` `complete` `error` |
| `tail` | 文字列（末尾 200 文字程度） | 思考や回答の本文（最新が末尾） |
| `tailKind` | `think` / `output` | 本文が思考か回答か（オーバーレイの振り分けに使う） |
| `role` `mode` `model` | 文字列 | パネルのタグ（例: `MAIN` / `orchestrator` / モデル名） |
| `tokS` `contextTokens` | 数値 | 生成速度、コンテキスト量 |
| `note` | 文字列 | 接続ランプにマウスを乗せると出る補足 |

一回だけの反応は `ctx.event({ type, text })`（`truncation` `subtask-start` `subtask-return` は専用の動き）、
ユーザーに知らせたい問題（ポートが使えない等）は `ctx.notice(text)`。

---

## 2. 調査：新しい相手について何を調べるか

対応する相手（AI エンジン、エージェント、ツール）について、次を**この順に**調べて表にまとめてから実装を始めること。

| # | 調べること | 調べ方 |
|---|---|---|
| 1 | 何を知らせたいか（状態・合図・本文・速度・モデル名・CTX のうち、相手が持っている情報はどれか） | 相手の UI を見る、ドキュメントを読む |
| 2 | **公式の状態 API はあるか**（`/metrics` `/health` `/status` `/slots` `/props` `/v1/models` など） | README・API 文書、`--help`、ソースで `"/metrics"` `route` `@app.get` などを grep |
| 3 | **公式のフック・プラグイン・イベント通知はあるか**（承認待ちや完了を外部コマンドに通知できるか） | ドキュメントの hooks / plugins / events / notifications の章 |
| 4 | **生成中の本文を外から読む手段はあるか** | 監視機能（例: Strata の `api_monitor`）、詳細ログ（例: llama-server `-v` の `streamed chunk`）、SSE の配信 |
| 5 | **状態を書き出すファイルはあるか**（会話履歴、タスクファイル、実行中プロセスの記録） | 設定フォルダ（`%APPDATA%` `%LOCALAPPDATA%` `~/.xxx`）を調べ、動かしながら更新されるファイルを探す |
| 6 | ポート番号と、それが変わる条件 | 設定ファイル、起動スクリプト、`--port`。自動でずれる場合は実際の番号を記録するファイルがないか |
| 7 | 起動方法（exe / bat / サービス / 他アプリの一部）と、起動設定をユーザーが変えられるか | 起動スクリプトを読む。アップデートで上書きされる場所かどうか |
| 8 | ストリームの形式（OpenAI 互換 SSE の `delta.content` / `delta.reasoning_content`、`<think>` タグ、独自形式） | 1回だけ短いリクエストを流して生の応答を見る |

**調査のコツ**
- 推測で書かない。ソースやドキュメントの該当行（ファイル名と行番号）を根拠として残す
- 相手が動いていれば、読み取り専用の GET で実際の応答を確かめる（`/metrics` など）
- 相手の設定・ファイルを書き換えて試さない（試すならコピーに対して）
- GPU を使う相手を勝手に起動しない。動作確認は模擬（下記「6. 検証」）で行い、実機確認はユーザーに頼む

---

## 3. 方式の選び方

上から順に検討し、**使える中で一番上の方式**を選ぶ。複数を組み合わせてもよい（例: 状態は API、合図はフック）。

| 方式 | 使える条件 | 長所 | 短所 | 雛形にするアドオン |
|---|---|---|---|---|
| **A. 状態 API をポーリング** | HTTP で状態や本文を返す API がある | 設定変更なし。相手に影響しない | 本文が取れない API も多い | `addons/strata` |
| **B. 公式フック／通知を受け取る** | 相手が外部コマンドや HTTP を呼べる | 合図（承認待ち・完了）が正確・即時 | ユーザーに登録してもらう必要がある | `addons/claude-code`（フック→`hook.js`→HTTP） |
| **C. ログをパイプで読む** | 詳細ログに生成中の文章が出る | 相手のアプリ側の設定は変えない | 起動方法の変更が必要。ログは大量（ファイルに書かない） | `addons/llama-log`（`tap.js`→UDP） |
| **D. ファイルを監視** | 相手が状態・履歴をファイルに書く | 設定変更なし | 書き込みの粒度次第（途中経過は取れないことが多い）。形式が変わりやすい | `addons/zoocode` |
| **E. Webhook で受け取る** | 相手（またはユーザーのスクリプト）が HTTP を送れる | コードを書かずに連携できる | 相手側の準備が必要 | `addons/webhook`（そのまま使える） |
| **F. 中継（プロキシ）** | 上のどれもだめで、相手が HTTP API | 何でも読める | アプリの接続先を変える必要があり、紛らわしい | `addons/_disabled-openai-relay`（休止中） |

**避けること**：通信の盗聴（パケットキャプチャ、ドライバの導入）、AgentWingman を閉じても動き続ける常駐プロセス、
相手のインストール先のファイルの書き換え（アップデートで消えるうえ、壊すと相手が動かなくなる）。

---

## 4. 守ること（必須のルール）

1. **読み取り専用が基本。** 相手の設定やファイルを変える必要があるときは、ユーザーに確認し、変更前にバックアップを作り、元のファイルは残して別名で作る（例: `_wingman.bat`）
2. **常駐させない。** アドオンが起こしたものは、停止関数ですべて止める（タイマー、サーバー、ソケット、ファイル監視、子プロセス）。外部に置く補助スクリプトは相手のプロセスと一緒に終わるようにする
3. **待ち受けは `127.0.0.1` のみ。** 外部のサーバーへ何も送らない
4. **会話の内容（依頼・思考・回答）をファイルやログに保存しない。** 表示のために一時的に持つだけ。`ctx.log` に本文を書かない
5. **相手を遅くしない。** ポーリングは目安で、生成中 250ms・待機中 1000ms。外部スクリプトは送りっぱなし（UDP や非同期）で、相手を待たせない
6. **例外で落ちない。** 相手が止まっている・応答が壊れている・ファイルが書き込み途中、を前提に `try/catch` する。相手が止まったら `online: false`
7. **ポートが使えないときは `ctx.notice` で知らせる**（`EADDRINUSE` なら「ほかのソフトが使用中」）
8. 設定値は `addon.json` の `settings` に既定値を書き、コードに数字を埋め込まない。ポートやパスは設定で変えられるようにする
9. `enabledByDefault` は `false`（ユーザーがトレイで選んでオンにする）
10. 表示する文章・吹き出し・README は日本語

---

## 5. 落とし穴（このプロジェクトで実際に踏んだもの）

| 症状 | 原因 | 対策 |
|---|---|---|
| 自分のテストで見た設定と、ユーザーのアプリの設定が違う | Claude デスクトップアプリ（MSIX）から起動したプロセスの `%APPDATA%` への書き込みは、`%LOCALAPPDATA%\Packages\Claude_...\LocalCache\Roaming` に振り替えられ、以後そちらが見える | テストは一時フォルダの userData で行う（`--snapshot` 系はそうなっている）。ユーザーの設定を確かめる前に、振り替え先のコピーが無いことを確認 |
| llama-server の「リクエスト開始」を検出したつもりが毎トークン反応する | `processing task` という文字列は内部キューの行にも毎トークン出る | `launch_slot_` のような、1リクエスト1回だけの行で判定する |
| 詳細ログのファイルが巨大になる | llama-server `-v` は 1トークンあたり約 2KB | ファイルに書かず、パイプで受けて必要な行だけ取り出す |
| フックの出力が会話に混ざる | Claude Code の `UserPromptSubmit` `SessionStart` などは標準出力をコンテキストに加える | フック用スクリプトは何も出力せず、常に終了コード 0 |
| Electron の exe からフックの標準入力が読めない | Windows の Electron メインプロセスは `process.stdin` のデータイベントが来ない | `fs.readFileSync(0)` で直接読む（`addons/claude-code/hook.js`） |
| bash 形式のフックが動かない PC がある | Git Bash が無いと Claude Code は PowerShell でフックを動かす | シェルを通さない「exec 形式」（`command` + `args`）で登録する |
| ドロップしたファイルのパスが取れない | Electron の `contextBridge` は `FileList` をまるごと渡せない | 1ファイルずつ `webUtils.getPathForFile` |
| 実行中の bat を書き換えると挙動がおかしくなる | cmd は bat を1行ずつファイルから読みながら実行する | 実行中の bat は触らない。改変版は別名で作る |
| bat をコピーすると動かない | `%~dp0` や相対パスがコピー先基準になる | コピーは元と同じフォルダに作る |
| exe 版で外部スクリプトのパスが無効 | `app.asar` の中のファイルは外部プロセスから実行できない | `app.asar.unpacked` のパスを使う（`package.json` の `asarUnpack` 対象に入れる） |
| 8080 番を複数のエンジンが取り合う | llama.cpp・Strata・SyncStrata・Open WebUI などが既定で 8080 | 応答の形（例: `/metrics` に `live` がある）で相手を確かめてから使う。実際の番号を記録するファイルがあればそれを読む |
| `skin.json` / `config.json` が読めない | メモ帳や PowerShell が UTF-8 の先頭に BOM を付ける | 読む前に `\uFEFF` を取り除く |

---

## 6. 検証のしかた

### 6-1. アドオン単体の自動検査（必須）

```bash
node tools/addon-harness.js addons/<id> --settings "{\"port\":8799}" --seconds 8 --drive <相手役のスクリプト.js> --expect-online
```

- アドオンを1つだけ読み込み、報告（表示されるはずの状態）を時刻つきで全部出力し、規則に沿っているか検査して `RESULT: PASS / FAIL` を出す
- 検査項目: `addon.json` の必須項目、起動できるか、停止関数があるか、`activity` と `signal` の値が正しいか、**停止後に何も残っていないか**
- `--drive` には「相手役」を動かすスクリプトを渡す。例: `tools/examples/drive-webhook.js`

### 6-2. 相手がいなくても試す方法（GPU を使わない）

| 相手 | 模擬のしかた |
|---|---|
| HTTP の状態 API | Node.js で 20 行ほどの偽サーバーを書く（`/metrics` などに本物と同じ形の JSON を返す）。本物の応答を一度保存しておき、その形を真似る |
| OpenAI 互換のストリーム | 偽サーバーで `text/event-stream` を少しずつ送る（`data: {"choices":[{"delta":{"content":"…"}}]}`）。`<think>` タグが途中で切れるケースも入れる |
| Strata / SyncStrata | 同梱サーバーの模擬エンジン: `python server.py --engine mock --port 3081` |
| ログ | 本物のログ行を数行コピーして、`tap.js` 相当のスクリプトの標準入力に流す |
| フック | 本物と同じ JSON を標準入力に入れてフック用スクリプトを実行する |

### 6-3. 本体と組み合わせた確認

- **`npm test` … 全体の検査。最後に必ず実行して ALL PASSED を確認する**（新しいアドオンも自動で検査対象になる。
  ポートが既定のままだと動作中の AgentWingman とぶつかるので、`tools/test-all.js` の `ADDON_SETTINGS` に検査用の設定を足す）
- `npm run snapshot` … キャラクターとパネルの全状態の画像（`snapshots/`）
- `npm run test:overlay` … 画面オーバーレイの全組み合わせと、アドオンを通した経路の確認
- 実機（本物の相手）での確認は、最後にユーザーに頼む。頼むときは「何を起動して、何をすると、何が表示されれば成功か」を書く

---

## 7. 完成の条件（チェックリスト）

- [ ] 調査結果の表（2章）と、根拠（ドキュメント・ソースの該当箇所）を README に書いた
- [ ] 方式（3章）を選んだ理由を書いた
- [ ] `addons/<id>/addon.json`・`index.js`・`README.md`（日本語：何が表示されるか、使い方、必要な設定、注意）を作った
- [ ] `node tools/addon-harness.js addons/<id> ... --expect-online` が相手役スクリプト付きで PASS
- [ ] 相手が止まっているときも PASS（`--expect-online` なしで、例外を出さず `online: false`）
- [ ] 相手の設定・ファイルを変更していない（変更が必要な場合は、ユーザー確認・バックアップ・別名作成の手順を README に書いた）
- [ ] 本文をログやファイルに保存していない
- [ ] ポート衝突時に `ctx.notice` が出ることを確認した
- [ ] `ADDONS.md` の同梱アドオン表に1行追加した
- [ ] 実機確認の手順をユーザー向けに書いた

---

## 8. 既存アドオンの早見表（雛形選びに）

| アドオン | 方式 | 見ている情報 | ポイント |
|---|---|---|---|
| `strata` | A（ポーリング） | `/metrics`、`/api/requests`、`/v1/models` | 応答の形で相手を確かめる。SyncStrata は `SYNC_HOME\run\procs.json` のポートも試す |
| `llama-log` | C（ログ） | llama-server `-v` の `streamed chunk` 行 | `tap.js` はパイプで受け、UDP で送りっぱなし。bat は `wingmanize.js` で別名作成 |
| `claude-code` | B（フック） | Claude Code の 13 種類のフック | セッションごとに状態を持つ。フック登録は `hooks-setup.js`（バックアップ付き） |
| `zoocode` | D（ファイル監視） | VS Code 拡張のタスクファイル | 書き込み途中の JSON を想定して再試行。自動承認の誤検出を猶予時間で防ぐ |
| `webhook` | E（受け取り） | 外部からの HTTP | `Content-Type: application/json` 以外を拒否して、Web ページからの送信を防ぐ |

---

## 9. エンジンごとのメモ（調査済みの情報）

| 相手 | 状態 | 本文 | 合図 | 備考 |
|---|---|---|---|---|
| Strata | `/metrics`（`live.state` = `reading` / `generating`） | `api_monitor: true` のとき `/api/requests?id=` | なし | 起動設定 `install\strata-<モデル>.json` |
| SyncStrata | Strata と同じ（中身が Strata のサーバー） | 取得不可（起動設定を毎回作り直し、`api_monitor` を渡す設定が無い） | なし | ポートは `%LOCALAPPDATA%\SyncStrata\run\procs.json` の `engine.port`。既定 8080、候補 8080/8081/3080/3081 |
| llama.cpp（llama-server） | `/slots`（`is_processing`）、`--metrics` で `/metrics` | API では取得不可。`-v` のログに `streamed chunk: data: {...}` | なし | `launch_slot_` で開始、`slot release:` で終了 |
| Claude Code | フック | `Stop` の `last_assistant_message`（最後の返答のみ） | `PermissionRequest`・`Notification`（`permission_prompt` / `idle_prompt`） | 13 種類のフックを `async` で登録 |
| Zoocode / Roo Code | タスクフォルダの `ui_messages.json` | 確定したメッセージのみ（途中経過は書かれない） | `ask: followup` / `command` / `tool` / `completion_result` | 拡張の更新で形式が変わる可能性 |

新しく調べたら、この表に追記すること。

---

## 10. AI に頼むときの依頼文の雛形

次の文の `〈 〉` を埋めて、AI エージェントにそのまま渡してください。

```text
〈AgentWingman のフォルダ〉（Electron 製のデスクトップマスコット「AgentWingman」）に、〈対応したいソフトの名前〉のアドオンを追加してください。

〈対応したいソフト〉について:
- 種類: 〈ローカル LLM エンジン / AI 開発エージェント / その他〉
- 場所: 〈インストール先のフォルダや公式サイトの URL〉
- 起動方法: 〈exe / bat / コマンド など〉
- 表示したいこと: 〈例: 思考中・回答中の状態と速度、承認待ちと完了の合図、思考の本文〉

進め方:
1. まず docs\AI_ADDON_GUIDE.md を最後まで読み、そこに書かれた手順・ルール・完成の条件に従ってください。
   ADDONS.md と addons\_template、近い方式の既存アドオンも読んでください。
2. ガイドの「2. 調査」の表を埋めてから、「3. 方式の選び方」で方式を決めてください。根拠（ファイル名と行番号、URL）を残してください。
3. 実装したら、tools\addon-harness.js と相手役のスクリプトで PASS するまで直してください。相手がいない場合は模擬で確認してください。
4. 対象ソフトの設定やファイルは変更しないでください。変更が必要なら、作業を止めて理由と手順を私に説明してください。
5. GPU を使うものを勝手に起動しないでください。実機での確認は、手順を書いて私に頼んでください。

完成したら、次を報告してください:
- 選んだ方式と理由
- 作ったファイルの一覧
- addon-harness の結果（全文）
- 私が実機で確認する手順（何をすると、何が表示されれば成功か）
- 分からなかったこと・できなかったこと
```
