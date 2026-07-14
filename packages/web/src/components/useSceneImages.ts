/**
 * Estado da feature "Illustrate scene": um job por vez (o server é
 * single-flight), imagens acumuladas por chave da linha de narração.
 * Como no escriba do brain, o server não empurra o fim do job — polling
 * leve em /scene-image/status só enquanto há job ativo.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSceneImageStatus, requestSceneImage } from "../api.js";

const POLL_MS = 2500;
/** Destilação + swap de VRAM + geração ~50-70s; encoder frio pode passar disso. */
const GIVE_UP_MS = 300_000;

export interface SceneImagesState {
  /** key da narração → URL do PNG gerado. */
  images: Record<string, string>;
  /** key do job em andamento (shimmer na linha correspondente). */
  activeKey: string | null;
  error: { key: string; message: string } | null;
}

export function useSceneImages(sessionId: string | null): SceneImagesState & {
  illustrate: (key: string, narration: string) => void;
} {
  const [images, setImages] = useState<Record<string, string>>({});
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const illustrate = useCallback(
    (key: string, narration: string) => {
      if (!sessionId) return;
      setError(null);
      setActiveKey(key);
      const started = Date.now();

      const poll = async () => {
        try {
          const status = await fetchSceneImageStatus();
          if (status.jobKey === key && status.phase === "done" && status.url) {
            setImages((prev) => ({ ...prev, [key]: status.url! }));
            setActiveKey(null);
            return;
          }
          if (status.jobKey === key && status.phase === "error") {
            setError({ key, message: status.error ?? "The image did not come out." });
            setActiveKey(null);
            return;
          }
        } catch {
          // status fora do ar: continua tentando até o give-up
        }
        if (Date.now() - started < GIVE_UP_MS) {
          timerRef.current = setTimeout(() => void poll(), POLL_MS);
        } else {
          setError({ key, message: "The illustration took too long — try again." });
          setActiveKey(null);
        }
      };

      requestSceneImage(sessionId, key, narration)
        .then(() => {
          timerRef.current = setTimeout(() => void poll(), POLL_MS);
        })
        .catch((err) => {
          setError({ key, message: err instanceof Error ? err.message : String(err) });
          setActiveKey(null);
        });
    },
    [sessionId],
  );

  return { images, activeKey, error, illustrate };
}
