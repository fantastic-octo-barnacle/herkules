/** The KB page's derived values: the pitfall feed, the entity cloud, the entity page's sections. */
import { describe, expect, it } from "vite-plus/test";

import type { EntityDetailDTO, KbBrowseDTO } from "../../src/api/dto.ts";
import {
  PITFALL_LIMIT,
  countEntities,
  entitySections,
  roundRobin,
  splitEntities,
} from "../src/kb/model.ts";

type Card = KbBrowseDTO["cards"][number];

function card(id: string, over: Partial<Card> = {}): Card {
  return {
    articleId: id,
    title: `【RM2026-${id}】队伍${id}`,
    author: null,
    publishedAt: null,
    tldr: "",
    genre: "",
    maturity: "未知",
    problem: null,
    domain: [],
    robotTypes: [],
    entities: [],
    pitfalls: [],
    ...over,
  } as unknown as Card;
}

describe("roundRobin", () => {
  const lists = [["a1", "a2", "a3"], ["b1"], [], ["d1", "d2"]];

  it("takes one from each list before a second from any", () => {
    expect(roundRobin(lists, PITFALL_LIMIT)).toEqual(["a1", "b1", "d1", "a2", "d2", "a3"]);
  });

  it("stops at the limit mid-round", () => {
    expect(roundRobin(lists, 4)).toEqual(["a1", "b1", "d1", "a2"]);
  });

  it("handles empty input", () => {
    expect(roundRobin([[]], 5)).toEqual([]);
    expect(roundRobin([], 5)).toEqual([]);
  });
});

describe("countEntities", () => {
  it("counts each entity once per card, case and punctuation insensitively", () => {
    const tallies = countEntities([
      card("a", { entities: ["OpenCV", "opencv", "M3508"] }),
      card("b", { entities: ["Open-CV", "CAN FD"] }),
      card("c", { entities: ["ROS2", "!!"] }),
    ]);
    expect(tallies).toEqual([
      { name: "OpenCV", count: 2 },
      { name: "CAN FD", count: 1 },
      { name: "M3508", count: 1 },
      { name: "ROS2", count: 1 },
    ]);
    const { common, rest } = splitEntities(tallies);
    expect(common.map((e) => e.name)).toEqual(["OpenCV"]);
    expect(rest.map((e) => e.name)).toEqual(["CAN FD", "M3508", "ROS2"]);
  });

  it("is empty for cards with no entities", () => {
    expect(countEntities([card("a")])).toEqual([]);
    expect(splitEntities([])).toEqual({ common: [], rest: [] });
  });
});

describe("entitySections", () => {
  const articles = [
    {
      articleId: "a",
      title: "【RM2026-底盘】队伍A",
      author: null,
      publishedAt: null,
      tldr: "",
      kb: {
        domain: [],
        robotTypes: [],
        problem: null,
        approach: null,
        components: [
          { name: "M3508", kind: "电机", spec: "3508", role: "底盘", source: null },
          { name: "STM32", kind: "MCU", spec: null, role: null, source: null },
        ],
        parameters: [
          { name: "M-3508 减速比", value: "19", unit: ":1", context: null, source: null },
          { name: "重量", value: "12", unit: "kg", context: "整车", source: null },
          { name: "电流", value: "10", unit: "A", context: "m3508 堵转", source: null },
        ],
        interfaces: [],
        toolchain: [],
        designDecisions: [
          { decision: "用 M3508", alternatives: null, rationale: "扭矩够", source: null },
          { decision: "用麦轮", alternatives: "全向轮", rationale: null, source: null },
        ],
        pitfalls: ["M3508 过热", "螺丝松动"],
        cost: null,
        references: [],
        entities: [],
        claims: [],
        openQuestions: [],
        searchKeywords: [],
      },
    },
  ] as unknown as EntityDetailDTO["articles"];

  it("separates what mentions the entity from the rest", () => {
    const s = entitySections("m3508", articles);
    expect(s.comparison.map((r) => r.name)).toEqual(["M-3508 减速比", "电流"]);
    expect(s.comparison[0]).toEqual({
      articleId: "a",
      title: "【RM2026-底盘】队伍A",
      name: "M-3508 减速比",
      value: "19",
      unit: ":1",
      context: null,
    });
    expect(s.otherParameters.map((r) => r.name)).toEqual(["重量"]);
    expect(s.asComponent).toEqual([
      { articleId: "a", title: "【RM2026-底盘】队伍A", role: "底盘", spec: "3508" },
    ]);
    expect(s.decisions.map((r) => r.decision)).toEqual(["用 M3508"]);
    expect(s.pitfalls.map((r) => r.pitfall)).toEqual(["M3508 过热"]);
  });

  it("puts every parameter in otherParameters when the key matches nothing", () => {
    const s = entitySections("ros2", articles);
    expect(s.comparison).toEqual([]);
    expect(s.otherParameters).toHaveLength(3);
    expect(s.asComponent).toEqual([]);
    expect(s.pitfalls).toEqual([]);
  });

  it("treats an empty key as matching nothing", () => {
    expect(entitySections("", articles).comparison).toEqual([]);
  });
});
