import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainStore } from "./store.js";
import { graphView, parseConnections, parseLog } from "./view.js";

let dir: string;
let store: BrainStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-view-"));
  store = new BrainStore(dir);
  store.ensureInit({ name: "Jão", summary: "Goblin Rogue de Cinzalto." });
  store.bumpSession();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const VEXCIA = `---
created: S1.T1
updated: S1.T2
type: npc
status: active
tags: [cinzalto, guild]
---
# Vexcia
Administradora da Scouts Guild; paga contratos.

## Log
- [S1.T1] Pagou pela entrega.
- [S1.T2] Pediu discrição.
- Bullet sem carimbo também conta.

## Connections
- works_for [[Scouts Guild]]
- knows_about [[Selo Quebrado]]
`;

const GUILD = `---
created: S1.T1
updated: S1.T1
type: faction
---
# Scouts Guild
Guilda de batedores de Cinzalto.

## Connections
- based_in [[Cinzalto]]
- rival_of [[Vexcia]]
`;

describe("view: parseLog/parseConnections", () => {
  it("extrai entradas do Log com e sem carimbo", () => {
    const body = VEXCIA.split("---\n")[2]!;
    const log = parseLog(body);
    expect(log).toHaveLength(3);
    expect(log[0]).toEqual({ stamp: "S1.T1", text: "Pagou pela entrega." });
    expect(log[2]).toEqual({ stamp: "", text: "Bullet sem carimbo também conta." });
  });

  it("extrai connections rotuladas; sem rótulo vira linked_to", () => {
    const conns = parseConnections(
      "# X\n\n## Connections\n- works_for [[Scouts Guild]]\n- [[Cinzalto]]\n",
    );
    expect(conns).toEqual([
      { label: "works_for", to: "Scouts Guild" },
      { label: "linked_to", to: "Cinzalto" },
    ]);
  });

  it("bullets fora da seção não contam (Log não vira connection)", () => {
    const body = VEXCIA.split("---\n")[2]!;
    const conns = parseConnections(body);
    expect(conns.map((c) => c.to)).toEqual(["Scouts Guild", "Selo Quebrado"]);
  });
});

describe("view: graphView", () => {
  it("monta nós tipados e edges apenas para alvos existentes", () => {
    writeFileSync(join(dir, "Vexcia.md"), VEXCIA);
    writeFileSync(join(dir, "Scouts Guild.md"), GUILD);
    const g = graphView(store);
    expect(g.nodes.map((n) => n.stem).sort()).toEqual(["Scouts Guild", "Vexcia"]);
    const vexcia = g.nodes.find((n) => n.stem === "Vexcia")!;
    expect(vexcia.type).toBe("npc");
    expect(vexcia.log).toHaveLength(3);
    // "Selo Quebrado" e "Cinzalto" não existem como nó → edge não entra.
    expect(g.edges).toEqual([
      { from: "Scouts Guild", to: "Vexcia", label: "rival_of" },
      { from: "Vexcia", to: "Scouts Guild", label: "works_for" },
    ]);
  });

  it("off-grid (Protagonist/Journal/Timeline) nunca entra no grafo", () => {
    writeFileSync(join(dir, "Vexcia.md"), VEXCIA);
    const g = graphView(store);
    expect(g.nodes.map((n) => n.stem)).toEqual(["Vexcia"]);
  });
});
