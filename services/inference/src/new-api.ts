import type { Config } from "./config.ts";

/** Management calls stay on the private network; never print requests or credentials. */
export class NewAPI {
  private cookie = "";
  private accessToken = "";
  private accessExpiresAt = 0;
  private userId = 0;
  readonly base: string;
  private readonly password: string;
  constructor(base: string, password: string) {
    this.base = base;
    this.password = password;
  }
  async call<T = unknown>(path: string, method = "GET", value?: unknown): Promise<T> {
    const response = await fetch(this.base + path, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: this.cookie,
        "New-Api-User": String(this.userId),
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        origin: new URL(this.base).origin,
      },
      ...(method === "GET"
        ? {}
        : { body: value === undefined ? undefined : JSON.stringify(value) }),
      signal: AbortSignal.timeout(15_000),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) this.cookie = cookies.map((c) => c.split(";")[0]).join("; ");
    const result = (await response.json()) as { success?: boolean; data?: T; message?: string };
    if (!response.ok || result.success !== true)
      throw new Error(`New API management request failed: ${method} ${path} (${response.status})`);
    return result.data as T;
  }
  async login() {
    if (this.accessExpiresAt > Date.now() + 60_000) return;
    const data = await this.call<{
      user: { id: number };
      access_token: string;
      access_expires_at: number;
    }>("/api/user/login", "POST", {
      username: "herkulesroot",
      password: this.password,
    });
    this.userId = data.user.id;
    this.accessToken = data.access_token;
    this.accessExpiresAt = data.access_expires_at * 1000;
  }
  async bootstrap(config: Config) {
    const setup = await this.call<{ status: boolean }>("/api/setup");
    if (!setup.status)
      await this.call("/api/setup", "POST", {
        username: "herkulesroot",
        password: this.password,
        confirmPassword: this.password,
        SelfUseModeEnabled: false,
        DemoSiteEnabled: false,
      });
    await this.login();
    const options: Record<string, string> = {
      ServerAddress: config.AI_PORTAL_ORIGIN,
      SystemName: "Herkules AI",
      HeaderNavModules: JSON.stringify({
        home: false,
        console: true,
        pricing: { enabled: true, requireAuth: true },
        rankings: false,
        docs: false,
        about: false,
      }),
      PasswordRegisterEnabled: "false",
      RegisterEnabled: "true",
      GitHubOAuthEnabled: "false",
      LinuxDOOAuthEnabled: "false",
      TelegramOAuthEnabled: "false",
      WeChatAuthEnabled: "false",
      "oidc.enabled": "false",
      QuotaForNewUser: "0",
      QuotaForInviter: "0",
      QuotaForInvitee: "0",
      "general_setting.ping_interval_enabled": "true",
      "general_setting.ping_interval_seconds": "10",
      "general_setting.quota_display_type": "TOKENS",
      RetryTimes: "0",
      ModelRequestRateLimitEnabled: "true",
      ModelRequestRateLimitCount: "20",
      ModelRequestRateLimitDurationMinutes: "1",
      ModelRequestRateLimitSuccessCount: "20",
      // One quota unit per input token, two per output token; never treat self-hosted compute as free.
      ModelRatio: JSON.stringify(Object.fromEntries(config.workers.map((w) => [w.model, 1]))),
      CompletionRatio: JSON.stringify(Object.fromEntries(config.workers.map((w) => [w.model, 2]))),
      GroupRatio: JSON.stringify({ default: 1 }),
    };
    // Preserve operator quota/pricing choices on subsequent boots; security settings are reconciled.
    const existing = await this.call<{ key: string; value: string }[]>("/api/option/");
    const have = new Map(existing.map((o) => [o.key, o.value]));
    for (const [key, initial] of Object.entries(options)) {
      let value = initial;
      if (["ModelRatio", "CompletionRatio", "GroupRatio"].includes(key)) {
        value = JSON.stringify({ ...JSON.parse(initial), ...JSON.parse(have.get(key) || "{}") });
      }
      if (
        setup.status &&
        [
          "ModelRequestRateLimitCount",
          "ModelRequestRateLimitDurationMinutes",
          "ModelRequestRateLimitSuccessCount",
        ].includes(key)
      )
        continue;
      if (have.get(key) !== value) await this.call("/api/option/", "PUT", { key, value });
    }
    const providers = await this.call<{ id: number; slug: string }[]>(
      "/api/custom-oauth-provider/",
    );
    const old = providers.find((p) => p.slug === "herkules");
    const provider = {
      name: "Herkules",
      slug: "herkules",
      enabled: true,
      client_id: "herkules-ai",
      client_secret: config.clientSecret,
      auth_style: 2,
      authorization_endpoint: `${config.AUTH_ISSUER}/oauth2/authorize`,
      token_endpoint: `${config.AI_OAUTH_BACKCHANNEL ?? config.AUTH_INTERNAL_URL}/oauth2/token`,
      user_info_endpoint: `${config.AI_OAUTH_BACKCHANNEL ?? config.AUTH_INTERNAL_URL}/oauth2/userinfo`,
      scopes: "openid email profile",
      user_id_field: "sub",
      username_field: "sub",
      display_name_field: "name",
      email_field: "email",
    };
    await this.call(
      old ? `/api/custom-oauth-provider/${old.id}` : "/api/custom-oauth-provider/",
      old ? "PUT" : "POST",
      provider,
    );
    const channels = await this.call<{ items: { id: number; name: string }[] }>(
      "/api/channel/?p=1&page_size=100",
    );
    const oldChannel = channels.items.find((c) => c.name === "herkules-dispatch");
    const channel = {
      type: 1,
      name: "herkules-dispatch",
      key: config.dispatchKey,
      base_url: config.AI_DISPATCH_URL,
      models: [...new Set(config.workers.map((w) => w.model))].join(","),
      group: "default",
      auto_ban: 0,
      header_override: JSON.stringify({ "X-Herkules-Ticket": "{client_header:X-Herkules-Ticket}" }),
    };
    await this.call(
      "/api/channel/",
      oldChannel ? "PUT" : "POST",
      oldChannel ? { ...channel, id: oldChannel.id } : { mode: "single", channel },
    );
  }
  async users() {
    const users: { id: number; status: number; role: number }[] = [];
    for (let page = 1; ; page++) {
      const data = await this.call<{
        items: { id: number; status: number; role: number }[];
        total: number;
      }>(`/api/user/?p=${page}&page_size=100`);
      users.push(...data.items);
      if (users.length >= data.total) return users;
    }
  }
  bindings(id: number) {
    return this.call<{ provider_slug: string; provider_user_id: string }[]>(
      `/api/user/${id}/oauth/bindings`,
    );
  }
}
