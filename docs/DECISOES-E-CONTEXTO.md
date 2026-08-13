# Decisões e Contexto — pathfinder-2e-project

> **O que é este arquivo.** É o "porquê" do projeto: o raciocínio destilado que
> guia as decisões de arquitetura. O `ROADMAP` diz *o que* construir; este arquivo
> diz *por que*, e o que faria a gente mudar de ideia.
>
> **Para o Claude Code:** você não tem acesso à conversa que originou estas
> decisões — este arquivo É essa conversa, destilada. Leia-o antes de propor
> qualquer mudança de arquitetura. Se uma tarefa parecer contradizer uma decisão
> aqui registrada, **pare e aponte a contradição** em vez de seguir. Referencie
> este arquivo no `CLAUDE.md` para que ele seja carregado toda sessão.

---

## 1. Contexto do projeto (resumo)

RPG solo, web, 100% local, baseado em Pathfinder 2e, com Mestre (GM) dirigido por
IA. Roda via `llama.cpp` (modelo padrão Gemma 4 12B Q4, ~12 GB VRAM, custo de
inferência zero). Pipeline de **dois estágios** num mesmo modelo: (1) contexto de
**Regras** resolve mecânica via tool use; (2) contexto de **Narrativa** recebe o
resumo mecânico e narra a cena. Já existe uma **engine determinística de combate**
(iniciativa, 3-action economy, MAP, dano/crit/sneak, condições, dying/recovery,
orçamento de XP, statblocks reais), a memória persistente ("Brain", grafo markdown)
e continuidade de campanha (`save.json` + recap determinístico), além de
**companheiros de grupo** (roster + turno de aliado em código + gate de voz,
Fase 2/ADR-004). Cobertura: **393 testes unitários** (362 server + 31 brain) +
bateria feat-audit (gate vigente registrado no ROADMAP).

---

## 2. A Régua (princípio-mor)

> **Mecânica em código. Voz no LLM.**

Todo estado que exige precisão (números, condições, posições, dano persistente,
custo de ação, dying) mora em **código determinístico**, validado, testável. O
modelo só faz duas coisas: **chamar tools** (estágio de Regras) e **narrar**
(estágio de Narrativa). O que não está no resumo mecânico, não aconteceu.

**Por que:** o gargalo de um modelo pequeno (12B) nunca foi "sobrecarga" de
processamento — é **confiabilidade**. Ele erra aritmética e perde estado aplicado
dezenas de mensagens atrás. Código não.

**Teste de violação:** se uma tarefa proposta faz o modelo *rastrear* ou *calcular*
estado (em vez de a engine fazer e o modelo apenas narrar/consultar), ela viola a
Régua. Reprojete para que a engine seja a fonte da verdade.

---

## 3. Restrições inegociáveis (pré-requisitos)

Qualquer proposta que quebre uma destas está fora de escopo por padrão:

- **Local e custo zero.** Nada de API paga. Inferência na máquina do jogador.
- **Solo.** Um jogador humano; o resto é dirigido pela IA/engine.
- **Pathfinder 2e**, ancorado no dataset do repo `foundryvtt/pf2e` (fonte de
  regras), consultado como índice local.
- **Ambiente:** WSL (usar `127.0.0.1`, não `localhost`, no `LLM_BASE_URL`).
- **Orçamento de hardware:** caber em ~12 GB VRAM com o modelo default.
- **Fronteira dos dois estágios** (Regras / Narrativa) é sagrada — não vaze tool
  use para o estágio narrativo nem narração para o estágio de regras.

---

## 4. Decisões (ADRs)

### ADR-001 — Não migrar para o Foundry VTT (por ora)
- **Status:** Aceito.
- **Contexto:** O apelo do Foundry seria ganhar uma engine de regras madura "de
  graça". Mas essa engine **já existe neste projeto**, própria e testada, e o
  projeto já consome o *dataset* `pf2e` do Foundry sem depender do *runtime* dele.
- **Decisão:** Manter a stack própria (Node/Express + React/Vite). Não portar o
  GM para módulo Foundry.
- **Consequências:** Evita um rewrite grande contra a corrente do Foundry (feito
  para mesa multiplayer com mestre humano; nosso caso é solo com mestre-IA).
  Mantém o controle total sobre engine e Brain. Em troca, seguimos mantendo a
  camada de regras e a UI nós mesmos.
- **Revisitar quando:** o objetivo passar a ser a experiência visual completa de
  VTT (mapa/token/grid tático maduro) **e** houver disposição de aposentar a
  engine própria. Aí vira decisão de *mudar de produto*, não de evoluir este.

### ADR-002 — Mecânica em código, voz no LLM (a Régua)
- **Status:** Aceito (já é a arquitetura vigente).
- **Contexto:** Ver seção 2.
- **Decisão:** Formalizar a Régua como restrição de projeto. Nenhuma mecânica de
  estado sobe para o modelo.
- **Consequências:** Confiabilidade e testabilidade altas; o modelo fica livre
  para o que faz bem (julgamento e prosa). Custo: toda regra nova exige código +
  teste, não só prompt.
- **Revisitar quando:** nunca por conveniência. Só se um modelo local ficar
  comprovadamente confiável em estado/aritmética — o que hoje não é o caso.

### ADR-003 — Ordem de evolução
- **Status:** Aceito (a validar na prática).
- **Decisão:** Evoluir nesta sequência, por retorno sobre esforço:
  1. **Confiabilidade** — saídas de tool restritas por gramática (GBNF do
     `llama.cpp`), matando classes de erro de formato de graça.
  2. **Companheiros** (ver ADR-004) — é o experimento que responde à pergunta em
     aberto: "até onde o Gemma aguenta?".
  3. **Combate posicional + geração procedural** — o salto real de "vira jogo",
     todo dentro da stack atual.
  4. **RAG sobre o Brain** (ver ADR-005) — quando as campanhas ficarem longas.
- **Consequências:** Confiabilidade primeiro reduz ruído em tudo que vier depois.
  Cada fase mecânica nova **estende a bateria feat-audit**; nada entra que derrube
  o baseline vigente nem os testes unitários.
- **Revisitar quando:** um achado da Fase 2 (limite do modelo) reordenar as
  prioridades.
- **Fase 1 — CONCLUÍDA em 2026-07-25.** Entregou o contrato de argumentos em zod
  (`gm/tool-schemas.ts`), a economia de ação real (reação/free action) e uma
  camada determinística de conformidade do dataset. O item "GBNF" saiu por
  impossibilidade técnica, não por desistência — ver **ADR-006**. Piso de teste
  atualizado: **305 unitários** e **73/75 na feat-audit** (gate de 26/07; os 2
  não-PASS são falso positivo/cegueira do juiz, documentados no ROADMAP; o
  75/75 antigo é de 2026-07-05, medido no LM Studio antes da migração, e não é
  comparável).

### ADR-004 — Companheiros: split mecânico/narrativo, "uma voz por vez"
- **Status:** Aceito (implementado e gateado na Fase 2, 2026-07-25 — 75/75 na
  feat-audit, 353 unitários).
- **Contexto:** NPCs aliados no grupo ainda não existem. O risco não é "quantos
  NPCs há", é **quantas vozes distintas o 12B mantém no mesmo contexto ao mesmo
  tempo** — ele borra personalidades quando encarna 3-4 de uma vez.
- **Decisão:** Dividir o companheiro em duas metades. A **mecânica** (turno,
  ataques, magias) é resolvida pela engine, igual ao turno de inimigo que já
  existe — praticamente de graça. A **personalidade** entra só quando o NPC
  *teria* motivo de falar, injetando a persona **apenas daquele** NPC naquele
  momento (nunca todos, todo turno).
- **Consequências:** Permite grupo pequeno (3-4) sem estourar o modelo. Exige um
  gate de "quando um companheiro fala" e um bench que meça o vazamento de voz com
  1/2/3/4 personas ativas — é assim que se descobre o teto real do Gemma.
- **Revisitar quando:** o bench indicar onde a coerência de vozes quebra.
- **Fase 2 — CONCLUÍDA em 2026-07-25 (gate: 75/75 na feat-audit).** Entregue: `Companion`
  no shared (stats resolvidos e CONGELADOS no recrutamento — statblock oficial
  ou benchmark de nível), roster em `GameState.companions` (persistido no save,
  campo opcional para não quebrar saves v1), tool `manage_companion`
  (join/leave com enforcement de engine: bestiary vence o palpite de nível,
  dedupe fuzzy, teto de party 4, saída bloqueada em combate), `resolveAllyTurns`
  espelhando o motor inimigo, revide inimigo distribuído por round-robin e o
  gate `gm/voice-gate.ts`.
- **O achado do bench (2026-07-25, 64 gerações, `scripts/voice-bench/`):** a
  premissa do ADR estava **certa no risco, errada no sintoma**. Com o gate: 0
  violações de silêncio e 0 vazamentos de marcador verbal em 1/2/3/4 personas;
  o escolhido falou em 23 de 24 turnos, 22 na voz certa — **nenhuma degradação
  até 4 personas**. O braço de CONTROLE (todas as personas no prompt, sem
  diretiva de vez — o approach ingênuo) revelou o modo de falha real: as vozes
  não se BORRAM, elas **somem** (o escolhido falou em 5 de 24 turnos, com o
  marcador em 6). Ou seja, o custo de despejar todas as personas não é confusão
  de personalidade — é diálogo genérico e raro, com a persona nunca chegando a
  existir. O gate não só contém as vozes: é o que as torna vivas.
- **Teto medido:** ≥4 personas com o gate (o limite do ADR-004 não foi
  alcançado). Se um dia a party crescer além de 4, re-rodar o bench antes de
  subir `MAX_PARTY_SIZE` — o teto é empírico, não teórico.

### ADR-005 — Escala de campanha via RAG sobre o Brain
- **Status:** Proposto.
- **Contexto:** Hoje a memória relevante é injetada no contexto; conforme a
  campanha cresce, isso aperta a janela.
- **Decisão:** Adicionar embeddings + recuperação top-k sobre os nós do Brain,
  injetando por turno só o que for relevante, em vez de despejar tudo.
- **Consequências:** Contexto permanece limitado mesmo com Brain grande; campanhas
  longas (dezenas de sessões) viáveis. Custo: infra de embeddings local + um bench
  de qualidade de recuperação.
- **Revisitar quando:** implementar antes de a janela de contexto virar gargalo é
  otimização prematura; fazer quando a dor aparecer.

### ADR-006 — Enforcement de argumento de tool é client-side, não GBNF
- **Status:** Aceito (2026-07-25).
- **Contexto:** A Fase 1 nasceu com a premissa de "restringir a saída do estágio
  de Regras por gramática (GBNF)". Ao ler o código real do `llama.cpp`
  (commit `505b1ed`), a premissa se mostrou parcialmente desatualizada:
  1. Com `--jinja` + o template do Gemma 4, o servidor **já monta uma gramática
     lazy** disparada por `<|tool_call>` (`common/chat.cpp:1412-1430`), que
     garante o formato: o nome da tool é um dos declarados e o dict de
     argumentos é sintaticamente válido. O critério de aceite original
     ("formato inválido impossível de emitir") **já estava satisfeito**.
  2. O schema dos ARGUMENTOS é ignorado nesse caminho: `chat.cpp:1386` usa um
     dict genérico e a linha que passaria `parameters` está comentada com um
     TODO upstream. Todos os outros formatos de chat fazem
     `p.tool_args(p.schema(...))` — Gemma 4 é a única exceção.
  3. Não há como injetar gramática pelo request: `response_format`/`json_schema`
     faz o caminho gemma4 **abandonar o tool calling** (`chat.cpp:1334-1339`), e
     um `grammar` no corpo é sobrescrito pela gramática do template.
- **Decisão:** Enforcement de argumento em **camada cliente** — zod é o dono do
  contrato (`packages/server/src/gm/tool-schemas.ts`), o JSON Schema mandado ao
  modelo é derivado dele, e `validateToolArgs` roda antes do dispatch. Não
  forkar o `llama.cpp`.
- **Consequências:** Argumento fora do contrato é rejeitado de forma auditável
  antes de chegar à engine, e a rejeição volta ao modelo pelo mesmo canal dos
  erros semânticos. Em troca, a emissão em si não é impossível — a garantia é a
  rejeição, não a impossibilidade. O `enum` do schema ainda chega ao modelo como
  texto, porque o template do Gemma 4 renderiza `enum` de propriedades string.
- **Revisitar quando:** o TODO de `chat.cpp:1386` for resolvido upstream — aí a
  gramática passa a cobrir argumentos e vale reavaliar. **Ao atualizar o
  `llama.cpp`, reconferir essa linha.**

### ADR-007 — Import é TOTAL; consumo é INCREMENTAL
- **Status:** Aceito (2026-07-26). Implementado na Fase 1.5.
- **Contexto:** Censo sobre o clone completo do `foundryvtt/pf2e` @ 7.8.0 mostrou
  que a doutrina 3 estava violada NA FONTE: dos 27.940 documentos dos packs, o
  importador antigo descartava 8 tipos inteiros (~1.650 docs — os 1.106 hazards
  nunca existiram no dataset), jogava fora `system.rules` de 7.653 docs (27% —
  os rule elements declarativos: FlatModifier, DamageDice, GrantItem…),
  enterrava 4.290 docs num `misc.json` que nenhuma função lia (2.815 são os
  `effect` com a mecânica de uso das habilidades) e ignorava a taxonomia nativa
  `system.category` dos feats — que o `classify-feats.ts` recriava na mão com
  regex sobre títulos. As 44 colisões de nome e o custo de feat errado da
  bateria foram sintomas disso.
- **Decisão:** O import é TOTAL: nenhum documento do core é descartado (tipo
  desconhecido FALHA o import), e por documento nenhum campo MECÂNICO é
  descartado — `rules` verbatim + campos estruturados por tipo + grafo de uuids
  (`selfEffect` normalizado, `uuid-index.json`) + `manifest.json` como prova de
  zero perda que a conformidade lê. A ENGINE, porém, só consome um dado novo
  quando houver tarefa própria com teste. Piloto: `condition-modifiers.ts` lê
  os FlatModifier das condições e a conformidade compara com as constantes da
  engine (off-guard −2 CA, frightened −N) — alarme de divergência, não troca de
  fonte.
- **Consequências:** Dataset ~42 MB (era ~34), 22 categorias; `lookup_rule`
  ganha hazards no fuzzy e o resto só por nome exato/uuid (política de índice
  em código — o GM não muda de comportamento porque o dataset cresceu).
  Únicas exclusões: documentos NÃO-Item (journals/rolltables, 182 docs, sem
  `type`) e campos editoriais (`img`, `publication`, `folder`).
- **Revisitar quando:** bump de ref (7.12.2+) — a conformidade audita o diff; e
  a cada consumidor novo de rule element (fila no ROADMAP).

### ADR-008 — Rule element só vira número quando o contexto DECIDE
- **Status:** Aceito (2026-08-03). Implementado na Fase 2.5.
- **Contexto:** A auditoria de 2026-08-03 mediu a distância entre a doutrina 3 e
  o código e achou um vão grande. O import era total (ADR-007), mas a engine
  consumia **1 key de 38** — `FlatModifier`, e só da categoria `conditions` (16
  rule elements). Os passivos de feat moravam numa tabela escrita à mão,
  `PASSIVE_FEAT_EFFECTS`, com **uma entrada** para os 4.925 feats passivos do
  dado. E as duas peças construídas para resolver isso — `roll-options.ts` (T2)
  e `predicate.ts` (T3) — **não eram importadas por nenhum módulo fora de
  `rules/`**: o parâmetro `ro` de `conditionModifiersFor` nunca chegava, então
  todo `FlatModifier` com predicado era descartado. Infraestrutura testada e
  desligada.
- **Decisão:** Três invariantes, nesta ordem de precedência:
  1. **Indecidível não aplica.** Predicado que o contexto não decide não vira
     bônus. Vale para condições, feats e defesas. O que não se aplica sai num
     diagnóstico (`skipped`, com motivo), nunca em silêncio.
  2. **Não-duplo-cômputo.** O Pathbuilder exporta valores FINAIS (`ac`,
     `perception`, `saves`, `skills[].modifier`, `weapons[].attack`). Em seletor
     que vem pronto da ficha, só se aplica `FlatModifier` COM predicado — um
     modificador situacional não pode estar embutido num número estático. Em
     seletor que a ENGINE compõe (`initiative`, dano), aplica-se também o
     incondicional. Seletor desconhecido cai no lado conservador (presumido na
     ficha).
  3. **O rule element é avaliado do ponto de vista de quem o carrega.** `self:`
     dentro do predicado é o dono da condição/feat, então a CA do defensor e a
     rolagem do atacante pedem contextos DIFERENTES (`rollOptionsOf` monta os
     dois). Um contexto só inverteria calado todo predicado sobre alvo.
- **Consequências:** consumo sobe de 1 para **4 keys** (`FlatModifier`,
  `Resistance`, `Weakness`, `Immunity`) e de 16 para **1.057 rule elements
  alcançáveis**; `PASSIVE_FEAT_EFFECTS` deixa de existir; condições passam a
  pesar em perícia e save (antes só em ataque); `ability` e `proficiency` viram
  tipos próprios na pilha de modificadores. A ponte é `rules/roll-context.ts`,
  e o dado entra em `combat.ts` por injeção (`setActorModifierSource`,
  `setActorDefenseSource`) — o núcleo segue puro.
- **Revisitar quando:** houver registro de efeitos ativos. É o teto atual: dos
  781 `FlatModifier` das categorias de ficha, 133 ficam INDECIDÍVEIS, travados
  em `self:effect:*` e nos slugs que `RollOption` (1.334 REs, sem leitor)
  deveria acender. Sem esse registro, `GrantItem`/`ChoiceSet`/`ActiveEffectLike`
  também não têm como entrar.
- **Revisado em 2026-08-12 (ADR-009):** o registro foi construído, e a medição
  desmentiu parte da justificativa acima. Correções, para que ninguém volte a
  planejar por elas: dos 133 indecidíveis, só **30** travavam em `self:effect:*`
  (o resto era `origin:trait` 16, `check:statistic` 10, `item:tag` 9 e uma cauda
  de vocabulário barato); e `ActiveEffectLike` **não** era prêmio nenhum — 1.259
  dos 1.461 estão nas categorias de ficha e são `system.skills.X.rank`, que o
  Pathbuilder já exporta somado. Seria duplo-cômputo puro. O prêmio real estava
  em `effects.json`, que o ADR-008 não mencionava.

### ADR-009 — O efeito ativo é estado da engine, com prazo do dado
- **Status:** Aceito (2026-08-12). Implementado na Fase 2.6.
- **Contexto:** O ADR-008 nomeou o teto certo — sem saber que efeitos estão
  ativos, `self:effect:*` é indecidível — mas errou onde estava o valor. Medindo
  antes de construir: `effects.json` tem **2.815 docs, 2.674 com rule elements**
  (1.949 `FlatModifier`, 378 `Resistance`, 308 `DamageDice`, 221 `TempHP`, 138
  `Weakness`) e **todos** com `effectDuration` estruturado. É o dobro de rule
  elements das cinco categorias de ficha somadas, e sem nenhum risco de dupla
  contagem: efeito é temporário, então nunca esteve no export do Pathbuilder.
- **Decisão:** `GameState.effects` guarda os efeitos ativos no JOGADOR, e quatro
  invariantes mandam:
  1. **Prazo é do dado, não do modelo.** O registro guarda a DURAÇÃO crua
     (`rounds`/`minutes`/`hours`/`days`/`encounter`/`unlimited`), não um prazo
     calculado: rodada só existe em combate, e fora dele o prazo é o próximo
     descanso. `minutes` vira rodada por conversão RAW (1 min = 10 rodadas),
     nunca por chute; `hours`/`days` não têm relógio nesta engine e expiram no
     descanso — dívida declarada. **Efeito que não expira é pior que efeito que
     não existe:** vira bônus permanente inventado.
  2. **O efeito precisa existir no dado E na ficha.** Nome que o modelo invente
     é rejeitado de forma auditável (doutrina 4), e a prosa só dispara efeito de
     ability que o personagem tem — é isso que torna seguro reconhecer "Flight"
     e "Passion" no texto, palavras corriqueiras que sem o portão viravam bônus.
  3. **Quem recebe o efeito sai do dado, não de suposição.** Três pontes
     medidas: `selfEffect` explícito (242 feats, 242/242 resolvendo), stance
     homônima (+7 além das que já vêm por `selfEffect`) e magia BENIGNA homônima
     (318; as 63 com ataque ou save ficam fora, porque o efeito delas incide em
     quem foi atingido — pôr `Spell Effect: Ill Omen` no conjurador inventaria
     penalidade contra o jogador). Ação/feat não-stance com effect homônimo fica
     FORA: "Hunt Prey" marca a presa, não o caçador.
  4. **Cobertura pode ser PARCIAL, e isso é declarado.** `self:effect:rage` a
     engine decide; `self:effect:overdrive-success:2` fala do *badge* (o contador
     do Foundry), que o registro não guarda — 53 statements do dataset. Daí
     `PARTIAL_COVERAGE`: o domínio é coberto até 3 segmentos e mais fundo segue
     dívida. Cobrir o prefixo inteiro os faria avaliar FALSO, e um `not:` em cima
     viraria bônus onde a verdade é "não sei".
- **Consequências:** REs alcançáveis pela engine sobem de **1.057 (6%) para
  3.548 (21%)**; predicados decididos de 64% para **68%**; os `FlatModifier` de
  ficha INDECIDÍVEIS caem de 133 para **90**. `effectiveAC` passa a aceitar os
  modificadores do próprio defensor, e as defesas tipadas do combatente do
  jogador são RECOMPOSTAS (ficha + efeitos) em vez de acumuladas — somar
  resistência na entrada e esquecer de tirar na saída deixaria o personagem
  imune a frio três cenas depois. Corrigido de passagem um bug que fazia
  `GrantItem` falhar inteiro em silêncio: as referências do dado vêm por NOME
  (o fonte do pf2e só as converte em id no build do compêndio), e `byUuid` só
  tentava id — 1.247 de 1.248 não resolviam.
- **Fora de escopo, declarado:** efeito em INIMIGO/ALIADO (o registro só cobre o
  jogador, e por isso `target:effect` segue em `DECLARED_UNCOVERED` — afirmar
  lista vazia por terceiros inverteria calado todo predicado sobre efeito
  alheio); o badge/contador; `DamageDice` e `TempHP` dos efeitos (308 e 221 REs,
  sem leitor ainda); e `ItemAlteration`, agora a maior key sem leitor (1.714).
- **Revisitar quando:** a Fase 3 trouxer posição — `self:flanking`,
  `target:distance` e cobertura são a próxima maior família indecidível depois
  de `spellcasting` (544).

### Bifurcações consideradas e adiadas (não fazer sem reabrir a decisão)
- **Modo dois-modelos** (`RULES_MODEL`/`NARRATIVE_MODEL`): exige segundo
  `llama-server`; limitado pela VRAM. Adiado.
- **LoRA/fine-tune** de um modelo pequeno para tool-calling PF2e: horizonte
  distante, provável overkill. Registrado, não priorizado.
- **Wrapper desktop (Tauri):** troca "aba de navegador" por "app"; esforço baixo,
  puramente de empacotamento. Pode entrar quando a experiência estiver madura.
- **Engine de jogo (Godot/Unity):** jogaria fora Node/React. Só se o objetivo
  virar um mundo 2D/3D com sprites. Fora de escopo deste roadmap.

---

## 5. Tetos conhecidos (paredes do Gemma 12B local)

Construir *na direção* das paredes, não esbarrar nelas sem querer:

- **Muitas vozes simultâneas** — mitigado pelo ADR-004 (uma por vez), não
  eliminado.
- **Coerência narrativa de altíssimo alcance** — mitigada pelo Brain + RAG
  (ADR-005), não resolvida.
- **Esquemas improvisados de muitos passos** — o modelo tende a se perder; ancore
  em estruturas de código (quests, estado) sempre que possível.

Dentro dessas paredes, o alvo realista é um RPG solo *excelente*: combate tático,
mundo persistente, grupo pequeno de companheiros com personalidade e campanha
longa.

---

## 6. Como usar com o Claude Code

- **Referencie este arquivo no `CLAUDE.md`** para carregá-lo toda sessão.
- **Uma decisão/fase por vez.** Não abra frentes em paralelo.
- **A Régua (seção 2) é lei.** Qualquer PR que mova estado para o modelo é
  rejeitado por princípio.
- **Toda mudança mecânica nasce com teste** e estende a feat-audit; o 75/75 e os
  195 testes são piso, não meta.
- **Na dúvida entre seguir uma tarefa e respeitar uma decisão daqui, respeite a
  decisão e sinalize.**
