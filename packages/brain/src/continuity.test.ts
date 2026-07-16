/**
 * Testes da organização do brain para a continuidade de campanha:
 * migração do layout plano → nodes/ e dedup gate da Timeline.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyCommands, isNearDuplicateTimeline } from "./commands.js";
import { BrainStore } from "./store.js";

let dir: string;
let store: BrainStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-cont-"));
  store = new BrainStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NODE = (name: string, type = "npc") => `---
created: S1.T1
updated: S1.T1
type: ${type}
---
# ${name}
Descrição de ${name}.

## Log
- [S1.T1] Apareceu.

## Connections
`;

describe("store: migração do layout plano para nodes/", () => {
  it("move nós da raiz para nodes/ e preserva off-grid na raiz", () => {
    // Layout ANTIGO montado à mão: nós .md na raiz, sem nodes/.
    writeFileSync(join(dir, "Vexcia.md"), NODE("Vexcia"));
    writeFileSync(join(dir, "Chapel.md"), NODE("Chapel", "place"));
    writeFileSync(join(dir, "Journal.md"), "# Journal\n- [S1.T1] linha\n");
    writeFileSync(join(dir, "Timeline.md"), "# Timeline\n- [S1] evento\n");
    writeFileSync(join(dir, "Protagonist.md"), "# Jão\nGoblin Rogue.\n");
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ session: 3, turn: 7 }));

    store.ensureInit();

    expect(existsSync(join(dir, "nodes", "Vexcia.md"))).toBe(true);
    expect(existsSync(join(dir, "nodes", "Chapel.md"))).toBe(true);
    expect(existsSync(join(dir, "Vexcia.md"))).toBe(false);
    // Off-grid fica na raiz, intocado.
    expect(readFileSync(join(dir, "Journal.md"), "utf8")).toContain("linha");
    expect(existsSync(join(dir, "nodes", "Journal.md"))).toBe(false);
    expect(existsSync(join(dir, "Protagonist.md"))).toBe(true);
    // Grafo continua funcionando pós-migração.
    expect(store.listStems()).toEqual(["Chapel", "Vexcia"]);
    expect(store.readNode("Vexcia")?.front.type).toBe("npc");
    expect(Object.keys(store.readMap()).sort()).toEqual(["Chapel", "Vexcia"]);
    expect(store.meta()).toEqual({ session: 3, turn: 7 });
  });

  it("é idempotente e escreve nós novos direto em nodes/", () => {
    store.ensureInit();
    store.ensureInit(); // segunda chamada não pode quebrar nada
    const write = store.writeNode("Kaelen", NODE("Kaelen"));
    expect(write.ok).toBe(true);
    expect(existsSync(join(dir, "nodes", "Kaelen.md"))).toBe(true);
    expect(store.listStems()).toEqual(["Kaelen"]);
  });
});

describe("commands: dedup gate da TIMELINE", () => {
  // Duplicatas REAIS da campanha do usuário (S3, 2026-07-13).
  const EXISTING = [
    '- [S3] The protagonist successfully delivered the "message" and received payment from the Administrator.',
    "- [S3] The Administrator revealed the existence of high-risk special contracts to the protagonist.",
  ];

  it("detecta a recontagem real do pagamento como quase-duplicata", () => {
    expect(
      isNearDuplicateTimeline(
        "- The protagonist delivered the message and received payment from the Administrator.",
        EXISTING,
      ),
    ).toBe(true);
  });

  it("evento genuinamente novo passa", () => {
    expect(
      isNearDuplicateTimeline(
        "- The protagonist descended into the Lower Sump at dawn.",
        EXISTING,
      ),
    ).toBe(false);
  });

  it("applyCommands rejeita TIMELINE toda duplicada e mantém a parcial", () => {
    store.ensureInit();
    store.bumpSession();
    store.appendTimeline(EXISTING, "S3.T1");

    // Comando 100% duplicata → rejeitado, nada appendado.
    const dup = applyCommands(
      store,
      [
        {
          kind: "timeline",
          body: "- The protagonist delivered the message and received payment from the Administrator.",
        },
      ],
      "turn text",
      "S3.T2",
    );
    expect(dup.applied).toEqual([]);
    expect(dup.rejected[0]?.reason).toContain("near-duplicate");

    // Comando misto → linha nova entra, duplicata é pulada (e auditada).
    const mixed = applyCommands(
      store,
      [
        {
          kind: "timeline",
          body:
            "- The Administrator revealed high-risk special contracts to the protagonist.\n" +
            "- The protagonist set out toward the Clockwork Ruins.",
        },
      ],
      "turn text",
      "S3.T3",
    );
    expect(mixed.applied).toEqual(["TIMELINE"]);
    expect(mixed.rejected[0]?.reason).toContain("near-duplicate line(s) skipped");
    const timeline = store.readOffGrid("Timeline");
    expect(timeline).toContain("set out toward the Clockwork Ruins");
    expect(timeline.match(/revealed/g)?.length).toBe(1);
  });
});
