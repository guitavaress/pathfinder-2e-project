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
e continuidade de campanha (`save.json` + recap determinístico). Cobertura: 195
testes unitários + bateria feat-audit 75/75.

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
  o 75/75 nem os 195 testes.
- **Revisitar quando:** um achado da Fase 2 (limite do modelo) reordenar as
  prioridades.

### ADR-004 — Companheiros: split mecânico/narrativo, "uma voz por vez"
- **Status:** Proposto.
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
