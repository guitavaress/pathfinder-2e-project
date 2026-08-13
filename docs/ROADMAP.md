# Roadmap de evolução — pathfinder-2e-project

> **Par deste arquivo:** `DECISOES-E-CONTEXTO.md` diz *por que*; este diz *o quê*.
> Leia os ADRs de lá antes de executar qualquer fase.
>
> **Para o Claude Code — disciplina de execução (vale para todas as fases):**
> 1. **Leia o código real primeiro.** Os caminhos e nomes abaixo vêm do README;
>    confirme assinaturas/estruturas reais lendo os arquivos antes de mexer. Não
>    invente API.
> 2. **Uma fase por vez, uma tarefa por vez.** Nada de frentes paralelas.
> 3. **A Régua é lei:** mecânica em código, voz no LLM. PR que mova estado para o
>    modelo é rejeitado por princípio.
> 4. **Todo comportamento mecânico novo nasce com teste** e estende a bateria
>    feat-audit. O gate vigente da bateria e os **645 testes** (614 server + 31
>    brain) são piso, não meta. Ao mexer no JUIZ da bateria, rode
>    `replay-judge.ts` antes de gastar GPU — ele re-julga transcripts gravados e
>    separa "o juiz mudou de opinião" de "o jogo mudou".
> 5. Se uma tarefa contradisser um ADR, **pare e sinalize**.

Ordem definida no **ADR-003**. Fases posteriores assumem as anteriores prontas.

---

## Fase 1 — Confiabilidade (saídas de tool restritas por gramática)

- **Objetivo:** eliminar por construção os erros de *formato* de tool call.
- **Por quê:** ADR-002/003. Ataca direto as "inconsistências que vou podando",
  sem custo de modelo, e reduz ruído em todas as fases seguintes.
- **Pré-leitura:** o estágio de **Regras** no `packages/server` — onde as tool
  calls (`roll_check`, `start_combat`, `end_combat`, `end_turn`, `spend_actions`,
  `use_item`, `cast_spell`, `rest`, `lookup_rule`, `update_state`) são definidas,
  serializadas e validadas; a config do `llama-server` (uso de `--jinja`).
- **Tarefas:**
  1. Definir schema estrito de argumentos de cada tool (fonte única de verdade,
     idealmente derivada dos tipos em `packages/shared`).
  2. Aplicar **GBNF / structured output do llama.cpp** para restringir a saída do
     estágio de Regras a JSON de tool válido por construção.
  3. Manter (não remover) a validação semântica em código que rejeita o que a
     ficha não suporta — gramática cuida do *formato*, engine cuida do *sentido*.
- **Critérios de aceite (revisados em 2026-07-25 — ver ADR-006):** argumento fora
  do contrato é **rejeitado de forma auditável antes de chegar à engine**, com
  fonte única em zod; entradas semanticamente inválidas continuam rejeitadas pela
  engine. O critério original ("formato inválido impossível de emitir") saiu por
  já ser verdade de graça: o `llama.cpp` restringe o formato por gramática desde a
  migração, e o schema de argumentos é ignorado upstream no caminho Gemma 4.
- **Testes:** casos que tentam violar o contrato e verificam que não passam, mais
  um corpus de aceitação com as chamadas reais já observadas (rede contra apertar
  demais).
- **Riscos:** contrato rígido demais pode bloquear tool call legítima — cubra com
  teste os formatos válidos conhecidos antes de apertar.

### ✅ CONCLUÍDA em 2026-07-25

Entregue: contrato de argumentos em zod (`gm/tool-schemas.ts`) com JSON Schema
derivado; economia de ação real (reação do jogador debitada/recarregada, free
action, custo lido da taxonomia do dataset); camada determinística de
conformidade do dataset; e dois bugs de bloqueio corrigidos (arquivamento de
campanha colidindo, e a bateria rodando contra o brain real do jogador).

**Piso vigente (gate de 2026-07-26, pós-conserto do juiz): 362 testes unitários
e 70 PASS · 2 FLAKY · 2 FAIL · 1 SUSPECT em 75 cenários, cada um rodado 3×
(`--repeat=3`), com cobertura de asserção de uso de 40/75.**

**Este número NÃO é comparável com os anteriores** — e essa é a questão. Todos
os gates até 25/07 (71/75 → 73/75 → 75/75) foram medidos por um juiz que
aprovava 40 dos 75 cenários sem verificar nada: bastava não explodir. O 75/75
de 25/07 era o auge dessa ilusão. A partir daqui a régua afere de verdade, e o
que interessa não é só o veredito, mas a **cobertura**: quantos cenários o
harness realmente sabe verificar.

Os 35 cenários "sem asserção" são o ponto cego DECLARADO — nem falha nem
aprovação. Por motivo: 26 passivos que a engine não implementa (nada
observável), 4 reações bloqueadas na Fase 3 (gatilho depende de posição), 3 em
que guardar a reação foi a jogada certa, 2 em que a engine declarou que a cena
não se aplicava. Esse número só cai implementando mecânica — é o mapa honesto
da dívida, não ruído a ser escondido.

Os não-PASS, todos com causa nomeada:
- `Shield Block` e `Clever Gambit` (FAIL 0/3) — reações cujo gatilho a engine
  detecta mas cujo efeito não implementa. Dívida real, item da fila.
- `Shackles of Law` (FLAKY 2/3) — cobrou 1 ação de um feat que custa 2 em uma
  das três rodadas. Instabilidade de enforcement: candidato à escada da
  doutrina 2.
- `Acupuncturist` (FLAKY 2/3) e `Exotic Edge` (SUSPECT 0/3) — atividade fora de
  combate resolvida sem mecânica; o feat não aparece em nenhuma tool aceita.

Os 2 não-PASS do gate são AMBOS do juiz, não do jogo (exemplares documentados
para o item 2 da fila): FAIL `Flying Blade` — mecânica perfeita (Strike com
target, miss narrado como miss), o regex de golpe falso casou `"the blade
missing your chest by mere inches as it bites into the dirt"`; SUSPECT
`Esoteric Wayfinder` — a escalação disparou, o modelo respondeu "não se aplica
na cena" (free action de exploração numa taverna) e a engine DECLAROU o vazio ao
narrador; o juiz não distingue isso de fuga da mecânica.

---

## Fase 1.5 — Dataset PF2e COMPLETO (import total do core)

### ✅ CONCLUÍDA em 2026-07-26 (ver ADR-007)

O censo do repo `foundryvtt/pf2e` @ 7.8.0 mostrou a doutrina 3 violada na fonte:
de 27.940 documentos, o importador descartava ~1.650 (8 tipos inteiros, incluindo
os 1.106 hazards), jogava fora os rule elements de 7.653 (27%), enterrava 4.290
num `misc.json` morto e recriava na mão a taxonomia nativa dos feats.

Entregue: importador v2 com mapeamento TOTAL (tipo desconhecido falha o import),
`rules` verbatim em todo registro, campos estruturados por tipo (featCategory,
prerequisites, selfEffect normalizado, condições valuadas, hazards com statblock),
`manifest.json` (prova de zero perda: 27.940/27.940) + `uuid-index.json`; carga
por manifesto com política de índice em código (fuzzy só nas categorias legadas +
hazards; effects e afins por nome exato/uuid — o GM não muda de comportamento);
filtros do harness na taxonomia nativa (regexes de PFS/boon/curse aposentados);
e o consumidor piloto `condition-modifiers.ts` — a conformidade compara as
constantes da engine com o dado oficial das condições.

**Fila de consumidores de rule element** (um por vez, cada um com teste):
1. ~~`FlatModifier` de condições → engine (substituir as constantes pelo dado);~~
   **FEITO na Fase 2.5** (T4, ADR-008).
2. `MultipleAttackPenalty` (Agile Grace etc.) no cálculo de MAP;
3. `DamageDice`/`FlatModifier` de feats de dano (selector strike-damage);
4. `Strike` de ancestry (ataques naturais concedidos);
5. hazards no GM (gerar cena de armadilha com statblock + stealth DC + desarme);
6. ~~`selfEffect`/effects: aplicar o effect do feat como condição com duração.~~
   **FEITO na Fase 2.6** (ADR-009) — registro de efeitos ativos com prazo do dado.

Também na fila: bump do ref 7.8.0 → 7.12.2 auditado pela conformidade; corrigir
`Purging Toxins` (`@item.rank`); redesenho da bateria sobre a taxonomia nativa
(incluir/excluir classfeatures é decisão desse redesenho).

---

## Fase 2 — Companheiros de grupo (NPCs aliados)

### ✅ CONCLUÍDA em 2026-07-25 (ver ADR-004)

**Gate da fase: 75/75 na feat-audit** (rodada `--fresh` de 25/07, 44 min,
0 FAIL · 0 SUSPECT) + **353 testes unitários** (322 server + 31 brain). A T3
mexeu no revide inimigo, então o gate foi rodado do zero para provar
empiricamente o que o teste unitário já afirmava: **sem aliados o combate não
mudou**. Os dois não-PASS do gate anterior (73/75 de 26/07 — `Flying Blade` e
`Esoteric Wayfinder`) passaram aqui, coerente com o diagnóstico registrado de
que eram artefato do JUIZ, não defeito do jogo. Isso **não** conserta o juiz:
a cegueira dele (40 de 75 cenários sem asserção de uso do feat) segue valendo
como item 2 da fila de confiabilidade — uma rodada verde não é prova de régua
boa, ainda mais a temperature 0.3.

Companheiro é **engine**: o modelo só recruta/dispensa (`manage_companion`) e
dubla a fala. Entregue em 5 tarefas, cada uma com gate verde:

1. **Entidade** — `Companion` no shared com stats resolvidos e CONGELADOS no
   recrutamento (statblock oficial do bestiary ou benchmark de nível, mesmo
   guard de `hp<=0` do inimigo); roster em `GameState.companions`, persistido no
   save (campo opcional: saves v1 seguem carregando). `allyCombatant` usa o
   MESMO id do roster — é o elo que o `syncCompanions` percorre para levar
   ferida de combate de volta ao roster (companheira sai da luta com 5 HP,
   entra na próxima com 5 HP).
2. **Tool `manage_companion`** — enforcement todo na engine: nível/statblock
   oficial vence o palpite do modelo, dedupe fuzzy contra re-recrutar, teto de
   party 4, saída bloqueada em combate ativo. Companheiros entram automaticamente
   no `start_combat` como `kind:"ally"`, e o orçamento de XP escala com a party
   real sem uma linha nova no `planEncounter` (duo: moderate 40 XP).
3. **Turno do aliado** — `strikeAtPlayer` generalizado para `strikeAt` (qualquer
   atacante/alvo), preservando a fronteira que importa: dying e o estado da
   sessão seguem EXCLUSIVOS do jogador; ally/enemy a 0 HP fica `defeated`.
   `resolveAllyTurns` espelha o motor inimigo (2 Strikes, MAP, statblock via
   `sourceName`) e pode fechar a luta em VICTORY. O revide inimigo distribui os
   golpes por **round-robin determinístico** entre defensores vivos — **sem
   aliados o baseline é intacto**, testado explicitamente.
4. **Gate "uma voz por vez"** (`gm/voice-gate.ts`) — a decisão de quem fala é
   determinística e auditável: evento mecânico do companheiro extraído do resumo
   (caiu > entrou/saiu > tomou dano > critou) > menção do jogador > banter em
   cadência > silêncio. Só a persona do escolhido entra no contexto do narrador.
5. **Bench do teto de vozes + cenários end-to-end** — ver abaixo.

**Achado que mudou a compreensão do problema** (bench, 64 gerações): o risco do
ADR-004 era real, mas o sintoma era outro. Com o gate, **nenhuma degradação até
4 personas** (0 violações de silêncio, 0 vazamentos de marcador, escolhido falou
23/24 na voz certa). Sem o gate, as vozes não se borram — elas **somem** (falou
5/24). O gate é o que torna as personas vivas, não só contidas. Teto medido:
**≥4 com gate**; subir `MAX_PARTY_SIZE` exige re-rodar o bench.

**Caso descoberto na implementação:** o jogo solo mascarava o "jogador caído com
aliados vivos" — o combate ficava ativo e congelado. Agora o ramo de dying move
o mundo (aliados agem, inimigos revidam neles, o caído não é alvo) e, ao
estabilizar, o combatente do jogador revive junto com o estado.

**Fila registrada (não iniciada):** conjuração de aliado (hoje o aliado caster
luta como marcial); política de alvo da magia inimiga (hoje foca sempre o
jogador, decisão documentada no código); cura/Treat Wounds dirigida a
companheiro caído.

---

<details>
<summary>Plano original da fase (histórico)</summary>

- **Objetivo:** permitir um grupo pequeno (3–4) de aliados, medindo o teto real do
  modelo.
- **Por quê:** ADR-004. Responde à pergunta em aberto ("até onde o Gemma aguenta?")
  e é pré-requisito de qualquer campanha que não seja estritamente solitária.
- **Pré-leitura:** como a engine resolve **turno de inimigo** hoje (é o molde do
  turno de aliado); como personas de NPC entram no estágio de Narrativa; o Brain
  (`packages/brain`) para persistir o companheiro como entidade.
- **Tarefas:**
  1. **Metade mecânica:** resolver o turno do aliado em código, reaproveitando o
     motor de turno de inimigo (alvo/lado trocados). Sem tocar no modelo.
  2. **Metade narrativa:** um *gate* de "quando este companheiro fala" (reação a
     evento, escolha moral, banter ocasional) que injeta a persona **apenas do NPC
     que fala**, nunca todos por turno.
  3. **Bench do teto:** cenário controlado com 1/2/3/4 personas ativas medindo
     vazamento de voz (personalidades borrando). Registrar onde quebra.
- **Critérios de aceite:** combate com aliados resolve deterministicamente; em cena
  narrativa, no máximo uma persona de companheiro é encarnada por vez; o bench
  produz um número de "quantas vozes antes de degradar".
- **Testes:** unit para turno de aliado (dano/ações/reactions como inimigo);
  feat-audit ganha cenários com aliado em campo; o bench de vozes é reprodutível.
- **Riscos:** tentação de deixar o modelo "gerenciar" os aliados — viola a Régua.
  Aliado é engine; só a fala é modelo.
- **Feito quando:** grupo de 3–4 jogável, com o teto de vozes documentado no
  ADR-004.

</details>

---

## Fase 2.5 — Regras como DADOS (consumo de rule elements)

### ✅ CONCLUÍDA em 2026-08-03 (ver ADR-008)

Fase não planejada no ADR-003: nasceu de uma auditoria de profundidade que mediu
quanto de PF2e a engine realmente implementava. O achado que a justificou: o
import era total desde a Fase 1.5, mas a engine consumia **1 rule element key de
38** — `FlatModifier`, e só de `conditions.json` (16 REs). O resto dos 16.671
rule elements era prosa. Os passivos de feat viviam numa tabela escrita à mão com
UMA entrada.

Entregue, uma tarefa por vez:

- **T0** — `@Localize` expandido no importador: 81% do texto que era descartado
  volta (7.596 expansões, 0 perdas no manifesto).
- **T1** — dano tipado: imunidade, fraqueza e resistência com parcelas
  (`rules/damage.ts`), e o ponto cego DECLARADO (defesas que a engine não
  suporta: `cold-iron`, `area-damage`, `critical-hits`…).
- **T2** — `rules/roll-options.ts`: o estado do turno no vocabulário do dado,
  com `covered` separando "falso" de "não sei".
- **T3** — `rules/predicate.ts`: avaliador de três valores, TOTAL sobre a
  gramática real dos 7.948 predicados do dataset.
- **T4** — pilha de modificadores do PF2e (`rules/modifiers.ts`) e as condições
  lidas do dado em vez de constantes.
- **T5** — **ligar T2·T3 ao turno e ampliar as keys consumidas.** Até aqui T2 e
  T3 estavam DESLIGADOS: nenhum módulo fora de `rules/` os importava, e
  `conditionModifiersFor` recebia `ro` indefinido, descartando todo predicado.
  - `rules/roll-context.ts` — a ponte estado→roll options que faltava;
  - `ro` chega a `effectiveAC`/`attackStatusPenalty`, com contexto SEPARADO por
    ator (o rule element é avaliado do ponto de vista de quem o carrega);
  - `rules/actor-modifiers.ts` — os `FlatModifier` dos feats/features/herança/
    ancestralidade/antecedente da ficha, com a regra de não-duplo-cômputo;
  - `PASSIVE_FEAT_EFFECTS` **removido** (o +2 de Incredible Initiative agora vem
    do dado); condições passam a pesar em **perícia e save**, não só em ataque;
  - `Resistance`/`Weakness`/`Immunity` da ficha — imunidade e fraqueza, que o
    Pathbuilder nem exporta, passam a existir.

**Gate da fase: 525 testes unitários (32 arquivos), sem GPU.**

**Métrica que a fase existe para mover** (linha `[T5]` em
`rules/dataset-conformance.test.ts` — mede a cada `npm test`, não a cada
impressão):

| | antes | depois |
|---|---|---|
| keys de rule element com leitor | 1 / 38 | **4 / 38** |
| rule elements alcançáveis pela engine | 16 | **1.057** (6% dos 16.671) |
| condições com efeito mecânico | 2 / 44 | todas as que têm `FlatModifier` |
| tabela de passivos escrita à mão | 1 entrada | **não existe mais** |

**A dívida, nomeada e medida** (é o que a próxima fase tem de mover):
dos 781 `FlatModifier` das categorias de ficha, 574 avaliam corretamente como
FALSO na cena de teste (a engine funcionando), 60 são presumidos já embutidos no
export do Pathbuilder, 3 têm valor por expressão — e **133 são INDECIDÍVEIS**.
Travam em `self:effect:*` e nos slugs que `RollOption` acenderia. Nas defesas,
216 das 260 ficam declaradas (tipo escolhido por `ChoiceSet`, valor por
expressão de nível).

**Teto atual, e o que o destrava:** um **registro de efeitos ativos**. Sem ele
não entram `RollOption` (1.334), `GrantItem` (1.510), `ChoiceSet` (1.245) nem
`ActiveEffectLike` (1.461) — as quatro maiores keys sem leitor. É o candidato
natural a T6.

**Fora de escopo, registrado:** as reações que a bateria acusa (`Shield Block`
precisa de hardness estruturado, `Clever Gambit`); a família posicional
(`target:distance`, `self:flanking`, cobertura), que é Fase 3.

---

## Fase 2.6 — Registro de efeitos ativos

### ✅ CONCLUÍDA em 2026-08-12 (ver ADR-009)

O teto que a Fase 2.5 nomeou. Nasceu de medir antes de construir — e a medição
**corrigiu duas coisas que o ADR-008 tinha registrado errado**:

- dos 133 `FlatModifier` indecidíveis, só **30** travavam em `self:effect:*`; o
  resto era `origin:trait` (16), `check:statistic` (10), `item:tag` (9) e uma
  cauda de vocabulário que a ficha já respondia;
- `ActiveEffectLike` (1.461 REs) **não** era prêmio: 1.259 estão nas categorias
  de ficha e são `system.skills.X.rank`, que o Pathbuilder já entrega somado.
  Duplo-cômputo puro.

O prêmio real, que o ADR-008 não mencionava, era `effects.json`: **2.815 docs,
2.674 com rule elements** — o dobro das cinco categorias de ficha somadas — e
**todos** com `effectDuration` estruturado.

Entregue, uma tarefa por vez:

- **T6.1** — `GameState.effects` com prazo do dado. Duração crua em vez de prazo
  calculado (rodada só existe em combate); `minutes` → rodadas por conversão RAW.
  Ticks LIGADOS de saída: fim de rodada, fim de luta pela transição
  `active→inactive` (pega os nove pontos que zeram `active`), descanso, e âncora
  ao entrar em combate.
- **T6.3** *(antes da T6.2, de propósito: leitor sem caminho de concessão nasce
  lendo lista vazia, que é o pecado do ADR-008)* — as três pontes de concessão,
  e o conserto do `byUuid` que fazia `GrantItem` falhar inteiro em silêncio.
- **T6.2** — os rule elements do efeito viram número. `self:effect:*` decidível
  (com `PARTIAL_COVERAGE` para o badge que não modelamos) e os
  `FlatModifier`/defesas do efeito valendo, SEM o portão de não-duplo-cômputo.
- **T6.4** — o vocabulário que a ficha já respondia: `check:statistic`,
  `self:armored`, `armor:category`, `item:magical`, `item:proficiency:rank`,
  `proficiency:<rank>`.
- **T6.5** — docs, ADR-009 e a linha `[T6]` de métrica.

**Gate da fase: 614 testes do servidor (37 arquivos) + 31 do brain, sem GPU.**

| | antes (fim da 2.5) | depois |
|---|---|---|
| rule elements alcançáveis | 1.057 (6%) | **3.548 (21%)** |
| predicados decididos | 5.093 (64%) | **5.379 (68%)** |
| statements decidíveis | 61% | **63%** |
| `FlatModifier` de ficha INDECIDÍVEL | 133 | **90** |
| efeitos que a engine sabe conceder | 0 | **567** |

**A dívida, nomeada e medida:** efeito em inimigo/aliado (o registro só cobre o
jogador); o badge/contador do efeito (53 statements); `DamageDice` (308) e
`TempHP` (221) dos efeitos, sem leitor; e `ItemAlteration`, agora a maior key sem
leitor (1.714). A maior família indecidível que sobra é `spellcasting` (544),
seguida da posicional — que é Fase 3.

---

## Fase 3 — Combate posicional + geração procedural

- **Objetivo:** sair do combate abstrato para o tático (posição importa) e gerar
  mapas/dungeons proceduralmente.
- **Por quê:** ADR-003. É o salto real de "vira jogo", 100% na stack atual.
- **Pré-leitura:** o combat engine e o HUD (`packages/web`) — o que hoje é
  "theater of mind" e onde entrariam distância, alcance, cobertura, flanqueamento,
  range de reação (Reactive Strike).
- **Tarefas:**
  1. **Estado posicional na engine:** grid/coordenadas, distâncias, cobertura,
     flanqueamento, alcance de ataque e de reação — tudo em código, alimentando o
     resumo mecânico.
  2. **Gerador procedural (algorítmico, NÃO IA):** mapas/dungeons *seeded* e
     determinísticos que alimentam tanto a engine (salas, posições, cobertura)
     quanto a narrativa (o modelo descreve o que o algoritmo montou).
  3. **Camada tática no HUD:** render de grid + tokens sobre o combate atual.
- **Critérios de aceite:** regras que dependem de posição são aplicadas em código
  (não improvisadas pelo modelo); mapas proceduais são reprodutíveis por seed.
- **Testes:** unit de regras posicionais (flanqueamento concede off-guard, cobertura
  altera CA, reação dispara no alcance certo); feat-audit ganha cenários
  posicionais; teste de determinismo do gerador (mesma seed → mesmo mapa).
- **Riscos:** escopo grande — fatie (primeiro distância/alcance, depois cobertura,
  depois flanqueamento). Não deixe o modelo inferir posição.
- **Feito quando:** um combate tático completo roda com posição enforced em código
  e mapa procedural seeded.

---

## Fase 4 — RAG sobre o Brain (escala de campanha)

- **Objetivo:** manter o contexto limitado conforme a campanha cresce.
- **Por quê:** ADR-005. Fazer **só quando** a janela de contexto virar gargalo real
  (antes disso é otimização prematura).
- **Pré-leitura:** como o Brain (`packages/brain`) é lido de volta hoje e injetado
  no estágio narrativo; o formato dos nós markdown.
- **Tarefas:**
  1. Embeddings locais dos nós do Brain.
  2. Recuperação top-k por turno, substituindo o despejo integral de memória.
  3. Bench de qualidade de recuperação (o nó certo entra quando deveria?).
- **Critérios de aceite:** com Brain grande, o tamanho do contexto injetado
  permanece limitado; a recuperação traz os nós relevantes ao turno.
- **Testes:** bench de recuperação reprodutível; teste de que o contexto não cresce
  linearmente com o tamanho do Brain.
- **Riscos:** recuperar de menos quebra continuidade; calibre o k e cubra com o
  bench.
- **Feito quando:** campanha longa roda sem estourar contexto e o ADR-005 vira
  Aceito.

---

## Fila de confiabilidade (achados de 2026-07-25, priorizados)

Levantados durante a Fase 1 e **deliberadamente adiados** para não abrir frentes
paralelas. Atacar nesta ordem, um por vez:

1. ✅ **Buraco do `[ENGINE CHECK]` — CONCLUÍDO na Fase 1** (a entrada ficou sem
   marcação até 2026-07-26). O `if (runIteration(...) === 0) break` virou o
   helper `escalate()` com condições de parada próprias por escada; existe o
   gatilho para "as únicas tools do turno foram `lookup_rule`"; o resumo
   mecânico declara o vazio (doutrina 4 — e é justamente isso que o juiz passou
   a ler em `engineDeclaredVoid`); e `lookup_rule` deixa a FICHA desempatar
   homônimos.
2. ✅ **Juiz da bateria — CONCLUÍDO em 2026-07-26.** Era cego em 40 dos 75
   cenários e acusava errado em 2. Entregue: juiz extraído para
   `scripts/feat-audit/judge.ts` com **31 testes** (não tinha nenhum) e asserção
   proporcional à evidência — reação aferida pelo estado da engine (FAIL),
   free action por heurística de nome (SUSPECT), passivo sem implementação
   **declarado** como ponto cego em vez de aprovado. Os dois falsos positivos
   fechados com a string real virando teste de regressão (`Flying Blade`, e
   `Esoteric Wayfinder` via `engineDeclaredVoid` — engine que cumpre a doutrina
   4 não é fuga). Novo `replay-judge.ts` re-julga transcripts gravados: validar
   mudança de juiz passa a custar **zero GPU**. `--repeat=N` (item 4) entrou
   junto, com o veredito **FLAKY** para cenário instável.

   **A cegueira escondia uma lacuna de código real**, hoje fechada: a reação do
   jogador era estruturalmente impossível de disparar — `chargeNonAction` só era
   alcançável por tool call do modelo, durante o turno do jogador, enquanto o
   revide inimigo roda em código depois. `playerReactionVsStrike` (simétrico ao
   `triggerEnemyReactions`) resolve Nimble Dodge, Flashy Dodge e Reactive Shield
   dentro do `strikeAt`. Política determinística: a reação só é gasta quando MUDA
   o desfecho — sem alguém a quem perguntar no meio do revide, queimá-la num
   golpe que já erraria seria pior para o jogador.

   **Reações ainda não honradas** (cada uma é tarefa própria):
   - `Shield Block` e `Clever Gambit` — gatilho é detectável pela engine, mas o
     efeito não está implementado (redução por Hardness do escudo; identificação
     via Recall Knowledge). Seguem FAIL na bateria, que é o veredito correto.
   - `Stand Still`, `Reactive Strike`, `Disrupt Prey`, `Goblin Scuttle` —
     gatilho depende de alcance/posição. **Bloqueadas na Fase 3**; o juiz as
     declara "sem asserção" (lendo o `**Trigger**` do dado oficial, não uma
     lista escrita à mão) em vez de acusar o jogo por uma regra que ele ainda
     não tem como conhecer.
3. **Baterias seccionadas por área de regra** — `rest`, magias, itens,
   bestiary/reações/dano persistente hoje têm **zero** cobertura de bateria. Nota:
   reações de inimigo nunca disparam nos cenários atuais porque o "bandit"
   genérico não tem statblock.
4. ✅ **`--repeat` para medir variância — CONCLUÍDO em 2026-07-26** (junto do
   item 2). Cada cenário roda N vezes com sessão nova; misto vira **FLAKY**, que
   é o gatilho da escada de escalação da doutrina 2 (o modelo às vezes acerta →
   candidato a virar enforcement em código).
5. **`run-bestiary-battery.ts` não tem sandbox de brain** — rodá-la hoje arquiva a
   campanha real do jogador a cada um dos 10 cenários. **Não rodar** antes de
   portar o fix.
6. **`Purging Toxins`** traz `formula: "@item.rank"` e causa 0 de dano em
   silêncio — conserto no `scripts/import-pf2e.ts`.

## Backlog / bifurcações (fora de escopo — não iniciar sem reabrir o ADR)

Registrados nos ADRs de `DECISOES-E-CONTEXTO.md`:

- **Modo dois-modelos** (`RULES_MODEL`/`NARRATIVE_MODEL`) — exige 2º `llama-server`;
  limitado por VRAM.
- **LoRA/fine-tune** de modelo pequeno para tool-calling PF2e.
- **Wrapper desktop (Tauri)** — empacotamento; entra quando a experiência amadurecer.
- **Foundry VTT / Godot** — mudança de *produto* (ADR-001), não deste roadmap.
