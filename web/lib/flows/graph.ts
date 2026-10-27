// Helpers shared by the engine and the node editor: turning an old linear flow into a graph,
// and walking a graph.

import type { Action, Cond, Graph, GraphEdge, GraphNode, Trigger } from "./types";

export const X_STEP = 300;
export const Y_STEP = 150;

type Linear = { trigger?: Trigger; match: "all" | "any"; conditions: Cond[]; actions: Action[] };

/**
 * The same behaviour as a linear flow, drawn as nodes: trigger, then one condition node holding all the
 * flow's conditions (only when there are any), then the actions in a row. A flow that never matched
 * keeps never matching, because only the condition's "true" output is wired on.
 */
export function flowToGraph(f: Linear): Graph {
  const nodes: GraphNode[] = [{ id: "t", kind: "trigger", x: 0, y: 0 }];
  const edges: GraphEdge[] = [];
  let prev = "t";
  let port: GraphEdge["port"] = "next";
  let x = X_STEP;
  if (f.conditions.length) {
    nodes.push({ id: "c1", kind: "condition", x, y: 0, match: f.match, conditions: f.conditions });
    edges.push({ from: prev, port, to: "c1" });
    prev = "c1";
    port = "true";
    x += X_STEP;
  }
  f.actions.forEach((action, i) => {
    const id = `a${i + 1}`;
    nodes.push({ id, kind: "action", x, y: 0, action });
    edges.push({ from: prev, port, to: id });
    prev = id;
    port = "next";
    x += X_STEP;
  });
  return { nodes, edges };
}

/** Nodes wired to one output of `from`, in the order the wires were drawn. */
export function successors(g: Graph, from: string, port: GraphEdge["port"]): GraphNode[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  return g.edges.filter((e) => e.from === from && e.port === port).flatMap((e) => byId.get(e.to) ?? []);
}

/** Smallest unused id such as "a3", "c2". */
export function freshId(g: Graph, prefix: "a" | "c"): string {
  const used = new Set(g.nodes.map((n) => n.id));
  for (let i = 1; ; i++) if (!used.has(prefix + i)) return prefix + i;
}

/** Nodes the trigger can never reach: they would be saved but never run. */
export function unreachable(g: Graph): string[] {
  const trigger = g.nodes.find((n) => n.kind === "trigger");
  if (!trigger) return g.nodes.map((n) => n.id);
  const seen = new Set<string>([trigger.id]);
  const todo = [trigger.id];
  while (todo.length) {
    const id = todo.pop()!;
    for (const e of g.edges) if (e.from === id && !seen.has(e.to)) (seen.add(e.to), todo.push(e.to));
  }
  return g.nodes.filter((n) => !seen.has(n.id)).map((n) => n.id);
}
