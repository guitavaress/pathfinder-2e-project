import { describe, expect, it } from "vitest";
import { SceneImageQueue, type SceneImageJob } from "./queue.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SceneImageQueue", () => {
  it("roda um job por vez e expõe as fases", async () => {
    const gate = deferred<string>();
    const phases: string[] = [];
    const q = new SceneImageQueue(async (_job, setPhase) => {
      setPhase("generating");
      return gate.promise;
    });

    expect(q.push({ key: "n1", narration: "a" })).toBe(true);
    await tick();
    expect(q.busy).toBe(true);
    phases.push(q.snapshot().phase);
    gate.resolve("/scene-images/x.png");
    await tick();
    expect(phases).toEqual(["generating"]);
    expect(q.snapshot()).toMatchObject({ phase: "done", url: "/scene-images/x.png", jobKey: "n1" });
    expect(q.busy).toBe(false);
  });

  it("coalesce clique repetido do mesmo job em andamento", async () => {
    const gate = deferred<string>();
    let runs = 0;
    const q = new SceneImageQueue(async () => {
      runs += 1;
      return gate.promise;
    });
    q.push({ key: "n1", narration: "a" });
    await tick();
    expect(q.push({ key: "n1", narration: "a" })).toBe(false);
    gate.resolve("/x.png");
    await tick();
    expect(runs).toBe(1);
  });

  it("jobs de narrações diferentes rodam em sequência", async () => {
    const order: string[] = [];
    const q = new SceneImageQueue(async (job: SceneImageJob) => {
      order.push(job.key);
      return `/img-${job.key}.png`;
    });
    q.push({ key: "n1", narration: "a" });
    q.push({ key: "n2", narration: "b" });
    await tick();
    await tick();
    expect(order).toEqual(["n1", "n2"]);
    expect(q.snapshot()).toMatchObject({ phase: "done", jobKey: "n2" });
  });

  it("erro do job vira snapshot error sem derrubar a fila", async () => {
    const q = new SceneImageQueue(async (job: SceneImageJob) => {
      if (job.key === "boom") throw new Error("ComfyUI não respondeu");
      return "/ok.png";
    });
    q.push({ key: "boom", narration: "a" });
    await tick();
    expect(q.snapshot()).toMatchObject({ phase: "error", error: "ComfyUI não respondeu" });
    q.push({ key: "n2", narration: "b" });
    await tick();
    expect(q.snapshot()).toMatchObject({ phase: "done", jobKey: "n2" });
  });

  it("permite tentar de novo um job que falhou (mesma key)", async () => {
    let attempt = 0;
    const q = new SceneImageQueue(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("falhou");
      return "/ok.png";
    });
    q.push({ key: "n1", narration: "a" });
    await tick();
    expect(q.snapshot().phase).toBe("error");
    expect(q.push({ key: "n1", narration: "a" })).toBe(true);
    await tick();
    expect(q.snapshot()).toMatchObject({ phase: "done", url: "/ok.png" });
  });
});
