# pathfinder-2e-project

RPG **solo, web e local** baseado em **Pathfinder 2e**, com um **Mestre (Game Master) gerado por IA**
rodando **100% localmente** (sem custo de API). Você importa um personagem criado no
[Pathbuilder 2e](https://pathbuilder2e.com/), e o Mestre narra uma história 100% dirigida pelas suas
decisões — com NPCs, um mundo vivo e testes de perícia seguindo as regras do PF2e
([Archives of Nethys](https://2e.aonprd.com/)).

> **Status:** MVP — importar personagem, ver a ficha e jogar uma **cena narrativa** com NPCs e testes de
> perícia. Motor de combate tático completo virá em fases seguintes.

## Como funciona

O Mestre é um **agente com tool use** rodando num **modelo local via [Ollama](https://ollama.com/)**:
em vez de inventar números, ele *chama ferramentas* para rolar dados (`roll_check`), consultar regras
(`lookup_rule`), ler a ficha (`get_character`) e registrar o estado da cena (`update_state`). Isso
garante aderência às regras do PF2e e impede "alucinação" de rolagens.

- **Modelo padrão:** `qwen2.5:7b` (versão instruct; tool calling confiável + bom português). Trocável
  por `.env` (`GM_MODEL`), ex.: `llama3.1:8b`.
- **Custo de inferência:** zero — tudo roda na sua máquina.

## Estrutura

```
packages/
├── shared/   # tipos TS compartilhados (Character, GameState, CheckResult...)
├── server/   # Node/Express: API REST + agente GM (Ollama) + dados + regras PF2e
└── web/      # React/Vite: import, ficha e cena narrativa (streaming via SSE)
```

## Requisitos

- Node.js 20+
- [Ollama](https://ollama.com/) instalado e rodando
- GPU NVIDIA com ~8GB+ de VRAM recomendado (roda em CPU, porém lento)

## Configuração

```bash
# 1. Instale o Ollama (https://ollama.com/download) e baixe o modelo
ollama pull qwen2.5:7b

# 2. Dependências do projeto
npm install
cp .env.example .env   # ajuste OLLAMA_HOST / GM_MODEL se necessário

# 3. Base de regras do PF2e (índice local para o GM consultar)
#    Baixa o dataset do repo foundryvtt/pf2e (~26k entradas: ações, talentos,
#    magias, condições, itens, bestiário). Requer git. Versão via PF2E_GIT_REF.
npm run data:pf2e
#    Alternativa: ler da sua instalação local do Foundry (feche o Foundry antes):
#    npm run data:pf2e -- --from-local      # usa PF2E_SYSTEM_PATH
```

> O dataset gerado fica em `packages/server/data/pf2e/generated/` (gitignored — não
> redistribuído). Antes de rodar `data:pf2e`, o GM usa uma pequena base semente.

### Mundo / cenário

Copie `LORE.example.md` para **`LORE.md`** na raiz e descreva o seu cenário + diretrizes do Mestre.
Ele é injetado automaticamente no prompt do GM (os segredos ali nunca são revelados diretamente ao
jogador). O `LORE.md` é **gitignored** (fica local, fora do repo público — porque costuma conter
spoilers só-GM). Caminho configurável via `LORE_PATH`; sem `LORE.md`, o jogo roda sem lore específica.

## Rodando

Em dois terminais:

```bash
npm run dev:server   # backend do GM em http://localhost:3001
npm run dev:web      # frontend em http://localhost:5173
```

Abra `http://localhost:5173`, importe `exemplo_personagem.json` (um Goblin Rogue nível 5) ou o seu próprio
export do Pathbuilder 2e, e comece a jogar. (O Ollama precisa estar rodando com o modelo já baixado.)

## Testes e build

```bash
npm test     # testes do parser do Pathbuilder e dos dados/graus de sucesso
npm run build
```

## Licença

MIT
