/** Formats a modifier with a sign: +4 / -1 / +0. */
export const fmt = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

/** Initial(s) for the placeholder avatar. */
export const initials = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";
