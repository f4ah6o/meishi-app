# meishi-app

iPhone名刺取り込み・法人/担当者特定 PoC/MVP。
`issues/open/20260930-iphone-business-card-capture-and-customer-identification-mvp.md` の実装。

```text
iPhone Safari / PWA (web/)
        | HTTPS
Cloudflare Access
        | Cloudflare Tunnel
Internal Hono Gateway (server/)
        +--> codex app-server   名刺画像 -> 構造化JSON
        +--> 国税庁法人番号API / gBizINFO
        +--> Decision AI (rule / Jev adapter)
        +--> kintone            corporations / contacts / business cards / interactions
```

## 構成

| パッケージ | 内容 |
| --- | --- |
| `web/` | Vite + React PWA。`getUserMedia()` で背面カメラを起動し、端末内で矩形検出・安定判定・ブレ判定を行い、条件を満たした1枚だけを台形補正して送信する。リアルタイム動画はサーバーへ送らない。手動シャッター / ファイル選択のフォールバックあり。 |
| `server/` | Hono + `@hono/node-server` の内部Gateway。抽出・正規化・既存顧客検索・法人候補・判定・確認登録のREST API。 |
| `shared/` | web/server 共有のAPI型定義。 |

## ローカル実行

```bash
npm install
cp .env.example .env   # 必要な値を埋める（ローカルdevならデフォルトのままで可）
npm run dev            # server:8787 + web:5173
```

ブラウザで `http://localhost:5173` を開く。カメラ権限の許可が必要。

デフォルトのローカル構成（外部サービス不要）:

- `AUTH_MODE=dev` — 固定の開発者identityで認証をバイパス（本番では必ず `access` にすること）
- `STORE_BACKEND=memory` — kintone の代わりにインメモリストア
- `CARD_EXTRACTOR=codex` — ホスト上の `codex` CLIを使用。ない場合は `stub` に変更
- `CORPORATE_REGISTRY=nta` — `NTA_APP_ID` 未設定なら候補0件で動作

### テスト / 検証

```bash
npm run lint
npm run typecheck
npm test          # vitest: 正規化・矩形検出・台形補正・ランキング・判定安全性・API
npm run build     # web の本番ビルド
```

## Codex app-server

`codex` CLI の `app-server` サブコマンドとstdio経由のJSON-RPC（JSONL）で通信する
（protocol: `initialize` → `initialized` → `thread/start` (ephemeral) → `turn/start`
→ `item/completed` → `turn/completed`）。ホストで `codex login` または
`OPENAI_API_KEY` による認証が必要。抽出は1画像=1スレッドで、base instructionsで
JSON-only応答を強制する。Codexプロセスはインターネットへ公開せず、Gatewayからのみ起動する。

## kintone

`STORE_BACKEND=kintone` に切り替え、以下の4アプリを作成する（フィールドコードは任意名を使用、コードを合わせること）:

| アプリ | フィールド |
| --- | --- |
| corporations | `corporate_number`, `official_name`, `address`, `website`, `verification_status` |
| contacts | `corporation_id`, `name`, `department`, `title`, `email`, `phone`, `mobile` |
| business_cards | `person_id`, `corporation_id`, `image_reference`, `captured_at`, `raw_extraction`, `confirmed_data`, `decision_confidence`, `review_status` |
| interactions | `corporation_id`, `person_id`, `interaction_type`, `interaction_at`, `summary`, `next_action` |

各アプリでAPIトークンを発行し `.env` に設定する。同一法人の重複登録は
`corporate_number` を主要キーとして抑止される。

## 法人データ

- `CORPORATE_REGISTRY=nta`: [法人番号公表サイト](https://www.houjin-bangou.nta.go.jp/webapi/) でアプリケーションID発行届出（無料、メールで13桁のIDが届く）。`/4/name` を `type=12`(XML) で呼ぶ。
- `CORPORATE_REGISTRY=gbizinfo`: [gBizINFO](https://info.gbiz.go.jp/) でWeb API利用申請（無料、即時トークン発行）。`GET /hojin/v1/hojin` を `X-hojinInfo-api-token` ヘッダで呼ぶ。

## Cloudflare Tunnel / Access

iPhone Safariから社内Gatewayへ届ける経路。Codex app-server自体は公開しない。

1. Gatewayを社内マシンで起動（`npm run start -w @meishi/server`、または web の `npm run build` 成果物を別途配信）。
2. `cloudflared` をインストールし、Tunnelを作成:

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create meishi
   # ~/.cloudflared/<tunnel-id>.json ができる
   ```

   `~/.cloudflared/config.yml`:

   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /path/to/<tunnel-id>.json
   ingress:
     - hostname: meishi.example.com
       service: http://localhost:8787   # APIのみトンネル経由でもよい
     - service: http_status:404
   ```

   ```bash
   cloudflared tunnel route dns meishi meishi.example.com
   cloudflared tunnel run meishi
   ```

   フロントエンドは別の静的ホスティング（Workers Pages等）に置いてもよい。その場合 `/api` をGatewayの公開ホストへ向ける。

3. Cloudflare Zero Trust → Access → Applications で `meishi.example.com` をSelf-hostedアプリとして保護し、許可するユーザーのメールドメイン/グループを設定。Application の **AUD tag** をコピーする。
4. `.env` に `AUTH_MODE=access`, `ACCESS_TEAM_NAME=<your-team>`, `ACCESS_AUD=<AUD>` を設定。Gatewayは `Cf-Access-Jwt-Assertion` を Access の公開鍵で検証する。

## セキュリティ

- HTTPSはCloudflare側で終端。GatewayはTunnel経由のみで受ける（直接公開しない）。
- `Cf-Access-Jwt-Assertion` JWTをAccessのJWKで検証（`AUTH_MODE=access`）。
- AI/API/kintoneの認証情報はGatewayのenvのみに置き、ブラウザへ出さない。
- リクエストサイズ制限・画像マジックバイト検証（JPEG/PNG/WebPのみ）・レート制限。
- アクセスログ・AI処理ログ・登録履歴をJSON構造化でstdoutに出力。
- 名刺画像は `IMAGE_RETENTION=ephemeral`（既定）で抽出直後に削除。`keep` はPoC検証用のみ。
- Codex側のデータ保持: OpenAIの利用条件を別途確認すること（ChatGPTログインかAPI keyかで保持条件が異なる）。

## 未検証・残課題

- Codex app-serverへの認証（ChatGPT login / OPENAI_API_KEY）がセットされた環境での実画像E2Eは未検証。プロトコルのハンドシェイクとクライアント実装は確認済み。
- kintone・NTA・gBizINFO・Jevの本番接続は資格情報次第。`memory`/`stub` で境界はテスト済み。
- 名刺検出はOpenCV.jsを使わない軽量実装（背景対比の最大領域＋四隅推定）。低コントラスト背景や複雑背景ではOpenCV.jsへの置き換えを推奨。
- PoC測定項目（accuracy/UX/性能）の計測基盤は未実装。
- iPhone Safari実機での自動撮影は未検証（エミュレータ非対応のため実機確認が必要）。
