/**
 * THE SQLITE FIXTURE: rm-wenku's six sqlx migrations (tests/fixtures/sqlite,
 * verbatim copies) executed with node:sqlite into a real FTS5 database, seeded
 * with twelve deterministic articles that cover the fold (full-width
 * punctuation, 【】), the renderer (HTML with editor noise + a reference marker,
 * markdown with a task list), link resolution (`/article/{n}` and an exact
 * canonical URL), images with and without alt, a pinned row, a `skipped` row
 * with a NULL body, three `article_ai` rows (two ready, one failed), three
 * entities (one orphaned), an `ai_usage` row whose user matches no user, and
 * the skipped tables (`users`, `sessions`, `api_tokens`).
 *
 * `FIXTURE` names what was seeded so an e2e test can assert on ids and counts
 * without re-deriving them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS_DIR = new URL("./fixtures/sqlite/", import.meta.url);

/** 2026-01-01T00:00:00Z. Every timestamp is `T0 + n days`. */
export const T0 = Date.UTC(2026, 0, 1);
const day = (n: number) => T0 + n * 86_400_000;

/** A valid 26-character ULID: `01J` + 23 zero-padded digits. */
export const fixtureId = (n: number): string => `01J${String(n).padStart(23, "0")}`;
const postId = (n: number) => String(2000 + n);
const url = (n: number) => `https://bbs.robomaster.com/article/${postId(n)}`;

export const SOURCE_ID = "src-bbs";
export const UNMAPPED_USER_ID = "01TESTMEMBER0000000000000";

interface SeedArticle {
  readonly n: number;
  readonly title: string;
  readonly author: string | null;
  readonly publishedAt: number | null;
  readonly discoveredAt: number;
  readonly listingPosition: number;
  readonly pinned?: boolean;
  readonly introduction: string | null;
  readonly format: "html" | "markdown" | null;
  readonly raw: string | null;
  readonly body: string | null;
  readonly status: "fetched" | "skipped";
  readonly tags: readonly string[];
  readonly links?: readonly { url: string; kind: string; label: string | null }[];
  readonly images?: readonly { url: string; alt: string | null; caption?: string }[];
  readonly titleParts: {
    season: string | null;
    team: string | null;
    topic: string;
    labels: string[];
  };
}

const HTML_1 = `<h1>【RM2026-开源】步兵底盘 ＨＰＭ5361 方案</h1><p style="line-height:1.5; text-align: center" data-w-e-type="x" contenteditable="false">大学步兵开源底盘，<b>PID</b> 整定经验。</p><script>alert(1)</script><a href="javascript:alert(1)">bad</a><img src="/static/a.png" alt="a" onerror="x()"><p>参考文献 <span data-w-e-type="reference" data-link="bbs://reference.com/1/x/y/${postId(2)}/1">[1]</span></p><iframe src="https://evil.example/x"></iframe><iframe src="https://player.bilibili.com/player.html?bvid=BV1&amp;p=1"></iframe><table><tbody><tr><td style="background-color: rgb(255, 251, 143)">全国产　方案（Ｐｒｏ版）</td></tr></tbody></table>`;

const MD_2 = `# 云台 PID 整定笔记\n\n经验上 *PID* 整定先调 P，再调 D，[参考](https://example.com/x)。\n\n- [x] 云台电机参数已校准\n- [ ] 自瞄联调\n\n| 参数 | 值 |\n|---|---|\n| Kp | 12 |\n`;

export const ARTICLES: readonly SeedArticle[] = [
  {
    n: 1,
    title: "【RM2026-开源】步兵底盘 ＨＰＭ5361 方案",
    author: "Kaiser",
    publishedAt: day(1),
    discoveredAt: day(1),
    listingPosition: 0,
    pinned: true,
    introduction: "简介：全国产方案",
    format: "html",
    raw: HTML_1,
    body: "大学步兵开源底盘，PID 整定经验。参考文献 [1] 全国产　方案（Ｐｒｏ版）",
    status: "fetched",
    tags: ["硬件/机器人硬件", "电控/电机"],
    links: [
      { url: "https://github.com/kaiser/rmcs", kind: "repository", label: "RMCS 仓库" },
      { url: `${url(2)}?source=1`, kind: "other", label: "云台 PID 整定笔记 <A&B>" },
      { url: url(3), kind: "other", label: null },
      { url: "https://example.com/doc.pdf", kind: "document", label: null },
    ],
    images: [
      { url: "https://cdn.example/a.png", alt: "封面" },
      { url: "https://cdn.example/b.png", alt: "", caption: "Lite 版 PCB 实物局部" },
    ],
    titleParts: {
      season: "RM2026",
      team: null,
      topic: "步兵底盘 ＨＰＭ5361 方案",
      labels: ["开源"],
    },
  },
  {
    n: 2,
    title: "云台 PID 整定笔记",
    author: "Bob",
    publishedAt: day(2),
    discoveredAt: day(2),
    listingPosition: 0,
    introduction: null,
    format: "markdown",
    raw: MD_2,
    body: "经验上 PID 整定先调 P，再调 D。云台电机参数已校准 自瞄联调 Kp 12",
    status: "fetched",
    tags: ["算法/控制"],
    links: [{ url: "https://example.com/x", kind: "other", label: "参考" }],
    titleParts: { season: null, team: null, topic: "云台 PID 整定笔记", labels: [] },
  },
  {
    n: 3,
    title: "【已删除】空帖",
    author: null,
    publishedAt: null,
    discoveredAt: day(3),
    listingPosition: 5,
    introduction: null,
    format: null,
    raw: null,
    body: null,
    status: "skipped",
    tags: [],
    titleParts: { season: null, team: null, topic: "空帖", labels: ["已删除"] },
  },
  {
    n: 4,
    title: "自瞄算法框架开源",
    author: "深圳大学",
    publishedAt: null,
    discoveredAt: day(4),
    listingPosition: 1,
    introduction: "自瞄 视觉 识别",
    format: "html",
    raw: "<p>自瞄算法基于 OpenCV，识别装甲板。</p>",
    body: "自瞄算法基于 OpenCV，识别装甲板。",
    status: "fetched",
    tags: ["算法/视觉"],
    titleParts: { season: null, team: "深圳大学", topic: "自瞄算法框架开源", labels: ["开源"] },
  },
  {
    n: 5,
    title: "M3508 电机驱动经验",
    author: "Carol",
    publishedAt: day(5),
    discoveredAt: day(5),
    listingPosition: 2,
    introduction: null,
    format: "html",
    raw: "<p>M3508 电机 CAN 通信与底盘功率控制。</p>",
    body: "M3508 电机 CAN 通信与底盘功率控制。",
    status: "fetched",
    tags: ["电控/电机"],
    titleParts: { season: null, team: null, topic: "M3508 电机驱动经验", labels: [] },
  },
  {
    n: 6,
    title: "M3508 电机驱动经验（续）",
    author: "Carol",
    publishedAt: day(5),
    discoveredAt: day(5),
    listingPosition: 1,
    introduction: null,
    format: "html",
    raw: "<p>续篇：电机堵转保护。</p>",
    body: "续篇：电机堵转保护。",
    status: "fetched",
    tags: ["电控/电机"],
    titleParts: { season: null, team: null, topic: "M3508 电机驱动经验（续）", labels: [] },
  },
  {
    n: 7,
    title: "哨兵导航方案",
    author: "Dan",
    publishedAt: day(7),
    discoveredAt: day(7),
    listingPosition: 0,
    introduction: null,
    format: "markdown",
    raw: "## 导航\n\n哨兵使用激光雷达导航，底盘为全向轮。",
    body: "导航 哨兵使用激光雷达导航，底盘为全向轮。",
    status: "fetched",
    tags: ["算法/导航", "机械/底盘"],
    titleParts: { season: null, team: null, topic: "哨兵导航方案", labels: [] },
  },
  {
    n: 8,
    title: "HPM5361 CtrlBoard Guide",
    author: "Eve",
    publishedAt: day(8),
    discoveredAt: day(8),
    listingPosition: 0,
    introduction: "English guide",
    format: "html",
    raw: "<p>Bring-up guide for the HPM5361 control board.</p>",
    body: "Bring-up guide for the HPM5361 control board.",
    status: "fetched",
    tags: ["硬件/机器人硬件"],
    titleParts: { season: null, team: null, topic: "HPM5361 CtrlBoard Guide", labels: [] },
  },
  {
    n: 9,
    title: "英雄机器人发射机构",
    author: "Frank",
    publishedAt: day(9),
    discoveredAt: day(9),
    listingPosition: 0,
    introduction: null,
    format: "html",
    raw: "<p>英雄 42mm 发射机构设计，摩擦轮电机选型。</p>",
    body: "英雄 42mm 发射机构设计，摩擦轮电机选型。",
    status: "fetched",
    tags: ["机械/发射"],
    titleParts: { season: null, team: null, topic: "英雄机器人发射机构", labels: [] },
  },
  {
    n: 10,
    title: "步兵云台结构优化",
    author: "Grace",
    publishedAt: day(10),
    discoveredAt: day(10),
    listingPosition: 0,
    introduction: null,
    format: "html",
    raw: "<p>步兵云台结构轻量化，pitch 轴电机。</p>",
    body: "步兵云台结构轻量化，pitch 轴电机。",
    status: "fetched",
    tags: ["机械/云台"],
    titleParts: { season: null, team: null, topic: "步兵云台结构优化", labels: [] },
  },
  {
    n: 11,
    title: "工程机器人取矿方案",
    author: "Heidi",
    publishedAt: day(11),
    discoveredAt: day(11),
    listingPosition: 0,
    introduction: null,
    format: "html",
    raw: "<p>工程取矿机构与气动方案。</p>",
    body: "工程取矿机构与气动方案。",
    status: "fetched",
    tags: ["机械/机构"],
    titleParts: { season: null, team: null, topic: "工程机器人取矿方案", labels: [] },
  },
  {
    n: 12,
    title: "裁判系统通信协议解析",
    author: "Ivan",
    publishedAt: day(12),
    discoveredAt: day(12),
    listingPosition: 0,
    introduction: null,
    format: "html",
    raw: "<p>裁判系统串口协议，CRC 校验。</p>",
    body: "裁判系统串口协议，CRC 校验。",
    status: "fetched",
    tags: ["电控/通信"],
    titleParts: { season: null, team: null, topic: "裁判系统通信协议解析", labels: [] },
  },
];

const OVERVIEW_1 = {
  genre: "开源方案",
  tldr: "全国产步兵底盘方案，HPM5361 主控",
  summary: "一套基于 HPM5361 的步兵底盘开源方案。",
  keyPoints: ["国产化", "CAN 通信"],
  appliesWhen: "步兵底盘选型时",
  package: ["PCB", "固件"],
  maturity: { status: "已上场", evidence: "RM2026 分区赛" },
  caveats: [],
  readingGuide: null,
  extras: {
    quickStart: ["刷固件"],
    portingChecklist: [],
    compat: [],
    lessons: [],
    thesis: null,
    arguments: [],
    actions: [],
  },
  faq: [{ question: "成本?", answer: "25 元", source: null }],
};
const KB_1 = {
  domain: ["机械", "电控"],
  robotTypes: ["步兵"],
  problem: "底盘主控国产化",
  approach: "HPM5361 + M3508",
  components: [{ name: "HPM5361", kind: "MCU", spec: null, role: "主控", source: null }],
  parameters: [{ name: "Kp", value: "12", unit: null, context: "底盘", source: null }],
  interfaces: ["CAN"],
  toolchain: [],
  designDecisions: [],
  pitfalls: ["CAN 终端电阻漏装"],
  cost: "25 元",
  references: [],
  entities: ["HPM5361", "M3508"],
  claims: [],
  openQuestions: [],
  searchKeywords: ["步兵", "底盘"],
};
const IMAGES_1 = [
  { index: 1, kind: "截图", caption: "项目封面", textInImage: null, facts: [] },
  {
    index: 2,
    kind: "实物照片",
    caption: "Lite 版 PCB 实物局部",
    textInImage: "RMCS",
    facts: ["丝印"],
  },
];
const OVERVIEW_2 = {
  genre: "经验",
  tldr: "云台 PID 先 P 后 D",
  summary: "云台 PID 整定顺序。",
  keyPoints: [],
  appliesWhen: null,
  package: [],
  maturity: { status: "不适用", evidence: null },
  caveats: [],
  readingGuide: null,
  extras: {
    quickStart: [],
    portingChecklist: [],
    compat: [],
    lessons: [],
    thesis: null,
    arguments: [],
    actions: [],
  },
  faq: [],
};
const KB_2 = {
  domain: ["算法"],
  robotTypes: ["步兵", "哨兵"],
  problem: "云台抖动",
  approach: "先 P 后 D",
  components: [],
  parameters: [{ name: "Kp", value: "12", unit: null, context: null, source: null }],
  interfaces: [],
  toolchain: [],
  designDecisions: [],
  pitfalls: [],
  cost: null,
  references: [],
  entities: ["M3508"],
  claims: [],
  openQuestions: [],
  searchKeywords: ["云台", "PID"],
};

export const ENTITIES = [
  { key: "hpm5361", name: "HPM5361", articleIds: [fixtureId(1)] },
  { key: "m3508", name: "M3508", articleIds: [fixtureId(1), fixtureId(2)] },
  { key: "orphan", name: "Orphan", articleIds: [] as string[] },
] as const;

const fetched = ARTICLES.filter((a) => a.status === "fetched");

/** What the seed contains, for tests that import it. */
export const FIXTURE = {
  sourceId: SOURCE_ID,
  ids: Object.fromEntries(ARTICLES.map((a) => [a.n, fixtureId(a.n)])) as Record<number, string>,
  titles: Object.fromEntries(ARTICLES.map((a) => [a.n, a.title])) as Record<number, string>,
  tags: Object.fromEntries(ARTICLES.map((a) => [a.n, a.tags])) as Record<number, readonly string[]>,
  /** Feed order (newest COALESCE(published_at, discovered_at) first, listing_position ASC, id DESC), fetched only. */
  feedOrder: [...fetched]
    .sort((a, b) => {
      const at = (b.publishedAt ?? b.discoveredAt) - (a.publishedAt ?? a.discoveredAt);
      if (at !== 0) return at;
      if (a.listingPosition !== b.listingPosition) return a.listingPosition - b.listingPosition;
      return b.n - a.n;
    })
    .map((a) => fixtureId(a.n)),
  skippedArticle: fixtureId(3),
  aiReady: [fixtureId(1), fixtureId(2)],
  aiFailed: fixtureId(4),
  entities: ENTITIES.map((e) => ({ key: e.key, name: e.name, articleCount: e.articleIds.length })),
  unmappedUserId: UNMAPPED_USER_ID,
  counts: {
    sources: 1,
    articles: ARTICLES.length,
    article_tags: ARTICLES.reduce((n, a) => n + a.tags.length, 0),
    article_links: ARTICLES.reduce((n, a) => n + (a.links?.length ?? 0), 0),
    article_images: ARTICLES.reduce((n, a) => n + (a.images?.length ?? 0), 0),
    poll_runs: 2,
    source_guard_state: 1,
    article_ai: 3,
    kb_entities: ENTITIES.length,
    article_entities: ENTITIES.reduce((n, e) => n + e.articleIds.length, 0),
    ai_usage: 2,
    article_search: fetched.length,
    kb_search: 2,
  },
  /** article_links rows whose URL resolves to a fixture article (`/article/{n}` or exact canonical URL). */
  resolvedLinks: 2,
  renderedArticles: ARTICLES.filter((a) => a.raw !== null).length,
} as const;

/** Builds `${dir}/app.db` from the migrations and the seed. Returns the path. */
export async function buildFixtureDb(dir: string): Promise<string> {
  const path = join(dir, "app.db");
  // The real dump was written with foreign keys off (a dangling ai_usage.user_id exists); so is this one.
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)`,
    );
    const files = [
      "0001_init",
      "0002_ai",
      "0003_refresh",
      "0004_accounts",
      "0005_api_tokens",
      "0006_title_parts",
    ];
    files.forEach((file, i) => {
      db.exec(readFileSync(new URL(`${file}.sql`, MIGRATIONS_DIR), "utf8"));
      db.prepare(
        "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (?, ?, 1, X'00', 0)",
      ).run(i + 1, file.slice(5).replaceAll("_", " "));
    });
    seed(db);
  } finally {
    db.close();
  }
  return path;
}

function seed(db: DatabaseSync): void {
  db.prepare(
    "INSERT INTO sources (id, kind, name, site_url, enabled, backfill_next_page, backfill_completed_at, initialized_at, last_checked_at, created_at, updated_at) VALUES (?, 'bbs', 'RoboMaster 论坛', 'https://bbs.robomaster.com', 1, 40, ?, ?, ?, ?, ?)",
  ).run(SOURCE_ID, day(0), day(0), day(12), day(0), day(12));

  const insertArticle = db.prepare(
    `INSERT INTO articles (id, source_id, source_article_id, canonical_url, url_hash, title, author, published_at, discovered_at, fetched_at, listing_position, is_pinned, introduction, content_format, content_raw, body_text, content_hash, parser_version, status, skip_reason, last_error, created_at, updated_at, refresh_requested_at, content_changed_at, title_season, title_team, title_topic, title_labels)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertTag = db.prepare("INSERT INTO article_tags (article_id, tag) VALUES (?, ?)");
  const insertLink = db.prepare(
    "INSERT INTO article_links (id, article_id, url, kind, label, position) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertImage = db.prepare(
    "INSERT INTO article_images (id, article_id, url, alt, position, caption, image_kind, image_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertSearch = db.prepare(
    "INSERT INTO article_search (article_id, title, author, tags, introduction, body_text) VALUES (?, ?, ?, ?, ?, ?)",
  );
  let linkN = 0;
  let imageN = 0;
  for (const a of ARTICLES) {
    const id = fixtureId(a.n);
    const fetchedAt = a.status === "fetched" ? a.discoveredAt + 60_000 : null;
    insertArticle.run(
      id,
      SOURCE_ID,
      postId(a.n),
      url(a.n),
      `h${a.n}`,
      a.title,
      a.author,
      a.publishedAt,
      a.discoveredAt,
      fetchedAt,
      a.listingPosition,
      a.pinned ? 1 : 0,
      a.introduction,
      a.format,
      a.raw,
      a.body,
      a.body === null ? null : `hash-${a.n}`,
      "3",
      a.status,
      a.status === "skipped" ? "no content" : null,
      null,
      a.discoveredAt,
      fetchedAt ?? a.discoveredAt,
      null,
      fetchedAt,
      a.titleParts.season,
      a.titleParts.team,
      a.titleParts.topic,
      JSON.stringify(a.titleParts.labels),
    );
    // Insertion order IS rowid order, which the import turns into `position`.
    for (const tag of a.tags) insertTag.run(id, tag);
    (a.links ?? []).forEach((l, i) =>
      insertLink.run(`lnk${String(++linkN).padStart(3, "0")}`, id, l.url, l.kind, l.label, i),
    );
    (a.images ?? []).forEach((im, i) =>
      insertImage.run(
        `img${String(++imageN).padStart(3, "0")}`,
        id,
        im.url,
        im.alt,
        i,
        im.caption ?? null,
        im.caption ? "实物照片" : null,
        null,
      ),
    );
    if (a.status === "fetched") {
      insertSearch.run(
        id,
        a.title,
        a.author ?? "",
        a.tags.join(" "),
        a.introduction ?? "",
        a.body ?? "",
      );
    }
  }

  db.prepare(
    "INSERT INTO poll_runs (id, source_id, trigger, status, started_at, finished_at, listed, discovered, fetched, skipped, failed, error, refreshed) VALUES (?, ?, 'schedule', 'ok', ?, ?, 40, 12, 11, 1, 0, NULL, 0)",
  ).run("poll001", SOURCE_ID, day(11), day(11) + 5_000);
  db.prepare(
    "INSERT INTO poll_runs (id, source_id, trigger, status, started_at, finished_at, listed, discovered, fetched, skipped, failed, error, refreshed) VALUES (?, ?, 'manual', 'failed', ?, ?, 0, 0, 0, 0, 1, 'timeout', 0)",
  ).run("poll002", SOURCE_ID, day(12), day(12) + 1_000);
  db.prepare(
    "INSERT INTO source_guard_state (source_id, state_json, updated_at) VALUES (?, ?, ?)",
  ).run(
    SOURCE_ID,
    JSON.stringify({ zeta: 1, alpha: [1, 2], nested: { b: true, a: null } }),
    day(12),
  );

  const insertAi = db.prepare(
    "INSERT INTO article_ai (article_id, status, prompt_version, model, context_hash, context_text, overview_json, kb_json, images_json, attempts, error, prompt_tokens, cached_tokens, completion_tokens, cost_usd, generated_at, updated_at) VALUES (?, ?, 'v3', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insertAi.run(
    fixtureId(1),
    "ready",
    "claude",
    "ctx1",
    "the context text, not ported",
    JSON.stringify(OVERVIEW_1),
    JSON.stringify(KB_1),
    JSON.stringify(IMAGES_1),
    1,
    null,
    1000,
    200,
    500,
    0.0123,
    day(2),
    day(2),
  );
  insertAi.run(
    fixtureId(2),
    "ready",
    "claude",
    "ctx2",
    "context 2",
    JSON.stringify(OVERVIEW_2),
    JSON.stringify(KB_2),
    "[]",
    1,
    null,
    800,
    0,
    300,
    0.01,
    day(3),
    day(3),
  );
  insertAi.run(
    fixtureId(4),
    "failed",
    "claude",
    null,
    null,
    null,
    null,
    null,
    3,
    "timeout",
    0,
    0,
    0,
    0,
    null,
    day(5),
  );

  const insertEntity = db.prepare(
    "INSERT INTO kb_entities (key, name, article_count, updated_at) VALUES (?, ?, ?, ?)",
  );
  const insertAe = db.prepare(
    "INSERT INTO article_entities (article_id, entity_key) VALUES (?, ?)",
  );
  for (const e of ENTITIES) {
    insertEntity.run(e.key, e.name, e.articleIds.length, day(3));
    for (const id of e.articleIds) insertAe.run(id, e.key);
  }
  db.prepare(
    "INSERT INTO kb_search (article_id, tldr, problem, approach, components, parameters, decisions, pitfalls, entities, keywords, captions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    fixtureId(1),
    `${OVERVIEW_1.tldr} ${OVERVIEW_1.summary}\n成本? 25 元\n`,
    KB_1.problem,
    KB_1.approach,
    "HPM5361 MCU 主控",
    "Kp 12",
    "",
    KB_1.pitfalls.join("\n"),
    KB_1.entities.join(" "),
    KB_1.searchKeywords.join(" "),
    IMAGES_1.map((i) => i.caption).join("\n"),
  );
  db.prepare(
    "INSERT INTO kb_search (article_id, tldr, problem, approach, components, parameters, decisions, pitfalls, entities, keywords, captions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    fixtureId(2),
    `${OVERVIEW_2.tldr} ${OVERVIEW_2.summary}\n`,
    KB_2.problem,
    KB_2.approach,
    "",
    "Kp 12",
    "",
    "",
    KB_2.entities.join(" "),
    KB_2.searchKeywords.join(" "),
    "",
  );

  db.prepare(
    "INSERT INTO users (id, github_id, github_login, avatar_url, created_at, last_login_at, role, disabled_at) VALUES ('usr001', 42, 'alice', NULL, ?, ?, 'admin', NULL)",
  ).run(day(0), day(12));
  db.prepare(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('ses001', 'usr001', ?, ?)",
  ).run(day(12), day(40));

  const insertUsage = db.prepare(
    "INSERT INTO ai_usage (id, user_id, article_id, kind, model, prompt_tokens, cached_tokens, completion_tokens, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insertUsage.run(
    `legacy-${fixtureId(1)}`,
    null,
    fixtureId(1),
    "generate",
    "claude",
    1000,
    200,
    500,
    0.0123,
    day(2),
  );
  insertUsage.run(
    fixtureId(90),
    UNMAPPED_USER_ID,
    fixtureId(2),
    "chat",
    "claude",
    300,
    0,
    100,
    0.002,
    day(6),
  );
}
