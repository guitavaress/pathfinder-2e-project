// Load the repo-root .env FIRST, before any import that reads process.env at
// module load (e.g. ../gm/agent.js). ESM evaluates imports in source order, so
// this side-effect import must stay at the very top.
import "../env.js";
import cors from "cors";
import express from "express";
import {
  LLM_BASE_URL,
  NARRATIVE_MODEL,
  RULES_MODEL,
  runTurn,
  type StreamEvent,
} from "../gm/agent.js";
import { existsSync, renameSync } from "node:fs";
import { z } from "zod";
import { graphView } from "@pf2e/brain";
import { TurnRefSchema } from "@pf2e/shared";
import {
  brainActivityLog,
  brainBumpSession,
  brainDir,
  brainSessionStart,
  brainStore,
  brainWriting,
  resetBrainStore,
} from "../gm/brain.js";
import { archiveDestination } from "../gm/campaign-archive.js";
import { buildRecapData, resumeKickoff } from "../gm/recap.js";
import { loadSave, restoreIntoSession } from "../gm/save.js";
import { createSession, getSession } from "../gm/sessions.js";
import { parsePathbuilder } from "../pathbuilder/parse.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT ?? 3001);

const KICKOFF =
  "Begin the adventure by narrating the opening scene described under 'Opening scene' in the Setting. Introduce ONLY what is physically present around my character right now — keep it grounded and mundane. Reveal nothing cosmic, secret, or from the GM-only lore. Keep it short (1-3 paragraphs) and end with a single, concrete hook for my first action.";

/** Checks whether the LLM server is reachable and serving the configured model. */
async function checkLlmServer(): Promise<{
  reachable: boolean;
  models: Record<string, boolean>;
}> {
  const wanted = { rules: RULES_MODEL, narrative: NARRATIVE_MODEL };
  try {
    const res = await fetch(`${LLM_BASE_URL}/models`);
    if (!res.ok) return { reachable: false, models: { rules: false, narrative: false } };
    const data = (await res.json()) as { data?: { id?: string }[] };
    const ids = (data.data ?? []).map((m) => m.id ?? "");
    // Substring both ways: LM Studio reports the model key as the id, while
    // llama.cpp reports the GGUF path ("models/gemma-4-12b-it-UD-Q4_K_XL.gguf"),
    // so the configured key is a fragment of it.
    const has = (key: string) =>
      ids.some((id) => id === key || id.includes(key) || key.includes(id));
    return {
      reachable: true,
      models: { rules: has(wanted.rules), narrative: has(wanted.narrative) },
    };
  } catch {
    return { reachable: false, models: { rules: false, narrative: false } };
  }
}

app.get("/health", async (_req, res) => {
  const llm = await checkLlmServer();
  res.json({
    ok: true,
    models: { rules: RULES_MODEL, narrative: NARRATIVE_MODEL },
    llm,
  });
});

/** Há campanha em andamento? (save, nós do grafo ou relógio já avançado). */
function campaignExists(): boolean {
  if (!existsSync(brainDir())) return false;
  if (loadSave() !== null) return true;
  try {
    const s = brainStore();
    return s.listStems().length > 0 || s.meta().session > 0;
  } catch {
    return false;
  }
}

/**
 * Arquiva a campanha atual (brain + save) em `brain-archive-<data>/` — nunca
 * apaga. O próximo brainStore() nasce num diretório limpo.
 */
function archiveCampaign(): string | null {
  const dir = brainDir();
  if (!campaignExists()) return null;
  const dest = archiveDestination(dir);
  renameSync(dir, dest);
  resetBrainStore();
  console.log(`[campaign] campanha anterior arquivada em ${dest}`);
  return dest;
}

/** Imports the Pathbuilder JSON and starts a NEW campaign (archives the old one). */
app.post("/character/import", (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object") {
      res.status(400).json({
        error:
          "Empty or invalid body. Send the Pathbuilder JSON with Content-Type: application/json.",
      });
      return;
    }
    const character = parsePathbuilder(req.body);
    const archived = archiveCampaign();
    const session = createSession(character);
    // Brain: semeia o Protagonist.md e abre a primeira sentada (S1).
    brainSessionStart(character);
    brainBumpSession();
    res.json({
      sessionId: session.id,
      character,
      state: session.state,
      archived,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Failed to import character:", message);
    res.status(400).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// Continuidade de campanha: save.json (gravado a cada turno) + recap do brain.
// ---------------------------------------------------------------------------

/** Metadados da campanha salva (alimenta o card "Continue" da UI). */
app.get("/campaign", (_req, res) => {
  const save = loadSave();
  if (!save) {
    res.json({ exists: false });
    return;
  }
  const { name, ancestry, className, level } = save.character;
  let recap: string[] = [];
  let meta = { session: 0, turn: 0 };
  try {
    meta = brainStore().meta();
    recap = brainStore()
      .readOffGrid("Timeline")
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .slice(-3);
  } catch {
    // brain ilegível não impede o continue — o save é a fonte da sessão.
  }
  res.json({
    exists: true,
    character: { name, ancestry, className, level },
    meta,
    savedAt: save.savedAt,
    recap,
  });
});

/** Retoma a campanha do save: sessão restaurada + próxima sentada no relógio. */
app.post("/campaign/continue", (_req, res) => {
  const save = loadSave();
  if (!save) {
    res.status(404).json({ error: "No saved campaign to continue." });
    return;
  }
  const session = createSession(save.character);
  restoreIntoSession(session, save);
  brainSessionStart(save.character);
  brainBumpSession();
  res.json({
    sessionId: session.id,
    character: save.character,
    state: session.state,
    resumed: true,
  });
});

/** Runs a turn and streams the GM events via SSE. */
app.post("/scene/turn", async (req, res) => {
  const { sessionId, text, refs } = req.body ?? {};
  const session = getSession(String(sessionId ?? ""));
  if (!session) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: StreamEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  let playerText: string;
  if (typeof text === "string" && text.trim()) {
    playerText = text;
  } else if (session.resumed) {
    // Primeiro turno de uma retomada: "Anteriormente…" em vez da Opening scene.
    session.resumed = false;
    playerText = resumeKickoff(buildRecapData(brainStore(), loadSave()));
  } else {
    playerText = KICKOFF;
  }
  // Referências que o jogador fixou na paleta (Fase 2.7). Validadas aqui: um
  // `refs` malformado vira lista vazia — o turno acontece do mesmo jeito, só
  // sem a desambiguação. Nunca derruba a jogada por causa da UI.
  const parsedRefs = z.array(TurnRefSchema).safeParse(refs);
  if (refs !== undefined && !parsedRefs.success) {
    console.warn("[turn] refs inválidos, ignorados:", parsedRefs.error.issues[0]?.message);
  }
  await runTurn(session, playerText, send, parsedRefs.success ? parsedRefs.data : []);
  res.end();
});

// ---------------------------------------------------------------------------
// Brain do protagonista (grafo de conhecimento revelado) — leitura JSON.
// A UI de grafo vem depois; por ora as rotas alimentam qualquer cliente.
// ---------------------------------------------------------------------------

/** Índice {stem: descrição} do grafo. */
app.get("/brain/map", (_req, res) => {
  res.json({ map: brainStore().readMap(), meta: brainStore().meta() });
});

/** Grafo estruturado para a UI: nós tipados + edges resolvidas. */
app.get("/brain/graph", (_req, res) => {
  res.json({ ...graphView(brainStore()), meta: brainStore().meta() });
});

/** Conteúdo Markdown de um nó. */
app.get("/brain/node/:stem", (req, res) => {
  const node = brainStore().readNode(String(req.params.stem ?? ""));
  if (!node) {
    res.status(404).json({ error: "No such node." });
    return;
  }
  res.json(node);
});

/** Diário de sessão (append-only). */
app.get("/brain/journal", (_req, res) => {
  res.json({
    journal: brainStore().readOffGrid("Journal"),
    timeline: brainStore().readOffGrid("Timeline"),
  });
});

/** Trilha de auditoria dos write passes (aplicados/rejeitados). */
app.get("/brain/activity", (_req, res) => {
  res.json({ activity: brainActivityLog(), writing: brainWriting() });
});

// Global error handler: body-parser (malformed JSON), large payload, etc.
// Ensures a JSON response + log instead of an HTML 500.
app.use(
  (
    err: Error & { status?: number; type?: string },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("Request error:", err.message);
    const status = err.status && err.status < 500 ? err.status : 400;
    res.status(status).json({
      error:
        err.type === "entity.parse.failed"
          ? "Invalid JSON in the request body."
          : err.message,
    });
  },
);

app.listen(PORT, async () => {
  console.log(`GM server listening on http://localhost:${PORT}`);
  const modelLine =
    RULES_MODEL === NARRATIVE_MODEL
      ? `GM model (single, two contexts): ${RULES_MODEL}`
      : `rules: ${RULES_MODEL} | narrative: ${NARRATIVE_MODEL}`;
  console.log(`LLM server: ${LLM_BASE_URL} | ${modelLine}`);
  const { reachable, models } = await checkLlmServer();
  if (!reachable) {
    console.warn(
      `WARNING: no LLM server at ${LLM_BASE_URL}. Start it with: gemma-up`,
    );
    return;
  }
  // O servidor responde, mas serve outro modelo — o jogo roda e o GM erra de um
  // jeito difícil de diagnosticar. Avisar apontando o que ele REALMENTE carregou.
  if (!models.rules) {
    console.warn(
      `WARNING: rules model "${RULES_MODEL}" doesn't match what the server has loaded. Check GET ${LLM_BASE_URL}/models and adjust GM_MODEL (or reload the server with gemma-up).`,
    );
  }
  if (!models.narrative) {
    console.warn(
      `WARNING: narrative model "${NARRATIVE_MODEL}" doesn't match what the server has loaded. Check GET ${LLM_BASE_URL}/models and adjust NARRATIVE_MODEL.`,
    );
  }
});
