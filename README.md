# medbook-rag — 自分の医学書を根拠頁つきで引く検索・回答アプリ

文字起こし済みの医学書（Markdown）を自前で索引化し、iPhone / iPad のブラウザ（ホーム画面に追加すれば PWA）から質問すると、
**毎回まず書籍を検索 → 該当節を読ませて回答 → 引用（書名・章節・頁）を付ける** アプリです。書籍に無い点やガイドライン改訂が絡む点は、
任意で Web 検索（学会・PMDA・KDIGO 等のドメインに限定）で補います。

Claude の Projects のような「アップロード容量の上限」「検索の中身が見えない」問題を避けるために、検索層を自分で持つ構成にしています。
書籍は何冊でも足せます（D1 の容量が上限。1冊 = 数十 MB 未満が目安）。

```
iPhone / iPad (Safari, PWA)
      │  HTTPS + Bearer token
      ▼
Cloudflare Worker ──────────────►  Anthropic Messages API
  /api/ask (SSE)   tool loop:        ・search_books(強制の初回呼び出し)
  /api/search      question →        ・web_search(任意)
  /api/parent/:id  search_books →    ・search_result による引用 (cited_text)
  /api/page/:b/:n  answer+citations
      │
      ├─ D1 (SQLite): 章/節/チャンク/文献 + FTS5 2系統（trigram, bigram）
      └─ R2 (任意): 原本の頁画像  pages/<book_id>/<頁>.webp
```

## 設計の要点（なぜこうしたか）

| 論点 | 判断 | 理由 |
|---|---|---|
| 検索単位 | 小さいチャンクで検索し、親の節（≤3500字）を返す | 検索精度（小）と文脈（大）の両立。頁マーカー `［p.N］` 付きで返す |
| 日本語検索 | FTS5 `trigram`（部分一致）＋ 文字 bigram の `unicode61` を RRF で統合 | trigram は2文字語（腎炎・感度）を引けない。bigram は2文字以上の CJK 語と英単語を引ける |
| 文章形のクエリ | 該当が3件未満なら、ひらがな・句読点で区切った内容語に緩めて再検索 | 「感度と特異度の違いを教えて」が単一の完全一致フレーズ扱いで0件になるため |
| 出典の信頼性 | チャンクに `provenance`（book / transcriber）を持たせ、転写者の図説明は「原本の記述ではない」と明示 | 転写者の補助文を書籍の主張として引用しないため |
| 数値 | 用量・閾値らしい記述を `numeric_critical` として印付け、回答に「原本の頁で再確認」を促す | 転写誤りが最も危険な箇所 |
| 引用 | Anthropic の `search_result` ブロック + `citations`。引用文は API が返す `cited_text` | モデルが頁を捏造できない（頁は検索結果のメタ情報から引く） |
| 検索の強制 | 1ターン目は `tool_choice` で `search_books` を強制 | 記憶だけで答え始めないため |
| 閲覧環境 | 自前 PWA | Claude アプリのコネクタ経由だと、iOS で頁画像やストリーミング表示を制御できない（未検証部分が多い） |

## ディレクトリ

```
ingest/      Markdown → 検証 → SQLite（Python 3.11+、標準ライブラリのみ）
  parse.py, validate.py, build_db.py, tokenize.py, export_sql.py, cli.py
schema.sql   テーブルと FTS5 定義
worker/      Cloudflare Worker（TypeScript）と Node 製テスト
  src/       handler / anthropic(ツールループ) / search / format / prompt(システムプロンプト) / db / tokenize
  test/      node:test（27件）、devserver.ts（偽 Anthropic でのローカル画面確認用）
web/         PWA（ビルド不要、外部ライブラリ無し）
eval/        検索評価（run_eval.ts、smoke 22問、questions.template.jsonl）
scripts/     prepare_pages.py（PDF → 頁 WebP）
tests/       Python テスト、合成フィクスチャ、ブラウザ確認 (e2e/ui_smoke.py)
docs/        FORMAT.md（転写 Markdown の書式と、実章で見つかった注意点）
```

## セットアップ

前提: Node 22 以上、Python 3.11 以上、Cloudflare アカウント（Workers / D1 / 任意で R2）、Anthropic API キー。

### 1. 書籍を取り込む（手元で）

```bash
python3 -m ingest validate rk4 chapters/ch01.md chapters/ch02.md          # 検証だけ。error があれば直す
python3 -m ingest build --db library.sqlite rk4 chapters/*.md             # 章単位で冪等に追加
python3 -m ingest.export_sql library.sqlite d1/                           # D1 用 SQL に書き出す
```

`validate` は頁番号の欠落・逆行、未解決の脚注/引用番号、表の列数、画像の欠落、節と著者の不整合などを検出します（書式は `docs/FORMAT.md`）。
別の本は別の `BOOK_ID`（英数字）で追加します。2冊目以降は同じ `library.sqlite` に `build` を重ねてから、再度 `export_sql` してください。

### 2. D1 を作って流し込む

```bash
cd worker && npm install
npx wrangler d1 create medbook            # 出力された database_id を wrangler.jsonc に貼る
for f in ../d1/*.sql; do npx wrangler d1 execute medbook --remote --file "$f"; done
```

`export_sql` は全テーブルを作り直す（DELETE → INSERT）ので、更新時も同じ手順です。
もし D1 が `tokenize='trigram'` を受け付けない場合は `python3 -m ingest.export_sql library.sqlite d1/ --no-trigram` で
bigram 索引だけの版を作れます（英字の部分一致の再現率は少し下がります）。Worker 側も trigram が使えないときは自動で bigram のみに落ちます。

### 3. 秘密情報とデプロイ

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put APP_TOKEN          # 16文字以上の長いランダム文字列
npx wrangler deploy
```

表示された URL を iPhone / iPad の Safari で開き、共有 → 「ホーム画面に追加」。初回に設定画面でアクセストークンを入力します
（この端末のブラウザにだけ保存。会話内容は保存しません）。URL は推測されにくいものにし、可能なら Cloudflare Access を前段に置いてください。

### 4. 原本の頁画像（任意）

```bash
npx wrangler r2 bucket create medbook-pages            # wrangler.jsonc の r2_buckets のコメントを外す
python3 scripts/prepare_pages.py --book rk4 --pdf book.pdf --offset -12 --out pages_out --emit-upload-script upload.sh
cd worker && sh ../upload.sh
```

`--offset` は「PDF の連番 → 本に印刷された頁」の差です。転写の `出典ページ: p.N` と同じ番号で保存します。

### 5. ローカル確認

```bash
cd worker && node --test test/*.test.ts            # TS テスト
python3 -m unittest discover -s tests -p 'test_ingest.py'
npx tsc --noEmit
# 画面確認（偽の Anthropic で動く。課金なし）
node --no-warnings worker/test/devserver.ts library.sqlite 8787 &
python3 tests/e2e/ui_smoke.py http://localhost:8787 /tmp/ui     # 要 playwright + Chromium
# 実 D1 相当（workerd）
cd worker && printf 'ANTHROPIC_API_KEY=x\nAPP_TOKEN=local-dev-token-0123456789\n' > .dev.vars
npx wrangler d1 execute medbook --local --file ../d1/001_data.sql   # 000 → 001 → 999 の順
npx wrangler dev --local
```

## 使い方のコツ

- 質問は文章のままで構いません（検索語はモデルが作ります）。検索だけを確認したいときは `POST /api/search {"queries":["尤度比"]}`（LLM を呼ばず無料）。
- 回答の `[n]` をタップ → 引用箇所・頁・節の全文・原本頁。「検索でヒットした節」を開くと、モデルが何を読んだかが見えます。
- 回答に書籍の引用が一つも無いときは、画面に警告が出ます（記憶ベースの可能性）。
- 振る舞い（回答の型・出典の扱い・迎合しない等）は `worker/src/prompt.ts` に集約しています。ここを直せば挙動が変わります。
- 評価: `eval/questions.template.jsonl` を参考に自分の質問を 30〜50 問書き、`node --no-warnings eval/run_eval.ts library.sqlite eval/questions.jsonl` で hit@k を測ってください。

## 検証状況（正直な一覧）

**確認したこと**
- 実際の1章（67頁・約9.9万字・254チャンク）の取り込み: 頁帰属（頁なし0件）、節と著者の対応（13/13）、参照文献 82 件（PMID 40）、図・表・転写者補助の分離。
- Python 22 件・TypeScript 27 件のテスト、型チェック、`wrangler deploy --dry-run`（設定とバンドル）。
- 偽の Anthropic API を相手にしたツールループ（分割到着する SSE、引用→頁の対応づけ、検索回数上限、API エラーの伝播と鍵の非漏洩）。
- Chromium（iPhone 幅・ダーク）での画面操作 29 項目（認証、ストリーミング、表・太字・箇条書き、引用チップ、根拠シート、節全文、頁画像、Web 引用、エラー、中止、CSP 違反なし）。
- `wrangler dev --local`（workerd + ローカル D1）で、FTS5 の trigram/unicode61 作成、データ投入、検索、認証、静的配信とセキュリティヘッダーが動くこと。

**未確認（あなたの環境で最初に確かめてください）**
- **実際の Anthropic API 呼び出し**（鍵が無いため一度も実行していません）。`search_result` の引用形式、`web_search` の挙動、ストリーミングのイベント形は、公式ドキュメントに基づく実装であって実測ではありません。最初の数問で、引用が付くか・頁が正しいかを必ず目視してください。
- **本番 D1（リモート）での trigram トークナイザ**。ローカル（SQLite）では通っていますが、リモート D1 は未実施です（失敗時は上記 `--no-trigram`）。
- 検索品質の実力。smoke 22 問は私が実章を見て作った**甘い**テストです（キーワード 12 問は上位 3 件に 100%、言い換え 5 問は上位 3 件に 5/5 だが 1 位は 4/5）。1 章分・自作問題の結果であり、臨床的な検索品質の指標ではありません。
- iOS Safari 実機での表示（Chromium の iPhone 幅エミュレーションのみ）。ホーム画面追加後の挙動、サービスワーカー更新。
- 複数冊・数万チャンク規模での速度と D1 の制限。
- 用量表・数式を含む章の取り込み（サンプルに無かったため、`numeric_critical` の精度は未評価）。
- 費用の実測。

## 費用の目安（概算・未実測）

1 回の質問は、システムプロンプト（キャッシュ）＋検索結果（親節 最大 5 件 × ≤3500 字 ≒ 1 万〜2 万トークン／検索）＋回答 2〜3 千トークン。
Sonnet 5.5（入力 $2 / 出力 $10 per MTok）で 1 質問あたり概ね 5〜15 円、Opus 5.5 はその約 2 倍、Web 検索は 1 回 $0.01 追加、を想定しています。
画面の回答下に、実際のトークン数から出した概算が表示されます（`web/app.js` の `PRICES` で単価を更新できます）。

## 既知の限界と次の一手

- **語彙一致が中心**。同義語・言い換えに弱い箇所があります。次の手: Voyage AI 等の埋め込みを足してベクトル検索を RRF に合流（`searchChunkIds` の `extraRankings` に差し込み口あり）。ただし先に自分の質問で評価してから。
- 文献（参考文献リスト）は既定で検索対象外。PMID は節の全文表示から PubMed へ飛べます。
- 図の「図中の文字・構造」は転写者の記述で、検索はできるが引用してはいけない扱い。
- 転写の誤りは検出できません（`validate` は形式の検査）。重要な数値は必ず原本で再確認する運用が前提です。
- 変換ログ（章ごとの照合状況）の取り込みは未実装（`issues` テーブルに `source='conversion-log'` として載せる設計）。
- 取り込み時に API を使う改善案: 文脈付き索引（Haiku 5.5 でチャンクごとの要約）、頁画像と本文の突き合わせによる誤転写の検出（Batch API で半額）。

## 安全・プライバシー・著作権

- 患者を特定する情報は入力しない設計（画面にも明記）。API 経由のデータは既定では学習に使われませんが、保持・ログの扱いはご自身の施設規程と Anthropic の最新の規約で確認してください。診療録そのものは入れないでください。
- 書籍テキストと頁画像は著作物です。D1 / R2 は自分専用の非公開リソースにし、リポジトリには含めないでください（`.gitignore` 済み）。
- 回答は検討の材料です。診療判断・用量決定は、原本・添付文書・施設プロトコルで確認してください。
