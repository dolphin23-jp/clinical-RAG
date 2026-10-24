# CLAUDE.md

医学書を根拠頁つきで引く検索・回答アプリ（medbook-rag）。**医師本人の実臨床の参考利用**に使う（2026-10-24 の医師の決定。参考にする程度で、最終判断は医師本人）。経緯と細目は `docs/clinical-use.md`、強化案と設計は `docs/enhancement-plan.md`。変更するときは以下を守る。

## 利用範囲（医師の決定。変えるなら方針の変更として、実装の前に医師に確認する）

- 渡し先は本人だけ。他の人への共有・提供・公開は作らない（出典台帳の「私的利用のみ」）
- 入れてよい質問は、年代・主要所見・検査値の数値まで。**氏名・ID は入れない**。画面にも API にも、そのための約束を残す
- 施設プロトコルは RAG に入れない。回答では「施設プロトコルは別途確認」と促すだけにする。入れる余地は残すが、入れる条件は未決（`docs/clinical-use.md` の 5）。入れる話が出たら、実装の前に医師に確認する
- clinical-modules（別リポジトリ）は訓練のまま。RAG を実臨床の参考にしてよいことは、clinical-modules に実患者の情報を入れてよいことにはならない
- 薬機法上の位置づけの問い合わせ・確認は、求めない・提案しない（2026-10-23 の医師の判断。clinical-modules の `docs/roadmap.md` の決定済み）

## 絶対に入れない（リポジトリに）

- 書籍・頁画像の本文（著作物）。`library/` `books/` `work/` `d1/` `pages_out/` は `.gitignore` 済み
- 質問・回答の本文を保存する処理、質問を出すログ（`docs/clinical-use.md` の 2.4）。書き込みを足すときは、先に医師に確認する（いまある書き込みは、利用上限の日付と回数〈T1-2〉と、評価の質問〈`eval_questions`。医師の決定。`docs/clinical-use.md` の 1c〉だけ。評価の質問は保存の前に `eval/lib.ts` の `parseQuestions` の検査を通す。回答と評価の結果は保存しない）
- API キー・トークン・実際の質問ファイル（評価用の質問は `eval/*.local.jsonl`。`.gitignore` 済み）。数値の作業表と回答の記録も `work/` にだけ置く（`docs/evaluation.md` の 4）
- 施設の内部プロトコル

## 守りの部品（2026-10-24。変えるときは同じ変更でテストを直す）

- 入力のガード: `web/id-guard.js` と `worker/src/idguard.ts` は双子。`tests/vectors/idguard.json` を両方が通ること。氏名と日付は検出しない（医師の決定）
- 常時表示の帯（「参考情報・患者を特定する情報は入れない・最終判断は医師」）は、ヘッダーと全てのダイアログに出す。消すボタンは作らない（`tests/e2e/ui_clinical.py`）
- 利用上限（`worker/src/usage.ts`）の書き込みは、日付と回数だけ。DB の部品（`db.ts`）は読み取りのまま
- 辞書（`worker/src/synonyms.ts`）は、医師の確認なしで語を足してよい（医師の決定）。数値・用量・閾値・商品名は入れない（テストが数値を検査する）
- 回答の生成が失敗したときは、見つかった節を出し、途中までの回答は残す（医師の決定）
- 「測定・評価」の画面（`web/tools.js`）: 数値の作業表の判定は端末の中だけ（`mb.numeric.v1`）。数値の抽出は `scripts/sample_numeric.py` と `worker/src/numsample.ts` が双子（`tests/vectors/numeric_expr.json`）、集計は Python と `web/eval-tools.js` が双子（`tests/vectors/numeric_report.json`）。`tests/e2e/ui_tools.py`

## 数値と出典

- 用量・閾値は創作しない。出典で確認できない数値は、強調して示す（モデルの自己申告だけに頼らず、決定論の突き合わせを足す方向。`docs/enhancement-plan.md` の T1-6）
- 引用の頁は、検索結果のメタ情報から引く。モデルに頁を作らせない
- 転写者の補助記述は、書籍の主張として引用しない
- 日本の添付文書と海外ガイドラインで用量や運用が違う場合は、違いを明示する

## 書き方

- 日本語で書く。振る舞い（回答の型・出典の扱い・姿勢）は `worker/src/prompt.ts` の1か所に集める。変えるときは、変更の前後で評価と数問のライブ確認を医師が見る
- 事実・推論・標準診療・施設依存を分ける（`[確認]` `[推論]` `[未確認]` `[要確認]`）。実測のない数や効果は、断定しない

## 変更の流れ

- 手元で通す: `cd worker && node --test test/*.test.ts` と `npx tsc --noEmit`、`python3 -m unittest discover -s tests -p 'test_*.py'`。画面を変えたときは `tests/e2e/ui_clinical.py` と `tests/e2e/ui_tools.py`（合成の書籍で動く。README の 5）
- CI と Cloudflare のビルドの通知は見ない・対応しない（clinical-modules と同じ運用。2026-10-17 の医師の判断）。代わりに、上のテストを手元で通してからPRにする
- 振る舞いを変える変更は、同じ変更の中にテストを足す。入力のガード、書き込みの一覧、プロンプトの必須の指示は、テストで固定する
