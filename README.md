# pathfinder-2e-project

RPG **solo, web e local** baseado em **Pathfinder 2e**, com um **Mestre (Game Master) gerado por IA**
rodando **100% localmente** (sem custo de API). Você importa um personagem criado no
[Pathbuilder 2e](https://pathbuilder2e.com/), e o Mestre narra uma história 100% dirigida pelas suas
decisões — com NPCs, um mundo vivo e testes de perícia seguindo as regras do PF2e
([Archives of Nethys](https://2e.aonprd.com/)).

> **Status:** MVP — importar personagem, ver a ficha e jogar uma **cena narrativa** com NPCs e testes de
> perícia. Motor de combate tático completo virá em fases seguintes.

## Como funciona

O Mestre roda em **modelos locais via [Ollama](https://ollama.com/)**, num **pipeline de dois modelos
especializados** por turno:

1. **Regras (`RULES_MODEL`)** — resolve a mecânica PF2e com *tool use*: escolhe o teste/DC, rola dados
   (`roll_check`), consulta regras (`lookup_rule`), atualiza o estado (`update_state`) e produz um
   resumo mecânico. Isso impede "alucinação" de rolagens (os dados vêm do código, não do modelo).
2. **Narrativa (`NARRATIVE_MODEL`)** — recebe esse resumo e escreve a cena imersiva (streaming),
   coerente com o resultado. Não chama ferramentas.

- **Padrão:** `RULES_MODEL=qwen3:30b-a3b` + `NARRATIVE_MODEL=gemma3:27b` (máxima qualidade).
  ⚠️ Esse par **não cabe concorrente** em GPUs de ~12GB → turnos lentos (offload/troca). Para fluidez,
  use no `.env` o par menor `RULES_MODEL=qwen3:8b` + `NARRATIVE_MODEL=gemma3:12b`.
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
- GPU NVIDIA: o par menor (`qwen3:8b` + `gemma3:12b`) cabe em ~12GB e roda fluido; o par grande
  (`qwen3:30b-a3b` + `gemma3:27b`) precisa de bem mais memória ou aceita ser lento (offload/troca)

## Configuração

```bash
# 1. Instale o Ollama (https://ollama.com/download) e baixe os dois modelos
ollama pull qwen3:30b-a3b   # regras (ou o par menor: ollama pull qwen3:8b)
ollama pull gemma3:27b      # narrativa (ou: ollama pull gemma3:12b)

# 2. Dependências do projeto
npm install
cp .env.example .env   # ajuste RULES_MODEL / NARRATIVE_MODEL / OLLAMA_HOST

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
