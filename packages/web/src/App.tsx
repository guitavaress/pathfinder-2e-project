import { useCallback, useState } from "react";
import type { Character, GameState } from "@pf2e/shared";
import { importCharacter, streamTurn } from "./api.js";
import { CompactRail } from "./components/CompactRail.js";
import { FullSheet } from "./components/FullSheet.js";
import { HeroBanner } from "./components/HeroBanner.js";
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
  const [fullSheetOpen, setFullSheetOpen] = useState(false);

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
              // PURE update: merge the delta into the last narration block, or
              // create a new one if the last item is player/check. No mutating
              // refs inside the updater (StrictMode calls it twice in dev).
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
        // Automatically starts the opening scene (empty text = kickoff).
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
      <HeroBanner character={character} state={state} />
      <div className="game-body">
        <Scene log={log} busy={busy} phase={phase} onSend={handleSend} />
        <CompactRail
          character={character}
          state={state}
          onOpenSheet={() => setFullSheetOpen(true)}
        />
      </div>
      {error && (
        <p className="error" style={{ position: "fixed", bottom: 0, left: 0, right: 0 }}>
          {error}
        </p>
      )}
      {fullSheetOpen && (
        <FullSheet
          character={character}
          state={state}
          onClose={() => setFullSheetOpen(false)}
        />
      )}
    </div>
  );
}
