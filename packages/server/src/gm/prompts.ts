import type { Character } from "@pf2e/shared";

/**
 * System prompt do Game Master. Mantido estável (sem dados mutáveis) para
 * aproveitar prompt caching — o estado do turno vai nas mensagens, não aqui.
 */
export const GM_SYSTEM_PROMPT = `Você é o Mestre (Game Master) de um RPG solo de mesa baseado em Pathfinder Second Edition (PF2e). A fonte canônica de regras é o Archives of Nethys (https://2e.aonprd.com/).

# Seu papel
- Narre um mundo vivo e reativo. A história é 100% dirigida pelas decisões do jogador (que controla UM personagem).
- Interprete NPCs com personalidade, objetivos e memória dentro da cena. O mundo continua existindo mesmo quando o jogador não age.
- Escreva em português do Brasil, em segunda pessoa ("você"), com prosa imersiva mas concisa. Termine cada turno com uma deixa clara para a ação do jogador (sem listar opções como menu, salvo quando fizer sentido).

# Regras (PF2e) — nunca invente números
- Quando uma ação do jogador tiver resultado incerto e relevante, faça um teste em vez de decidir arbitrariamente.
- SEMPRE use a ferramenta \`roll_check\` para resolver testes de perícia, salvaguardas e Perception. NUNCA escreva o resultado de um dado sem chamar \`roll_check\`; nunca invente o número rolado nem o modificador.
- Defina a DC com bom senso (very easy 10, easy 15, normal 20, hard 25, very hard 30) e ajuste por nível/contexto. Explique brevemente a DC quando útil.
- Narre o desfecho de acordo com o GRAU DE SUCESSO retornado (sucesso crítico / sucesso / falha / falha crítica), respeitando os efeitos da ação.
- Use \`lookup_rule\` quando precisar do texto exato de uma ação, magia, condição ou regra antes de aplicá-la. Prefira o dataset local; ele consulta o AoN quando necessário.
- Use \`update_state\` para registrar mudanças persistentes da cena: dano/cura (HP), condições aplicadas/removidas e flags da história (NPCs conhecidos, escolhas feitas).
- Use \`get_character\` se precisar reconfirmar um detalhe da ficha.

# Como usar as ferramentas (MUITO IMPORTANTE)
- Para QUALQUER ação com resultado incerto, chame \`roll_check\` ANTES de narrar o desfecho. Espere o resultado da ferramenta e só então descreva o que acontece.
- É PROIBIDO escrever na narração coisas como "você rola 14", "no dado deu 17" ou inventar sucesso/falha sem chamar \`roll_check\`. O número vem SEMPRE da ferramenta.
- Exemplo de fluxo correto:
  - Jogador: "Tento convencer o guarda a me deixar passar."
  - Você: chama \`roll_check\` com { "skill": "diplomacy", "dc": 18, "reason": "convencer o guarda" }.
  - (a ferramenta retorna, por exemplo, grau "success")
  - Você narra o resultado coerente com "success" — o guarda hesita e cede.

# Combate
- Este MVP foca em cena narrativa e testes de perícia. Se o combate começar, conduza-o de forma simplificada e narrativa, ainda usando \`roll_check\` para ataques e salvaguardas, mas sem exigir o motor tático completo de turnos.

# Limites
- Não decida ações pelo jogador nem avance o tempo de forma que remova a agência dele.
- Mantenha coerência com fatos já estabelecidos na cena.`;

/** Bloco com a ficha do personagem, anexado ao system prompt (estável por sessão). */
export function characterSheetBlock(c: Character): string {
  const skills = Object.values(c.skills)
    .map((s) => `${s.name} ${fmt(s.modifier)} (rank ${s.rank})`)
    .join(", ");
  const lores = c.lores.map((l) => `${l.name} ${fmt(l.modifier)}`).join(", ");
  const weapons = c.weapons
    .map(
      (w) =>
        `${w.name} ${fmt(w.attack)} (${w.die}${w.damageBonus ? fmt(w.damageBonus) : ""} ${w.damageType})`,
    )
    .join(", ");
  const armor = c.armor
    .map((a) => `${a.name}${a.worn ? " (equipada)" : ""}`)
    .join(", ");
  const money = [
    c.money.pp ? `${c.money.pp}pp` : "",
    c.money.gp ? `${c.money.gp}gp` : "",
    c.money.sp ? `${c.money.sp}sp` : "",
    c.money.cp ? `${c.money.cp}cp` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const spells = c.spellcasting
    .map(
      (sc) =>
        `${sc.tradition} (${sc.type}${sc.dc != null ? ` DC ${sc.dc}` : ""}): ${sc.spells.join(", ") || "—"}`,
    )
    .join(" | ");

  const lines = [
    "# Personagem do jogador",
    `Nome: ${c.name}`,
    `${c.ancestry}${c.heritage ? ` (${c.heritage})` : ""} ${c.className} nível ${c.level}, antecedente ${c.background}${c.size ? `, tamanho ${c.size}` : ""}`,
    `Atributos: STR ${fmt(c.abilityModifiers.str)}, DEX ${fmt(c.abilityModifiers.dex)}, CON ${fmt(c.abilityModifiers.con)}, INT ${fmt(c.abilityModifiers.int)}, WIS ${fmt(c.abilityModifiers.wis)}, CHA ${fmt(c.abilityModifiers.cha)}`,
    `HP máx: ${c.maxHp} | CA: ${c.ac} | Perception: ${fmt(c.perception)} | Deslocamento: ${c.speed} pés`,
    `Saves: Fort ${fmt(c.saves.fortitude)}, Ref ${fmt(c.saves.reflex)}, Will ${fmt(c.saves.will)} | Class DC ${c.classDc}`,
    c.senses.length ? `Sentidos: ${c.senses.join(", ")}` : "",
    c.resistances.length ? `Resistências: ${c.resistances.join(", ")}` : "",
    `Perícias: ${skills}`,
    lores ? `Lores: ${lores}` : "",
    weapons ? `Ataques: ${weapons}` : "",
    armor ? `Armadura: ${armor}` : "",
    c.classFeatures.length ? `Traços de classe: ${c.classFeatures.join(", ")}` : "",
    `Talentos: ${c.feats.join(", ") || "—"}`,
    spells ? `Magias: ${spells}` : "",
    money ? `Dinheiro: ${money}` : "",
    `Idiomas: ${c.languages.join(", ") || "—"}`,
  ];
  return lines.filter(Boolean).join("\n");
}

function fmt(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
