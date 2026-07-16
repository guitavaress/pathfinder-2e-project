import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCommands, applyCommands } from "./commands.js";
import { durableJournalLines } from "./journal.js";
import { knowledgeBlock, relevantStems } from "./routing.js";
import { parseNode, serializeNode, wikiLinks } from "./schema.js";
import { BrainStore } from "./store.js";
import { buildWritePrompt, runWritePass, WritePassQueue } from "./write.js";

let dir: string;
let store: BrainStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-"));
  store = new BrainStore(dir);
  store.ensureInit({ name: "Jão", summary: "Goblin Rogue de Cinzalto." });
  store.bumpSession();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const VEXCIA = `---
created: S1.T1
updated: S1.T1
type: npc
status: active
tags: [cinzalto, guild]
---
# Vexcia
Administradora da Scouts' Guild; paga contratos.

## Log
- [S1.T1] Pagou pela entrega.

## Connections
- works_for [[Scouts Guild]]
`;

describe("schema: parseNode/serializeNode/wikiLinks", () => {
  it("parseia nó completo (frontmatter, descrição, links)", () => {
    const { node, error } = parseNode("Vexcia", VEXCIA);
    expect(error).toBeUndefined();
    expect(node?.front.type).toBe("npc");
    expect(node?.front.tags).toEqual(["cinzalto", "guild"]);
    expect(node?.name).toBe("Vexcia");
    expect(node?.description).toContain("Administradora");
    expect(node?.links).toEqual(["Scouts Guild"]);
  });

  it("rejeita frontmatter ausente ou type inválido", () => {
    expect(parseNode("X", "# X\nsem frontmatter").error).toContain("frontmatter");
    expect(
      parseNode("X", "---\ncreated: S1.T1\nupdated: S1.T1\ntype: dragon\n---\n# X").error,
    ).toContain("frontmatter");
  });

  it("serializeNode ida-e-volta", () => {
    const { node } = parseNode("Vexcia", VEXCIA);
    const again = parseNode("Vexcia", serializeNode(node!.front, node!.body));
    expect(again.node?.front).toEqual(node!.front);
  });

  it("wikiLinks deduplica e aceita label ([[X|rótulo]])", () => {
    expect(wikiLinks("vi [[A]] e [[A]] e [[B|o tal B]]")).toEqual(["A", "B"]);
  });
});

describe("store: guards, map, journal/timeline, meta", () => {
  it("bloqueia path traversal e nomes off-grid", () => {
    expect(store.nodePath("../../etc/passwd")).toBeNull();
    expect(store.nodePath("journal")).toBeNull();
    expect(store.nodePath("Protagonist")).toBeNull();
    expect(store.nodePath("Vexcia")).not.toBeNull();
  });

  it("writeNode valida e rebuilda o map; off-grid fora do grafo", () => {
    expect(store.writeNode("Vexcia", VEXCIA)).toEqual({ ok: true });
    expect(store.writeNode("Broken", "# sem frontmatter").ok).toBe(false);
    const map = store.readMap();
    expect(Object.keys(map)).toEqual(["Vexcia"]);
    expect(map.Vexcia).toContain("npc:");
    expect(store.listStems()).toEqual(["Vexcia"]);
  });

  it("journal é append-only com cabeçalho de sessão e carimbo", () => {
    store.appendJournal(["Combat begins vs 2 scavengers"], "S1.T4");
    store.appendJournal(["- Combat ends: VICTORY."], "S1.T6");
    const j = store.readOffGrid("Journal");
    expect(j).toContain("## Session 1");
    expect(j).toContain("- [S1.T4] Combat begins vs 2 scavengers");
    expect(j).toContain("- [S1.T6] Combat ends: VICTORY.");
    expect(store.journalTail(1)[0]).toContain("VICTORY");
  });

  it("meta: bumpSession zera turno; bumpTurn carimba", () => {
    expect(store.meta().session).toBe(1);
    expect(store.bumpTurn()).toBe("S1.T1");
    expect(store.bumpTurn()).toBe("S1.T2");
    store.bumpSession();
    expect(store.bumpTurn()).toBe("S2.T1");
  });
});

describe("commands: parse + gates", () => {
  const TURN = "You meet Vexcia at the counter. Kaelen waits at the East Gate.";

  it("parseia múltiplos comandos delimitados", () => {
    const cmds = parseCommands(
      `=== CREATE Vexcia.md ===\ncorpo A\n=== TIMELINE ===\n- evento`,
    );
    expect(cmds.map((c) => c.kind)).toEqual(["create", "timeline"]);
    expect(cmds[0]?.stem).toBe("Vexcia");
  });

  it("CREATE válido aplica com frontmatter normalizado pela engine", () => {
    const report = applyCommands(
      store,
      parseCommands(
        `=== CREATE Vexcia.md ===\n---\ntype: npc\n---\n# Vexcia\nAdministradora da guilda.`,
      ),
      TURN,
      "S1.T2",
    );
    expect(report.applied).toEqual(["CREATE Vexcia.md"]);
    const node = store.readNode("Vexcia");
    expect(node?.front.created).toBe("S1.T2");
    expect(node?.front.type).toBe("npc");
  });

  it("mention gate: nó não citado no turno é rejeitado", () => {
    const report = applyCommands(
      store,
      parseCommands(`=== CREATE Silas.md ===\n---\ntype: npc\n---\n# Silas\nMercador.`),
      TURN,
      "S1.T2",
    );
    expect(report.applied).toEqual([]);
    expect(report.rejected[0]?.reason).toContain("mention gate");
  });

  it("dedup gate: CREATE de nome fuzzy-existente sugere UPDATE", () => {
    store.writeNode("Vexcia", VEXCIA);
    const report = applyCommands(
      store,
      parseCommands(`=== CREATE Vexcia.md ===\n---\ntype: npc\n---\n# Vexcia\nDe novo.`),
      TURN,
      "S1.T2",
    );
    expect(report.rejected[0]?.reason).toContain("use UPDATE");
  });

  it("UPDATE preserva created e herda type quando o modelo omite", () => {
    store.writeNode("Vexcia", VEXCIA);
    const report = applyCommands(
      store,
      parseCommands(`=== UPDATE Vexcia.md ===\n# Vexcia\nAgora confia no Jão.`),
      TURN,
      "S2.T5",
    );
    expect(report.applied).toEqual(["UPDATE Vexcia.md"]);
    const node = store.readNode("Vexcia");
    expect(node?.front.created).toBe("S1.T1");
    expect(node?.front.updated).toBe("S2.T5");
    expect(node?.front.type).toBe("npc");
  });

  it("type inválido, off-grid e excesso de comandos são rejeitados", () => {
    const bad = applyCommands(
      store,
      parseCommands(`=== CREATE Vexcia.md ===\n---\ntype: dragon\n---\n# Vexcia\nx`),
      TURN,
      "S1.T2",
    );
    expect(bad.rejected[0]?.reason).toContain("unknown type");
    const off = applyCommands(
      store,
      parseCommands(`=== UPDATE Journal.md ===\nhistória reescrita`),
      TURN,
      "S1.T2",
    );
    expect(off.rejected[0]?.reason).toContain("off-grid");
    const many = applyCommands(
      store,
      parseCommands(
        Array.from({ length: 6 }, () => `=== TIMELINE ===\n- e`).join("\n"),
      ),
      TURN,
      "S1.T2",
    );
    expect(many.rejected.some((r) => r.reason.includes("cap"))).toBe(true);
  });

  it("output ilegível aplica nada e não corrompe", () => {
    const report = applyCommands(store, parseCommands("prosa sem comandos"), TURN, "S1.T2");
    expect(report.applied).toEqual([]);
    expect(store.listStems()).toEqual([]);
  });
});

describe("journal determinístico + routing", () => {
  it("durableJournalLines filtra o que vale memória e descarta ruído", () => {
    const lines = durableJournalLines([
      "1. Combat begins (round 1). Encounter: moderate (20/20 XP). Initiative: X.",
      "2. Dagger Strike: Jão vs Scavenger 1 → HIT for 2 piercing; Scavenger 1 22→20 HP.",
      "- Combat ends: VICTORY.",
      "- Use Healing Potion: FAILED — no such item.",
      "- A full night's rest: Jão recovers 10 HP (20→30) and wakes with renewed strength. The night passes.",
    ]);
    expect(lines.some((l) => l.includes("Combat begins"))).toBe(true);
    expect(lines.some((l) => l.includes("VICTORY"))).toBe(true);
    expect(lines.some((l) => l.includes("night's rest"))).toBe(true);
    expect(lines.some((l) => l.includes("Dagger Strike"))).toBe(false);
    expect(lines.some((l) => l.includes("FAILED"))).toBe(false);
  });

  it("relevantStems + knowledgeBlock capados e citando nós do turno", () => {
    store.writeNode("Vexcia", VEXCIA);
    store.appendJournal(["Conheceu Vexcia na guilda"], "S1.T1");
    expect(relevantStems(store.readMap(), "falo com vexcia sobre o contrato")).toEqual([
      "Vexcia",
    ]);
    const block = knowledgeBlock(store, "falo com vexcia sobre o contrato");
    expect(block).toContain("What your protagonist knows");
    expect(block).toContain("--- Vexcia ---");
    expect(block.length).toBeLessThanOrEqual(1700);
    expect(knowledgeBlock(new BrainStore(join(dir, "empty")), "oi")).toBe("");
  });
});

describe("write pass", () => {
  it("runWritePass aplica comandos do modelo injetado", async () => {
    const activity = await runWritePass({
      store,
      bundles: [
        {
          playerText: "I greet Vexcia and take the contract",
          mechanical: "",
          narration: "Vexcia hands you the brass token.",
        },
      ],
      stamp: "S1.T3",
      complete: async (prompt) => {
        expect(prompt).toContain("EXISTING MEMORY FILES");
        return `=== CREATE Vexcia.md ===\n---\ntype: npc\n---\n# Vexcia\nAdministradora da guilda.\n=== TIMELINE ===\n- Aceitou o contrato da guilda`;
      },
    });
    expect(activity.applied).toEqual(["CREATE Vexcia.md", "TIMELINE"]);
    expect(store.readOffGrid("Timeline")).toContain("[S1] Aceitou o contrato");
  });

  it("NOTHING_TO_SAVE e erro de infra não aplicam nada", async () => {
    const nothing = await runWritePass({
      store,
      bundles: [{ playerText: "x", mechanical: "", narration: "y" }],
      stamp: "S1.T3",
      complete: async () => "NOTHING_TO_SAVE",
    });
    expect(nothing.applied).toEqual([]);
    const broken = await runWritePass({
      store,
      bundles: [{ playerText: "x", mechanical: "", narration: "y" }],
      stamp: "S1.T3",
      complete: async () => {
        throw new Error("LLM server offline");
      },
    });
    expect(broken.error).toContain("offline");
    expect(store.listStems()).toEqual([]);
  });

  it("WritePassQueue coalesce turnos que chegam durante um pass", async () => {
    const batches: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const queue = new WritePassQueue(async (bundles) => {
      batches.push(bundles.length);
      if (batches.length === 1) await gate;
    });
    queue.push({ playerText: "1", mechanical: "", narration: "" });
    await new Promise((r) => setTimeout(r, 10));
    queue.push({ playerText: "2", mechanical: "", narration: "" });
    queue.push({ playerText: "3", mechanical: "", narration: "" });
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(batches).toEqual([1, 2]);
  });

  it("buildWritePrompt injeta o nó existente relevante", () => {
    store.writeNode("Vexcia", VEXCIA);
    const prompt = buildWritePrompt(store, [
      { playerText: "volto até Vexcia", mechanical: "", narration: "ela sorri" },
    ]);
    expect(prompt).toContain("=== CURRENT Vexcia.md ===");
    expect(prompt).toContain("NOTHING_TO_SAVE");
  });
});
