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
| 出典のない数値 | 救急で標準的に確立した用量は、省略せず「一般的な範囲」として書き、数値の直後に【出典未確認・要確認】を付ける（画面で強調）。本邦と海外で規格が違いうるものは添付文書での確認を促す。自信のない数値は書かず理由を述べる | 用量まで具体化したいが、出典のない数値が出典のある数値に見えてはいけないため |
| 出典の信頼性 | チャンクに `provenance`（book / transcriber）を持たせ、転写者の図説明は「原本の記述ではない」と明示 | 転写者の補助文を書籍の主張として引用しないため |
| 数値 | 用量・閾値らしい記述を `numeric_critical` として印付け、回答に「原本の頁で再確認」を促す | 転写誤りが最も危険な箇所 |
| 引用 | Anthropic の `search_result` ブロック + `citations`。引用文は API が返す `cited_text` | モデルが頁を捏造できない（頁は検索結果のメタ情報から引く） |
| 検索の強制 | `tool_choice` は使わない（Claude 5.5 は強制指定を 400 で拒否する）。最初の書籍検索より前の本文は画面に出さず保留し、検索せずに答えた場合は破棄して「先に search_books を呼べ」と指示して1回だけ再依頼。それでも検索しなければ警告つきで表示 | 記憶だけの回答を根拠付きの回答に見せないため |
| 閲覧環境 | 自前 PWA | Claude アプリのコネクタ経由だと、iOS で頁画像やストリーミング表示を制御できない（未検証部分が多い） |
| 検索語の拡張 | 辞書（`worker/src/synonyms.ts`）で、同義語・略語・表記ゆれと関連語を低い重みで足す。各1本の OR 検索にまとめる | 語の一致では「高K血症」で「hyperkalemia」や「透析」の節に当たらないため。D1 の問い合わせの数を増やしすぎないため |
| 入力のガード | 画面と Worker の両方で、識別情報らしき入力（8桁以上の数字・電話番号・ID/MRN・メール・識別の語）を検査し、確認なしには送らない。氏名と日付は検出しない | 実臨床の参考利用で、氏名・ID を入れない約束を道具の側でも守るため（`docs/clinical-use.md`） |
| 失敗時の振る舞い | 回答の生成が失敗しても、見つかった節（なければ質問の内容語で検索し直した節）を出す。途中までの回答は残す | 回答が出ないときも、書籍を引ける状態を保つため |

## ディレクトリ

```
ingest/      Markdown → 検証 → SQLite（Python 3.11+、PyYAML のみ）
  parse.py, validate.py, build_db.py, tokenize.py, export_sql.py, cli.py
  ocr_convert.py   EbookText Studio の自動 OCR（全文.md）→ 章形式への変換
schema.sql   テーブルと FTS5 定義
worker/      Cloudflare Worker（TypeScript）と Node 製テスト
  src/       handler / anthropic(ツールループ) / search / format / prompt(システムプロンプト) / db / tokenize
  test/      node:test（27件）、devserver.ts（偽 Anthropic でのローカル画面確認用）
web/         PWA（ビルド不要、外部ライブラリ無し）
eval/        評価（run_eval.ts 検索・run_ask_eval.ts 回答・lib.ts、clinical.template.jsonl、smoke 22問）。手順は docs/evaluation.md
scripts/     prepare_pages.py（PDF → 頁 WebP）、import_ebooktextstudio.py（OCR 本の一括取り込み）、sample_numeric.py（数値の転写誤り率の作業表と集計）
tests/       Python テスト、合成フィクスチャ、ブラウザ確認 (e2e/ui_smoke.py)
docs/        FORMAT.md（転写の書式）、clinical-use.md（実臨床の参考利用の範囲）、enhancement-plan.md（強化案と設計）、evaluation.md（測定と評価の手順）
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

#### 1b. EbookText Studio の自動 OCR 本を取り込む（`全文.md`）

EbookText Studio の出力フォルダ（`<書名>/output/全文.md`）は、章ごとの転写 Markdown とは別の形式です（見出しは OCR の推定、頁は `<!-- p.N ここまで -->` と `<!-- 改ページ -->`）。
`ingest.ocr_convert` が章形式に変換し、同じ検証・索引化を通します。**1コマンド版**（変換 → 検証 → SQL 化 → D1 へ送信。本ごとに差し替えるので他の本は消えません）:

```bash
pip install pyyaml
cd worker && npm ci && npx wrangler login && cd ..          # 初回のみ（wrangler login でブラウザが開く）
python scripts/import_ebooktextstudio.py "C:\Users\<you>\Documents\EbookTextStudio" --push
python scripts/import_ebooktextstudio.py BASE --only "書名のフォルダ名" --push    # 1冊だけ追加・再取り込み
```

`--push` を付けない実行は変換と SQL 生成だけの予行演習です。変換結果と SQL は `work/` に出ます（著作物なので `.gitignore` 済み）。

頁の決め方（誤った頁を出さないための保守的な規則）:
- 頁の終わり（`p.N ここまで`・`改ページ`）を1件ずつ数え、他の番号と「番号 − 通し番号」が一致するものだけを信用します。OCR の読み違い（11, 1058, 19 など）は捨てます。
- 信用した2つの番号の間は、件数が合えば1頁ずつ確定、1〜3 のずれなら幅つき（`p.10-11`）、それ以上は区間全体を幅で示します。
- 見出しは作らず、約2万字ごとに機械的な節（S01, S02…）で区切ります。OCR の見出しは H2 以下に残ります。
- 古い版の EbookText Studio の出力（`p.N ここまで` が無い・見出しも表も無い）は取り込まず、再出力を促します。
- 全結果に「自動 OCR・照合未完」の警告が付きます。数値・用量・表は原本の画像で確認してください。

### 2. D1 を作って流し込む

```bash
cd worker && npm install
npx wrangler d1 create medbook            # 出力された database_id を wrangler.jsonc に貼る
for f in ../d1/*.sql; do npx wrangler d1 execute medbook --remote --file "$f"; done
```

`export_sql` は既定で全テーブルを作り直します（DELETE → INSERT）。`--books id1,id2` を付けるとその本だけを差し替え、他の本はそのままです（1b のスクリプトはこちらを使います）。
もし D1 が `tokenize='trigram'` を受け付けない場合は `python3 -m ingest.export_sql library.sqlite d1/ --no-trigram` で
bigram 索引だけの版を作れます（英字の部分一致の再現率は少し下がります）。Worker 側も trigram が使えないときは自動で bigram のみに落ちます。

### 3. 秘密情報とデプロイ

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put APP_TOKEN          # 16文字以上の長いランダム文字列
npx wrangler deploy
```

`/api/ask` の1日の上限は `wrangler.jsonc` の `DAILY_ASK_LIMIT`（日本時間で数える。仮の値 100、`"0"` で上限なし）。回数は D1 の `usage_daily`（日付と回数だけ）に Worker が自分で作って数えます。

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
cd worker && node --test test/*.test.ts            # TS テスト（67件）
python3 -m unittest discover -s tests -p 'test_ingest.py'
npx tsc --noEmit
# 画面確認（偽の Anthropic で動く。課金なし）
node --no-warnings worker/test/devserver.ts library.sqlite 8787 &
python3 tests/e2e/ui_smoke.py http://localhost:8787 /tmp/ui     # 要 playwright + Chromium（5 は rk4 の章が前提）
python3 tests/e2e/ui_clinical.py http://localhost:8787 /tmp/uc  # 帯・入力ガード・縮退（合成の書籍で動く）
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
- 評価: `eval/clinical.template.jsonl` を `eval/clinical.local.jsonl` にコピーして自分の質問を 30〜50 問書き、`node --no-warnings eval/run_eval.ts --api https://<worker> eval/clinical.local.jsonl --compare-dict` で hit@k と辞書の効果を測ってください（無料。回答まで見るのは `eval/run_ask_eval.ts`）。数値の転写誤り率は `scripts/sample_numeric.py`。手順は `docs/evaluation.md`。

## 検証状況（正直な一覧）

**確認したこと**
- 実際の1章（67頁・約9.9万字・254チャンク）の取り込み: 頁帰属（頁なし0件）、節と著者の対応（13/13）、参照文献 82 件（PMID 40）、図・表・転写者補助の分離。
- Python 45 件・TypeScript 67 件のテスト、型チェック、`wrangler deploy --dry-run`（設定とバンドル）。2026-10-24 時点。
- 入力ガード・常時表示の帯・縮退の画面（`tests/e2e/ui_clinical.py` の 27 項目。合成の書籍と偽の API。Chromium の iPhone 幅）。
- 偽の Anthropic API を相手にしたツールループ（分割到着する SSE、引用→頁の対応づけ、検索回数上限、API エラーの伝播と鍵の非漏洩）。
- Chromium（iPhone 幅・ダーク）での画面操作 29 項目（認証、ストリーミング、表・太字・箇条書き、引用チップ、根拠シート、節全文、頁画像、Web 引用、エラー、中止、CSP 違反なし）。
- `wrangler dev --local`（workerd + ローカル D1）で、FTS5 の trigram/unicode61 作成、データ投入、検索、認証、静的配信とセキュリティヘッダーが動くこと。

- EbookText Studio の 4 冊（約 2,900 チャンク）の変換・検証・本ごと差し替え SQL の生成と、ローカル D1 への投入・横断検索。頁の割り当ては 4 冊中 3 冊で全区間が件数一致（残る 1 冊は 1 区間だけ ±1 の幅つき）。
- Cloudflare への実デプロイ（Workers Builds、`/api/health`、秘密情報の設定後の認証応答）。

**未確認（あなたの環境で最初に確かめてください）**
- **実際の Anthropic API 呼び出し**（開発環境には鍵が無く、自動テストは偽の API 相手です。実機の初回では `tool_choice` の強制が 400 で拒否され、上記の方式に直しました。このように、実測で初めて分かる差異が残っている可能性があります）。`search_result` の引用形式、`web_search` の挙動、ストリーミングのイベント形は、公式ドキュメントに基づく実装であって実測ではありません。最初の数問で、引用が付くか・頁が正しいかを必ず目視してください。
- ~~本番 D1 での trigram トークナイザ~~ → **確認済み**（2026-10-22、D1 コンソールで日本語3文字の一致検索が動作）。大きな SQL ファイル（数 MB）の `wrangler d1 execute --remote` 取り込みと、無料枠の書き込み行数上限（1日10万行）への収まり具合は未確認です。
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

- **語彙一致が中心**。同義語・言い換えに弱い箇所があります。辞書（`worker/src/synonyms.ts`）で一部を補いましたが、本物の書籍での効果は未測定です。次の手: 評価セット（`docs/enhancement-plan.md` の A1）で測ってから、埋め込みを足してベクトル検索を RRF に合流（`searchChunkIds` の `extraRankings` に差し込み口あり）。
- 文献（参考文献リスト）は既定で検索対象外。PMID は節の全文表示から PubMed へ飛べます。
- 図の「図中の文字・構造」は転写者の記述で、検索はできるが引用してはいけない扱い。
- 転写の誤りは検出できません（`validate` は形式の検査）。重要な数値は必ず原本で再確認する運用が前提です。
- 変換ログ（章ごとの照合状況）の取り込みは未実装（`issues` テーブルに `source='conversion-log'` として載せる設計）。
- 取り込み時に API を使う改善案: 文脈付き索引（Haiku 5.5 でチャンクごとの要約）、頁画像と本文の突き合わせによる誤転写の検出（Batch API で半額）。

## 安全・プライバシー・著作権

- **実臨床の参考利用に使います**（2026-10-24 の医師の決定。参考にする程度で、最終判断は医師本人。`docs/clinical-use.md`）。入れてよい質問は、年代・主要所見・検査値の数値まで。**氏名・ID は入れません**。診療録そのものは入れないでください。施設プロトコルはこのアプリに入れていません（別途確認してください）。
- API 経由のデータは既定では学習に使われませんが、保持・ログの扱いはご自身の施設規程と Anthropic の最新の規約で確認してください。
- 強化案と第1段の設計は `docs/enhancement-plan.md`。
- 書籍テキストと頁画像は著作物です。D1 / R2 は自分専用の非公開リソースにし、リポジトリには含めないでください（`.gitignore` 済み）。
- 回答は検討の材料です。診療判断・用量決定は、原本・添付文書・施設プロトコルで確認してください。
