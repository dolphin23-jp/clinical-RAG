# 書籍の再出力・更新を D1 に取り込む手順

状態: **作成者（AI）の案。2026-10-24**。最初の使い道は、clinical-modules の台帳 S001（『救急外来 ただいま診断中！ 第2版』）の再出力の取り込み。どの本にも使える。

**実際に走らせたのは**、合成の試験用フォルダ（`tests/fixtures/ocr_book`）での予行演習と、`books.json` で `book_id` を固定する動作だけ。本物の再出力・本番の D1・`wrangler` は、この手順では**まだ試していない**（再出力のフォルダは医師の PC にあり、Cloudflare へのログインも医師の手元で要る）。

clinical-modules 側（台帳・試験・ビルド・接続）は、clinical-modules の `docs/s001-reflect.md`。全体の順序もそちらにある。この文書は、RAG（D1）の側だけを書く。

## 0. 前提と守ること

- Node 22 以上、Python 3.11 以上、`pip install pyyaml`、`cd worker && npm ci`、`npx wrangler login`（取り込みのスクリプトが、ログインしていなければブラウザを開く）
- 出力はすべて `work/`（`.gitignore` 済み）。**書籍の本文・頁画像・作業ファイルをリポジトリに入れない**。結果を残すときは数字だけを書く（本文や質問の文は書かない。`docs/evaluation.md` の 4）
- アクセストークンは環境変数 `MEDBOOK_TOKEN` に入れる（コマンドの引数に書かない）
  - PowerShell: `$env:MEDBOOK_TOKEN="（トークン）"`
  - mac / Linux: `export MEDBOOK_TOKEN=（トークン）`
- 渡し先は本人だけ（出典台帳の「私的利用のみ」）。取り込みの手順は、他の人に書籍を渡す道を作らない

## 1. 準備（取り込みの前）

### 1.1 再出力のフォルダを確かめる

`<BASE>\<フォルダ名>\output\全文.md` がある（BASE は EbookText Studio の出力先。例: `C:\Users\<you>\Documents\EbookTextStudio`）。

現行の出力の目印は、`<!-- p.N ここまで -->` と `<!-- 改ページ -->`。古い版の出力（この印が無い）は、取り込みスクリプトが `SKIP`（再出力を促す）で止める。PowerShell で数を見る例:

```powershell
(Select-String -Path "<BASE>\<フォルダ名>\output\全文.md" -Pattern 'ここまで').Count
```

0 なら古い形式（`SKIP` になる）。

### 1.2 `book_id` を決める（固定をおすすめする）

`book_id` の既定は、**フォルダ名のハッシュ**（`b-` ＋ 8 文字）。同じフォルダ名なら同じ id になり、再取り込みは同じ本を置き換える。しかし、**フォルダ名を変えると別の id になる**ので、古い本が D1 に残って二重になり、clinical-modules の台帳に書く値も変わる。

固定するには、`<BASE>\books.json` に書く（書かれたフォルダだけが対象。ほかの本の id は変わらない）:

```json
{ "<フォルダ名>": { "id": "s001", "title": "救急外来 ただいま診断中！ 第2版" } }
```

- `id`: 英数字と `. _ -` の 1〜40 字（API の頁の入口と clinical-modules の台帳の検査と同じ形）。clinical-modules の台帳 ID（`S001`）と揃えると読みやすい
- `title`: 検索結果と回答の引用に出る書名
- 固定するかどうかは医師が決める（案: 固定する）

### 1.3 いまの D1 の状態を控える

本番の索引に、同じ本がすでに別の id で入っていないかを見る。入っていると、二重になる。

- アプリ（iPad）: 書籍の一覧に出る書名・チャンク数を控える
- または PowerShell（`<worker>` は RAG の Worker の URL）:

```powershell
Invoke-RestMethod -Uri "https://<worker>/api/books" -Headers @{ Authorization = "Bearer $env:MEDBOOK_TOKEN" } | ConvertTo-Json -Depth 5
```

- 控えるもの: 各書籍の `book_id`・`chapters`・`chunks`・`open_issues`（**数字だけ**）。取り込みの後に「ほかの本が変わっていない」を確かめる材料になる
- 同じ本が別の id で入っていたときは、ここで止めて医師に確認する（置き換えるのか、消すのか。D1 の削除は戻せない）

### 1.4 取り込む前の評価を一度走らせて控える（評価セットがあるとき）

本が増えると、ほかの本の検索の順位も変わりうる（1 つの本から出す節の数に上限があり、競合が増える）。評価セット（`eval/clinical.local.jsonl` または iPad の「測定・評価」）があるなら、**取り込みの前に**検索の評価（無料。LLM を呼ばない）を走らせて、数字を控える:

```bash
node --no-warnings eval/run_eval.ts --api https://<worker> eval/clinical.local.jsonl --compare-dict
```

## 2. 予行演習（送らない）

`--push` を付けない。変換・検証・SQL の生成だけをして、D1 には何も送らない。

```powershell
python scripts/import_ebooktextstudio.py "<BASE>" --only "<フォルダ名>"
```

- `--only` に本のフォルダ名を指定すると、その本だけを扱う（指定しないと、BASE の全部が対象）
- 結果は `work/` に出る（`work/<book_id>/chapter.md`、`work/library.sqlite`、`work/d1/*.sql`）

### 2.1 出力の読み方

| 出力 | 意味 | 対応 |
|---|---|---|
| `OK  <フォルダ名>  id=...  chunks=N  pages=a-b  page markers kept x/y` | 変換・検証を通った。`chunks` は索引の単位の数。`pages` は頁の範囲。`kept x/y` は、頁の終わりの印のうち、周りと辻褄が合うとして信用した数（残りは OCR の読み違いとして捨てた） | `id` が 1.2 で決めたものか確かめる。数字（chunks・pages・x/y）を控える |
| `(N page gap(s) only known to a range)` | 頁を 1 頁に決められず、`p.10-12` のような幅で出す区間の数 | 件数を控える。多いほど、引用の頁が幅つきになる |
| `SKIP  ...  (older EbookText Studio export...)` | 古い形式の出力 | 再出力する |
| `SKIP  ...  N validation error(s)` | 検証で error | `python -m ingest validate <book_id> work/<book_id>/chapter.md` で内容を見る |
| `nothing to import` | 取り込めるものがなかった | フォルダ名・`output/全文.md` の有無を確かめる |

- 頁の決め方は保守的（誤った頁を出さないため）。`README.md` の 1b を参照
- **どの数字なら取り込んでよいかは、作成者は決めない**。参考: 手元の 4 冊は、4 冊中 3 冊で全区間が件数一致、残る 1 冊は 1 区間だけ ±1 の幅つきだった（`README.md` の「検証状況」）

### 2.2 書き込みの量を見る

D1 の書き込み行数の上限（無料枠で 1 日 10 万行）に収まるかは、**未確認**（`README.md`）。目安を見る:

```powershell
(Select-String -Path "work\d1\*.sql" -Pattern '^INSERT').Count
```

- 全文検索の索引（`999_fts.sql`）は `INSERT ... SELECT` で作るので、上の数に入らない。索引の行は、チャンクごとに 2 本（`chunks_tri`・`chunks_bi`）。実際の書き込みはこれより多い可能性がある（索引の内部の行。`[未確認]`）
- 上限を超えて途中で止まったら、翌日に同じコマンドをもう一度走らせる（3 の再実行は安全）

## 3. 送信

予行演習の結果に問題がなければ、同じコマンドに `--push` を足す。

```powershell
python scripts/import_ebooktextstudio.py "<BASE>" --only "<フォルダ名>" --push
```

- 本ごとに置き換える（その本の行を消してから入れ直す）。ほかの本は消えない
- **送信の最中は、その本の検索が途中の状態になりうる**（消してから入れるまでが複数のファイルに分かれる）。アプリや clinical-modules の草案を使っていない時間に行う
- 途中で失敗したら、同じコマンドをもう一度走らせる（置き換えなので安全）。失敗したファイル名が出る
- 初回は `wrangler login` のブラウザが開く。『Allow』を押す

## 4. 確認（RAG の側）

### 4.1 書籍の一覧

1.3 と同じ方法で `/api/books` を見る。

- 取り込んだ本の `book_id` が 1.2 のとおりか。`chunks` が予行演習の `chunks` と同じか
- `open_issues`（検証の警告・error の件数）を控える
- **ほかの本の `chunks` が 1.3 から変わっていないか**
- この `book_id` を、clinical-modules の台帳「RAG book_id」に書く（`docs/s001-reflect.md`）

### 4.2 検索（LLM を呼ばない。無料）

アプリの「測定・評価」の「頁を探す」か、`POST /api/search`。**患者の情報を入れない**（本の見出しや一般的な語で十分）。

```powershell
$h = @{ Authorization = "Bearer $env:MEDBOOK_TOKEN" }
$body = @{ queries = @("（本の見出しなどの語）"); book_ids = @("s001"); parents = 5 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://<worker>/api/search" -Headers $h -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body)) | ConvertTo-Json -Depth 5
```

（PowerShell のコマンドは、ここでは走らせていない。日本語が化けるときは、アプリの「頁を探す」を使う）

見るところ:

- `results[].book_id` が取り込んだ本か
- `results[].page_label` が `p.12` か `p.12-14` の形か。**空だったり形が違うと、clinical-modules は、その結果を捨てる**（頁の行にならない）
- `flags`（OCR・数値の警告）が付いているか
- 0 件にならないか（本に確かにある語で試す）

### 4.3 頁の抜き取り（引用の頁が合っているか）

clinical-modules の台帳は「頁番号は推定。頁画像で確かめるまで `p.` を付けず章名で書く」としている。再出力で頁の根拠は強くなったが、**合っているかは実際に見るまで分からない**。

1. 本のあちこち（章をまたいで、数か所ずつ）から、本に載っている語で検索する
2. 返った `page_label` を、手元の本の**印刷された頁**と見比べる
3. 数字だけ記録する: 一致 ／ ±1〜3 のずれ ／ 大きなずれ。幅つき（`p.10-12`）の結果は、その幅に正しい頁が入っているか
4. 結果は clinical-modules の「`S001 p.N` に切り替えるか」の判断の材料になる（切り替えは医師の判断。`docs/s001-reflect.md` の 2）

頁画像（R2）を入れていれば、アプリの根拠シートの「原本 p.N」で見比べやすい（`README.md` の 4）。

### 4.4 評価セットへの影響

- **「書籍にない」問い（`"negative": true`）を見直す**: 本が増えると、これまで書籍に無かった問いに、答えが出るようになる。そうなった問いは「書籍にない」ではなくなるので、評価の分類を直す（医師が決める）
- 取り込んだ本の正解（gold の頁・必須語）は、**医師が本で確かめて書く**。作成者は臨床の正解を作らない。検索の結果を見る前に書く（`docs/evaluation.md` の 3.1）
- 1.4 で控えた評価を、同じコマンドでもう一度走らせて比べる。ほかの本の hit@k が下がっていないか
- 新しい本で外れた問いは、辞書（`worker/src/synonyms.ts`。医師の確認なしで足してよい。数値は入れない）の候補になる

### 4.5 数値の転写誤り率（任意。T1-7）

本ごとに誤り率が違うなら、誤りの多い本から頁画像で照合する（`docs/evaluation.md` の 2.4）。取り込んだ本だけを抜くには:

```powershell
python scripts/sample_numeric.py sample --d1 medbook --books s001
```

clinical-modules は、S001 の表の数値を「OCR で崩れていて未記入」にしている箇所が多い。再出力で表が読めるようになったかを見る材料にもなる。**測るか、いつ測るかは医師が決める**。

## 5. やり直し・戻し

- **同じ `book_id` で取り込み直す**: 同じコマンドの再実行で、その本が置き換わる
- **`book_id` を変えた**（フォルダ名を変えた・`books.json` を足した）: 古い id の本が D1 に残って二重になる。clinical-modules の台帳の値も直す。古い本を消すかは医師が決める（D1 の削除は戻せない。消す前に `/api/books` で対象の id を確かめる）
- **clinical-modules から外したい**: RAG の本は残したままでよい。clinical-modules の `RAG_TOKEN` を消すか、台帳の列を空にする（`docs/s001-reflect.md` の 7）
- 取り込んだ本の全文は、D1 に置かれた著作物。D1 / R2 は自分専用の非公開のまま。リポジトリには入れない

## 6. 確認していないこと

- 本物の再出力・本番の D1 での取り込み（この手順は、合成の試験用フォルダでの予行演習の出力の形に合わせて書いた）
- D1 の書き込み上限に収まるか（2.2）
- 再出力の頁の確からしさ（4.3 の抜き取りで初めて分かる）
- PowerShell のコマンド（走らせていない。mac / Linux では `curl` と環境変数で同じことができる）
