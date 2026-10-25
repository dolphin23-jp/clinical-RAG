import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { ACCESS_HEADER, accessConfigProblem, createAccessVerifier } from "../src/access.ts";
import type { Db } from "../src/db.ts";
import { handle, type AppDeps } from "../src/handler.ts";
import { buildFixtureDb, openDb } from "./nodeDb.ts";

const TEAM = "doctor.cloudflareaccess.com";
const AUD = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TOKEN = "test-token-0123456789abcdef";
const NOW = new Date("2026-10-25T03:00:00Z");
const sec = Math.floor(NOW.getTime() / 1000);

let db: Db;
before(() => {
  db = openDb(buildFixtureDb());
});

const b64 = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b);
  return Buffer.from(bytes).toString("base64url");
};

async function keyPair(kid: string) {
  const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid, alg: "RS256", use: "sig" };
  return { priv: kp.privateKey, jwk };
}

type Claims = Record<string, unknown>;
const goodClaims = (): Claims => ({ aud: [AUD], iss: `https://${TEAM}`, exp: sec + 600, iat: sec - 10, email: "doctor@example.com", sub: "x" });

async function sign(priv: CryptoKey, kid: string, claims: Claims, header: Claims = {}) {
  const h = b64(JSON.stringify({ alg: "RS256", kid, typ: "JWT", ...header }));
  const p = b64(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64(sig)}`;
}

/** A fake of https://<team>/cdn-cgi/access/certs that counts how often it is asked. */
function certs(keys: () => unknown[], opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: any) => {
    calls.push(String(url));
    if (opts.fail) return new Response("no", { status: 503 });
    return new Response(JSON.stringify({ keys: keys() }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const reqWith = (token?: string) => new Request("http://x/api/books", token ? { headers: { [ACCESS_HEADER]: token } } : {});

test("a token Access signed for this application is accepted; the keys are fetched once and only from the team's own address", async () => {
  const k = await keyPair("k1");
  const c = certs(() => [k.jwk]);
  const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: c.fetchImpl, now: () => NOW });
  const t = await sign(k.priv, "k1", goodClaims());
  assert.equal(await v.check(reqWith(t)), null);
  assert.equal(await v.check(reqWith(t)), null);
  assert.deepEqual(c.calls, [`https://${TEAM}/cdn-cgi/access/certs`]);
  // the audience may be a list with other applications' tags too, and the tag's case does not matter
  assert.equal(await v.check(reqWith(await sign(k.priv, "k1", { ...goodClaims(), aud: ["other", AUD.toUpperCase()] }))), null);
});

test("what is refused, and why (a code, never the token)", async () => {
  const k = await keyPair("k1");
  const other = await keyPair("k1"); // the same kid, a different key: a forged token
  const c = certs(() => [k.jwk]);
  const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: c.fetchImpl, now: () => NOW });
  const why = async (t?: string) => v.check(reqWith(t));
  assert.equal(await why(undefined), "missing");
  assert.equal(await why("not a token"), "malformed");
  assert.equal(await why("a.b.c"), "malformed");
  assert.equal(await why(await sign(k.priv, "k1", { ...goodClaims(), exp: sec - 3600 })), "expired");
  assert.equal(await why(await sign(k.priv, "k1", { ...goodClaims(), exp: undefined })), "expired");
  assert.equal(await why(await sign(k.priv, "k1", { ...goodClaims(), nbf: sec + 3600 })), "not_yet");
  assert.equal(await why(await sign(k.priv, "k1", { ...goodClaims(), aud: ["another-application-tag"] })), "audience");
  assert.equal(await why(await sign(k.priv, "k1", { ...goodClaims(), aud: undefined })), "audience");
  assert.equal(await why(await sign(k.priv, "k1", { ...goodClaims(), iss: "https://evil.cloudflareaccess.com" })), "issuer");
  assert.equal(await why(await sign(other.priv, "k1", goodClaims())), "signature");
  assert.equal(await why(await sign(k.priv, "k1", goodClaims(), { alg: "none" })), "alg");
  assert.equal(await why(await sign(k.priv, "k1", goodClaims(), { alg: "HS256" })), "alg");
  // a token whose body was changed after signing
  const [h, , s] = (await sign(k.priv, "k1", goodClaims())).split(".");
  assert.equal(await why(`${h}.${b64(JSON.stringify({ ...goodClaims(), exp: sec + 99999 }))}.${s}`), "signature");
});

test("a minute of clock skew is allowed, not more", async () => {
  const k = await keyPair("k1");
  const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: certs(() => [k.jwk]).fetchImpl, now: () => NOW });
  assert.equal(await v.check(reqWith(await sign(k.priv, "k1", { ...goodClaims(), exp: sec - 30 }))), null);
  assert.equal(await v.check(reqWith(await sign(k.priv, "k1", { ...goodClaims(), exp: sec - 90 }))), "expired");
});

test("an unknown key id fetches the keys again (Cloudflare rotated them), but not more than once a minute", async () => {
  const k1 = await keyPair("k1");
  const k2 = await keyPair("k2");
  let live = [k1.jwk];
  let t = NOW.getTime();
  const c = certs(() => live);
  const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: c.fetchImpl, now: () => new Date(t) });
  assert.equal(await v.check(reqWith(await sign(k1.priv, "k1", goodClaims()))), null);
  assert.equal(c.calls.length, 1);
  live = [k1.jwk, k2.jwk];
  const t2 = await sign(k2.priv, "k2", goodClaims());
  assert.equal(await v.check(reqWith(t2)), "kid"); // too soon after the last fetch: no new fetch
  assert.equal(c.calls.length, 1);
  t += 61_000;
  assert.equal(await v.check(reqWith(t2)), null);
  assert.equal(c.calls.length, 2);
  // a flood of tokens with a made-up key id does not become a flood of fetches
  const bad = await sign(k1.priv, "nope", goodClaims());
  assert.equal(await v.check(reqWith(bad)), "kid");
  assert.equal(await v.check(reqWith(bad)), "kid");
  assert.ok(c.calls.length <= 3, String(c.calls.length));
});

test("keys that cannot be fetched fail closed (nothing is let through)", async () => {
  const k = await keyPair("k1");
  const down = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: certs(() => [k.jwk], { fail: true }).fetchImpl, now: () => NOW });
  assert.equal(await down.check(reqWith(await sign(k.priv, "k1", goodClaims()))), "keys");
  const broken = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: (async () => { throw new Error("network"); }) as typeof fetch, now: () => NOW });
  assert.equal(await broken.check(reqWith(await sign(k.priv, "k1", goodClaims()))), "keys");
  const junk = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: (async () => new Response("<html>")) as typeof fetch, now: () => NOW });
  assert.equal(await junk.check(reqWith(await sign(k.priv, "k1", goodClaims()))), "keys");
});

test("the settings: both or neither; the team domain is Cloudflare's; the audience is a hex tag", () => {
  assert.equal(accessConfigProblem(undefined, undefined), null);
  assert.equal(accessConfigProblem("", "  "), null);
  assert.equal(accessConfigProblem(TEAM, AUD), null);
  assert.match(accessConfigProblem(TEAM, "") ?? "", /must be set together/);
  assert.match(accessConfigProblem("", AUD) ?? "", /must be set together/);
  for (const bad of ["evil.example.com", "https://doctor.cloudflareaccess.com", "doctor.cloudflareaccess.com/x", "a.b.cloudflareaccess.com", "doctor.cloudflareaccess.com.evil.com"]) {
    assert.match(accessConfigProblem(bad, AUD) ?? "", /<team>\.cloudflareaccess\.com/, bad);
  }
  assert.match(accessConfigProblem(TEAM, "not hex") ?? "", /Audience tag/);
  assert.throws(() => createAccessVerifier({ teamDomain: "evil.example.com", aud: AUD }));
});

// ---------------------------------------------------------------- at the API door
const app = (extra: Partial<AppDeps> = {}): AppDeps => ({ db, apiKey: "k", appToken: TOKEN, model: "m", now: () => NOW, ...extra });
const authed = (init: RequestInit = {}, access?: string): RequestInit => ({ ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(access ? { [ACCESS_HEADER]: access } : {}), ...(init.headers as Record<string, string> | undefined) } });

test("API: with Access configured, every /api/ path except /api/health and /api/search needs both the app token and a valid Access token", async () => {
  const k = await keyPair("k1");
  const access = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: certs(() => [k.jwk]).fetchImpl, now: () => NOW });
  const good = await sign(k.priv, "k1", goodClaims());
  const url = (p: string) => `http://x${p}`;
  for (const path of ["/api/books", "/api/conversations", "/api/records", "/api/eval/questions", "/api/numeric/sample"]) {
    const none = await handle(new Request(url(path), authed()), app({ access }));
    assert.equal(none.status, 401, path);
    assert.deepEqual(await none.json(), { error: "unauthorized", code: "access", reason: "missing" });
    const bad = await handle(new Request(url(path), authed({}, "x.y.z")), app({ access }));
    assert.equal(bad.status, 401, path);
    // the app token alone is not enough, and the Access token alone is not enough
    const onlyAccess = await handle(new Request(url(path), { headers: { [ACCESS_HEADER]: good } }), app({ access }));
    assert.equal(onlyAccess.status, 401, path);
    assert.deepEqual(await onlyAccess.json(), { error: "unauthorized" });
  }
  const ok = await handle(new Request(url("/api/books"), authed({}, good)), app({ access }));
  assert.equal(ok.status, 200);
  // the writes and the model calls are behind the same lock
  for (const [path, method] of [["/api/ask", "POST"], ["/api/extract", "POST"], ["/api/records", "POST"], ["/api/conversations", "POST"]] as const) {
    const r = await handle(new Request(url(path), authed({ method, body: "{}" })), app({ access }));
    assert.equal(r.status, 401, path);
  }
});

test("API: /api/health and /api/search do not need the Access token (clinical-modules reaches /api/search through a service binding); /api/search still needs the app token", async () => {
  const k = await keyPair("k1");
  const access = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl: certs(() => [k.jwk]).fetchImpl, now: () => NOW });
  assert.equal((await handle(new Request("http://x/api/health"), app({ access }))).status, 200);
  const search = await handle(new Request("http://x/api/search", authed({ method: "POST", body: JSON.stringify({ queries: ["ゼルニア値"] }) })), app({ access }));
  assert.equal(search.status, 200);
  const noToken = await handle(new Request("http://x/api/search", { method: "POST", body: JSON.stringify({ queries: ["x"] }) }), app({ access }));
  assert.equal(noToken.status, 401);
});

test("API: without Access settings nothing changes (the app token only); half-set settings refuse every call instead of running unlocked", async () => {
  const plain = await handle(new Request("http://x/api/books", authed()), app());
  assert.equal(plain.status, 200);
  const half = await handle(new Request("http://x/api/books", authed()), app({ accessProblem: accessConfigProblem(TEAM, "") ?? "" }));
  assert.equal(half.status, 500);
  assert.match(((await half.json()) as any).error, /must be set together/);
  // the health check still answers (a deploy check should not need a secret)
  assert.equal((await handle(new Request("http://x/api/health"), app({ accessProblem: "x" }))).status, 200);
});

test("the Access check keeps nothing and says nothing: no storage, no logging, no token in an answer", () => {
  const src = readFileSync(new URL("../src/access.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(src, /console\.|\.prepare\(|INSERT|UPDATE|localStorage|caches\.|KVNamespace|\.put\(/);
});
