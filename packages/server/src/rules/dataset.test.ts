import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  activityFrequency,
  creatureRecord,
  itemRecord,
  itemTraits,
  namedActivity,
  officialConditions,
  spellRecord,
} from "./dataset.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

// Estes testes leem o dataset gerado (gitignorado) — em um clone fresco sem
// `npm run data:pf2e` eles não têm o que validar e são pulados.
describe.skipIf(!hasGenerated)("dataset (requer generated/)", () => {
  describe("itemRecord / itemTraits", () => {
    it("acha a Dagger com o trait agile e statblock", () => {
      const traits = itemTraits("Dagger");
      expect(traits).toContain("agile");
      expect(traits).toContain("finesse");
      expect(itemRecord("Dagger")?.damage).toEqual({
        dice: 1,
        die: "d4",
        type: "piercing",
      });
    });

    it("Longsword NÃO é agile", () => {
      const traits = itemTraits("Longsword");
      expect(traits.length).toBeGreaterThan(0); // achou o item
      expect(traits).not.toContain("agile");
    });

    it("ignora prefixos de runas (+1 Striking Dagger → Dagger)", () => {
      expect(itemTraits("+1 Striking Dagger")).toContain("agile");
    });

    it("resolve a variante mais fraca ('alchemist's fire' → Lesser)", () => {
      const bomb = itemRecord("alchemist's fire");
      expect(bomb?.name).toBe("Alchemist's Fire (Lesser)");
      expect(bomb?.damage).toEqual({ dice: 1, die: "d8", type: "fire" });
      expect(bomb?.splash).toBe(1);
      expect(bomb?.persistent).toEqual({ number: 1, faces: null, type: "fire" });
      expect(bomb?.range).toBe(20);
      expect(bomb?.weaponCategory).toBe("martial");
      expect(bomb?.traits).toContain("bomb");
    });

    it("retorna vazio para item desconhecido", () => {
      expect(itemTraits("zzz-nonexistent-item-zzz")).toEqual([]);
    });
  });

  describe("activityFrequency", () => {
    it("detecta uma atividade once-per-round citada no texto", () => {
      const f = activityFrequency("I use Sharpened Senses to find the thief");
      expect(f?.name).toBe("sharpened senses");
      expect(f?.max).toBe(1);
      expect(f?.per).toBe("round");
    });

    it("null quando o texto não cita atividade com frequency", () => {
      expect(activityFrequency("I attack with my dagger")).toBeNull();
    });
  });

  describe("namedActivity", () => {
    it("detecta uma atividade ativa citada na mensagem do jogador", () => {
      expect(namedActivity("Here at the tavern, I use Goblin Song.")).toBe("Goblin Song");
      expect(namedActivity("I try Battle Medicine on my ally")).toBe("Battle Medicine");
    });

    it("null para mensagem sem atividade nomeada", () => {
      expect(namedActivity("I walk into the tavern and order an ale")).toBeNull();
    });
  });

  describe("officialConditions", () => {
    it("contém as 44 oficiais (lowercase)", () => {
      const set = officialConditions();
      expect(set.size).toBe(44);
      expect(set.has("frightened")).toBe(true);
      expect(set.has("off-guard")).toBe(true);
      expect(set.has("dying")).toBe(true);
      expect(set.has("companion: cat")).toBe(false);
    });
  });

  describe("creatureRecord (bestiary com statblock)", () => {
    it("Giant Rat: statblock real completo", () => {
      const rec = creatureRecord("Giant Rat");
      expect(rec?.name).toBe("Giant Rat");
      expect(rec?.level).toBe(-1);
      const sb = rec?.statblock;
      expect(sb).toMatchObject({ ac: 15, hp: 8, perception: 5 });
      expect(sb?.saves).toEqual({ fortitude: 6, reflex: 7, will: 3 });
      const jaws = sb?.attacks[0];
      expect(jaws?.name).toBe("Jaws");
      expect(jaws?.bonus).toBe(7);
      expect(jaws?.damage).toEqual([{ formula: "1d6+1", type: "piercing" }]);
      expect(jaws?.traits).toContain("agile");
      expect(jaws?.traits).toContain("finesse");
    });

    it("Goblin Warrior: 2 ataques (ranged marcado) e reaction na abilitiesList", () => {
      const sb = creatureRecord("Goblin Warrior")?.statblock;
      const names = sb?.attacks.map((a) => a.name);
      expect(names).toEqual(["Dogslicer", "Shortbow"]);
      expect(sb?.attacks[0]?.rangeIncrement).toBeUndefined();
      expect(sb?.attacks[1]?.rangeIncrement).toBe(60);
      // Contrato de dados do PR3 (reactions): a habilidade vem estruturada.
      const scuttle = sb?.abilitiesList.find((a) => a.name === "Goblin Scuttle");
      expect(scuttle?.actionType).toBe("reaction");
    });

    it("Goblin War Chanter: spellcasting estruturado (contrato do PR4)", () => {
      const casting = creatureRecord("Goblin War Chanter")?.statblock?.spellcasting;
      expect(casting?.[0]?.dc).toBe(17);
      expect(casting?.[0]?.tradition).toBe("occult");
      expect(casting?.[0]?.spells.length).toBeGreaterThan(0);
    });

    it("normaliza sufixo de instância, plural e parêntese", () => {
      expect(creatureRecord("Goblin Warrior 2")?.name).toBe("Goblin Warrior");
      expect(creatureRecord("Giant Rats")?.name).toBe("Giant Rat");
      expect(creatureRecord("Rat Swarm (Large)")?.name).toBe("Rat Swarm");
    });

    it("nome decorado resolve pelo match mais específico contido na query", () => {
      expect(creatureRecord("elite Goblin Warrior")?.name).toBe("Goblin Warrior");
    });

    it("genérico NUNCA liga a um NPC específico nem cruza categoria", () => {
      // "Thug" não pode virar "Scarlet Triad Thug" (level 7).
      expect(creatureRecord("Thug")).toBeNull();
      // Spell homônimo jamais vira statblock de inimigo.
      expect(creatureRecord("Fireball")).toBeNull();
      expect(creatureRecord("zzz-not-a-creature")).toBeNull();
    });
  });

  describe("spellRecord (magias com mecânica estruturada)", () => {
    it("Fireball: save reflex basic, 6d6 fire, heighten +2d6, área", () => {
      const s = spellRecord("Fireball")?.spell;
      expect(s?.rank).toBe(3);
      expect(s?.cantrip).toBe(false);
      expect(s?.castActions).toBe("2");
      expect(s?.defense).toEqual({ save: "reflex", basic: true });
      expect(s?.damage).toEqual([{ formula: "6d6", type: "fire", kinds: ["damage"] }]);
      expect(s?.heighten).toEqual({ interval: 1, add: ["2d6"] });
      expect(s?.area).toBe("20-foot burst");
    });

    it("Ignition: cantrip de ataque com heighten +1d4", () => {
      const s = spellRecord("Ignition")?.spell;
      expect(s?.cantrip).toBe(true);
      expect(s?.attack).toBe(true);
      expect(s?.damage[0]?.formula).toBe("2d4");
      expect(s?.heighten).toEqual({ interval: 1, add: ["1d4"] });
    });

    it("Heal: kinds distingue cura de dano", () => {
      const s = spellRecord("Heal")?.spell;
      expect(s?.damage[0]?.kinds).toContain("healing");
    });

    it("nome desconhecido/categoria errada → null", () => {
      expect(spellRecord("Giant Rat")).toBeNull();
      expect(spellRecord("zzz-not-a-spell")).toBeNull();
    });
  });
});
