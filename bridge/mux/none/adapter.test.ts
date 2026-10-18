import { describe, expect, test } from "bun:test";

import { MUX_CAPABILITIES } from "../capabilities.ts";
import { EMPTY_CENSUS, NONE_MUX, NoneMuxAdapter, noneMuxFactory } from "./adapter.ts";

// The mux-less adapter (ADR 0036's named end state): the shape a VPS lead runs, and the reason a
// lead with no local terminals is HEALTHY rather than disconnected. What these tests pin is the
// honesty — an empty census that is true, refusals that name themselves, and a watch that keeps
// the contract's promise with nothing to watch.

describe("the none adapter", () => {
  const adapter = new NoneMuxAdapter();

  test("declares nothing, and the declaration is total", () => {
    for (const capability of MUX_CAPABILITIES) {
      expect(adapter.capabilities.supports[capability], `${capability} must be declared absent`).toBe(false);
    }
    expect(adapter.capabilities.unsupportedKeys).toEqual([]);
    expect(adapter.capabilities.spaces).toBe("many");
  });

  test("declares itself paneless — the empty census is health by declaration", () => {
    expect(adapter.paneless).toBe(true);
  });

  test("reachable() is always true — no multiplexer cannot be unreachable", async () => {
    await expect(adapter.reachable()).resolves.toBe(true);
  });

  test("snapshot() is the same empty, consistent census every time", async () => {
    await expect(adapter.snapshot()).resolves.toEqual(EMPTY_CENSUS);
    await expect(adapter.snapshot()).resolves.toEqual({ panes: [], spaces: [], tabs: [] });
  });

  test("refresh() resolves and loses nothing", async () => {
    const before = await adapter.snapshot();
    await adapter.refresh();
    await expect(adapter.snapshot()).resolves.toEqual(before);
  });

  test("every verb answers unsupported, naming its capability", async () => {
    const refusals = [
      adapter.readGrid("any", { scope: "viewport", lines: 10, styling: "strip" }),
      adapter.typeText("any", "text"),
      adapter.writeKeys("any", ["Enter"]),
      adapter.renamePane("any", "label"),
      adapter.closePane("any"),
      adapter.setFocus("any"),
      adapter.createTab({ spaceId: "any" }),
      adapter.renameTab("any", "label"),
      adapter.closeTab("any"),
      adapter.createSpace({ cwd: "/tmp" }),
      adapter.listWorktrees({ repoRoot: "/tmp" }),
      adapter.createWorktree({ repoRoot: "/tmp", branch: "collie/x" }),
      adapter.openWorktree({ repoRoot: "/tmp", path: "/tmp/wt" }),
      adapter.listSessions(),
    ];
    const answers = await Promise.all(refusals);
    const expected = [
      "paneGrid",
      "typeText",
      "sendKeys",
      "renamePane",
      "closePane",
      "setFocus",
      "createTab",
      "renameTab",
      "closeTab",
      "createSpace",
      "listWorktrees",
      "createWorktree",
      "openWorktree",
      "listSessions",
    ] as const;
    for (let i = 0; i < answers.length; i += 1) {
      const answer = answers[i]!;
      expect(answer.ok, `${expected[i]!} must refuse`).toBe(false);
      if (!answer.ok) {
        expect(answer.reason).toBe("unsupported");
        if (answer.reason === "unsupported") {
          expect(answer.capability, `${expected[i]} names itself`).toBe(expected[i]!);
          expect(answer.detail.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("the optional methods an interactive adapter has are absent", () => {
    const optional = [
      "readLogicalText",
      "listStarters",
      "startStarter",
      "openAsks",
      "answerAsk",
      "paneTurn",
      "paneActions",
      "controlTurn",
      "foregroundProcesses",
      "pasteText",
      "renameSpace",
      "logo",
    ] as const;
    for (const member of optional) {
      expect(member in adapter, `${member} must be absent on a paneless adapter`).toBe(false);
    }
  });

  test("watch comes up, never pokes, and goes down exactly once on close", async () => {
    let up = 0;
    let downs = 0;
    let topology = 0;
    let paneChanges = 0;
    const subscription = adapter.watch({
      panes: [],
      onTopologyChange: () => (topology += 1),
      onPaneChange: () => (paneChanges += 1),
      onUp: () => (up += 1),
      onDown: () => (downs += 1),
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(up).toBe(1);
    subscription.close();
    subscription.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(downs).toBe(1);
    expect(topology).toBe(0);
    expect(paneChanges).toBe(0);
  });

  test("the factory registers under the name the config carries", () => {
    expect(noneMuxFactory.mux).toBe(NONE_MUX);
    expect(noneMuxFactory.mux).toBe("none");
    const built = noneMuxFactory.create({ endpoint: "", timeoutMs: 1000, options: {} });
    expect(built.mux).toBe("none");
    expect(noneMuxFactory.describeTarget?.("")).toContain("no multiplexer");
  });
});
