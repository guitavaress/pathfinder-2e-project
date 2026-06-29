import { useCallback, useState } from "react";
import type { Character, GameState } from "@pf2e/shared";
import { importCharacter, streamTurn } from "./api.js";
import { CharacterSheet } from "./components/CharacterSheet.js";
import { ImportScreen } from "./components/ImportScreen.js";
import { Scene, type LogItem } from "./components/Scene.js";

export function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [character, setCharacter] = useState<Character | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [log, setLog] = useState<LogItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<"rules" | "narrative" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runTurn = useCallback(
    async (id: string, text: string) => {
      setBusy(true);
      setPhase(null);
      try {
        await streamTurn(id, text, (event) => {
          switch (event.type) {
            case "phase":
              setPhase(event.phase);
              break;
            case "delta":
              // Atualização PURA: mescla o delta no último bloco de narração,
              // ou cria um novo se o último item for player/check. Sem mutar refs
              // dentro do updater (StrictMode chama o updater 2x em dev).
              setLog((prev) => {
                const last = prev[prev.length - 1];
                if (last && last.kind === "narration") {
                  return [
                    ...prev.slice(0, -1),
                    { kind: "narration", text: last.text + event.text },
                  ];
                }
                return [...prev, { kind: "narration", text: event.text }];
              });
              break;
            case "check":
              setLog((prev) => [...prev, { kind: "check", result: event.result }]);
              break;
            case "state":
              setState(event.state);
              break;
            case "error":
              setError(event.message);
              break;
            case "done":
              break;
          }
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        setPhase(null);
      }
    },
    [],
  );

  const handleImport = useCallback(
    async (rawJson: string) => {
      setError(null);
      setBusy(true);
      try {
        const result = await importCharacter(rawJson);
        setSessionId(result.sessionId);
        setCharacter(result.character);
        setState(result.state);
        setLog([]);
        // Inicia automaticamente a cena de abertura (texto vazio = kickoff).
        await runTurn(result.sessionId, "");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [runTurn],
  );

  const handleSend = useCallback(
    (text: string) => {
      if (!sessionId) return;
      setLog((prev) => [...prev, { kind: "player", text }]);
      void runTurn(sessionId, text);
    },
    [sessionId, runTurn],
  );

  if (!sessionId || !character || !state) {
    return <ImportScreen onImport={handleImport} error={error} busy={busy} />;
  }

  return (
    <div className="game">
      <CharacterSheet character={character} state={state} />
      <main>
        {error && <p className="error">{error}</p>}
        <Scene log={log} busy={busy} phase={phase} onSend={handleSend} />
      </main>
    </div>
  );
}
