# ComfyUI アドオン

画像・動画生成の [ComfyUI](https://github.com/comfyanonymous/ComfyUI) が **いま何を作っているか** を文章にして、
ほかのアドオンと同じようにキャラクター・パネル・画面オーバーレイに出します。
ComfyUI は文章を出さないので、実行中のワークフロー（ノードのつながり）を読んで、このアドオンが文を組み立てます。

## 表示されるもの

| 場所 | 内容 | 例 |
|---|---|---|
| 状態 | 生成中は「作業中」（キーボードを打つ動き） | |
| 灰色の作業行（オーバーレイにも1回流れる） | 何を作っているか。ジョブが変わったときだけ変わる | `画像を生成中：animagineXL40_v4Opt・1024×1024・25ステップ・「1girl, silver hair, …」` |
| | | `動画を生成中：wan2.2_i2v_high_noise_14B_fp8 + LoRA・832×480・81フレーム・4ステップ・入力画像1枚・「the girl turns…」` |
| 左上のタグ | 順番待ちの件数 | `待ち8件`（待ちが無ければ `COMFY`） |
| モードのタグ | 経過時間と、同じワークフローの前回の所要時間 | `経過 3:12 / 前回 10:29` |
| モデルのタグ | 主なモデルのファイル名 | `minimax_h3_ref2va_pruned_int8_convrot` |
| 吹き出し（1件終わるごと） | 保存したファイルの数と所要時間 | `1件完了（画像4枚・1:23）` |
| **合図：タスク完了** | 順番待ちが空になったとき | `ComfyUI：14件すべて完了（画像1000枚、最後は f_00249_.png）` |
| **合図：エラー** | ジョブが失敗したとき（その回の順番待ちが終わるまで残る） | `KSampler（#3）でエラー：OutOfMemoryError Allocation on device` |
| 吹き出し | 中断したとき、実行中に ComfyUI が応答しなくなったとき | `ComfyUI：中断しました` |
| 接続ランプの補足 | 版、URL、VRAM の空き | `ComfyUI 0.40.0 http://127.0.0.1:8188・VRAM 空き 1.0 / 15.9 GB` |

文はノードの種類と、直接書かれた値（またはつながった Primitive ノードの値）から作ります。
カスタムノードばかりのワークフローでも文は出ますが、読み取れる項目が少なくなります（何も読めなければ `◯ノード`）。

| 項目 | 読み方 |
|---|---|
| 画像／動画／音声／3D | ノードの種類（`Video` `AnimateDiff` `Wan…ToVideo` `VHS_` `SaveAudio` `Save3D` など）や `fps` `num_frames` の入力 |
| モデル | `Load` を含むノードの `.safetensors` `.gguf` などのファイル名。LoRA・VAE・テキストエンコーダーは除く |
| サイズ・フレーム数 | `width` `height`（`EmptyLatent…` を優先）、`length` `num_frames` |
| ステップ数 | サンプラー（`KSampler` `SamplerCustom…` など）とスケジューラーの `steps`。サンプラーが複数なら `×個数` |
| プロンプト | サンプラーの `positive` につながったテキストエンコーダーの文（冒頭 `promptChars` 文字）。文字列を組み立てるワークフローでは出ません |

## 使い方

1. ComfyUI をふだんどおり起動する（設定の変更は不要）
2. トレイ → アドオン → **ComfyUI** にチェック
3. ComfyUI でキューに入れると、キャラクターが作業中になり、何を作っているかが出ます

## 設定（config.json の `addons.comfyui.settings`）

| キー | 既定 | 内容 |
|---|---|---|
| `url` | `"auto"` | `auto` なら `http://127.0.0.1:8188`（標準）、`8000`（ComfyUI デスクトップ版）、`8189` を順に探します。別の番号なら `"http://127.0.0.1:8190"` のように書く |
| `busyPollMs` | `1000` | 生成中に状態を見る間隔（ミリ秒） |
| `idlePollMs` | `2000` | 待機中に状態を見る間隔 |
| `promptChars` | `40` | 表示するプロンプトの文字数 |
| `eventEachJob` | `true` | 1件終わるごとに吹き出しを出すか（短いジョブを大量に流すなら `false`） |

## 注意

- **読み取りだけです。** キューへの追加・取り消し・中断はしません。ComfyUI の設定やファイルも変えません
- **ステップの進み具合（例: 12/25）は出せません。** ComfyUI は進み具合を、ジョブを出したブラウザにだけ送るためです。
  代わりに経過時間と前回の所要時間を出します
- 待ち行列が長いと `/queue` の応答が数 MB になります。読むのはジョブが切り替わったときだけです
- ジョブが1秒未満で終わると、間に合わず見えないことがあります（完了の合図は出ます）
- プロンプトは表示のために一時的に持つだけで、ファイルやログには残しません
- 外部への送信はしません（`127.0.0.1` の ComfyUI にだけ問い合わせます）

---

## 開発者向け

### 調査結果（ComfyUI 0.40.0、`server.py` / `comfy_execution/jobs.py`）

| # | 調べたこと | 結果 |
|---|---|---|
| 1 | 知らせたいこと | 実行中か、何を作っているか、待ち件数、完了・失敗・中断、所要時間。思考や本文は無い |
| 2 | 状態 API | `GET /api/jobs`（`server.py` 787 行、`status` `workflow_id` `limit` で絞れる）、`GET /api/jobs/{id}`（実行中はグラフを含まない）、`GET /queue`（1030 行、実行中・待ちの全グラフ）、`GET /history/{id}`（1025 行）、`GET /prompt`（`exec_info.queue_remaining`）、`GET /system_stats`（版・VRAM） |
| 3 | フック・通知 | 公式の外部通知は無い。カスタムノードを入れれば可能だが、ComfyUI のフォルダにファイルを足すことになるので使わない |
| 4 | 生成中の情報 | WebSocket `/ws` の `progress` `executing` は `server_instance.client_id`（ジョブを出したクライアント）宛て（`main.py` 433 行、`server.py` 1348 行の `send_json` で `sid` 指定時はその接続だけ）。同じ `clientId` で接続すると元の接続が外される（`server.py` 271–273 行）ので使えない |
| 5 | 状態ファイル | 無し（履歴はメモリ上） |
| 6 | ポート | 既定 8188（`--port`）。ComfyUI デスクトップ版は 8000 |
| 7 | 起動方法 | `python main.py` / ポータブル版の bat / デスクトップ版。どれでも API は同じ |
| 8 | 形式 | JSON。ジョブ一覧は `{ jobs: [{ id, status, workflow_id, execution_start_time, ... }], pagination: { total } }` |

### 方式

**A. 状態 API のポーリング**。ComfyUI 側の変更が要らず、ジョブの開始・終了・失敗と、実行中のグラフが読めるため。
`/api/jobs` が無い古い版（404）では `/prompt` と `/queue` に切り替えます。

### 検査

```bash
node tools/addon-harness.js addons/comfyui --settings "{\"url\":\"http://127.0.0.1:18768\",\"idlePollMs\":300,\"busyPollMs\":300}" --seconds 10 --drive tools/examples/drive-comfyui.js --expect-online
```

`tools/examples/drive-comfyui.js` は GPU を使わない偽の ComfyUI です（画像2件・動画1件を順に実行）。
環境変数 `COMFY_SCENARIO=error` で2件目がメモリ不足で失敗、`COMFY_LEGACY=1` で `/api/jobs` の無い古い版になります。

`node addons/comfyui/source.js http://127.0.0.1:8188` で、動いている ComfyUI から読めた内容をそのまま表示できます（読み取りのみ）。

### ファイル

| ファイル | 内容 |
|---|---|
| `index.js` | 状態・合図・吹き出しへの変換。順番待ちが空になるまでを1回分として完了・エラーをまとめる |
| `source.js` | ポーリング（サーバー探し、ジョブの開始・終了の検出、前回の所要時間） |
| `describe.js` | グラフ → 文、履歴 → 結果（ファイル数・エラー文） |
