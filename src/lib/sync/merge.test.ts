import { describe, expect, it } from "vitest";
import { merge3 } from "@/lib/sync/merge";

const m = (id: string, createdAt: number, text = id) => ({
  id,
  kind: "text",
  createdAt,
  segments: [text],
});

describe("merge3", () => {
  it("unions concurrent message additions ordered by createdAt", () => {
    const base = [m("a", 1)];
    const local = [m("a", 1), m("l", 3)];
    const remote = [m("a", 1), m("r", 2)];
    expect(merge3(base, local, remote, true)).toEqual([m("a", 1), m("r", 2), m("l", 3)]);
  });

  it("deletes an item removed on one side and unchanged on the other", () => {
    const base = [m("a", 1), m("b", 2)];
    expect(merge3(base, [m("a", 1)], [m("a", 1), m("b", 2), m("c", 3)], true)).toEqual([
      m("a", 1),
      m("c", 3),
    ]);
  });

  it("keeps an item deleted on one side but edited on the other", () => {
    const base = [m("a", 1)];
    expect(merge3(base, [], [m("a", 1, "edited")], true)).toEqual([m("a", 1, "edited")]);
  });

  it("resolves both-changed by preferLocal", () => {
    const base = { name: "x", n: 1 };
    const local = { name: "L", n: 1 };
    const remote = { name: "R", n: 2 };
    expect(merge3(base, local, remote, true)).toEqual({ name: "L", n: 2 });
    expect(merge3(base, local, remote, false)).toEqual({ name: "R", n: 2 });
  });

  it("first sync unions lists and prefers local scalars", () => {
    expect(merge3(null, [{ id: "a" }], [{ id: "b" }], false)).toEqual([{ id: "b" }, { id: "a" }]);
    expect(merge3(null, { t: 1, a: 1 }, { t: 2, b: 2 }, true)).toEqual({ a: 1, b: 2, t: 1 });
  });

  it("converges: both devices reach the same value", () => {
    const base = [m("a", 1)];
    const phone = [m("a", 1), m("p", 5)];
    const pc = [m("a", 1), m("c", 4)];
    // PC syncs first, uploads merged; phone then merges against it.
    const afterPc = merge3(base, pc, base, true);
    const afterPhone = merge3(base, phone, afterPc, true);
    const pcAgain = merge3(afterPc, pc, afterPhone, true);
    expect(pcAgain).toEqual(afterPhone);
    expect(merge3(base, phone, pc, true)).toEqual(merge3(base, pc, phone, false));
  });
});
