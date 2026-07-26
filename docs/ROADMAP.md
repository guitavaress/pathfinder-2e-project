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
>    feat-audit. O gate vigente da bateria e os **353 testes** (322 server + 31
>    brain) são piso, não meta.
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

**Piso vigente (gate de 2026-07-25, pós-Fase 2): 353 testes unitários e 75/75
na feat-audit.** O 75/75 de 2026-07-05 NÃO é o mesmo número: foi medido no LM
Studio antes da migração para llama.cpp, com a bateria quebrada entre 14/07 e
25/07. Progressão na stack atual: 71/75 (25/07) → 73/75 (26/07, após o fix do
`[ENGINE CHECK]` + `lookup_rule` pela ficha + import total) → **75/75 (25/07,
pós-Fase 2)**. Atenção ao ler essa curva: o rules stage roda a temperature 0.3
e o mesmo cenário alterna entre rodadas — a diferença de 73 para 75 é
compatível com variância + juiz cego, não é prova de melhora do jogo.

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
1. `FlatModifier` de condições → engine (substituir as constantes pelo dado);
2. `MultipleAttackPenalty` (Agile Grace etc.) no cálculo de MAP;
3. `DamageDice`/`FlatModifier` de feats de dano (selector strike-damage);
4. `Strike` de ancestry (ataques naturais concedidos);
5. hazards no GM (gerar cena de armadilha com statblock + stealth DC + desarme);
6. `selfEffect`/effects: aplicar o effect do feat como condição com duração.

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

1. **Buraco do `[ENGINE CHECK]`** — causa de 3 das 4 falhas do baseline. A escada
   de escalação existe para "combate ativo e nada resolvido", mas o loop é
   `if (runIteration(...) === 0) break`: uma resposta em prosa a encerra na
   primeira das 3 tentativas. Precisa também de gatilho para "as únicas tools do
   turno foram `lookup_rule`", e de declarar no resumo mecânico quando nada foi
   resolvido (doutrina 4). Junto: `lookup_rule` deve deixar a **ficha** escolher a
   entrada principal em homônimo, como `costProfileOf` já faz.
2. **Juiz da bateria** — hoje é cego e acusa errado. Cego: 40 dos 75 cenários
   (7 reaction, 2 free, 31 passive) não têm asserção de que o feat foi usado —
   `Nimble Dodge` e `Reactive Shield` passaram sem o feat ter sido usado uma vez.
   Acusa errado: o `FALSE_BLOW_KW` não entende negação.
3. **Baterias seccionadas por área de regra** — `rest`, magias, itens,
   bestiary/reações/dano persistente hoje têm **zero** cobertura de bateria. Nota:
   reações de inimigo nunca disparam nos cenários atuais porque o "bandit"
   genérico não tem statblock.
4. **`--repeat` para medir variância** — o estágio de regras roda a `temperature
   0.3`; o mesmo cenário alterna PASS/FAIL entre rodadas, o que dificultou
   atribuir falhas. Taxa de PASS vale mais que veredito binário.
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
