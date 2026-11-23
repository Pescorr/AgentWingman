# llama.cpp / OpenAI互換リレー

llama-server（llama.cpp）には、生成中の文章を外から読む機能がありません（`/slots` で分かるのは「処理中か」と生成トークン数だけです）。
そこでこのアドオンは、アプリと LLM サーバーの **間に中継役（リレー）として入り**、流れてくる返事を読みながら
そのままアプリへ渡します。応答の中身は一切変えません。

```
アプリ（Zoocode・Open WebUI・自作スクリプト…） → リレー 127.0.0.1:8090 → llama-server 127.0.0.1:8080
```

llama.cpp 以外の OpenAI 互換サーバー（LM Studio、Ollama の `/v1`、KoboldCpp など）でも同じように使えます。

## いちばん簡単な使い方：llama.cpp の WebUI をリレー経由で開く

llama-server の設定は何も変えずに使えます。

1. トレイ → アドオン → **llama.cpp / OpenAI互換リレー** にチェック（既定で 8090 → 8080 に中継します）
2. ブラウザで **`http://127.0.0.1:8090/`** を開く（いつもの `:8080` の代わり）

WebUI はページを開いたアドレスへチャットを送るので（`./v1/chat/completions`）、ページも会話もすべてリレーを通ります。
AgentWingman を閉じているときは、いつも通り `:8080` を開けば今まで通り使えます。常駐するものは何もありません。

（llama-server b12602 で確認：ページと全ファイルがリレー経由でも同一、`reasoning_format: none` の思考もリアルタイムに表示）

## API を直接使うアプリの場合

1. トレイ → アドオン → **llama.cpp / OpenAI互換リレー** にチェック
2. `config.json` の `addons.openai-relay.settings` で、`upstream` を LLM サーバーのアドレスにする（既定 `http://127.0.0.1:8080`）
3. アプリ側の接続先（Base URL）を `http://127.0.0.1:8090/v1` に変える

| 設定 | 既定値 | 内容 |
|---|---|---|
| `listenPort` | `8090` | リレーが待ち受けるポート（このPCの中だけ） |
| `upstream` | `http://127.0.0.1:8080` | 本物の LLM サーバー |
| `watchSlots` | `true` | リレーを通らないリクエストも `/slots` で「処理中」だけは分かるようにする（llama-server のみ） |
| `statusPollMs` | `3000` | サーバーの生存確認とモデル名の取得の間隔 |

## 表示されるもの

| 状態 | 判断のしかた |
|---|---|
| プロンプト読込中 | リクエストを送ってから最初のトークンが来るまで |
| 思考中（本文つき） | `reasoning_content` / `reasoning`、または `<think>…</think>` の中身が流れている |
| 回答作成中（本文つき） | それ以外の `content` が流れている |
| tok/s | 最後に届く `timings.predicted_per_second`（llama-server）。無ければ受信ペースからの概算 |
| CTX | `timings`（prompt_n + cache_n + predicted_n）または `usage.total_tokens` |
| モデル名 | サーバーの返事の `model`、無ければ `/v1/models` |

`--reasoning-format` が `none` で思考が `<think>` タグのまま本文に入っていても、タグで分けて表示します。

## 注意

- リレーを通したリクエストだけが本文まで見えます。通さないリクエストは（llama-server なら）「処理中」だけ表示します。
- AgentWingman を終了するとリレーも止まり、接続先をリレーにしたアプリはつながらなくなります。常用するなら
  AgentWingman を常駐させておくか、使わないときはアプリの接続先を元に戻してください。
- 待ち受けは `127.0.0.1` のみで、ほかの PC からは使えません。
