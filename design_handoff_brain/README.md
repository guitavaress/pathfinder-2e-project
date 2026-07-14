# Handoff: O Brain do Protagonista — "Grimório da Memória"

## Overview
Novas telas do **pathfinder-2e-project** (branch `feat/brain`) para o pacote `brain`: o grafo de memória do protagonista, journal/timeline e auditoria do write pass. Protótipo hi-fi em `Brain do Protagonista.dc.html` (canvas com frames 1A–1G), nos mesmos tokens do handoff "O Grimório Aberto".

**Recomendação de integração (frame 1G):** overlay full-screen sobre o jogo, aberto por botão no trilho compacto ou tecla `B`, fechado com `Esc`. Rota própria (`#brain`) para preservar estado no refresh. O painel lateral colapsável é alternativa futura, não a casa principal.

---

## Tokens (idênticos ao handoff anterior)

```css
--bg-page:        #14100c;   /* fundo geral */
--bg-panel:       #171209;   /* toolbar, nav lateral */
--bg-inset:       #100c08;   /* inputs, cartões internos */
--bg-card:        #181209;   /* cards (connections, atividade) */
--bg-topbar:      linear-gradient(180deg,#221a10,#1a130c);
--bg-drawer:      linear-gradient(180deg,#1f1810,#17110a);
--border-subtle:  #2a2118;
--border-default: #322820;
--border-strong:  #3a2e20;
--border-gold:    #5a4520;   /* divisor sob a topbar */
--gold:           #c6a24c;
--gold-bright:    #e3c878;
--gold-gradient:  linear-gradient(180deg,#d4af5e,#bb8f3d); /* tab ativa, CTA */
--text-body:      #e6dac2;
--text-soft:      #cdbfa2;
--text-muted:     #9a8868;
--text-faint:     #8a7a5e;
--text-ghost:     #7a6c52 / #6b5d46;
--ok:             #a9c47e;  --ok-border:   #4a5a34;
--warn:           #c2853f;  --warn-border: #6e5326;   /* rejeições: âmbar, nunca vermelho */
--danger:         #d98a82;  --danger-border:#6e342f;  /* só erro de sistema */
```

Fontes: **Cinzel** (títulos, labels uppercase, stamps) + **EB Garamond** (corpo, itálico para meta/dicas).

### Cores por tipo de nó (tema constelação — fechado)
| tipo | cor | glifo |
|---|---|---|
| npc | `#e3c878` | busto |
| place | `#9ab873` | triângulo |
| faction | `#c97c6a` | bandeira |
| quest | `#7fb0b5` | "!" |
| item | `#c2853f` | losango |
| lore | `#a98fc9` | livro aberto |

### Status do nó
`active` → ok / `resolved` → muted / `dead` → danger / `unknown` → faint.

---

## Hierarquia de componentes (React alvo)

```
<BrainOverlay>                    // rota #brain; Esc fecha; foco preso
  <BrainTopbar>                   // título + tabs (Grafo/Journal/Timeline/Atividade) + badge S·T + fechar
  <GraphView>                     // tab Grafo
    <GraphToolbar>                //   busca + chips de filtro por tipo (com contagem)
    <GraphCanvas>                 //   <canvas> força-dirigido (ver física abaixo)
    <NodePanel>                   //   drawer 392px da direita (1A) — recomendado
  <JournalView>                   // tab Journal: nav de sessões 200px + coluna 640px
  <TimelineView>                  // tab Timeline: lista vertical com marcadores
  <ActivityView>                  // tab Atividade: 1 card por write pass
<ScribeIndicator>                 // no composer do chat (1F): idle/rodando/ok/avisos
```

## Física / interações do grafo (implementadas no protótipo — copiar)
- Repulsão `2600/d²` (corte em 260px), molas nas edges (rest 128, k 0.012), gravidade ao centro 0.0016, damping 0.86.
- Raio do nó: `min(19, 7.5 + grau*1.5)`. Labels: sempre p/ grau ≥ 4, todos a partir de zoom 0.8.
- Scroll = zoom (0.35–3.2, ancorado no cursor). Arrastar nó = fixa durante o drag. Arrastar fundo = pan.
- Hover/seleção: vizinhos em destaque, resto a 16% de alpha. Busca: matches com anel, resto a 14%.
- **Rótulos de edge**: visíveis a partir de zoom ≥ 1.45 (e sempre nas edges do nó focado). Fundo `--bg-panel`, itálico, dados em EN (`works_for`…).
- Clique fora = desseleciona. Clique em connection no painel = seleciona e centraliza o alvo.

## NodePanel
Badges de tipo (cor do tipo) e status; título Cinzel 25px; meta "Descoberto na Sessão X · Turno Y" (parsear `SN.TN`); tags; descrição; **Log** (timeline com pontos dourados); **Connections** (cards clicáveis `label → alvo` + dot da cor do tipo do alvo).

## Journal & Timeline (1D)
Coluna de leitura 640px. Journal: separador ornamental "Sessão N", entradas `SN.TN` + texto; linhas de Check/Combat em `--ok`. Nav lateral ancora por sessão (scroll do container, não `scrollIntoView`). Timeline: linha vertical + marcadores dourados com glow.

## Atividade (1E) — auditoria do write pass
1 card por pass: stamp humanizado + resumo. Aplicados = chips verdes com verbo (`+` CREATE, `~` UPDATE, `»` APPEND). Rejeitados = linha âmbar com comando + motivo. Erro de sistema = linha vermelha. Borda do card acompanha o pior estado.

## ScribeIndicator (1F)
Botão circular 40px à direita do composer, ícone de pena. Rodando: pena pulsando + dot dourado + tooltip. Concluído: toast ~5s "Anotado: + X · ~ Y" (clique → Atividade). Rejeições: âmbar "Anotado com avisos… ver por quê →". **Nunca vermelho para rejeições** — não é erro do jogador.

## Estados (1C)
- Vazio: céu com poucas "estrelas" apagadas, copy "O mundo ainda é um mistério", CTA "Voltar à cena".
- Carregando: 3 dots pulsando + "Abrindo o grimório…".
- Erro: "A memória não respondeu" + retry. (Tom de fantasia sempre; detalhe técnico em linha pequena.)

## Decisões fechadas
1. Direção do grafo: **1A constelação** (fechada). O frame 1B (pergaminho) fica no protótipo apenas como registro — não implementar.
2. Painel do nó: **drawer 392px** (1A).
3. Dados dos stems/edges permanecem em EN; toda a UI em PT.
