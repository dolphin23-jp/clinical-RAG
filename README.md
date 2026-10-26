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
| 会話の保存 | 1往復ごとにサーバー（D1）に保存し、「会話」の画面で開き直し・削除・質問へのジャンプ。識別情報の確認を通した質問は保存しない。30日で自動的に消える（`CONVERSATION_RETENTION_DAYS`） | アプリの再起動（iPad）や再読み込みで会話が消えるため。医師の決定（`docs/clinical-use.md` の 1d） |
| 症例モード | ヘッダーの「症例」に年齢・性別・場面・主訴と経過・バイタル・所見・既往を入れて固定し（画面の上に1行で残る）、「アセスメントとプラン（草案）」「鑑別と反証」「見落としチェック」「コンサルト・医師コールの基準」を作る。固定の見出し、引用のない文には出どころの印（`[推論]` `[標準・出典未確認]` `[施設依存]`）。自分のアセスメントを入れると「先生の案との差」（正誤・点数なし）。症例の全欄に識別情報のガード。症例は会話と一緒に保存される | 症例を前に論点・根拠・反証を整理するため。医師の決定（`docs/clinical-use.md` の 1d の②）。草案であり、最終判断は医師 |
| カルテ記載の下書き | アセスメントとプランの草案の項目に「採用」を付け、「記載の下書きを作る」で、症例の入力と採用した項目だけを、記載の型（救急外来初療・外来初診・病棟入院時・病棟の経過・退院時サマリ・コンサルト依頼・申し送り）の欄に並べてコピーできる。場面・症候の質問の答えは、救急外来初療では、質問のカテゴリ（clinical-modules の橋宣言）→ `ROUTES` → 欄の順で記載の欄に振り分け、欄に結びつかない答えは末尾のブロックに残して件数を出す（`docs/enhancement-plan.md` の 8.18）。組み立ては決定論（AI を使わない）。未入力の必須欄は「（未入力）」、日付・患者ID・氏名は空欄。型の欄の名前・順序は clinical-modules から取り込む（`scripts/import_note_types.py`） | 実際のカルテに貼る下書きを、症例の事実と医師が採用した項目だけで作るため。医師の決定（`docs/clinical-use.md` の 1d の③）。画面に保存・書き出し・印刷・共有はない |
| Casebook へ送る（試作） | 症例の記録の「Casebook へ送る（試作）」で、先生が選んだ項目（救急の入力・問題・確度を選んだ診断・評価・計画・コール基準・日ごとの文）を、clinical-casebook の受け渡しパケットにしてクリップボードへ。**通信しない**。新しい症例か既存の症例（症例コード）かを選び、**実症例か架空症例かは毎回先生が選ぶ**。AI の草案から採用した項目は初めは選ばれない。送れない項目（識別情報・日付・除外した問題・外来）は理由つきで除く。同じ項目を送り直しても Casebook に2つできない。検査値・バイタルは項目にしない | 医師の決定（`docs/clinical-use.md` の 1f）。Casebook を先に更新してから送る（Casebook の T059）。送る向きだけ |
| 場面・症候の質問での入力（試作） | 「症例」の画面の年齢・性別の下で、場面と症候（救急外来 × 胸痛・腹痛・失神など12、外来初診 × 発熱）を選ぶと、clinical-modules のフローの質問が段階ごとに出る（中核を前に、残りは畳む）。選択・数値・時刻・短い文で入れ、**未入力の中核の質問を一覧で出す（未確認。陰性にしない）**。日付を書くと「4日前」「入院3日目」へ自動で直す（原文は残さない）。答えは症例に付いて質問に使われ、会話と一緒に保存されて開き直すと戻る。取り込むのは質問の構造だけ（`scripts/import_flow_schema.py`。規則・鑑別は取り込まない） | 症例の入力を場面ごとの型にし、抜けを見えるようにするため。医師の決定（`docs/clinical-use.md` の 1e）。鑑別・危険・検査の提案はしない。数値は記録するだけ |
| 文章からの取り込み（試作） | 「場面・症候の質問で入力する」の中で、メモを貼ると、そのフローの質問への答えの**提案**を、**元の文の該当箇所つき**で出す。**先生が確認して「入れる」を押したものだけ**が答えに入る（陰性・時刻・行った処置・否定や予定の言い方のあるものは1件ずつ。どれも最初は選ばれていない。入力済みの答えは上書きしない）。メモに書かれていない項目は提案せず、**判断・方針は聞かない**。貼った文章は**保存しない**（識別情報らしき文字があれば送らない。日付は送る前に「N日前」へ） | 入力の重さを減らす（質問を探す手間）。医師の決定（`docs/clinical-use.md` の 1e）。設計は `docs/enhancement-plan.md` の 8.12・8.15。Claude を1回呼ぶ（`/api/extract`）が、保存は増えない。**本物のAPIでの確認はまだ**（`eval/run_extract_eval.ts` で測る） |
| 症例の記録（救急 → 入院時 → 経過・退院） | ヘッダーの「症例の記録」と、固定中の症例の横の「記録」。固定した症例を**サーバーに保存する記録**にして、開き直せる（最後の更新から60日で自動的に消え、「終える」で消せる）。救急: 場面・症候の質問に入れた時刻を**病着からの分**で並べる（判定しない）、未入力・結果待ち・決めていない項目を**数えて**出す（判定ではない）。入院時: 回答の「症例の記録へ」で採用した項目を、**先生が1件ずつ**問題の評価・計画に付ける（自動では写さない。AI 由来の印と出典は保つ。計画は「予定・検討」で着き、「実施」は先生が選んだときだけ）。問題には安定した番号と、先生が選ぶ診断の確度。入院時の記載（A05）は記録から決定論で組み立てる。**入院後は、日ごとの記録・問題ごとの推移（先生が選んだものだけ）・課題（担当・期限）を足し、病棟の経過（A06）・中間サマリー（A07）・退院時サマリー（A08）を、その日までに先生が記録した判断だけから、AI を使わずに組み立てる**（退院時サマリーは、先生が退院を決めたときだけ） | 診察をまたいで残る症例の記録にし、入院時・経過・退院時の記載を救急の続きとして書くため。医師の決定（`docs/clinical-use.md` の 1e）。設計は `docs/enhancement-plan.md` の 8.13・8.14。書き込み先は `case_records` が増える（保存の入口で識別情報の検査・版の検査） |
| 外来の記録（初診 → 再診） | 「症例の記録」で、外来の記録を作る（固定した外来の症例を初診として、または**再診から**始めて**前回の方針を貼る**）。日は「基準日」と「基準日からN日後」だけで、日付は入れない。再診では、前回の計画の結果（実施・変更・中止は先生が選ぶ。記録のないものは「予定のまま」）・その日の先生の言葉・問題ごとの推移（選ばなければ空欄）・課題を記録し、**再診の記載（外来再診 A02）と初診の記載（A01）**を AI を使わずに組み立てる（その日より後に記録したことは入らない）。保存の期間は60日のまま（長く空いたら再診から始め直す）。Casebook へは送れない（外来の受診には受診日の暦日が要るため）。外来再診の場面（AI の草案）は未作成 | 入院の記録と同じ保存・識別情報の検査・版の確認の上に載せた。実機での使い心地は未確認 |
| 架空症例の作成 | 「症例」の中の「書籍から架空症例を作る」で、テーマ（病名・症候）・場面・難しさ・学ばせたいこと・落とし穴の有無から、書籍が示す典型的な所見をもとに**新しい架空症例**を作る（導入文・症例の入力用・所見の表・見立て・落とし穴・教訓。診断は「見立て」にだけ書かれ、最初は畳まれる）。書籍の症例文を写していないかを機械で検査（30字以上の一致を警告し、Modules 用の下書きのコピーを止める）。作った症例は「症例モードに入れる」で、自分のアセスメントと草案の見比べに使える。clinical-modules の訓練症例（`drills/*.toml`）の下書きも出す（`[case.answers]` は作らない）。依頼に日数（3〜14日）を付けると、**入院後の日ごとの経過**（できごと・症状・所見と検査〔数値は例示〕・治療と処置〔用量は書かない〕。書籍の典型的な経過に沿う架空の経過）も作り、画面は**1日ずつ**見せる（日ごとの記載の練習。本物の API での確認はまだない） | 書籍を参考にした訓練用の架空症例を作るため。医師の決定（`docs/clinical-use.md` の 1d の④）。数値は例示で、閾値・用量は書かせない |
| 数値の突き合わせ・薄い表示 | 回答中の数値を、検索結果の本文と機械で突き合わせ（引用の中／検索結果の中／どこにもない）、書籍の引用がない文を薄く表示する | 用量の誤りを、モデルの自己申告の印だけに頼らず見つけるため。判定ではなく注意 |
| 失敗時の振る舞い | 回答の生成が失敗しても、見つかった節（なければ質問の内容語で検索し直した節）を出す。途中までの回答は残す | 回答が出ないときも、書籍を引ける状態を保つため |

## ディレクトリ

```
ingest/      Markdown → 検証 → SQLite（Python 3.11+、PyYAML のみ）
  parse.py, validate.py, build_db.py, tokenize.py, export_sql.py, cli.py
  ocr_convert.py   EbookText Studio の自動 OCR（全文.md）→ 章形式への変換
schema.sql   テーブルと FTS5 定義
worker/      Cloudflare Worker（TypeScript）と Node 製テスト
  src/       handler / anthropic(ツールループ) / search / format / prompt(システムプロンプト) / db / tokenize
  test/      node:test（449件）、devserver.ts（偽 Anthropic でのローカル画面確認用）
web/         PWA（ビルド不要、外部ライブラリ無し）
eval/        評価（run_eval.ts 検索・run_ask_eval.ts 回答・lib.ts、clinical.template.jsonl、smoke 22問）。手順は docs/evaluation.md
scripts/     prepare_pages.py（PDF → 頁 WebP）、import_ebooktextstudio.py（OCR 本の一括取り込み）、sample_numeric.py（数値の転写誤り率の作業表と集計）
tests/       Python テスト、合成フィクスチャ、ブラウザ確認 (e2e/ui_smoke.py)
docs/        FORMAT.md（転写の書式）、clinical-use.md（実臨床の参考利用の範囲）、enhancement-plan.md（強化案と設計）、evaluation.md（測定と評価の手順）、book-update.md（書籍の再出力・更新を取り込む手順）
```

## セットアップ

前提: Node 22 以上、Python 3.11 以上、Cloudflare アカウント（Workers / D1 / 任意で R2）、Anthropic API キー。

### 1. 書籍を取り込む（手元で）

```bash
python3 -m ingest validate rk4 chapters/ch01.md chapters/ch02.md          # 検証だけ。error があれば直す
python3 -m ingest build --db library.sqlite rk4 chapters/*.md             # 章単位で冪等に追加
python3 -m ingest conversion-log --db library.sqlite rk4 log.jsonl        # 変換ログ（照合の状況）を警告として載せる（任意。docs/FORMAT.md の 7）
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

書籍の再出力・更新を取り込むときの順序（`book_id` の固定、取り込み前の控え、予行演習の出力の読み方、取り込み後の確認、評価セットへの影響、やり直し）は `docs/book-update.md`。

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

`/api/ask` の1日の上限は `wrangler.jsonc` の `DAILY_ASK_LIMIT`（日本時間で数える。仮の値 100、`"0"` で上限なし）。回数は D1 の `usage_daily`（日付と整数だけ）に Worker が自分で作って数えます。同じ表に、回答の様子を日ごとに数える4つの整数（書籍を検索せずに回答／検索して1節も見つからない／書籍の引用がない／書籍に見つからない数値がある）も入ります（質問・回答の文字は入れません）。

**Cloudflare Access の JWT の検証（任意）**: Access で守るなら、`ACCESS_TEAM_DOMAIN`（`<チーム名>.cloudflareaccess.com`）と `ACCESS_AUD`（アプリの Audience tag）を**両方**設定します（`wrangler secret put` か `vars`。値は Cloudflare の画面にあります）。設定すると、`/api/health` と `/api/search` 以外の `/api/` が、アプリのトークンに加えて Access の JWT を要求します（`/api/search` は、サービスバインディングで呼ぶ clinical-modules のため、アプリのトークンだけです）。片方だけの設定は、全部 500 で断ります。評価の道具（`eval/`）を Access の背後の Worker に向けるときは、Access のサービストークンを `CF_ACCESS_CLIENT_ID`・`CF_ACCESS_CLIENT_SECRET` の環境変数で渡します。設定しなければ、今までどおりアプリのトークンだけです。`/api/extract`（文章からの取り込み）も、同じ数に数えます。取り込みだけ別のモデルにしたいときは、`wrangler.jsonc` に `EXTRACT_MODEL` を足します（未設定なら `MODEL`）。

表示された URL を iPhone / iPad の Safari で開き、共有 → 「ホーム画面に追加」。初回に設定画面でアクセストークンを入力します
（この端末のブラウザにだけ保存）。会話は、1往復ごとにサーバー（D1）に保存され、ヘッダーの「会話」から開き直せます（最後のやりとりから 30 日で自動的に消えます。識別情報の確認を通した質問は保存されません。`docs/clinical-use.md` の 1d）。URL は推測されにくいものにし、可能なら Cloudflare Access を前段に置いてください。

### 4. 原本の頁画像（任意）

```bash
npx wrangler r2 bucket create medbook-pages            # wrangler.jsonc の r2_buckets のコメントを外す
python3 scripts/prepare_pages.py --book rk4 --pdf book.pdf --offset -12 --out pages_out --emit-upload-script upload.sh
cd worker && sh ../upload.sh
```

`--offset` は「PDF の連番 → 本に印刷された頁」の差です。転写の `出典ページ: p.N` と同じ番号で保存します。

### 5. ローカル確認

```bash
cd worker && node --test test/*.test.ts            # TS テスト（449件）
python3 -m unittest discover -s tests -p 'test_ingest.py'
npx tsc --noEmit
# 画面確認（偽の Anthropic で動く。課金なし）
node --no-warnings worker/test/devserver.ts library.sqlite 8787 &
python3 tests/e2e/ui_smoke.py http://localhost:8787 /tmp/ui     # 要 playwright + Chromium（5 は rk4 の章が前提）
python3 tests/e2e/ui_clinical.py http://localhost:8787 /tmp/uc  # 帯・入力ガード・縮退（合成の書籍で動く）
python3 tests/e2e/ui_tools.py http://localhost:8787 /tmp/ut     # 測定・評価の画面（iPad 幅）
python3 tests/e2e/ui_conv.py http://localhost:8787 /tmp/uv      # 会話の保存・復元・削除、数値の突き合わせ、薄い表示
python3 tests/e2e/ui_case.py http://localhost:8787 /tmp/ucase   # 症例モード（固定・4つの依頼・識別情報・保存と復元）
python3 tests/e2e/ui_note.py http://localhost:8787 /tmp/unote   # カルテ記載の下書き（採用・型・コピー・何も送らない）
python3 tests/e2e/ui_create.py http://localhost:8787 /tmp/ucreate # 架空症例の作成（警告・症例モードへ・Modules 用の下書き）
python3 tests/e2e/ui_intake.py http://localhost:8787 /tmp/uintake # 場面・症候の質問での入力（中核の未入力・日付の相対化・保存と復元）
python3 tests/e2e/ui_extract.py http://localhost:8787 /tmp/uextract # 文章からの取り込み（提案は確認まで入らない・まとめて/1件ずつ・上書きしない・識別情報は送らない・保存しない）
python3 tests/e2e/ui_casebook.py http://localhost:8787 /tmp/ucasebook # Casebook へ送る（折りたたみ・項目・実/架空の選び・パケットの読み戻し・印は取り込んだとき・送信後に直した項目）
python3 tests/e2e/ui_record.py http://localhost:8787 /tmp/urecord # 症例の記録（時間軸・引き継ぎ・問題の板・A05・経過・A06〜A08・自動保存・版の競合・終える）
python3 tests/e2e/ui_scene.py http://localhost:8787 /tmp/uscene   # 場面別の草案・記録の要約・問題ごとの書籍の根拠（要約は送る前に見える・会話に残らない・頁は先生が残す）
python3 tests/e2e/ui_outpatient.py http://localhost:8787 /tmp/uoutpatient # 外来の記録（初診／再診から・前回の方針を貼る・基準日からの日数・再診の記載 A02・Casebook には出ない）
python3 tests/e2e/ui_sim.py http://localhost:8787 /tmp/usim         # 架空症例の模擬（試験用の設定・聞く／行為／待つ／段・受け皿は入れるまで入らない・A04・振り返りは並べるだけ・何も送らず保存しない）
# 記載の型と、その欄への振り分け表 ROUTES を取り込み直す（clinical-modules のチェックアウトから。--check で差があれば終了コード1）
python3 scripts/import_note_types.py --modules ../clinical-modules
# 場面・症候の質問の構造と、各質問のカテゴリ cat を取り込み直す（同上。規則・鑑別は取り込まない）
python3 scripts/import_flow_schema.py --modules ../clinical-modules
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
- 評価: `eval/clinical.template.jsonl` を `eval/clinical.local.jsonl` にコピーして自分の質問を 30〜50 問書き、`node --no-warnings eval/run_eval.ts --api https://<worker> eval/clinical.local.jsonl --compare-dict` で hit@k と辞書の効果を測ってください（無料。回答まで見るのは `eval/run_ask_eval.ts`）。数値の転写誤り率は `scripts/sample_numeric.py`。**iPad だけで行うときは、ヘッダーの ☑「測定・評価」**（数値の照合と評価セット。PC も Python も要らない）。手順は `docs/evaluation.md`。

## 検証状況（正直な一覧）

**確認したこと**
- 実際の1章（67頁・約9.9万字・254チャンク）の取り込み: 頁帰属（頁なし0件）、節と著者の対応（13/13）、参照文献 82 件（PMID 40）、図・表・転写者補助の分離。
- Python 94 件・TypeScript 449 件のテスト、型チェック（2026-10-26 に手元で再実行）。`wrangler deploy --dry-run`（設定とバンドル）は 2026-10-24 時点。
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
- 変換ログ（章ごとの照合状況）の取り込みは実装済み（`python3 -m ingest conversion-log`。`issues` に `source='conversion-log'`）。ただし**実物の変換ログの形式は見ていない**ので、読む形は `docs/FORMAT.md` の 7 の JSON lines に決めてあり、作る側の出力からの変換が別に要ります。
- 取り込み時に API を使う改善案: 文脈付き索引（Haiku 5.5 でチャンクごとの要約）、頁画像と本文の突き合わせによる誤転写の検出（Batch API で半額）。

## 安全・プライバシー・著作権

- **実臨床の参考利用に使います**（2026-10-24 の医師の決定。参考にする程度で、最終判断は医師本人。`docs/clinical-use.md`）。入れてよい質問は、年齢（歳の整数）・主要所見・検査値の数値まで。**氏名・ID は入れません**。診療録そのものは入れないでください。施設プロトコルはこのアプリに入れていません（別途確認してください）。
- API 経由のデータは既定では学習に使われませんが、保持・ログの扱いはご自身の施設規程と Anthropic の最新の規約で確認してください。
- 強化案と第1段の設計は `docs/enhancement-plan.md`。
- 書籍テキストと頁画像は著作物です。D1 / R2 は自分専用の非公開リソースにし、リポジトリには含めないでください（`.gitignore` 済み）。
- 回答は検討の材料です。診療判断・用量決定は、原本・添付文書・施設プロトコルで確認してください。
