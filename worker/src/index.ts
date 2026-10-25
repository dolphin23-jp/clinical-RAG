import { accessConfigProblem, createAccessVerifier, type AccessVerifier } from "./access.ts";
import { fromD1 } from "./db.ts";
import { handle } from "./handler.ts";
import { d1Counter } from "./usage.ts";

export interface Env {
  DB: D1Database;
  PAGES?: R2Bucket;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  APP_TOKEN: string;
  MODEL?: string;
  /** the model for /api/extract (default: MODEL) */
  EXTRACT_MODEL?: string;
  ALLOWED_MODELS?: string;
  WEB_ALLOWED_DOMAINS?: string;
  /** /api/ask calls per day, Japan time ("0" or unset = no cap) */
  DAILY_ASK_LIMIT?: string;
  /** conversations expire this many days after their last turn ("0" = keep until deleted; default 30) */
  CONVERSATION_RETENTION_DAYS?: string;
  /** case records expire this many days after their last update ("0" = keep until deleted; default 60) */
  CASE_RECORD_RETENTION_DAYS?: string;
  /** Cloudflare Access: "<team>.cloudflareaccess.com" and the application's Audience tag.  Both set = every /api/ call (except /api/health and /api/search) must carry a valid Access token */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

let accessCache: { key: string; verifier: AccessVerifier } | null = null;
/** The Access check for these settings (kept for the life of the isolate so the public keys are fetched once), or why it cannot be made. */
function accessFor(env: Env): { access?: AccessVerifier; accessProblem?: string } {
  const problem = accessConfigProblem(env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
  if (problem) return { accessProblem: problem };
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();
  if (!team || !aud) return {};
  const key = `${team}|${aud}`;
  if (accessCache?.key !== key) accessCache = { key, verifier: createAccessVerifier({ teamDomain: team, aud }) };
  return { access: accessCache.verifier };
}

const list = (s?: string): string[] | undefined => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, {
      db: fromD1(env.DB),
      apiKey: env.ANTHROPIC_API_KEY,
      appToken: env.APP_TOKEN,
      model: env.MODEL ?? "claude-sonnet-5-5",
      extractModel: env.EXTRACT_MODEL || undefined,
      allowedModels: list(env.ALLOWED_MODELS),
      webDomains: list(env.WEB_ALLOWED_DOMAINS),
      dailyAskLimit: Math.max(0, Math.floor(Number(env.DAILY_ASK_LIMIT ?? 0))) || 0,
      counter: d1Counter(env.DB),
      ...accessFor(env),
      rw: env.DB,
      conversationRetentionDays: Number.isFinite(Number(env.CONVERSATION_RETENTION_DAYS ?? 30)) ? Number(env.CONVERSATION_RETENTION_DAYS ?? 30) : 30,
      caseRecordRetentionDays: Number.isFinite(Number(env.CASE_RECORD_RETENTION_DAYS ?? 60)) ? Number(env.CASE_RECORD_RETENTION_DAYS ?? 60) : 60,
      pages: env.PAGES
        ? {
            async get(key) {
              const o = await env.PAGES!.get(key);
              return o ? { body: o.body, contentType: o.httpMetadata?.contentType } : null;
            },
          }
        : undefined,
      assets: (r) => env.ASSETS.fetch(r),
    });
  },
} satisfies ExportedHandler<Env>;
