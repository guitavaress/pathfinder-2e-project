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
  if (entries.length === 0) return null;
  let lastGroup: PaletteEntry["group"] | null = null;
  return (
    <ul className="palette" role="listbox" aria-label="Your abilities">
      {entries.map((e, i) => {
        const header = e.group !== lastGroup ? GROUP_LABEL[e.group] : null;
        lastGroup = e.group;
        return (
          <li key={`${e.category}:${e.name}`}>
            {header && <div className="palette-group">{header}</div>}
            <button
              type="button"
              role="option"
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
