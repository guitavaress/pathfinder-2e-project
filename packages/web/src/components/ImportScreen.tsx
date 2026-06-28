import { useState } from "react";

interface Props {
  onImport: (rawJson: string) => void;
  error: string | null;
  busy: boolean;
}

export function ImportScreen({ onImport, error, busy }: Props) {
  const [json, setJson] = useState("");

  async function handleFile(file: File) {
    setJson(await file.text());
  }

  return (
    <div className="import">
      <h1>Pathfinder 2e — RPG Solo</h1>
      <p>
        Cole o JSON exportado do <strong>Pathbuilder 2e</strong> ou envie o
        arquivo para começar.
      </p>
      <input
        type="file"
        accept="application/json,.json"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
      />
      <textarea
        value={json}
        onChange={(e) => setJson(e.target.value)}
        placeholder='{"success":true,"build":{ ... }}'
        rows={12}
      />
      {error && <p className="error">{error}</p>}
      <button
        disabled={busy || json.trim().length === 0}
        onClick={() => onImport(json)}
      >
        {busy ? "Importando…" : "Importar personagem"}
      </button>
    </div>
  );
}
