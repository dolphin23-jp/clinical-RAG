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
  ALLOWED_MODELS?: string;
  WEB_ALLOWED_DOMAINS?: string;
  /** /api/ask calls per day, Japan time ("0" or unset = no cap) */
  DAILY_ASK_LIMIT?: string;
}

const list = (s?: string): string[] | undefined => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, {
      db: fromD1(env.DB),
      apiKey: env.ANTHROPIC_API_KEY,
      appToken: env.APP_TOKEN,
      model: env.MODEL ?? "claude-sonnet-5-5",
      allowedModels: list(env.ALLOWED_MODELS),
      webDomains: list(env.WEB_ALLOWED_DOMAINS),
      dailyAskLimit: Math.max(0, Math.floor(Number(env.DAILY_ASK_LIMIT ?? 0))) || 0,
      counter: d1Counter(env.DB),
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
