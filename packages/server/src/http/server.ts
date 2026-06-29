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
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";

const KICKOFF =
  "Comece a aventura. Descreva a cena de abertura, onde meu personagem está e o que percebe ao redor, e termine com uma deixa para minha ação.";

/** Verifica se o Ollama está acessível e quais modelos configurados estão presentes. */
async function checkOllama(): Promise<{
  reachable: boolean;
  models: Record<string, boolean>;
}> {
  const wanted = { rules: RULES_MODEL, narrative: NARRATIVE_MODEL };
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    if (!res.ok) return { reachable: false, models: { rules: false, narrative: false } };
    const data = (await res.json()) as { models?: { name?: string }[] };
    const names = (data.models ?? []).map((m) => m.name ?? "");
    const has = (tag: string) => {
      const base = tag.split(":")[0];
      return names.some((n) => n === tag || n.startsWith(`${base}:`));
    };
    return {
      reachable: true,
      models: { rules: has(wanted.rules), narrative: has(wanted.narrative) },
    };
  } catch {
    return { reachable: false, models: { rules: false, narrative: false } };
  }
}

app.get("/health", async (_req, res) => {
  const ollama = await checkOllama();
  res.json({
    ok: true,
    models: { rules: RULES_MODEL, narrative: NARRATIVE_MODEL },
    ollama,
  });
});

/** Importa o JSON do Pathbuilder e cria uma sessão. */
app.post("/character/import", (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object") {
      res.status(400).json({
        error:
          "Corpo vazio ou inválido. Envie o JSON do Pathbuilder com Content-Type: application/json.",
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
    console.error("Falha ao importar personagem:", message);
    res.status(400).json({ error: message });
  }
});

/** Executa um turno e transmite os eventos do GM via SSE. */
app.post("/scene/turn", async (req, res) => {
  const { sessionId, text } = req.body ?? {};
  const session = getSession(String(sessionId ?? ""));
  if (!session) {
    res.status(404).json({ error: "Sessão não encontrada." });
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

// Handler de erro global: body-parser (JSON malformado), payload grande, etc.
// Garante resposta JSON + log, em vez de um 500 em HTML.
app.use(
  (
    err: Error & { status?: number; type?: string },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("Erro na requisição:", err.message);
    const status = err.status && err.status < 500 ? err.status : 400;
    res.status(status).json({
      error:
        err.type === "entity.parse.failed"
          ? "JSON inválido no corpo da requisição."
          : err.message,
    });
  },
);

app.listen(PORT, async () => {
  console.log(`GM server ouvindo em http://localhost:${PORT}`);
  console.log(
    `Ollama: ${OLLAMA_HOST} | regras: ${RULES_MODEL} | narrativa: ${NARRATIVE_MODEL}`,
  );
  const { reachable, models } = await checkOllama();
  if (!reachable) {
    console.warn(
      `AVISO: Ollama não acessível em ${OLLAMA_HOST}. Inicie o Ollama antes de jogar.`,
    );
    return;
  }
  if (!models.rules) {
    console.warn(
      `AVISO: modelo de regras "${RULES_MODEL}" não encontrado. Rode: ollama pull ${RULES_MODEL}`,
    );
  }
  if (!models.narrative) {
    console.warn(
      `AVISO: modelo de narrativa "${NARRATIVE_MODEL}" não encontrado. Rode: ollama pull ${NARRATIVE_MODEL}`,
    );
  }
});
