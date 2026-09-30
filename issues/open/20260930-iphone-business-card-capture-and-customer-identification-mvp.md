# iPhone名刺取り込み・法人/担当者特定 PoC/MVP

## Goal

iPhoneのブラウザ/PWAから名刺を撮影し、名刺情報を構造化して国内法人・既存担当者へ紐付け、kintoneへ登録できるPoC/MVPを実装する。

単純なOCRではなく、以下を一連の体験として成立させる。

- 名刺の撮影
- 名刺らしい矩形の検出と自動撮影
- 名刺情報の構造化
- 国内法人の実在確認・法人番号特定
- 既存顧客/担当者の早期サジェスト
- 過去商談コンテキストの復元
- 曖昧なケースのみ人が確認
- kintoneへの登録

PoC段階では従量課金のVision APIを主経路にせず、社内マシン上のCodex app-serverをAI解析レイヤーとして使う。

## Scope

### In scope

- iPhone
- Safari / PWA
- 日本国内法人
- 日本語中心の名刺
- 法人番号を持つ法人
- 名刺1枚単位の撮影
- 新規顧客
- 既存顧客
- 既存担当者との再商談
- kintoneを正本とする顧客データ管理

### Out of scope

- PC向けUI
- Android最適化
- 海外企業
- 個人事業主
- 法人番号を持たない組織
- 大量スキャナーによる一括取り込み
- 完全無人での100%自動登録
- Sansan相当の有人補正サービス

## Selected stack

### iPhone frontend

- TypeScript
- React または Preact
- Vite
- PWA
- Safari
- MediaDevices / `getUserMedia()`
- Canvas
- 必要に応じて OpenCV.js 等のブラウザ内画像処理

Next.jsは使用しない。

### Internal backend

- TypeScript
- Hono
- Codex app-server

### Network / access

- Cloudflare Tunnel
- Cloudflare Access

### Data store

- kintone

kintoneを法人・担当者・名刺・商談/接触履歴の正本とする。

### Corporation data

候補:

- 国税庁 法人番号関連データ/API
- gBizINFO

### Decision layer

法人候補や既存顧客候補の選択には、必要に応じてJev等のDecision AIを利用する。

自由文生成ではなく、候補選択・Yes/No・信頼度のような限定された判断を優先する。

## Architecture

```text
iPhone Safari / PWA
        |
        | HTTPS
        v
Cloudflare Access
        |
Cloudflare Tunnel
        |
        v
Internal Hono Gateway
        |
        +--> Codex app-server
        |      +--> business card image -> structured JSON
        |
        +--> corporate registry / gBizINFO
        |
        +--> Decision AI
        |
        +--> kintone
               +--> corporations
               +--> contacts
               +--> business cards
               +--> meetings/interactions
```

Codex app-server自体はインターネットへ直接公開しない。Cloudflare Tunnelの接続先はHono Gatewayとし、GatewayからCodex app-serverへ接続する。

## Functional requirements

### 1. iPhone camera capture

1. iPhone Safari/PWAで撮影画面を開く
2. 背面カメラを起動する
3. 名刺らしい四角形を検出する
4. 名刺位置・サイズ・ブレを継続評価する
5. 撮影条件を満たしたら自動撮影する
6. 必要に応じてトリミング/台形補正する
7. 良い1枚だけをバックエンドへ送信する

リアルタイム動画はサーバーへ送らない。

#### Auto-capture conditions

少なくとも以下を組み合わせる。

- 名刺全体がフレーム内にある
- 四隅/矩形が認識できる
- 一定以上の表示面積がある
- 一定時間位置が安定している
- 極端な傾きがない
- 強い手ブレがない
- 極端なピンぼけではない

初期値の目安として500ms〜1秒程度の安定を条件とし、PoCで調整する。

### 2. Business card extraction

PoCではCodex app-serverへ画像を渡し、以下相当の構造化JSONを得る。

```json
{
  "company_name_raw": "",
  "person_name": "",
  "department": "",
  "title": "",
  "postal_code": "",
  "address": "",
  "phone": "",
  "mobile": "",
  "fax": "",
  "email": "",
  "website": "",
  "uncertain_fields": []
}
```

AIの役割はOCR、レイアウト理解、項目分類までとする。法人の実在確認はAI出力だけで確定しない。

### 3. Normalization

通常コードで以下を正規化する。

- Unicode
- 全角/半角
- 不要空白
- `㈱` / `（株）` 等の法人表記
- 郵便番号
- 電話番号
- メールアドレス
- URL

例:

```text
（株）山田建設
-> 株式会社山田建設
```

AIを使わず確定的に処理できるものは通常コードで処理する。

### 4. Existing customer / contact lookup first

名刺から最低限の会社名または担当者名が得られた時点で、まずkintoneの既存データを検索する。

可能なら名刺解析の全項目確定を待たずに先行検索する。

候補表示例:

```text
今回のお相手はこちらですか？

山田建設株式会社
山田 太郎
営業部長

最終商談: 2026-09-12

[この方で開始]
```

既存担当者を十分高い確度で特定できる場合は、新規登録前提の処理を省略する。

### 5. Corporation lookup

新規法人または既存法人を確定できない場合、公的法人データから法人候補を取得する。

検索キーの優先候補:

1. 法人名
2. 都道府県
3. 市区町村
4. 名刺記載住所
5. Webサイトドメイン

複数候補がある場合は無理に1件へ固定しない。

### 6. Decision layer

候補選択にDecision AIを利用できる抽象化を設ける。

入力候補:

- 名刺からの会社名
- 住所
- Webサイト
- kintone既存候補
- 公的法人候補

出力例:

```json
{
  "choice": "candidate_1",
  "confidence": 0.97
}
```

または:

```json
{
  "choice": "none",
  "confidence": 0.85
}
```

判断対象:

- 正式法人名の一致
- 所在地一致
- 表記揺れ
- 本店/支店関係
- Webドメイン一致
- 既存顧客との一致

PoCでは閾値を固定せず、誤った法人番号を自動確定しないことを優先する。

### 7. Repeat-meeting suggestion

2回目以降の商談では、ユーザーが会社名や担当者名を思い出す前に候補を提示できることを目指す。

初期ランキングはルールベースでよい。

スコア要素の候補:

- 最近会った
- 会った回数が多い
- 同一法人
- 最近商談した
- 直近に接触履歴がある
- 今回の予定と一致する
- 名刺から部分認識した会社名と一致する
- 氏名の部分一致

初期実装ではベクトルDBを必須としない。

### 8. Meeting context restore

担当者を確定した後、過去の商談/接触履歴からユーザーが相手を思い出すための情報を表示する。

例:

```text
山田 太郎
山田建設株式会社
営業部長

前回:
新社屋案件について打合せ

前回の確認事項:
- 工期確認
- 見積提出

最終接触:
2026-09-12
```

## kintone data model

既存アプリ構成に合わせて調整可能とするが、概念上は以下を分離する。

### Corporation

- corporation_id
- corporate_number
- official_name
- address
- website
- verification_status

### Contact

- person_id
- corporation_id
- name
- department
- title
- email
- phone
- mobile

### BusinessCard

- business_card_id
- person_id
- corporation_id
- image_reference
- captured_at
- raw_extraction
- confirmed_data
- decision_confidence
- review_status

### Meeting / Interaction

- interaction_id
- corporation_id
- person_id
- interaction_type
- interaction_at
- summary
- next_action

同一法人は法人番号を主要な同一性キーとして重複登録を抑制する。

## AI abstraction

AI実装を将来差し替えられるようにする。

```text
CardExtractor
  |- CodexAppServerExtractor   # PoC default
  |- OpenAIExtractor           # future
  |- GeminiExtractor           # future
  '- ClaudeExtractor           # future
```

PoCではCodex app-serverを既定にする。

将来、処理量、安定性、SLA、運用コストの要件が変わった場合に従量課金Vision APIへ置き換えられる構造とする。

## Security requirements

- HTTPS必須
- Cloudflare Accessで利用者を制限
- Codex app-serverの直接公開禁止
- AI/API/kintoneの認証情報をブラウザに置かない
- Hono Gatewayで認証/認可
- リクエストサイズ制限
- MIME type検証
- レート制限
- アクセスログ
- AI処理ログ
- 登録/修正履歴
- 不要になった名刺画像の保持/削除方針を定義する
- AIサービス側のデータ保持条件を確認する

## Performance principles

- カメラ動画は端末内処理し、サーバーへ送らない
- 撮影済みの良い1枚だけ送る
- AI呼び出し回数を抑える
- 正規化/形式検証は通常コードで行う
- 既存法人はkintoneを優先する
- 法人情報は必要に応じてキャッシュする
- Decision AIは小さな判断問題へ限定する

## Implementation phases

### Phase 1: end-to-end skeleton

- iPhone Safari/PWA
- 手動シャッター
- Cloudflare Access/Tunnel
- Hono Gateway
- Codex app-server
- 画像 -> JSON表示

### Phase 2: camera UX

- 名刺矩形検出
- 安定判定
- 自動シャッター
- トリミング/台形補正

### Phase 3: kintone / corporation identity

- kintone既存顧客検索
- 法人候補検索
- 法人番号特定
- 候補確認UI

### Phase 4: decision

- Decision AI adapter
- 候補ランキング
- confidence
- 自動確定しない安全側ルール

### Phase 5: repeat-meeting UX

- 既存担当者サジェスト
- 再会候補ランキング
- 前回商談/接触履歴表示

### Phase 6: production AI option

必要性が確認された場合のみ、Codex app-serverから外部Vision APIへ切り替える。

## PoC measurements

### Accuracy

- 氏名正解率
- 会社名正解率
- 部署正解率
- 役職正解率
- 住所正解率
- メール正解率
- 電話番号正解率
- 法人番号特定率
- 法人誤特定率
- 既存担当者特定率

### UX

- 自動撮影成功率
- 再撮影率
- 人による修正率
- 登録までの操作回数

### Performance

- 撮影から構造化結果表示までの時間
- 法人候補表示までの時間
- 既存担当者候補表示までの時間

### AI operation

- Codex利用量
- 利用制限到達頻度
- AI解析失敗率
- 再試行率

## Acceptance criteria

- [ ] iPhone Safari/PWAから背面カメラを利用できる
- [ ] 名刺画像を取得し、Hono Gatewayへ安全に送信できる
- [ ] Cloudflare Access/Tunnel経由で社内Gatewayへ接続できる
- [ ] Codex app-serverで名刺画像を構造化JSONへ変換できる
- [ ] 会社名・電話・メール等を通常コードで正規化できる
- [ ] kintoneの既存法人/担当者を検索できる
- [ ] 国内法人候補を取得できる
- [ ] 法人番号を確認できる
- [ ] 曖昧な法人候補を人に提示できる
- [ ] 同一法人の重複登録を抑制できる
- [ ] 誤特定しそうなケースを自動確定しない
- [ ] 名刺矩形を検出できる
- [ ] 安定した名刺を自動撮影できる
- [ ] 既存担当者を早い段階でサジェストできる
- [ ] 前回の商談/接触コンテキストを表示できる
- [ ] ユーザーが修正・確認した結果をkintoneへ登録できる

## Design principle

```text
iPhone:
  撮る / 確認する

Codex:
  見る / 読む / 分類する

Normal code:
  正規化 / 検証する

kintone:
  社内の正本を持つ

Public corporate data:
  法人の実在を確認する

Decision AI:
  候補から判断する

Human:
  曖昧なケースだけ確定する
```

## Notes

このissueは実装をまだ含めない。後工程でPhase単位またはacceptance criteria単位に実装を積むための基準仕様とする。
