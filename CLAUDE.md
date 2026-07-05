# CLAUDE.md — guia do projeto para agentes

RPG solo de Pathfinder 2e, web, 100% local (LM Studio, custo zero de API). Monorepo
npm workspaces: `packages/shared` (tipos zod), `packages/server` (Express + agente GM),
`packages/web` (React/Vite, SSE).

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
- `.env`, `LORE.md`, `WORLD.md` e `data/pf2e/generated/` são **gitignorados** — nunca
  commitá-los.
- Não mergear na `main` sem aprovação explícita do usuário (ele play-testa antes).
- Baterias longas de GPU (auditorias com o modelo) só iniciam com OK explícito.

## Comandos

```bash
npm test                 # unit tests (vitest, packages/server)
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
1. **Rules** (`runRulesStage`): tool loop (roll_check, start_combat, end_combat,
   end_turn, spend_actions, update_state, lookup_rule, get_character) → resumo
   mecânico determinístico. Em combate: 1 mensagem do jogador = 1 turno completo
   (3 ações; engine cobra custos, aplica dano, resolve o revide inimigo em código,
   roda dying/recovery checks quando o jogador cai).
2. **Narrative** (`runNarrativeStage`): narra o resumo (streaming), temperatura
   menor em combate, sem tools.

SSE: `delta`/`check`/`state`/`phase`/`done`/`error`; o combate vai dentro de `state`.
