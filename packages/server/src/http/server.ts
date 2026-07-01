import "dotenv/config";
import cors from "cors";
import express from "express";
import {
  NARRATIVE_MODEL,
  RULES_MODEL,
  runTurn,
  type StreamEvent,
} from "../gm/agent.js";
import { createSession, getSession } from "../gm/sessions.js";
import { parsePathbuilder } from "../pathbuilder/parse.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT ?? 3001);
const LMSTUDIO_BASE_URL =
  process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1";

const KICKOFF =
  "Begin the adventure. Describe the opening scene, where my character is and what they notice around them, and end with a hook for my action.";

/** Checks whether LM Studio is reachable and which configured models are present. */
async function checkLmStudio(): Promise<{
  reachable: boolean;
  models: Record<string, boolean>;
}> {
  const wanted = { rules: RULES_MODEL, narrative: NARRATIVE_MODEL };
  try {
    const res = await fetch(`${LMSTUDIO_BASE_URL}/models`);
    if (!res.ok) return { reachable: false, models: { rules: false, narrative: false } };
    const data = (await res.json()) as { data?: { id?: string }[] };
    const ids = (data.data ?? []).map((m) => m.id ?? "");
    // LM Studio reports each model's key as the id; match exact or substring.
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
  const lmstudio = await checkLmStudio();
  res.json({
    ok: true,
    models: { rules: RULES_MODEL, narrative: NARRATIVE_MODEL },
    lmstudio,
  });
});

/** Imports the Pathbuilder JSON and creates a session. */
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
    const session = createSession(character);
    res.json({
      sessionId: session.id,
      character,
      state: session.state,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Failed to import character:", message);
    res.status(400).json({ error: message });
  }
});

/** Runs a turn and streams the GM events via SSE. */
app.post("/scene/turn", async (req, res) => {
  const { sessionId, text } = req.body ?? {};
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

  const playerText = typeof text === "string" && text.trim() ? text : KICKOFF;
  await runTurn(session, playerText, send);
  res.end();
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
  console.log(`LM Studio: ${LMSTUDIO_BASE_URL} | ${modelLine}`);
  const { reachable, models } = await checkLmStudio();
  if (!reachable) {
    console.warn(
      `WARNING: LM Studio not reachable at ${LMSTUDIO_BASE_URL}. Run: lms server start`,
    );
    return;
  }
  if (!models.rules) {
    console.warn(
      `WARNING: rules model "${RULES_MODEL}" not found. Run: lms get ${RULES_MODEL}`,
    );
  }
  if (!models.narrative) {
    console.warn(
      `WARNING: narrative model "${NARRATIVE_MODEL}" not found. Run: lms get ${NARRATIVE_MODEL}`,
    );
  }
});
