/**
 * Rules fallback via Archives of Nethys.
 *
 * AoN is backed by a public Elasticsearch index. We query that index for cases
 * not covered by the local dataset. Everything here degrades gracefully: any
 * network error returns `null`, and the GM falls back on general PF2e knowledge
 * instead of breaking the scene.
 */

const AON_ELASTIC = "https://elasticsearch.aonprd.com/aon/_search";
const AON_BASE = "https://2e.aonprd.com";

export interface WebRuleHit {
  name: string;
  category: string;
  url: string;
  text: string;
}

interface ElasticHit {
  _source?: {
    name?: string;
    category?: string;
    url?: string;
    text?: string;
    markdown?: string;
  };
}

export async function lookupWebRule(
  query: string,
  timeoutMs = 6000,
): Promise<WebRuleHit | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(AON_ELASTIC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        size: 1,
        query: {
          multi_match: {
            query,
            fields: ["name^3", "text", "markdown"],
            type: "best_fields",
          },
        },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      hits?: { hits?: ElasticHit[] };
    };
    const hit = data.hits?.hits?.[0]?._source;
    if (!hit?.name) return null;

    const raw = hit.text ?? hit.markdown ?? "";
    const text = raw.replace(/\s+/g, " ").slice(0, 1200);
    return {
      name: hit.name,
      category: hit.category ?? "",
      url: hit.url ? `${AON_BASE}${hit.url}` : AON_BASE,
      text,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
