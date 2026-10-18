// The `none` conformance fixture — one adapter, no world to perturb.
//
// `none` fronts no multiplexer (adapter.ts), so every perturbation the engine can ask for is a
// no-op that resolves: there is no connection to reconnect, no process to restart, no pane to
// rename, change, end, title or focus, and no topology to change silently. The suite still runs —
// and what it proves for this adapter is the half that does not need a world: the declaration is
// total and honest, `reachable()` answers true, the empty census is internally consistent, every
// undeclared verb refuses BY NAME against a synthetic id, the session list refuses, the topology
// bound is declared, and `refresh()` loses nothing. The pane-needing legs pass vacuously through
// the `paneless` fact, which is the honest reading: an adapter that can never have a pane cannot
// be asked to prove pane behaviour.

import type { MuxConformanceFixture, MuxConformanceWorld } from "../conformance.ts";
import { NoneMuxAdapter } from "./adapter.ts";

/** The world of a mux-less collie: one adapter, and nothing anyone can perturb. */
export function noneWorld(): MuxConformanceWorld {
  return {
    adapter: new NoneMuxAdapter(),
    writes: () => [],
    reconnect: async () => {},
    restartMux: async () => {},
    renameOutOfBand: async () => {},
    changePane: async () => {},
    endPane: async () => {},
    pokeTopologyOutOfBand: async () => {},
    close: async () => {},
  };
}

export const noneConformanceFixture: MuxConformanceFixture = {
  mux: "none",
  create: async () => noneWorld(),
};
