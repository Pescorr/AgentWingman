# アドオンの作り方

> AI エージェントに新しいエンジンやツールへの対応を頼むときは、[docs/AI_ADDON_GUIDE.md](docs/AI_ADDON_GUIDE.md)
> （調査の手順・方式の選び方・守ること・落とし穴・自動検査・依頼文の雛形）を渡してください。
> 作ったアドオンは `node tools/addon-harness.js addons/<id>` で検査できます。

AgentWingman 本体は「キャラクターとパネル」だけを持ち、**何を表示するかはすべてアドオンが決めます**。
アドオンは、見張りたいツール（開発エージェント、LLM サーバー、ビルド、何でも）の状態を読み取り、
`ctx.update()` と `ctx.event()` で本体に伝えるだけの小さな Node.js モジュールです。

複数のアドオンを同時に有効にでき、本体がそれらをまとめて1つの表示にします。

## 同梱アドオン

| アドオン | 内容 | 初期状態 |
|---|---|---|
| `strata` | ローカルLLMサーバー Strata / SyncStrata の状態と速度。Strata は Thinking・回答のリアルタイム本文も | オフ |
| `zoocode` | VS Code 拡張 Zoocode / Roo Code の質問・承認・完了・モード・サブタスク | オフ |
| `webhook` | このPCの中だけの HTTP 窓口。どんなツールからでも状態と合図を送れる | オフ |
| `claude-code` | Claude Code のフックから、承認待ち・入力待ち・完了・エラー・圧縮・サブエージェントを受け取る（[説明](addons/claude-code/README.md)） | オフ |
| `llama-log` | llama-server の詳細ログをパイプで受け取り、思考と回答をリアルタイムに表示。アプリの接続先は変えない（[説明](addons/llama-log/README.md)） | オフ |

休止中のアドオン: `addons/_disabled-openai-relay`（LM Studio・Ollama などとアプリの間に入る中継役。
[説明](addons/_disabled-openai-relay/README.md)）。フォルダ名が `_` で始まるので読み込まれません。
使うときは `openai-relay` に名前を戻してください。

トレイのアイコン → アドオン で、チェックを付けるとその場で起動し、外すと止まります。

## フォルダ構成

```
addons\<アドオンID>\
  addon.json   名前・説明・設定の既定値
  index.js     activate(ctx) を書く
```

置き場所は、アプリ付属の `addons\` と、ユーザー用の `%APPDATA%\agent-wingman\addons\`
（トレイ → アドオン → アドオンフォルダを開く）の2か所です。同じ ID なら後者が優先されます。
フォルダ名の先頭が `_` のもの（`_template` など）は読み込まれません。

`addons\_template` をコピーして名前を変えるのが一番早い始め方です。

## addon.json

```json
{
  "name": "マイアドオン",
  "short": "MINE",
  "version": "0.1.0",
  "description": "何を見張るアドオンか",
  "main": "index.js",
  "enabledByDefault": false,
  "settings": { "intervalMs": 5000 }
}
```

| キー | 内容 |
|---|---|
| `name` | トレイの一覧に出る名前 |
| `short` | パネル下部の接続ランプに出る短い名前（8文字程度） |
| `main` | 読み込むファイル（既定 `index.js`） |
| `enabledByDefault` | 初めて見つかったときに有効にするか |
| `settings` | 設定の既定値。ユーザーは `config.json` の `addons.<ID>.settings` で上書きできます（初回起動時に既定値が書き込まれます） |

## index.js

```js
exports.activate = (ctx) => {
  ctx.update({ online: true, activity: "idle" });
  const timer = setInterval(() => { /* 見張って ctx.update() する */ }, ctx.settings.intervalMs);
  return () => clearInterval(timer);   // 止めるときに呼ばれる
};
```

`activate` は async でもかまいません。戻り値の関数（または `exports.deactivate`）は、
アドオンを無効にしたとき・再読み込みしたとき・アプリを終了したときに呼ばれます。
タイマー、ファイル監視、サーバーなどは必ずここで止めてください。

## ctx（本体とのやりとり）

| 名前 | 内容 |
|---|---|
| `ctx.update(patch)` | 状態を伝える。渡した項目だけが上書きされます |
| `ctx.event({ type, text })` | 一回だけの反応（吹き出し＋効果音）。`text` が吹き出しの文 |
| `ctx.settings` | 設定（addon.json の既定値 + config.json の上書き） |
| `ctx.id` / `ctx.name` / `ctx.dir` | アドオンの ID・名前・フォルダ |
| `ctx.log(...)` | コンソールに `[ID]` 付きで出力 |

### ctx.update で渡せる項目

| 項目 | 値 | 表示される場所 |
|---|---|---|
| `online` | `true` / `false` | 接続ランプ。`false` のアドオンは表示の判定から外れます |
| `activity` | `idle` `reading` `thinking` `writing` `running` | キャラクターの動きと状態名 |
| `signal` | `{ kind, text }` または `null` | **ユーザーを呼ぶ合図**。`kind` は `question` `approval` `complete` `error`。`null` で取り消し |
| `tail` | 文字列 | パネルの本文（思考内容など。最新の行が下に表示されます） |
| `tailKind` | `think` / `output` | 本文の色（思考＝水色、回答＝白） |
| `role` | 例 `MAIN` `SUB 2` | パネル左上のタグ |
| `mode` | 例 `orchestrator` | モードのタグ |
| `model` | 例 `qwen3.8-flash` | モデル名のタグ |
| `tokS` | 数値 | 生成速度（tok/s） |
| `contextTokens` | 数値 | CTX の表示 |
| `note` | 文字列 | 接続ランプにマウスを乗せると出る補足（エラー理由など） |

### 複数のアドオンの合わせ方

1. どれかのアドオンに `signal` があれば、**一番新しい合図**を表示します（`complete` は10分で自動的に消えます）
2. なければ、動いているアドオンのうち `thinking`/`writing` ＞ `reading` ＞ `running` の順で一番忙しいものを表示します
3. どれも動いていなければ「待機中」、有効なアドオンが全部 `online: false` なら「接続なし」です

タグ（モード・モデルなど）は、表示中のアドオンが持っていなければ、ほかのアドオンの値で補います。
たとえば「Zoocode のモード」と「Strata のモデル名・思考内容」が1つのパネルに並びます。

### 組み込みのイベント

`ctx.event({ type })` の `type` がこれらなら、専用の動きと音になります。それ以外は吹き出しと短い音だけです。

| type | 反応 |
|---|---|
| `truncation` | 汗をかいてつぶれる「コンテキスト圧縮…」 |
| `subtask-start` | 「サブタスク出撃！」 |
| `subtask-return` | 「サブタスク帰還」 |

## Webhook アドオンの使い方（コードを書かずに連携）

有効にすると `http://127.0.0.1:8765` で受け付けます（ポートは設定で変更可）。
このPCの外からは届きません。また、`Content-Type: application/json` 以外は受け付けないので、
ブラウザで開いた Web ページが勝手に送ることもできません。

```bash
curl -X POST http://127.0.0.1:8765/update -H "Content-Type: application/json" -d "{\"activity\":\"thinking\",\"tail\":\"考え中…\",\"mode\":\"build\"}"
```

```bash
curl -X POST http://127.0.0.1:8765/signal -H "Content-Type: application/json" -d "{\"kind\":\"complete\",\"text\":\"ビルド完了\"}"
```

| パス | 本文 | 内容 |
|---|---|---|
| `POST /update` | `ctx.update` と同じ項目 | 状態を送る |
| `POST /signal` | `{"kind":"question","text":"..."}`、`{}` で取り消し | 合図を出す・消す |
| `POST /event` | `{"type":"...","text":"..."}` | 一回だけの反応 |
| `POST /clear` | `{}` | 合図と状態を待機中に戻す |
| `GET /` | — | 使い方を表示 |

`/update` が `idleAfterSeconds`（既定300秒）届かないと、自動で待機中に戻ります。

## 注意

- アドオンは本体と同じ権限で動く普通のプログラムです（ファイルの読み書きや通信ができます）。**中身を確認したもの、信頼できるものだけを入れてください。**
- 例外で落ちても本体は止まりません。吹き出しにエラーが出て、そのアドオンだけが止まります。
- 編集したアドオンは、トレイ → アドオン → すべて再読み込み で反映されます。
