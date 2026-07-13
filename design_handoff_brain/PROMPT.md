# PROMPT para o Claude Code

> Cole na raiz do repositório `pathfinder-2e-project`, branch `feat/brain`, junto com a pasta `design_handoff_brain/`.

---

Implemente as telas do Brain ("Grimório da Memória") em `packages/web`, seguindo fielmente o protótipo e o README em `design_handoff_brain/`. O protótipo `Brain do Protagonista.dc.html` é a referência visual e comportamental — os valores de estilo estão inline nele; a física do grafo e os builders de view estão no `<script>` do mesmo arquivo.

## Escopo
1. **BrainOverlay** — overlay full-screen sobre o jogo (frame 1G, opção recomendada). Abre por botão no CompactRail e tecla `B`; fecha com `Esc`; rota hash `#brain` (com sub-rota por tab, ex. `#brain/journal`).
2. **GraphView** (frame 1A — constelação, direção fechada; ignore o frame 1B) — canvas force-directed com os parâmetros exatos do README (repulsão, molas, damping, zoom 0.35–3.2). Toolbar com busca e chips de filtro por tipo com contagem. Rótulos de edge visíveis a partir de zoom ≥ 1.45 e sempre nas edges do nó focado.
3. **NodePanel** — drawer de 392px (transform translateX, .28s ease). Conteúdo: badges tipo/status, nome, meta humanizada de `SN.TN`, tags, descrição, Log, Connections clicáveis (selecionam e centralizam o alvo).
4. **JournalView / TimelineView** (frame 1D) — coluna de leitura 640px, âncoras por sessão (scrollTop do container, nunca scrollIntoView), linhas de Check/Combat em verde-ok.
5. **ActivityView** (frame 1E) — GET no histórico de write passes; card por pass com aplicados (chips verdes), rejeitados (âmbar + motivo) e erros (vermelho).
6. **ScribeIndicator** (frame 1F) — no composer do chat; estados idle/rodando/concluído/avisos; toast de 5s; clique abre `#brain/activity`. Rejeição é âmbar, nunca vermelho.
7. **Estados** (frame 1C) — vazio ("O mundo ainda é um mistério" + CTA Voltar à cena), carregando ("Abrindo o grimório…"), erro ("A memória não respondeu" + retry).

## Dados
- Fonte: endpoints existentes do pacote `brain` (`/brain/map` para nós+edges; journal/timeline/atividade conforme a API atual — se algum endpoint faltar, crie-o no pacote `brain` lendo os arquivos .md do vault).
- Stems de edges e verbos de comando permanecem em inglês (`works_for`, `CREATE`…); toda a UI em pt-BR.
- Parse de stamps `SN.TN` → "Sessão N · Turno N" num util compartilhado.

## Regras
- Reutilize os tokens CSS já criados no handoff "O Grimório Aberto"; os novos valores estão na seção Tokens do README.
- Fontes já carregadas: Cinzel + EB Garamond.
- Canvas com devicePixelRatio; ResizeObserver para redimensionar.
- Não use bibliotecas de grafo — a física do protótipo cabe em ~100 linhas e já está ajustada.
- Acessibilidade: overlay com foco preso, `Esc` fecha, botões com aria-label, hit targets ≥ 40px.
