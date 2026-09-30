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

- `AUTH_MODE=dev` — 固定の開発者identityで認証をバイパス。**既定は `access`（フェイルクローズ）で、`dev` はローカルの `.env` で明示した場合のみ有効**
- `STORE_BACKEND=memory` — kintone の代わりにインメモリストア
- `CARD_EXTRACTOR=codex` — ホスト上の `codex` CLIを使用。ない場合は `stub` に変更
- `CORPORATE_REGISTRY=nta` — `NTA_APP_ID` 未設定なら候補0件で動作

本番は `web` をビルドしてGateway単体で配信する:

```bash
npm run build                 # web/dist を生成
npm run start -w @meishi/server   # Gatewayが /api/* と PWA を同一オリジンで配信
```

Gatewayは `HOST=127.0.0.1` にバインドするため、Cloudflare Tunnel経由でしか到達できない。

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
`corporate_number` を主要キーとして抑止される。**corporationsアプリの
`corporate_number` フィールドは「重複する値を禁止する」をONにすること** —
これにより同時登録の競合でも一意性が保証される。なお、同じ社名でも
`corporate_number` が異なる既存レコードとは名寄せしない（別法人として新規作成）。

## 法人データ

- `CORPORATE_REGISTRY=nta`: [法人番号公表サイト](https://www.houjin-bangou.nta.go.jp/webapi/) でアプリケーションID発行届出（無料、メールで13桁のIDが届く）。`/4/name` を `type=12`(XML) で呼ぶ。
- `CORPORATE_REGISTRY=gbizinfo`: [gBizINFO](https://info.gbiz.go.jp/) でWeb API利用申請（無料、即時トークン発行）。`GET /hojin/v1/hojin` を `X-hojinInfo-api-token` ヘッダで呼ぶ。

## Cloudflare Tunnel / Access

iPhone Safariから社内Gatewayへ届ける経路。Codex app-server自体は公開しない。

1. `npm run build` で `web/dist` を生成し、Gatewayを社内マシンで起動（`npm run start -w @meishi/server`）。Gatewayは `web/dist` のPWAと `/api/*` を同一オリジン（`127.0.0.1:8787`）で配信する。
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
       service: http://localhost:8787   # PWAとAPIを同一ホスト名で公開
     - service: http_status:404
   ```

   ```bash
   cloudflared tunnel route dns meishi meishi.example.com
   cloudflared tunnel run meishi
   ```

   フロントエンドを別の静的ホスティング（Workers Pages等）に置く場合は `WEB_DIST=off` で静的配信を無効化し、`/api` をGatewayの公開ホストへ向ける。

3. Cloudflare Zero Trust → Access → Applications で `meishi.example.com` をSelf-hostedアプリとして保護し、許可するユーザーのメールドメイン/グループを設定。Application の **AUD tag** をコピーする。同一ホスト名で配信されるため、PWAとAPIの両方がAccessで保護される。
4. `.env` に `AUTH_MODE=access`, `ACCESS_TEAM_NAME=<your-team>`, `ACCESS_AUD=<AUD>` を設定。Gatewayは `Cf-Access-Jwt-Assertion` を Access の公開鍵で署名・issuer・audienceを検証する。

## Cloudflare Workers デプロイ（`worker/`）

PWAと同一APIをCloudflare Worker + Workers Static Assets + D1 (SQLite) で配信する構成。Node Gateway (`server/`) はそのまま残り、こちらは公開デモ向けの別経路。

```text
iPhone Safari / PWA (web/dist → Workers Assets)
        | HTTPS
Cloudflare Access (worker destination)
        |
Cloudflare Worker (worker/)
        +--> OpenCode Zen Go vision API   名刺画像 -> 構造化JSON
        +--> 国税庁法人番号API / gBizINFO (fetch)
        +--> Decision AI (rule / Jev adapter)
        +--> Cloudflare D1                corporations / contacts / business_cards / interactions
```

### 構成

- `worker/wrangler.toml` — `meishi-demo` Worker。`[assets]` で `web/dist` を配信（`run_worker_first = true` で全リクエストがWorkerの認証を通る）、`[[d1_databases]]` は binding `DB` → `meishi-demo`、`preview_urls = false` でプレビューURLは公開しない。
- `worker/migrations/0001_init.sql` — 4テーブル。`corporate_number` 非空に部分一意索引（同時登録の重複抑止）、`name_key` 列で名寄せ検索を永続化。
- `worker/src/store/d1Store.ts` — kintone版と同一のデデュープ規則をD1に実装。全クエリバインドパラメータ。
- `worker/src/extract/opencodeVision.ts` — OpenAI互換 `POST {OPENCODE_BASE_URL}/chat/completions`（既定 `https://opencode.ai/zen/go/v1`）に `data:` URL画像を投げるvision抽出。`OPENCODE_API_KEY` 未設定時は `/api/cards/analyze` が `503 extractor_not_configured` を返す（成功を偽装しない）。Zen Goは本来コーディングエージェント用途が主のため、モデル/キーがアプリ用途に対応するかは契約次第（実測: `max_tokens` が小さいとreasoningで枯渇し `finish_reason=length` + 空contentになるため2000に設定、length/空contentはエラー扱い）。

### 認証（フェイルクローズ）

全ルート（PWA静的アセットを含む）で以下の順にidentityを解決し、取れなければ401:

1. `ctx.access.getIdentity()` — Accessがworker宛に認証した呼び出しのみ存在。
2. `Cf-Access-Jwt-Assertion` をAccess JWKで署名・issuer・audience検証（多層防御）。

`AUTH_MODE=dev` は `ENVIRONMENT=local`（`wrangler dev` + `.dev.vars`）のときだけ有効。デプロイ環境では絶対に設定しない。

### デプロイ手順（オーナー作業）

```bash
npm run build -w @meishi/web
# 1) まず403プレースホルダWorkerを作成し、Access (destination: worker) を
#    meishi-demo に紐付けてから本実装をデプロイする（公開穴を作らない）
cd worker
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put OPENCODE_API_KEY
npx wrangler deploy --var ACCESS_TEAM_NAME:<team> --var ACCESS_AUD:<aud>
```

オプション: `NTA_APP_ID`（`--var`）、`GBIZINFO_API_TOKEN` / `JEV_API_KEY`（`secret put`）、`CORPORATE_REGISTRY` / `DECISION_PROVIDER` / `JEV_ENDPOINT`（`--var`）。

ローカル検証:

```bash
cd worker && cp .dev.vars.example .dev.vars   # ENVIRONMENT=local + AUTH_MODE=dev
npm run build -w @meishi/web
npx wrangler dev                              # D1はローカルSQLiteに自動作成
npx wrangler d1 migrations apply DB --local
```

## セキュリティ

- HTTPSはCloudflare側で終端。GatewayはTunnel経由のみで受ける（直接公開しない）。
- `Cf-Access-Jwt-Assertion` JWTをAccessのJWKで検証（issuer `https://<team>.cloudflareaccess.com` + audience）。`AUTH_MODE` の既定は `access` でフェイルクローズ。
- Gatewayは `HOST=127.0.0.1` にバインドし、Tunnel以外から直接到達できない。
- 確認登録時、クライアント送信の `corporate_number` は13桁検証のうえkintone既存レコードまたは公開法人データ（NTA `/4/id` / gBizINFO `/hojin/v1/hojin/{n}`）で照合し、確認できた場合のみ `verified` とする。
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
