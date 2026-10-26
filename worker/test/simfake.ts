// A fake of the Anthropic API for the simulation's calls (/api/sim), shared by the dev server (devserver.ts) and the tests (simapi.test.ts).
// Not deployed.

/**
 * A fake of the simulation's calls (/api/sim; the schema names `assumed` / `event_text` / only `facts`).  It reads the flow's question list from
 * the system text and answers with plain values: the first option, a fixed number, a short test sentence.  A theme with __copy__ copies a book
 * sentence into the opening, __leak__ puts the assumed diagnosis in the opening on the first try (the screen's check refuses it and asks once
 * more with <repair>), and __apierror__ fails.  The next segment depends on whether fluids were recorded, so a branch can be seen.
 */
export function fakeSim(body: any): Response {
  const props = body.output_config.format.schema.properties;
  const sys: string = body.system[0].text;
  const user: string = body.messages[0].content;
  const qs = sys
    .split("\n")
    .filter((l: string) => l.startsWith("{\"id\""))
    .map((l: string) => JSON.parse(l));
  const val = (q: any): string[] =>
    q.type === "number" ? [q.id === "rr" ? "30" : q.id === "spo2" ? "92" : q.id === "lactate" ? "4.2" : "50"] : q.type === "text" ? ["試験用の文"] : q.options?.length ? [q.options[0][0]] : ["試験用"];
  const who = (q: any) => (q.type === "number" ? ["看護師", "測定"] : ["患者", "問診"]);
  const fact = (q: any, v = val(q)) => ({ q: q.id, v, who: who(q)[0], how: who(q)[1] });
  const sources: string[] = [...user.matchAll(/^\[([^\]]+)\] /gm)].map((m) => m[1]);
  let out: any;
  // the next acts as an example: an item and an order of the flow when it has them
  const has = (id: string) => qs.some((q: any) => q.id === id);
  const suggest = [
    ...(has("limbs") ? [{ act: "ask", target: "limbs", why: "末梢の冷感から循環の状態を確かめる" }] : []),
    ...(has("tests") ? [{ act: "do", target: "tests=vbg", why: "乳酸と酸塩基を確かめる" }] : []),
    ...(has("first") ? [{ act: "ask", target: "first", why: "読みの質問は挙げない（画面が捨てる）" }] : []),
  ];
  if (props.S) {
    // the S/O/A/P draft: one number that is not in what the doctor was told (9.9), so the screen's mark can be seen
    out = {
      S: ["救急隊: 試験用の報告（呼吸が速い）"],
      O: ["呼吸数 30 回/分", "乳酸 9.9 mmol/L"],
      A: [{ problem: "#1 試験の問題", assessment: "試験の評価の文 [推論]" }],
      P: [
        { kind: "Dx", text: "血液ガスの再検（予定・検討）" },
        { kind: "Tx", text: "試験の処置（予定・検討）" },
        { kind: "Ex", text: "家族へ経過を説明（予定・検討）" },
      ],
      disposition: "未決定（試験の行き先）",
    };
  } else if (props.suggest && !props.assumed && !props.event_text) {
    out = { suggest };
  } else if (props.assumed) {
    const leak = /__leak__/.test(user) && !/<repair>/.test(user);
    const copy = /__copy__/.test(user) ? (/\] [^\n]*\n([^\n]{40,})/.exec(user)?.[1].slice(0, 45) ?? "") : "";
    const facts = qs.filter((q: any) => q.kind === "fact" && !q.afterAct).map((q: any) => fact(q));
    const tests = qs.find((q: any) => q.id === "tests");
    const orders = tests && qs.some((q: any) => q.id === "lactate") ? [{ order: "tests=vbg", results: ["vbg_res", "lactate"] }] : [];
    out = {
      patient: { age: 68, sex: "男性" },
      clock_start: "02:10",
      opening: [{ who: "救急隊", text: `試験用の導入文です。${leak ? "試験用の想定診断の疑い。" : ""}${copy}` }],
      facts,
      orders,
      assumed: { dx: ["試験用の想定診断"], ddx: ["試験用の鑑別"], key: facts.slice(0, 1).map((f: any) => f.q), pitfall: "試験用の落とし穴。", lesson: "試験用の教訓。" },
      used: sources.slice(0, 2),
      suggest,
    };
  } else if (props.event_text) {
    const fluids = /細胞外液の負荷[^\n]*：/.test(user);
    const rr = qs.find((q: any) => q.id === "rr");
    out = {
      facts: rr ? [fact(rr, [fluids ? "22" : "34"])] : [],
      event_who: "看護師",
      event_text: fluids ? "試験用の出来事: 呼吸が落ち着いてきました。" : "試験用の出来事: 呼びかけへの反応が鈍くなりました。",
      basis: sources.slice(0, 1),
      suggest,
    };
  } else {
    const want: string[] = props.facts.items.properties.q.enum;
    out = { facts: qs.filter((q: any) => want.includes(q.id)).map((q: any) => fact(q)) };
  }
  return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", usage: { input_tokens: 9000, output_tokens: 900, cache_read_input_tokens: 8000 } }), { headers: { "content-type": "application/json" } });
}

/** A fetch that answers the simulation's calls with fakeSim (and fails on anything else). */
export const simFetch = (async (_url: unknown, init: any) => {
  const body = JSON.parse(init.body);
  if (/__apierror__/.test(body.messages?.[0]?.content ?? "")) return new Response(JSON.stringify({ error: { type: "overloaded_error", message: "overloaded (fake)" } }), { status: 529 });
  return fakeSim(body);
}) as typeof fetch;
