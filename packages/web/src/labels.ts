import type { Ability } from "@pf2e/shared";

/** Ability labels (3-letter abbreviation). */
export const ABILITY_LABEL: Record<Ability, string> = {
  str: "STR",
  dex: "DEX",
  con: "CON",
  int: "INT",
  wis: "WIS",
  cha: "CHA",
};

/** Display labels for the 16 standard skills. */
export const SKILL_LABEL: Record<string, string> = {
  acrobatics: "Acrobatics",
  arcana: "Arcana",
  athletics: "Athletics",
  crafting: "Crafting",
  deception: "Deception",
  diplomacy: "Diplomacy",
  intimidation: "Intimidation",
  medicine: "Medicine",
  nature: "Nature",
  occultism: "Occultism",
  performance: "Performance",
  religion: "Religion",
  society: "Society",
  stealth: "Stealth",
  survival: "Survival",
  thievery: "Thievery",
};

export const skillLabel = (name: string): string =>
  SKILL_LABEL[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
