import { useRef, useState } from "react";
import { StarIcon, UploadIcon } from "./icons.js";

interface Props {
  onImport: (rawJson: string) => void;
  error: string | null;
  busy: boolean;
}

export function ImportScreen({ onImport, error, busy }: Props) {
  const [json, setJson] = useState("");
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function readFile(file: File) {
    setJson(await file.text());
  }

  return (
    <div className="import">
      <div className="import-left">
        <div className="emblem">
          <StarIcon size={56} />
        </div>
        <div className="kicker">PATHFINDER 2E</div>
        <h2>Solo RPG</h2>
        <p className="tagline">
          An AI Game Master narrates your story. Every decision is yours; every roll, fate's.
        </p>
      </div>

      <div className="import-right">
        <h1>Begin your story</h1>
        <p className="lead">
          Import a character built in Pathbuilder 2e — drag the <code>.json</code> file or paste its
          contents below.
        </p>

        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void readFile(f);
          }}
        />
        <div
          className={`dropzone${drag ? " drag" : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => fileRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") fileRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void readFile(f);
          }}
        >
          <UploadIcon size={28} style={{ color: "var(--gold)" }} />
          <strong>Drag the .json file here</strong>
          <small>or click to browse</small>
        </div>

        <div className="sep">OR PASTE THE JSON</div>

        <textarea
          className="json"
          value={json}
          onChange={(e) => setJson(e.target.value)}
          placeholder='{"success":true,"build":{ ... }}'
          aria-label="Pathbuilder JSON"
        />

        {error && <p className="error">{error}</p>}

        <button
          className="btn-primary"
          disabled={busy || json.trim().length === 0}
          onClick={() => onImport(json)}
        >
          {busy ? "Importing…" : "Import character and play"}
        </button>
      </div>
    </div>
  );
}
