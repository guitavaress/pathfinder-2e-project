# CLAUDE.md — guia do projeto para agentes

RPG solo de Pathfinder 2e, web, 100% local (LM Studio, custo zero de API). Monorepo
npm workspaces: `packages/shared` (tipos zod), `packages/brain` (grafo de memória em
markdown), `packages/server` (Express + agente GM), `packages/web` (React/Vite, SSE).

## Doutrinas do projeto (não negociáveis)

1. **Engine garante, prompt reforça.** Com modelo local 12B, toda regra que importa
   ganha enforcement em código (`packages/server/src/gm/combat.ts` + guards em
   `agent.ts`). Prompt é mitigação, nunca garantia. Tools validam entrada — jamais
   aceitar default silencioso (o bug clássico: `dc ?? 0` fabricava crits).
2. **Classificar antes de corrigir.** Toda falha do GM é diagnosticada como
   [MODELO] × [CÓDIGO] × [FALTA DE DEFINIÇÃO] antes do fix. Fix de prompt que
   reincide é promovido a código (escada de escalação).
3. **Regras como DADOS.** O dataset Foundry (`data/pf2e/generated/`, gerado por
   `npm run data:pf2e`) traz campos estruturados (actionType, actionCost, traits).
   A engine lê o dado (ex.: `multiActionCost`), não confia no modelo interpretar prosa.
4. **Estado nunca mente.** O narrador recebe os resultados mecânicos numerados como
   última mensagem e é proibido de inventar/inverter; o que não está nas linhas
   não aconteceu. Cura/dano/itens sem fonte na ficha são rejeitados pela engine.

## Fluxos e restrições

- **Nunca** deixar `dev:server` rodando em background (colide com o :3001 do usuário).
  Servidores temporários de teste usam a porta **3101** e são derrubados ao final.
- `.env`, `LORE.md`, `WORLD.md`, `data/pf2e/generated/`, `/brain/`, `/brain-archive-*/`
  e `/scene-images/` são **gitignorados** — nunca commitá-los.
- Não mergear na `main` sem aprovação explícita do usuário (ele play-testa antes).
- Baterias longas de GPU (auditorias com o modelo) só iniciam com OK explícito.

## Comandos

```bash
npm test                 # unit tests (vitest, packages/server + packages/brain)
npm run build            # tsc + vite em todos os workspaces
npm run data:pf2e        # (re)gera o dataset de regras do foundryvtt/pf2e
# Auditoria de feats (suite de regressão do GM — usa GPU/LM Studio):
cd packages/server
npx tsx scripts/feat-audit/classify-feats.ts     # classifica os 7039 feats
npx tsx scripts/feat-audit/select-battery.ts     # regenera battery.json (sobrescreve!)
npx tsx scripts/feat-audit/run-feat-tests.ts     # roda a bateria (--side/--archetype/--feat/--fresh)
```

## Arquitetura do turno (GM)

`runTurn` = 2 estágios com o MESMO modelo residente (contextos separados):
1. **Rules** (`runRulesStage`): tool loop (roll_check, cast_spell, rest,
   start_combat, end_combat, end_turn, spend_actions, use_item, update_state,
   lookup_rule, get_character) → resumo mecânico determinístico. `rest` cura
   com as regras reais (overnight: CON×nível + slots/focus; Treat Wounds:
   Medicine check DC 15 com toolkit) — cura inventada via `update_state` é
   rejeitada dentro e fora de combate. Em combate: 1 mensagem do
   jogador = 1 turno completo (3 ações; engine cobra custos, aplica dano, resolve
   o revide inimigo em código, roda dying/recovery checks quando o jogador cai).
   Inimigos nomeados usam o **statblock oficial do bestiary** (`creatureRecord` —
   AC/HP/saves/ataques reais; nível oficial vence o palpite do modelo; nome
   genérico/inventado cai no benchmark por nível). Dano persistente ticka no fim
   da rodada (dano → flat check DC 15, `tickPersistentDamage`). **Reações**
   (Reactive Strike/AoO do statblock) disparam em código quando o jogador usa
   item/conjura/se move e consomem `reactionAvailable`. `cast_spell` valida a
   magia na ficha, gasta slot/focus real (cantrip auto-heightened) e resolve
   spell attack vs AC ou save REAL do alvo vs DC com dano estruturado
   (`spellRecord`); inimigo caster conjura 1x por combate, deterministicamente.
   `start_combat` impõe o **orçamento de XP do encontro** (GM Core) para o
   tamanho REAL da party (`planEncounter` em combat.ts — solo: moderate 20 XP,
   teto extreme 40): corta excedente criatura a criatura, nunca começa combate
   vazio, PL+5 nunca entra, inimigos derrotados seguem contando contra reforços
   (anti-onda) e criatura rebaixada pelo orçamento perde o statblock (stats não
   mentem).
2. **Narrative** (`runNarrativeStage`): narra o resumo (streaming), temperatura
   menor em combate, sem tools.

SSE: `delta`/`check`/`state`/`phase`/`done`/`error`; o combate vai dentro de `state`.

## Brain e continuidade de campanha

Pós-`done`, um **write pass** coalescido (fila single-flight em `gm/brain.ts`) deixa o
modelo gravar o turno como grafo markdown em `brain/` (gitignorado): nós em
`brain/nodes/*.md` (front-matter + `## Log` carimbado S.T + `## Connections` wikilinks);
off-grid (Journal/Timeline/Protagonist/map.json/meta.json/save.json) na raiz. Gates em
`packages/brain/src/commands.ts` rejeitam lixo (mention gate, nome inválido, dedup de nó,
TIMELINE quase-duplicada por Jaccard ≥0.6) — rejeição é auditável no activity feed (âmbar
na UI), nunca silenciosa. UI "Grimório da Memória" abre com a tecla B.

Continuidade (`gm/save.ts` + `gm/recap.ts` + rotas em `http/server.ts`): `saveSession`
grava `brain/save.json` após cada turno (personagem + estado + cauda de 30 msgs).
`GET /campaign` alimenta o card "Continue campaign"; `POST /campaign/continue` restaura a
sessão e é (junto com nova campanha) o **único** dono do `brainBumpSession` — S conta
sentadas reais, não imports. Turno vazio com `session.resumed` usa `resumeKickoff`: a
engine monta o recap (`buildRecapData`: cauda da Timeline + quests ativas + última cena) e
o modelo só narra — o que não está no recap não aconteceu. Import com campanha existente
**arquiva** o brain em `brain-archive-<data>/` (nunca apaga).
