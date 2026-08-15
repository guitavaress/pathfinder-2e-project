# Colisão de nomes no índice do dataset — a decisão, com os números

> Rascunho de decisão preparado em 2026-08-14 (madrugada). **Não implementei
> nada**: a escolha é sua e antecede a Fase 2.5. Isto existe para ela virar uma
> linha em vez de uma investigação.

## O problema, em um caso

`lookupLocalRule` indexa por nome exato com precedência de categoria
(`NAME_INDEX_ORDER`, com `actions` na frente de `feats`). Quando o mesmo nome
existe nas duas, a de `actions` ganha e a outra fica invisível.

```
Shake It Off (actions) → "Frequency once per day. Trigger You fail or critically
                          fail a saving throw against a condition…"
Shake It Off (feats)   → "You concentrate on your rage, overcoming fear and
                          fighting back sickness. Reduce your Frightened…"
```

São **habilidades diferentes** que dividem o nome. O GM pede a regra do feat do
bárbaro e recebe a reação de uma vez por dia. É a causa do FAIL do Shake it Off
na bateria — e do Shield Block.

## O tamanho real (medido no dataset @ 7.8.0)

| | |
|---|---|
| nomes distintos indexáveis | 27.077 |
| **colisões** (mesmo nome em 2+ categorias) | **309** (1,1%) |
| maiores pares | `feats ⟵ spells` 85 · `actions ⟵ feats` 50 · `equipment ⟵ feats` 26 |
| feats sombreados por actions | 53 |
| **destes, com texto DIVERGENTE** (Jaccard < 0,6) | **47** |

Os 6 restantes são o mesmo texto em dois lugares — colisão inofensiva. Os 47 são
o GM lendo a regra errada. Os mais divergentes: `Opportune Riposte` (0,00),
`Swim` (0,03), `Overdrive` (0,05), `Shake It Off` (0,05), `Quick Alchemy` (0,05),
`Shield Block` (0,06).

**Conclusão da medição: a colisão não é cosmética.** Onde ela acontece, erra em
~89% dos casos.

## As três opções que você levantou

| opção | o que resolve | o que não resolve |
|---|---|---|
| (a) expor homônimos no `lookupLocalRule` | o modelo vê os dois e escolhe pelo contexto | custa tokens em toda consulta; depende do modelo escolher certo |
| (b) só registrar | nada — vira telemetria | o GM continua lendo a regra errada |
| (c) precedência explícita por categoria | os casos em que uma categoria é sempre certa | **nenhum destes**: para `Shake It Off` a resposta certa depende da CLASSE do personagem, não da categoria. Precedência estática só muda de quem é o erro |

## O que eu recomendo, e por quê

**(a), com um portão determinístico antes: prefira o documento que a FICHA
nomeia.**

Se o personagem tem "Shake It Off" na lista de feats, o doc de `feats` é o certo
— e isso a engine decide em código, sem modelo. É o mesmo portão da doutrina 4
que já rejeita cura e item sem fonte, e que a T6.3 usa para disparar efeito.

Quanto isso cobre, medido:

| | colisões |
|---|---|
| **exatamente um lado é nomeável pela ficha** → decide em código | **167 (54%)** |
| 2+ lados nomeáveis → ambígua mesmo com ficha | 128 (41%) |
| nenhum lado na ficha (bestiary, hazard…) → o GM escolhe | 14 (5%) |

Então: **54% resolvidos deterministicamente**, e os outros 46% caem no (a) —
`lookupLocalRule` devolve o principal e LISTA os homônimos, para o modelo
desambiguar com o contexto da cena. O (b) fica embutido de graça: expor o
homônimo já é registrar.

Custo de tokens: só nas 309 consultas colidentes, e só uma linha extra
("também existe X em `feats`"). `homonymsOf(rec)` já existe em `dataset.ts` —
metade da peça está construída.

## Como eu mediria se funcionou

Os dois FAIL da bateria (`Shake it Off`, `Shield Block`) são o teste. O primeiro
deve virar PASS só com esta mudança; o segundo **não** — ele precisa de hardness
estruturado, que o importador ainda não guarda (verificado: os 115 docs
`docType: "shield"` vêm sem hardness/HP/BT).
