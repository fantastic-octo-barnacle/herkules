import { z } from "zod";

const botConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_ORIGIN: z.string().url(),
  SEARCH_INDEX: z.enum(["trgm", "pgroonga"]).default("trgm"),
  FEISHU_APP_ID: z.string().min(1),
  FEISHU_APP_SECRET: z.string().min(1),
  FEISHU_ANNOUNCEMENT_CHAT_ID: z.string().min(1),
});

export interface BotConfig {
  readonly databaseUrl: string;
  readonly appOrigin: string;
  readonly searchIndex: "trgm" | "pgroonga";
  readonly feishuAppId: string;
  readonly feishuAppSecret: string;
  readonly announcementChatId: string;
}

export function loadBotConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const raw = botConfigSchema.parse(env);
  return Object.freeze({
    databaseUrl: raw.DATABASE_URL,
    appOrigin: new URL(raw.APP_ORIGIN).origin,
    searchIndex: raw.SEARCH_INDEX,
    feishuAppId: raw.FEISHU_APP_ID,
    feishuAppSecret: raw.FEISHU_APP_SECRET,
    announcementChatId: raw.FEISHU_ANNOUNCEMENT_CHAT_ID,
  });
}
