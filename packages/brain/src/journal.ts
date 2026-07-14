/**
 * Journaling DETERMINÍSTICO: a engine (não o modelo) appenda o esqueleto
 * mecânico da sessão no Journal — ground truth que nunca passa pelo 12B.
 * Melhoria central sobre o desenho do Lemma, exigida pela doutrina do projeto.
 */

/** Padrões de linhas do resumo mecânico que merecem memória durável. */
const DURABLE: RegExp[] = [
  /^-?\s*Combat begins/i,
  /Combat ends: (VICTORY|DEFEAT)/i,
  /Recovery check:.*(STABILIZES|DIES)/i,
  /^-?\s*Use .+: .*(healed|Strike|for \d+)/i,
  /^-?\s*Casts /i,
  /^-?\s*A full night's rest/i,
  /^-?\s*Treat Wounds/i,
  /^-?\s*Reinforcements join/i,
];

/** Ruído que nunca entra (rejeições/erros já aparecem no activity feed). */
const NOISE = /FAILED|NOT done|ILLEGAL|REJECTED/i;

/**
 * Filtra as linhas numeradas do resumo mecânico para o Journal. Entrada crua
 * ("- Combat begins (round 1). ..." ou "1. Combat ends: VICTORY."); saída
 * limpa, sem numeração, pronta para appendJournal.
 */
export function durableJournalLines(summaryLines: string[]): string[] {
  const out: string[] = [];
  for (const raw of summaryLines) {
    const line = raw.replace(/^\s*(?:\d+\.|-)\s*/, "").trim();
    if (!line || NOISE.test(line)) continue;
    if (DURABLE.some((re) => re.test(line))) {
      out.push(line.length > 160 ? `${line.slice(0, 157)}…` : line);
    }
  }
  return out;
}
