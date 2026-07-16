import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainStore } from "@pf2e/brain";
import { buildRecapData, resumeKickoff } from "./recap.js";
import type { SaveGame } from "./save.js";

let dir: string;
let store: BrainStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recap-"));
  store = new BrainStore(dir);
  store.ensureInit({ name: "Jão", summary: "Goblin Rogue." });
  store.bumpSession();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const QUEST = (name: string, status: string) => `---
created: S3.T1
updated: S3.T2
type: quest
status: ${status}
---
# ${name}
Contrato de exploração das ruínas.

## Log
- [S3.T2] Accepted the contract from the Administrator.

## Connections
`;

function fakeSave(narration: string): SaveGame {
  return {
    version: 1,
    savedAt: "2026-07-14T00:00:00.000Z",
    character: {} as SaveGame["character"],
    state: {} as SaveGame["state"],
    messages: [
      { role: "user", content: "I ask about the pay." },
      { role: "assistant", content: narration },
    ],
  };
}

describe("buildRecapData", () => {
  it("junta timeline, quests ativas e a última cena do save", () => {
    store.appendTimeline(["- The protagonist reached Cinzalto."], "S3.T1");
    store.writeNode("Clockwork Contract", QUEST("Clockwork Contract", "active"));
    store.writeNode("Old Debt", QUEST("Old Debt", "resolved"));

    const recap = buildRecapData(store, fakeSave("The Administrator slides the key across the desk."));
    expect(recap).toContain("Recent events:");
    expect(recap).toContain("reached Cinzalto");
    expect(recap).toContain("Open quests:");
    expect(recap).toContain("Clockwork Contract");
    expect(recap).toContain("Accepted the contract");
    // Quest resolvida NÃO entra no recap.
    expect(recap).not.toContain("Old Debt");
    expect(recap).toContain("The last scene ended like this:");
    expect(recap).toContain("slides the key");
  });

  it("sem save ainda monta recap do brain (e vazio vira string vazia)", () => {
    expect(buildRecapData(store, null)).toBe("");
    store.appendTimeline(["- Something happened."], "S1.T1");
    const recap = buildRecapData(store, null);
    expect(recap).toContain("Something happened");
    expect(recap).not.toContain("last scene");
  });
});

describe("resumeKickoff", () => {
  it("embute o recap e proíbe inventar fora dele", () => {
    const kickoff = resumeKickoff("Recent events:\n- X happened.");
    expect(kickoff).toContain("X happened");
    expect(kickoff).toContain("do not invent events absent from it");
    expect(kickoff).toContain("Previously");
  });
});
