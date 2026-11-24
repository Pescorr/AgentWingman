# キャラクターの作り方

AgentWingman のキャラクターは「ポーズ画像を数枚」用意するだけで差し替えられます。
体全体の動き（呼吸・跳ねる・震える・ジャンプ）と記号（考え中の「…」、「！」、星、汗）はアプリが付けるので、
画像は **止まったポーズだけ** で大丈夫です。

## 1. 用意する画像（12枚）

`guide/` に標準パイロットで描いた見本があります。全ポーズの一覧は `guide/_all_poses.png` です。

| ファイル名 | ポーズ | 使われる場面 |
|---|---|---|
| `idle.png` | 通常。正面で立つ | 待機中 |
| `blink.png` | idle と同じで目だけ閉じる | 待機中のまばたき |
| `read.png` | idle と同じで目線を横に | プロンプト読込中 |
| `think.png` | 目線を斜め上に、考える顔 | 思考中 |
| `type1.png` | 胸の前のキーボードを打つ（左手が下・右手が上） | 回答作成中・作業中 |
| `type2.png` | type1 の左右の手を逆に | 同上（交互に再生） |
| `question.png` | 片手を高く挙げて呼ぶ | 質問があります |
| `wave1.png` | 手を外側に開いて振る | 承認待ち |
| `wave2.png` | 手を頭側に倒して振る | 同上（交互に再生） |
| `cheer.png` | 両手を上げてバンザイ、目を細める | タスク完了 |
| `error.png` | 困った・焦った顔 | エラー |
| `sleep.png` | 目を閉じて休む | 接続なし（アプリが灰色にします） |

最低限 `idle.png` があれば動きます。足りない状態は近いポーズで代用されます
（例: `read.png` が無ければ `think.png`、それも無ければ `idle.png`）。

**画像のルール**
- 全部 **同じサイズの正方形**（512×512 推奨）
- キャラクターの **大きさ・位置を全枚そろえる**（足元を下端中央に）
- 背景は透明 PNG。透明が作れない場合は **単色ベタ塗り**（#00FF00 の緑など）にして、`skin.json` の `chromaKey` に指定すると自動で抜けます
- 床の影・文字・「！」や星などの記号は描かない（アプリが付けます）

## 動画や GIF があるなら：キャラクターメーカー

動くキャラクターの動画（どの動画生成 AI で作ったものでも）や GIF があるなら、AgentWingman の
右クリック → キャラクターの種類 → **動画からキャラクターを作る…** で、このフォルダを手で作らずに済みます。
背景の除去、大きさと足元の位置合わせ、`skin.json` の作成まで自動で行います。

## 2. AI に描かせる

`PROMPTS.md` に、そのまま貼れるプロンプトがあります。
あなたのキャラクター画像と `guide/` の見本画像を一緒に渡して、1ポーズずつ描いてもらいます。

## 3. フォルダにまとめる

1. この `_template` フォルダをコピーして、好きな名前に変える（例: `my-oc`。先頭に `_` を付けないこと）
2. 画像を入れる（`guide/` フォルダは消してかまいません）
3. `skin.json` の `name` を書き換える。緑背景なら `"chromaKey": "#00ff00"` にする
4. タスクトレイのアイコン → キャラクター → 一覧を更新 → 作ったキャラクターを選ぶ

置き場所はトレイの「キャラクターフォルダを開く」で開く場所（AgentWingman.exe と同じフォルダの `characters\`）です。
選択中のキャラクターは、画像や `skin.json` を保存すると即座に反映されます。

## skin.json の書き方

```json
{
  "name": "マイキャラクター",
  "size": [512, 512],
  "chromaKey": "#00ff00",
  "chromaTolerance": 80,
  "effects": true,
  "states": {
    "idle":    { "frames": ["idle.png", "idle.png", "idle.png", "blink.png"], "fps": 4 },
    "writing": { "frames": ["type1.png", "type2.png"], "fps": 8 },
    "complete":{ "frames": ["cheer.png"], "motion": "jump", "effect": "stars" }
  }
}
```

| キー | 内容 |
|---|---|
| `format` | この形式の版（今は `1`。省略すると 1）。AgentWingman より新しい版のキャラクターは、壊れずに「更新してください」と表示されます |
| `size` | 画像の縦横比（ピクセル）。表示の高さは常に同じで、幅がこの比率になります |
| `chromaKey` | 抜く背景色（`#rrggbb`）。透明 PNG なら `null` |
| `chromaTolerance` | 背景色をどこまで抜くか（既定 80）。キャラクターの色まで欠けるなら下げ、背景が残るなら上げる |
| `effects` | `false` にするとアプリの記号（…、！、星、汗）を出さない |
| `states.<状態>.frames` | コマの並び。同じ画像を並べるか `{ "file": "idle_03.png", "hold": 4 }` で長く表示されます |
| `states.<状態>.video` | ループ動画（透過 WebM: VP9 + yuva420p 推奨）。`frames` より優先され、再生できないときは `frames` に戻ります |
| `states.<状態>.fps` | 1秒あたりのコマ数 |
| `states.<状態>.loop` | `false` で最後のコマで止める |
| `states.<状態>.motion` | 体全体の動き: `breathe` `scan` `hop` `jump` `shake` `dim`（灰色＋ゆっくり呼吸）`dim-still`（灰色だけ）`none`。画像や動画の中で体が動くなら `none` / `dim-still` |
| `states.<状態>.effect` | 記号: `dots` `mark` `stars` `sweat` または `null` |

状態の名前: `idle` `reading` `thinking` `writing` `running` `question` `approval` `complete` `error` `offline`

**コマごとの位置ずれを直す**：AI の出力で位置や大きさが少しずれた画像は、ファイル名の代わりに
`{ "file": "think.png", "x": -2, "y": 3, "scale": 0.95 }` と書くと補正できます（x, y は % 単位）。

**1枚のスプライトシートにまとめる**：AI が全ポーズを1枚に並べて出力した場合は、切り分けずに使えます。

```json
"sheet": { "file": "sheet.png", "cols": 4, "rows": 3,
           "cells": { "idle": 0, "blink": 1, "read": 2, "think": 3, "type1": 4, "type2": 5,
                      "question": 6, "wave1": 7, "wave2": 8, "cheer": 9, "error": 10, "sleep": 11 } },
"states": { "idle": { "frames": ["idle", "idle", "idle", "blink"], "fps": 4 } }
```

`cells` は左上から右へ数えたマス番号（0始まり）。マスの大きさが全部同じで、`size` をマス1つの比率にしてください。
GIF アニメも使えます（その場合 `chromaKey` は効きません）。

## もっとアニメーションさせる（多コマ・動画）

同じ `skin.json` の書き方で、3段階の作り込みができます。混ぜて使ってもかまいません。

| 方式 | 書き方 | 向いているもの |
|---|---|---|
| 静止ポーズ | 状態ごとに1〜2枚（このテンプレートの形） | 手軽に作りたいとき。動きはアプリが付ける |
| 多コマ PNG | `"frames": ["idle_00.png", "idle_01.png", ...], "fps": 12` | 体の動きまで絵で描きたいとき |
| 動画 | `"video": "idle.webm"`（`frames` も書けば予備になる） | なめらかな24fpsの動き。ファイルも小さい |

```json
"idle":    { "video": "idle.webm", "frames": ["idle_00.png", "idle_01.png"], "fps": 12, "motion": "none", "effect": null },
"offline": { "video": "offline.webm", "motion": "dim-still" }
```

動画は透過 WebM（VP9、`yuva420p`）にしてください。透過の無い動画は背景ごと表示されます（`chromaKey` は動画には効きません）。
先頭のコマから自然にループするように作ると継ぎ目が出ません。SpriteForge_Wingman（ComfyUI 用の別ツール）で作れます。

動いているかの確認は `npm run snapshot -- --skin <名前> --frames 4`（状態ごとに0.25秒おきに4枚撮影）で行えます。
