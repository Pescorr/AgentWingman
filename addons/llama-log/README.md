# llama.cpp（ログ連携）

llama-server を詳細ログ（`-v`）付きで起動すると、ストリーミングで送った文章の断片がほぼ同時にログへ出ます。
このアドオンは、そのログを **パイプで受け取って** 思考と回答をリアルタイムに表示します。

- **アプリ（Zoocode・WebUI・自作ツールなど）の接続先は 8080 のまま。** 何も変えません
- 変えるのは llama-server を起動する bat の1行だけ（元の bat は残したまま、別名のコピーを作ります）
- ログは **ファイルに書きません**（詳細ログは1トークンあたり約2KBと大量なため）
- 常駐するものはありません。受け取り役の `tap.js` は llama-server と一緒に起動し、一緒に終了します

```
llama-server -v ... 2>&1 | node tap.js  ──(このPC内の UDP)──▶  AgentWingman
        │
        └ コンソールには今まで通りの表示（詳細ログの行は隠します）
```

## 使い方

1. トレイ → アドオン → **llama.cpp（ログ連携）** にチェック
2. 起動用 bat の AgentWingman 版を作る（元の bat は変更されません）。次のどれでも同じものができます
   - **ランチャーに bat をドラッグ＆ドロップ**（Wingman 版を作って、それをランチャーに登録します）
   - トレイ → アドオン → **llama.cpp の bat を Wingman 版にする…**
   - コマンド: `node "<AgentWingman のフォルダ>\addons\llama-log\make-bat.js" "<元の bat>"`
3. 以後はその `<元の名前>_wingman.bat` で llama-server を起動する

Wingman 版でしているのは、llama-server の起動コマンドの最後に次の1行を足すことだけです。手で書き足してもかまいません。

```bat
    --port 8080 ^
    -v --log-prefix --log-colors off 2>&1 | node "<AgentWingman のフォルダ>\addons\llama-log\tap.js"
```

Node.js が無い PC でトレイやランチャーから作ると、`node` の代わりに `AgentWingman.exe` で `tap.js` を動かす形
（`set "ELECTRON_RUN_AS_NODE=1"` の1行が加わります）になります。

## 表示されるもの

| 状態 | 判断のしかた |
|---|---|
| プロンプト読込中 | スロットがリクエストを受け取った（`launch_slot_`） |
| 思考中（本文つき） | `reasoning_content` の断片、または `<think>` 内の文章 |
| 回答作成中（本文つき） | `content` の断片 |
| tok/s | 直近2秒の受信ペース。最後に `timings.predicted_per_second` |
| CTX | 最後の `timings`（prompt_n + cache_n + predicted_n） |
| モデル名 | ストリームの `model`（2秒ごとの生存通知でも送るので、あとから AgentWingman を起動しても分かります） |

ストリーミングでないリクエストは、生成中の本文が無いので「読込中」→「待機中」になります。

## 確認したこと（2026-11-23）

| | Qwen3.8-27B（b12602） | Inkling-2-Mini（b12633） |
|---|---|---|
| アプリは 8080 に直接接続したまま、思考・回答をリアルタイム表示 | ✅ | ✅ |
| 速度への影響 | なし（約 38〜40 tok/s） | なし（約 45 tok/s） |
| コンソールの表示 | 詳細ログの行だけ隠れ、通常のログは今まで通り | 同左 |
| llama-server 終了で tap.js も終了 | ✅ | ✅ |

## 注意

- AgentWingman が起動していなくても、llama-server はいつも通り動きます（UDP は相手がいなければ捨てられるだけで、待ちません）。
- Wingman 版は元の bat のコピーです。元の bat を書き換えたら、Wingman 版を消して作り直してください。
- exe 版の AgentWingman で作った Wingman 版は exe の場所を覚えています。exe を移動したら作り直してください。
- 詳細ログの行もコンソールに出したいときは、bat の `tap.js"` のあとに ` --show-debug` を付けます。
- ポートを変えるときは、`config.json` の `addons.llama-log.settings.port` と、bat の `tap.js` のあとに ` --port <番号>` を同じにします。
