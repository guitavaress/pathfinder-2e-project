# CLAUDE.md — guia do projeto para agentes

RPG solo de Pathfinder 2e, web, 100% local (llama.cpp, custo zero de API). Monorepo
npm workspaces: `packages/shared` (tipos zod), `packages/brain` (grafo de memória em
markdown), `packages/server` (Express + agente GM), `packages/web` (React/Vite, SSE).

## Doutrinas do projeto (não negociáveis)

1. **Engine garante, prompt reforça.** Com modelo local 12B, toda regra que importa
   ganha enforcement em código (`packages/server/src/gm/combat.ts` + guards em
   `agent.ts`). Prompt é mitigação, nunca garantia. Tools validam entrada — jamais
   aceitar default silencioso (o bug clássico: `dc ?? 0` fabricava crits). O
   contrato de argumentos das tools tem **fonte única** em
   `gm/tool-schemas.ts` (zod manda; o JSON Schema mandado ao modelo é derivado
   dele) — ver ADR-006 para por que o enforcement é client-side e não GBNF. Vale
   também para o backend: samplers vão fixados em código (`SAMPLERS` no
   `agent.ts`), não herdados dos defaults de quem serve o modelo.
   **`validateToolArgs` roda no dispatch, dentro de `dispatchToolCall`** — de
   25/07 a 15/08/2026 ela existia, era testada e NUNCA era chamada, e nenhum
   teste podia pegar isso porque o laço de tool calls só roda com o llama-server
   no ar (ADR-012). Regra que ficou: **comportamento atrás de dependência externa
   precisa de unidade testável sem ela**.
2. **Classificar antes de corrigir.** Toda falha do GM é diagnosticada como
   [MODELO] × [CÓDIGO] × [FALTA DE DEFINIÇÃO] antes do fix. Fix de prompt que
   reincide é promovido a código (escada de escalação).
3. **Regras como DADOS.** O dataset Foundry (`data/pf2e/generated/`, gerado por
   `npm run data:pf2e`) é o import TOTAL do core @ 7.8.0 (ADR-007): 27.940 docs
   em 22 categorias (inclui hazards, effects, heritages…), com `system.rules`
   (rule elements) VERBATIM, taxonomia nativa de feats (`featCategory`), grafo de
   uuids e `manifest.json` como prova de zero perda. A engine lê o dado (ex.:
   `multiActionCost`, `costProfileOf`), não confia no modelo interpretar prosa —
   e cada consumo novo de rule element nasce como tarefa própria com teste.
   **A ponte é `rules/roll-context.ts`** (estado do turno → vocabulário do dado),
   `rules/predicate.ts` avalia e `rules/actor-modifiers.ts` + `condition-modifiers.ts`
   aplicam. Duas invariantes do ADR-008 mandam aqui: **indecidível não aplica**
   (predicado que o contexto não decide não vira bônus, e sai declarado em
   `skipped`) e **não-duplo-cômputo** (o Pathbuilder já exporta AC/saves/perícias
   finais; em seletor da ficha só entra `FlatModifier` COM predicado). A exceção,
   do ADR-009, é o **efeito ativo** (`rules/active-effects.ts` +
   `GameState.effects`): temporário, logo nunca embutido no export, logo o
   incondicional dele entra. Efeito só existe se o dado o conhece E a ficha o
   autoriza, e **expira em código** — efeito que não expira é bônus permanente
   inventado. Cobertura medida a cada `npm test` nas linhas `[T5]`/`[T6]` de
   `rules/dataset-conformance.test.ts`: hoje **4 keys de 38, 3.548 rule elements
   alcançáveis (21%)** e 567 efeitos concedíveis.
4. **Estado nunca mente.** O narrador recebe os resultados mecânicos numerados como
   última mensagem e é proibido de inventar/inverter; o que não está nas linhas
   não aconteceu. Cura/dano/itens sem fonte na ficha são rejeitados pela engine.
   **Vale também para o que a engine NÃO faz** (ADR-012): habilidade da ficha que
   ela reconhece mas não executa é DECLARADA — linha própria no resumo e evento
   `adjudicated` ao jogador (`rules/coverage.ts` → `adjudicationFor`). Medido:
   **61,3% das entradas de uma ficha caem nesse caso**, porque 52,6% dos feats do
   PF2e são prosa pura em QUALQUER fonte (o Foundry também não os automatiza). O
   alvo do projeto não é automatizar tudo — é ser impecável em saber o que sabe.
   A linha `[T9]` de `rules/coverage.test.ts` mede a cada `npm test`
   (MECANIZADO 25,4% · DECLARADO 13,3% · CEGO 61,3%), com **teto congelado**: o
   balde CEGO pode encolher, nunca crescer.

## Fluxos e restrições

- **Nunca** deixar `dev:server` rodando em background (colide com o :3001 do usuário).
  Servidores temporários de teste usam a porta **3101** e são derrubados ao final.
- `.env`, `LORE.md`, `WORLD.md`, `data/pf2e/generated/`, `/brain/`, `/brain-archive-*/`
  e `/scene-images/` são **gitignorados** — nunca commitá-los.
- Não mergear na `main` sem aprovação explícita do usuário (ele play-testa antes).
- Baterias longas de GPU (auditorias com o modelo) só iniciam com OK explícito.

## Modelo (llama.cpp, desde 2026-07-16)

`llama-server` no WSL com `gemma-4-12b-it` Q4 + draft MTP, `-c 65536`, KV `q8_0`,
`--jinja` (**sem isso não há tool calling — o rules stage inteiro morre**),
`--reasoning off`, bind `127.0.0.1:1234`. Sobe/desce com `gemma-up`/`gemma-down`
(`~/.local/bin`). `LLM_BASE_URL` no `.env` usa **`127.0.0.1`, nunca `localhost`**
(bind é IPv4-only e no WSL2 `localhost` cai em `::1`). llama.cpp **ignora** o campo
`model` do request — serve o GGUF carregado; `GM_MODEL` só alimenta o `/health`.
Não tem JIT load: servidor fora do ar = jogo fora do ar, sem fallback.
Medido nesta máquina: ~116 tok/s de geração, ~2200 tok/s de prefill.

## Comandos

```bash
gemma-up / gemma-down    # sobe/derruba o llama-server (porta 1234)
npm test                 # unit tests (vitest, packages/server + packages/brain)
npm run build            # tsc + vite em todos os workspaces
npm run sim              # BATERIA DE SIMULAÇÃO — rodar a cada PR (sem GPU, ~1s)
npm run data:pf2e        # (re)gera o dataset de regras do foundryvtt/pf2e
# Auditoria de feats (suite de regressão do GM — usa GPU/llama.cpp):
cd packages/server
npx tsx scripts/feat-audit/classify-feats.ts     # classifica os 7039 feats
npx tsx scripts/feat-audit/select-battery.ts     # regenera battery.json (sobrescreve!)
npx tsx scripts/feat-audit/run-feat-tests.ts     # roda a bateria (--side/--archetype/--feat/--fresh)
```

## Arquitetura do turno (GM)

`runTurn` = 2 estágios com o MESMO modelo residente (contextos separados). Janelas
de histórico dimensionadas para os 64k (`RULES_CONTEXT_TURNS=16`,
`NARRATIVE_CONTEXT_MESSAGES=80`, `SAVE_MESSAGE_TAIL=80` acompanha o narrador):
1. **Rules** (`runRulesStage`): tool loop (roll_check, cast_spell, rest,
   start_combat, end_combat, end_turn, spend_actions, use_item, update_state,
   manage_companion, lookup_rule, get_character) → resumo mecânico
   determinístico. `lookup_rule` desambigua nome colidido em três forças
   (ADR-010, `rules/sheet-lookup.ts`): **referência que o jogador fixou na
   paleta `@`** (`refs` no turno, viva um turno só) → **portão da ficha**
   (172 das 309 colisões, em código) → índice, com homônimos sempre listados.
   `rest` cura
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

SSE: `delta`/`check`/`state`/`phase`/`adjudicated`/`done`/`error`; o combate vai
dentro de `state`. `adjudicated` (ADR-012) é a habilidade da ficha que a engine
reconhece e não executa — some do log quando o que foi citado é mecanizado.

**Cobertura de ficha** (`rules/coverage.ts`): `auditCharacter` classifica cada
entrada da ficha em MECANIZADO / DECLARADO / CEGO, estaticamente — o runtime não
emite sinal (`ToolOutcome` não tem campo de "mecanizei"), então a auditoria
replica os portões e lê o `.skipped` de `actorModifiersFor`, que produção
calcula e descarta. `rules/corpus.ts` gera fichas do dataset real, **seeded**,
para a suíte parar de medir sempre o mesmo personagem — sem substituir as
fixtures truncadas, que provam "ausência ≠ falso" e um corpus não reproduz.

## Companheiros (Fase 2 / ADR-004)

Companheiro é **engine**; o modelo só recruta (`manage_companion` join/leave) e
dubla a fala. Roster em `GameState.companions` (persistido no save), stats
resolvidos e CONGELADOS no recrutamento (statblock oficial ou benchmark), teto de
party 4 (`MAX_PARTY_SIZE`). Entram sozinhos no `start_combat` como `kind:"ally"`
— e o orçamento de XP escala com a party real. `resolveAllyTurns` roda o turno
deles em código (2 Strikes, MAP, statblock via `sourceName`); o revide inimigo
distribui golpes por round-robin entre os defensores vivos (**sem aliados o
comportamento é o de sempre**). Só o JOGADOR tem dying/estado de sessão: aliado a
0 HP fica `defeated`. `syncCompanions` leva ferida de combate de volta ao roster
todo turno. A fala passa pelo gate `gm/voice-gate.ts`: **no máximo uma persona por
turno** (evento mecânico > menção > banter > silêncio) — sem gate as vozes somem,
com gate não há degradação até 4 (bench em `scripts/voice-bench/`).

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

## Evolução do projeto — leia antes de mexer em arquitetura

**Régua (inegociável):** mecânica em código, voz no LLM. Todo estado que exige
precisão (números, condições, posição, dano persistente, custo de ação, dying)
mora em código determinístico e testado. O modelo só chama tools e narra.

**Antes de qualquer mudança de arquitetura, ou ao pegar trabalho do roadmap, leia
`docs/DECISOES-E-CONTEXTO.md` (os porquês / ADRs) e `docs/ROADMAP.md` (as fases).**

Regras de trabalho:
- Uma fase / uma tarefa por vez. Nada de frentes paralelas.
- **A cada PR, rodar `npm run sim`** (decisão do usuário, 2026-08-15). É a
  bateria de simulação: personagens de NÍVEL 20 gerados do dataset jogam um dia
  de aventura completo contra criaturas oficiais do bestiary, e ~4.600
  invariantes são verificadas passo a passo. Sem GPU, ~1s, determinística
  (`--seed=`, `--chars=`, `--level=`, `--verbose`). Sai com código 1 em qualquer
  violação. Ela responde UMA pergunta — *a engine se contradiz?* — e não
  substitui play-test: cena, ritmo e voz continuam exigindo o jogador.
  Ao mexer no turno, a bateria e o `runRulesStage` **compartilham**
  `resolveRoundEnd`/`beginPlayerRound` de propósito: copiar a sequência faria a
  bateria medir uma ficção que diverge do código real.
- Todo comportamento mecânico novo nasce com teste e estende a bateria feat-audit.
  O piso vigente é **709 testes do servidor** (+31 do brain, medido em 2026-08-15)
  e, na bateria, **69 PASS · 3 FLAKY ·
  1 SUSPECT · 2 FAIL com cobertura de asserção 40/75** (gate de **2026-08-14**,
  pós-Fases 2.5/2.6, `--repeat=3` contra o commit 8dafee6; juiz honesto — NÃO
  comparável com os 75/75 antigos). Piso, não meta.
  Os 2 FAIL são as reações não implementadas (`Shield Block` precisa de hardness
  estruturado, `Clever Gambit`) e o SUSPECT é `Exotic Edge` — dívida declarada.
  Os FLAKY são [MODELO]: o modelo resolve a atividade por `roll_check` com o
  combate inativo, e fora de combate a engine não cobra ações.
  A bateria **não** exercita a paleta da Fase 2.7 (manda prosa direto, sem
  `refs`) nem os efeitos ativos da 2.6 — medir os dois exige cenários novos
  (é a Fase 2.9).
- Se uma tarefa contradisser uma decisão registrada nos ADRs, PARE e sinalize.
  **Precedente vivo (ADR-011, 2026-08-15):** a Fase 3 pedia "grid + tokens no
  HUD", que é a cláusula de revisitar do ADR-001 escrita como tarefa. A medição
  matou a ideia (a geometria vale <1% dos rule elements; as 166 reações
  posicionais pedem relação binária e evento, não coordenada) e o usuário
  retirou o plano da Fase 3 em diante para repensar a direção.
- **O roadmap vivo vai até a Fase 2.9** — **2.8** (deadly/fatal + runas + a
  decisão de ADR do item investido) e **2.9** (a bateria voltar a medir as Fases
  2.6 e 2.7). A **2.75** (contrato desligado + fronteira medida) entrou fora do
  plano, por medição, e está CONCLUÍDA. Nomeada e não iniciada: **ações de
  perícia com consequência** — hoje Demoralize não aplica `frightened`, Trip não
  aplica `prone`, e a única exceção do sistema é Treat Wounds.
  Depois disso está **em aberto de propósito**; o plano antigo está
  congelado em `docs/ROADMAP-LEGADO-2026-08-15.md` — **consultar, não obedecer**.
  Proposta de fase nova nasce de censo com métrica no `npm test`, não de
  cronograma: foi assim que 1.5, 2.5, 2.6 e 2.7 deram certo e é por não ser assim
  que as fases planejadas no abstrato precisaram ser reescritas.