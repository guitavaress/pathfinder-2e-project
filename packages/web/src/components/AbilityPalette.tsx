import { useEffect, useRef } from "react";
import type { PaletteEntry } from "../api.js";

const GROUP_LABEL: Record<PaletteEntry["group"], string> = {
  ability: "Feats & features",
  spell: "Spells",
  item: "Gear",
  identity: "Identity",
};

interface Props {
  entries: PaletteEntry[];
  selected: number;
  onPick: (entry: PaletteEntry) => void;
  onHover: (index: number) => void;
}

/**
 * A lista que abre no `@` (Fase 2.7).
 *
 * Mostra o que a FICHA tem, com o custo de ação vindo do dado. Escolher aqui
 * não é só conforto de digitação: leva junto a categoria e o uuid do
 * documento, e é isso que faz a colisão de nomes desaparecer antes de o
 * modelo ver qualquer coisa.
 */
export function AbilityPalette({ entries, selected, onPick, onHover }: Props) {
  const listRef = useRef<HTMLUListElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // A seta leva a seleção pra fora da janela de 280px — sem isto o jogador
  // navega às cegas até uma opção que não está na tela. `scrollTop` no próprio
  // container, e não `scrollIntoView`, que aqui já quebrou o layout antes.
  useEffect(() => {
    const list = listRef.current;
    const el = activeRef.current;
    if (!list || !el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [selected, entries]);

  if (entries.length === 0) return null;
  let lastGroup: PaletteEntry["group"] | null = null;
  return (
    <ul className="palette" role="listbox" aria-label="Your abilities" ref={listRef}>
      {entries.map((e, i) => {
        const header = e.group !== lastGroup ? GROUP_LABEL[e.group] : null;
        lastGroup = e.group;
        return (
          <li key={`${e.category}:${e.name}`}>
            {header && <div className="palette-group">{header}</div>}
            <button
              type="button"
              role="option"
              ref={i === selected ? activeRef : null}
              aria-selected={i === selected}
              className={`palette-row${i === selected ? " on" : ""}`}
              // `onMouseDown` e não `onClick`: o clique não pode tirar o foco
              // do campo antes de inserir, senão o cursor se perde.
              onMouseDown={(ev) => {
                ev.preventDefault();
                onPick(e);
              }}
              onMouseEnter={() => onHover(i)}
            >
              <span className="palette-name">{e.name}</span>
              {e.cost && <span className="palette-cost">{e.cost}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
