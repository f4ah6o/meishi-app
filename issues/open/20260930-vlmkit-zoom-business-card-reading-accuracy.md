# VLMKit zoom loopで名刺読み取り精度を改善する

## Goal

iPhoneで撮影した名刺画像の読み取りに、`mizchi/vlmkit` の zoom/reasoning loop を応用し、特にメールアドレス・電話番号・URL・氏名などの「1文字の誤りが実害になる項目」の読み取り精度を改善する。

既存のMVP仕様にある「Codex app-serverへ名刺画像を1回渡して構造化JSONを得る」経路を、必要な領域だけ原画像から拡大して再確認できる構造へ拡張する。

対象のVLMKit:

- https://github.com/mizchi/vlmkit
- `@mizchi/vlmkit-ai/zoom.ts`
- `prepareZoomSource`
- `zoomInto`
- `runZoomLoop`

## Background

VLMへ名刺全体を縮小して渡すと、全体のレイアウトや意味は把握できても、小さい文字列の厳密な認識で誤りやすい。

例:

- `0` / `O`
- `1` / `l` / `I`
- `rn` / `m`
- ハイフンやピリオド
- 小さいふりがな
- 電話番号の末尾
- メールアドレスのローカル部
- URLのサブドメインやパス

`mizchi/vlmkit` の zoom loop は、最初に画像を所定のimage budgetへ縮小してモデルへ見せ、モデルが詳細確認したい矩形を指定すると、その座標を原画像へ写像してcropし、拡大画像をモデルへ返す。

現行実装では:

- full-resolution originalを保持する
- model-visible viewをimage budgetへ縮小する
- modelが `zoom(image, x1, y1, x2, y2)` を要求できる
- native function calling と text protocol の両方に対応する
- view上のboxをoriginal pixel coordinatesへ変換する
- originalからcropして再度image budgetまで拡大する
- zoom回数に上限を持つ

という構成になっている。

VLMKitのzoom accuracy benchmarkではUI画像の厳密値判定で zoom 58/58、single look 48/58 という結果が報告されている。ただし、この結果は名刺OCRの精度を示すものではない。名刺については本issue内で別途ベンチマークを行う。

## Scope

### In scope

- `mizchi/vlmkit` の zoom architecture / implementation の利用可否調査
- 名刺画像をfull-resolutionで保持する処理
- first-pass用の縮小画像生成
- 名刺読み取り向けzoom loop
- 項目ごとのconfidence / uncertainty
- uncertaintyが高い項目の領域再確認
- email / phone / mobile / fax / URL の厳密値再確認
- 氏名 / 会社名 / 部署 / 役職 / 住所の再確認
- zoom回数・画像サイズ・token利用量の上限
- zoomなしとの比較ベンチマーク
- Codex app-server経由で利用できるadapter設計

### Out of scope

- VLMKitをそのままOCRエンジンとして採用すること
- VLMKitのVRT / browser testing機能全体の導入
- 外部Vision APIへの本番移行
- kintoneデータモデル自体の変更
- 法人番号照合ロジックの変更
- 100%自動確定

## Design

### Processing flow

```text
iPhone camera
    |
    v
high-resolution card image
    |
    +------------------------------+
    |                              |
    v                              |
first-pass view                    |
(resized to image budget)          |
    |                              |
    v                              |
Codex / VLM                        |
    |                              |
    +--> structured fields         |
    |      + confidence            |
    |      + uncertainty           |
    |      + optional bbox         |
    |                              |
    +--> needs zoom? --------------+
              |
              v
      zoom request / bbox
              |
              v
 original-resolution crop
              |
              v
      magnified crop to VLM
              |
              v
       revised field value
              |
              v
 deterministic validation
              |
              v
      user confirmation UI
```

### Principle

名刺全体を毎回高解像度のまま複数回送らない。

最初は全体構造を把握できる解像度で解析し、厳密値が必要かつ不確実な箇所だけ、原画像から高解像度cropを作って再確認する。

### Field policy

#### High-priority exact fields

以下は1文字誤りでも実害が大きいため、低confidence時にzoom再確認する。

- email
- phone
- mobile
- fax
- website / URL
- postal_code

通常コードによる形式検証も必須とする。

例:

- email syntax
- 電話番号の文字種・桁
- URL parse
- 郵便番号形式

#### Semantic fields

以下は周辺レイアウトや全体文脈も重要なので、cropだけで確定せずfirst-pass contextを保持する。

- person_name
- company_name_raw
- department
- title
- address

### Proposed intermediate result

```json
{
  "fields": {
    "person_name": {
      "value": "山田 太郎",
      "confidence": 0.94,
      "bbox": [120, 210, 760, 390],
      "needs_review": false
    },
    "email": {
      "value": "t.yamada@example.co.jp",
      "confidence": 0.71,
      "bbox": [180, 980, 1320, 1080],
      "needs_review": true
    }
  }
}
```

bboxの座標系は実装時に明示し、VLMKit側の `pixels` または0-1000 normalized coordinatesとの変換境界を一箇所にまとめる。

## VLMKit integration strategy

VLMKit全体をアプリへ組み込むことを前提としない。

まず以下を比較する。

### Option A: `@mizchi/vlmkit-ai` を直接利用

利点:

- upstream実装をそのまま利用できる
- `runZoomLoop` / `zoomInto` の修正を追従しやすい
- native tool calling / text protocolの抽象化を再利用できる

確認事項:

- packageのruntime要件
- Codex app-serverとの接続方法
- PNG-only制約
- browser/backend境界
- dependency size
- API stability

### Option B: zoom primitiveだけをmeishi-app側に実装

必要な最小機能:

- original/view座標変換
- crop
- resize
- image budget
- zoom回数制限
- VLM tool protocol

VLMKitを直接依存させるコストが高い場合のみ選択する。

実装をコピーする場合はライセンス条件を確認し、必要なnoticeを追加する。

## Image handling

VLMKitの現行zoom image実装はPNG入力を前提とする。

iPhone撮影画像がJPEG/HEIC等の場合は、zoom layerへ渡す前に明示的に変換する。

変換後も、再cropに使うsource imageは十分な解像度を保持する。

検証対象:

- JPEG -> PNG変換コスト
- memory peak
- latency
- image size
- EXIF orientation
- color profile
- portrait / landscape
- 台形補正後画像との相性

## Zoom policy

初期値として以下を検討する。

- first pass: 1回
- max zooms: 3〜6
- exact fieldごとに無制限zoomしない
- 同一領域への重複zoomを抑止
- 形式検証で確定できた項目はzoomしない
- 既にconfidenceが十分高い項目はzoomしない
- zoom budget到達時は人の確認へfallback

閾値は固定値として仕様化せず、PoCの測定結果から決定する。

## Prompt / tool contract

モデルに以下を要求する。

1. 名刺全体から構造化項目を抽出する
2. 読めない文字を推測で埋めない
3. confidenceが低い場合は対象領域を示す
4. zoom toolが利用可能なら、小さい文字の厳密値確認に使う
5. zoom後に値を再評価する
6. 依然不明なら `uncertain` を返す

「必ず何かを返す」より「不明を不明として返す」ことを優先する。

## Measurement

実名刺または十分に現実的な検証用名刺セットを用意し、最低でも以下を比較する。

1. single look
2. zoom loop
3. 必要なら既存OCR併用案

### Metrics

#### Field exact match

- person_name
- company_name
- department
- title
- postal_code
- address
- phone
- mobile
- fax
- email
- website

#### Character-level

- character error rate
- exact string accuracy

特に:

- email exact match
- phone exact match
- URL exact match

を独立して集計する。

#### Operational

- 平均zoom回数
- p95 zoom回数
- input/output token usage
- latency
- image bytes transferred
- first-passのみで完了した割合
- user correction rate

### Dataset

最低50枚、可能なら100枚以上で測定する。

以下を混ぜる。

- 横型
- 縦型
- 日本語のみ
- 日英併記
- 小さい文字
- 薄い文字
- ロゴ化した社名
- QRコードあり
- 複数電話番号
- FAXあり
- 長いメールアドレス
- 長い部署名/役職名
- 傾きあり
- 軽いblur
- 照明ムラ

同じ画像セットをsingle look / zoomの両方で評価する。

## Acceptance criteria

- [ ] `mizchi/vlmkit` のzoom実装を調査し、直接依存か最小再実装かを決定できている
- [ ] full-resolution originalとmodel-visible viewを分離して保持できる
- [ ] view座標からoriginal座標へ正しく変換できる
- [ ] 指定領域をoriginalからcropしてVLMへ再提示できる
- [ ] zoom回数に上限がある
- [ ] 不正bbox / 範囲外bboxを安全に拒否またはclampできる
- [ ] email / phone / URLの低confidence項目だけを再確認できる
- [ ] zoom後の値をstructured resultへ反映できる
- [ ] zoom budget超過時に推測で確定せず人の確認へfallbackできる
- [ ] iPhone由来のJPEG/HEIC等をzoom処理可能な形式へ変換できる
- [ ] single lookとzoom loopを同じ画像セットで比較できる
- [ ] exact-match accuracyとcharacter-level accuracyを記録できる
- [ ] token usage / latency / zoom回数を記録できる
- [ ] zoomによる精度改善がない場合、通常経路へ戻せる
- [ ] kintone登録前にユーザーが最終値を確認・修正できる

## Success criterion

VLMKitのUI benchmark値を名刺精度の根拠として流用しない。

名刺データセットで、

- exact field accuracy
- character accuracy
- user correction rate
- latency / token cost

を比較し、追加コストに見合う改善が確認できた場合のみdefault pathへ採用する。

改善が特定フィールドに限定される場合は、zoomをそのフィールドだけに限定する。

## References

- https://github.com/mizchi/vlmkit
- https://github.com/mizchi/vlmkit/blob/main/packages/vlmkit-ai/src/zoom.ts
- https://github.com/mizchi/vlmkit/blob/main/packages/vlmkit-ai/src/zoom-loop.ts
- https://github.com/mizchi/vlmkit/blob/main/packages/vlmkit-ai/src/zoom-image.ts
- https://github.com/mizchi/vlmkit/blob/main/docs/reports/2026-09-28-zoom-accuracy-agent-v2.md

## Notes

このissueは仕様・検証計画のみを追加する。実装は後工程で積む。

既存の `issues/open/20260930-iphone-business-card-capture-and-customer-identification-mvp.md` のBusiness card extractionを補強する位置付けとし、既存仕様を削除・置換しない。
