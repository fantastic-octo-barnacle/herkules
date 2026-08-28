/** Dates are Asia/Shanghai everywhere, counts follow the corpus's own scale. */
import { describe, expect, it } from "vite-plus/test";

import { NO_DATE, formatCount, formatDate, linkKindText } from "../src/lib/format.ts";

describe("formatDate", () => {
  it("renders YYYY-MM-DD in Asia/Shanghai", () => {
    expect(formatDate("2026-08-20T06:32:00.000Z")).toBe("2026-08-20");
    // 16:00 UTC is the next day in Shanghai (+08).
    expect(formatDate("2026-08-20T16:00:00.000Z")).toBe("2026-08-21");
  });

  it("renders an em dash for null and for junk", () => {
    expect(formatDate(null)).toBe(NO_DATE);
    expect(formatDate("not a date")).toBe(NO_DATE);
  });
});

describe("formatCount", () => {
  it("scales at 1k and 万", () => {
    expect(formatCount(820, "字")).toBe("820 字");
    expect(formatCount(3500, "字")).toBe("3.5k 字");
    expect(formatCount(12_000, "字")).toBe("1.2万字");
    expect(formatCount(7, "链接")).toBe("7 链接");
    expect(formatCount(3, "图")).toBe("3 图");
  });

  it("renders zero as nothing so the meta line drops the segment", () => {
    expect(formatCount(0, "图")).toBe("");
  });
});

describe("linkKindText", () => {
  it("names every kind", () => {
    expect(
      (["repository", "document", "download", "video", "cloud_drive", "other"] as const).map(
        linkKindText,
      ),
    ).toEqual(["仓库", "文档", "下载", "视频", "网盘", "链接"]);
  });
});
