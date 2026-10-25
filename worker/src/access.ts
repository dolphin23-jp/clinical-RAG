// Cloudflare Access JWT check (docs/enhancement-plan.md T1-2).  Access sits in front of the app and adds `Cf-Access-Jwt-Assertion`; this makes the Worker
// itself check it (signature, expiry, issuer, audience), so a request that reaches the Worker some other way (a workers.dev address, a route Access does
// not cover) is refused too.  It is a second lock beside the app token, never a replacement: both must pass.
//
// Nothing is stored and nothing is logged: the public keys are held in memory for a while (a Worker isolate's lifetime), the token is never echoed, and the
// only answer is "ok" or a short reason code.  No dependency: WebCrypto only.
//
// Off unless both ACCESS_TEAM_DOMAIN and ACCESS_AUD are set (then the app behaves as before: the app token only).  Half set = misconfigured, which the
// handler answers with 500 (fail closed), not "off".

/** "<team>.cloudflareaccess.com" — Access team domains are always of this form; anything else is refused so the keys are only ever fetched from Cloudflare. */
const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const SKEW_SECONDS = 60;
/** How long fetched keys are trusted before they are fetched again (Cloudflare rotates them on a schedule of weeks; a new kid triggers an early refetch). */
const KEY_TTL_MS = 60 * 60 * 1000;
/** A token with an unknown key id may refetch the keys, but not more often than this (a flood of bad tokens must not become a flood of fetches). */
const REFETCH_MIN_MS = 60 * 1000;
export const ACCESS_HEADER = "cf-access-jwt-assertion";

export type AccessFailure = "missing" | "malformed" | "alg" | "keys" | "kid" | "signature" | "expired" | "not_yet" | "issuer" | "audience";

export interface AccessVerifier {
  /** null when the request carries a valid Access token; otherwise why not (a code, never the token). */
  check(req: Request): Promise<AccessFailure | null>;
}

export interface AccessConfig {
  teamDomain: string;
  aud: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** The configuration problem, or null: both set and well formed, or both unset (off). */
export function accessConfigProblem(teamDomain?: string, aud?: string): string | null {
  const t = (teamDomain ?? "").trim();
  const a = (aud ?? "").trim();
  if (!t && !a) return null;
  if (!t || !a) return "server misconfigured: ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set together";
  if (!TEAM_DOMAIN.test(t)) return "server misconfigured: ACCESS_TEAM_DOMAIN must look like <team>.cloudflareaccess.com";
  if (!/^[0-9a-f]{32,128}$/i.test(a)) return "server misconfigured: ACCESS_AUD must be the application's Audience tag (hex)";
  return null;
}

const b64urlToBytes = (s: string): Uint8Array => {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const decodeJson = (s: string): any => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

interface KeySet {
  at: number;
  keys: Map<string, CryptoKey>;
}

export function createAccessVerifier(cfg: AccessConfig): AccessVerifier {
  const problem = accessConfigProblem(cfg.teamDomain, cfg.aud);
  if (problem || !cfg.teamDomain || !cfg.aud) throw new Error(problem ?? "ACCESS_TEAM_DOMAIN and ACCESS_AUD are required");
  const issuer = `https://${cfg.teamDomain.trim()}`;
  const aud = cfg.aud.trim().toLowerCase();
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const now = cfg.now ?? (() => new Date());
  let set: KeySet | null = null;
  let lastFetch = 0;
  let inflight: Promise<KeySet | null> | null = null;

  async function load(): Promise<KeySet | null> {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const res = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, { headers: { accept: "application/json" } });
        if (!res.ok) return null;
        const body = (await res.json()) as { keys?: Array<Record<string, unknown>> };
        const keys = new Map<string, CryptoKey>();
        for (const jwk of body.keys ?? []) {
          if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
          try {
            keys.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk as unknown as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
          } catch {
            // a key that cannot be imported is skipped; the token that needs it fails as "kid"
          }
        }
        if (!keys.size) return null;
        set = { at: now().getTime(), keys };
        return set;
      } catch {
        return null;
      } finally {
        lastFetch = now().getTime();
        inflight = null;
      }
    })();
    return inflight;
  }

  async function keyFor(kid: string): Promise<CryptoKey | "keys" | "kid"> {
    const t = now().getTime();
    if (!set || t - set.at > KEY_TTL_MS) {
      const fresh = await load();
      if (!fresh) return "keys";
    }
    let key = set?.keys.get(kid);
    if (!key && now().getTime() - lastFetch >= REFETCH_MIN_MS) {
      // an unknown key id: Cloudflare may have rotated the keys since the last fetch
      await load();
      key = set?.keys.get(kid);
    }
    return key ?? "kid";
  }

  return {
    async check(req) {
      const token = req.headers.get(ACCESS_HEADER);
      if (!token) return "missing";
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) return "malformed";
      let header: any;
      let payload: any;
      try {
        header = decodeJson(parts[0]);
        payload = decodeJson(parts[1]);
      } catch {
        return "malformed";
      }
      if (!header || typeof header !== "object" || !payload || typeof payload !== "object") return "malformed";
      if (header.alg !== "RS256") return "alg"; // never "none", never a symmetric algorithm
      if (typeof header.kid !== "string") return "kid";
      const key = await keyFor(header.kid);
      if (key === "keys" || key === "kid") return key;
      let ok = false;
      try {
        ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
      } catch {
        return "signature";
      }
      if (!ok) return "signature";
      const sec = Math.floor(now().getTime() / 1000);
      if (typeof payload.exp !== "number" || sec > payload.exp + SKEW_SECONDS) return "expired";
      if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || sec + SKEW_SECONDS < payload.nbf)) return "not_yet";
      if (payload.iss !== issuer) return "issuer";
      const auds: unknown[] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!auds.some((a) => typeof a === "string" && a.toLowerCase() === aud)) return "audience";
      return null;
    },
  };
}
