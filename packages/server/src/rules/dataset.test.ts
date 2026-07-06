import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  activityFrequency,
  itemRecord,
  itemTraits,
  namedActivity,
  officialConditions,
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
});
