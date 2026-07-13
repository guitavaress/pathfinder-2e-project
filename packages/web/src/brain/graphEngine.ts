/**
 * Motor do grafo constelação (frame 1A do handoff design_handoff_brain):
 * canvas force-directed com os parâmetros exatos do protótipo — repulsão
 * 2600/d² (corte 260px), molas rest 128 / k 0.012, gravidade 0.0016,
 * damping 0.86, zoom 0.35–3.2 ancorado no cursor, rótulos de edge a partir
 * de zoom ≥ 1.45 (e sempre nas edges do nó focado). Sem bibliotecas.
 */
import { TYPE_META, type BrainGraph, type BrainGraphNode, type NodeType } from "./api.js";

interface SimNode extends BrainGraphNode {
  deg: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

interface SimEdge {
  from: string;
  to: string;
  label: string;
  na: SimNode;
  nb: SimNode;
}

export interface GraphEngine {
  setSearch(q: string): void;
  toggleFilter(type: NodeType): void;
  filters(): Record<NodeType, boolean>;
  setSelected(stem: string | null, center: boolean): void;
  zoom(): number;
  destroy(): void;
}

export interface GraphEngineCallbacks {
  onSelect(stem: string | null): void;
  onZoom(z: number): void;
}

export function createGraphEngine(
  canvas: HTMLCanvasElement,
  data: BrainGraph,
  cb: GraphEngineCallbacks,
): GraphEngine {
  const ctx = canvas.getContext("2d")!;

  const degree = new Map<string, number>(data.nodes.map((n) => [n.stem, 0]));
  for (const e of data.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const N = data.nodes.length;
  const nodes: SimNode[] = data.nodes.map((n, i) => {
    const a = (i / Math.max(N, 1)) * Math.PI * 2;
    const r = 160 + (i % 5) * 46;
    const deg = degree.get(n.stem) ?? 0;
    return {
      ...n,
      deg,
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
      vx: 0,
      vy: 0,
      r: Math.min(19, 7.5 + deg * 1.5),
    };
  });
  const byStem = new Map(nodes.map((n) => [n.stem, n]));
  const edges: SimEdge[] = data.edges
    .map((e) => ({ ...e, na: byStem.get(e.from)!, nb: byStem.get(e.to)! }))
    .filter((e) => e.na && e.nb);

  const stars: [number, number, number][] = [];
  for (let i = 0; i < 70; i++) {
    stars.push([Math.random(), Math.random(), Math.random() * 0.14 + 0.05]);
  }

  const g = {
    w: 0,
    h: 0,
    dpr: 1,
    zoom: 1,
    panX: 0,
    panY: 0,
    centered: false,
    hover: null as SimNode | null,
    selected: null as string | null,
    dragNode: null as SimNode | null,
    panning: false,
    moved: 0,
    raf: 0,
    search: "",
    filters: Object.fromEntries(
      (Object.keys(TYPE_META) as NodeType[]).map((t) => [t, true]),
    ) as Record<NodeType, boolean>,
  };

  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    g.w = w;
    g.h = h;
    g.dpr = dpr;
    if (!g.centered) {
      g.panX = w / 2;
      g.panY = h / 2;
      g.centered = true;
    }
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  const visible = (n: SimNode) => g.filters[n.type];
  const toWorld = (sx: number, sy: number): [number, number] => [
    (sx - g.panX) / g.zoom,
    (sy - g.panY) / g.zoom,
  ];
  const pick = (sx: number, sy: number): SimNode | null => {
    const [wx, wy] = toWorld(sx, sy);
    let best: SimNode | null = null;
    let bd = Infinity;
    for (const n of nodes) {
      if (!visible(n)) continue;
      const d = Math.hypot(n.x - wx, n.y - wy);
      if (d < n.r + 7 && d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  };

  const tick = () => {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const d2 = dx * dx + dy * dy || 1;
        if (d2 > 260 * 260) continue;
        const f = 2600 / d2;
        const d = Math.sqrt(d2);
        dx /= d;
        dy /= d;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }
    }
    for (const e of edges) {
      const dx = e.nb.x - e.na.x;
      const dy = e.nb.y - e.na.y;
      const d = Math.hypot(dx, dy) || 1;
      const f = (d - 128) * 0.012;
      e.na.vx += (dx / d) * f;
      e.na.vy += (dy / d) * f;
      e.nb.vx -= (dx / d) * f;
      e.nb.vy -= (dy / d) * f;
    }
    for (const n of nodes) {
      n.vx -= n.x * 0.0016;
      n.vy -= n.y * 0.0016;
      n.vx *= 0.86;
      n.vy *= 0.86;
      if (n !== g.dragNode) {
        n.x += n.vx;
        n.y += n.vy;
      }
    }
  };

  /** Glifo por tipo (busto/triângulo/bandeira/"!"/losango/livro). */
  const glyph = (n: SimNode, c: string, s: number) => {
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    switch (n.type) {
      case "npc":
        ctx.arc(0, -s * 0.35, s * 0.32, 0, Math.PI * 2);
        ctx.moveTo(-s * 0.55, s * 0.55);
        ctx.arc(0, s * 0.62, s * 0.56, Math.PI, 0);
        ctx.stroke();
        break;
      case "place":
        ctx.moveTo(0, -s * 0.6);
        ctx.lineTo(s * 0.55, s * 0.5);
        ctx.lineTo(-s * 0.55, s * 0.5);
        ctx.closePath();
        ctx.stroke();
        break;
      case "faction":
        ctx.moveTo(-s * 0.35, -s * 0.6);
        ctx.lineTo(-s * 0.35, s * 0.62);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-s * 0.35, -s * 0.55);
        ctx.lineTo(s * 0.55, -s * 0.28);
        ctx.lineTo(-s * 0.35, 0);
        ctx.closePath();
        ctx.fill();
        break;
      case "quest":
        ctx.font = `700 ${Math.round(s * 1.5)}px Cinzel, serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("!", 0, s * 0.05);
        break;
      case "item":
        ctx.moveTo(0, -s * 0.62);
        ctx.lineTo(s * 0.5, 0);
        ctx.lineTo(0, s * 0.62);
        ctx.lineTo(-s * 0.5, 0);
        ctx.closePath();
        ctx.stroke();
        break;
      case "lore":
        ctx.moveTo(0, -s * 0.4);
        ctx.quadraticCurveTo(-s * 0.62, -s * 0.62, -s * 0.62, s * 0.4);
        ctx.quadraticCurveTo(-s * 0.25, s * 0.25, 0, s * 0.45);
        ctx.quadraticCurveTo(s * 0.25, s * 0.25, s * 0.62, s * 0.4);
        ctx.quadraticCurveTo(s * 0.62, -s * 0.62, 0, -s * 0.4);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.4);
        ctx.lineTo(0, s * 0.45);
        ctx.stroke();
        break;
    }
  };

  const draw = () => {
    const { w, h, dpr } = g;
    if (!w) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // céu de tinta
    ctx.fillStyle = "#0f0b07";
    ctx.fillRect(0, 0, w, h);
    const bg = ctx.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, Math.max(w, h) * 0.7);
    bg.addColorStop(0, "rgba(38,29,16,.9)");
    bg.addColorStop(1, "rgba(15,11,7,0)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    for (const [sx, sy, sa] of stars) {
      ctx.fillStyle = `rgba(198,162,76,${sa})`;
      ctx.fillRect(sx * w, sy * h, 1.6, 1.6);
    }
    ctx.translate(g.panX, g.panY);
    ctx.scale(g.zoom, g.zoom);

    const focus = g.hover ?? (g.selected ? byStem.get(g.selected) ?? null : null);
    const neighbors = new Set<string>();
    if (focus) {
      neighbors.add(focus.stem);
      for (const e of edges) {
        if (e.from === focus.stem) neighbors.add(e.to);
        if (e.to === focus.stem) neighbors.add(e.from);
      }
    }
    const q = g.search.trim().toLowerCase();
    const matches = q
      ? new Set(nodes.filter((n) => n.name.toLowerCase().includes(q)).map((n) => n.stem))
      : null;
    const dimOf = (stem: string) => {
      if (matches && !matches.has(stem)) return 0.14;
      if (focus && !neighbors.has(stem)) return 0.16;
      return 1;
    };
    const showEdgeLabels = g.zoom >= 1.45;

    for (const e of edges) {
      if (!visible(e.na) || !visible(e.nb)) continue;
      const hi = !!focus && (e.from === focus.stem || e.to === focus.stem);
      const alpha = Math.min(dimOf(e.from), dimOf(e.to));
      ctx.globalAlpha = hi ? 1 : alpha;
      ctx.strokeStyle = hi ? "rgba(227,200,120,.85)" : "rgba(198,162,76,.22)";
      ctx.lineWidth = (hi ? 1.6 : 1) / g.zoom;
      ctx.beginPath();
      ctx.moveTo(e.na.x, e.na.y);
      ctx.lineTo(e.nb.x, e.nb.y);
      ctx.stroke();
      if ((showEdgeLabels || hi) && alpha > 0.5) {
        const mx = (e.na.x + e.nb.x) / 2;
        const my = (e.na.y + e.nb.y) / 2;
        const fs = 10.5 / Math.max(g.zoom, 1);
        ctx.font = `italic ${fs}px "EB Garamond", serif`;
        const tw = ctx.measureText(e.label).width;
        ctx.fillStyle = "#171209";
        ctx.globalAlpha = (hi ? 1 : alpha) * 0.92;
        ctx.fillRect(mx - tw / 2 - 4, my - fs * 0.75, tw + 8, fs * 1.5);
        ctx.globalAlpha = hi ? 1 : alpha;
        ctx.fillStyle = "#9a8868";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(e.label, mx, my);
      }
    }

    for (const n of nodes) {
      if (!visible(n)) continue;
      const c = TYPE_META[n.type].color;
      const isSel = g.selected === n.stem;
      const isHover = g.hover === n;
      const alpha = isSel || isHover ? 1 : dimOf(n.stem);
      ctx.globalAlpha = alpha;
      if (alpha > 0.5) {
        ctx.shadowColor = c;
        ctx.shadowBlur = isSel || isHover ? 22 : 10;
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = "#1a130c";
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = (isSel ? 2.4 : 1.6) / Math.sqrt(g.zoom);
      ctx.strokeStyle = c;
      ctx.stroke();
      if (isSel) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = "#e3c878";
        ctx.lineWidth = 1 / g.zoom;
        ctx.setLineDash([3 / g.zoom, 3 / g.zoom]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (matches?.has(n.stem)) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = "#e3c878";
        ctx.lineWidth = 1.4 / g.zoom;
        ctx.stroke();
      }
      ctx.save();
      ctx.translate(n.x, n.y);
      glyph(n, c, n.r * 0.62);
      ctx.restore();
      const showLabel = g.zoom >= 0.8 || n.deg >= 4 || isSel || isHover;
      if (showLabel && alpha > 0.3) {
        const fs = Math.max(11, 12.5 / Math.sqrt(g.zoom));
        ctx.font = `500 ${fs}px "EB Garamond", serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = isSel || isHover ? "#f0e2bc" : "#b6a585";
        ctx.fillText(n.name, n.x, n.y + n.r + 5);
      }
      ctx.globalAlpha = 1;
    }
  };

  const loop = () => {
    tick();
    draw();
    g.raf = requestAnimationFrame(loop);
  };
  g.raf = requestAnimationFrame(loop);

  const onDown = (ev: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    g.moved = 0;
    const n = pick(sx, sy);
    if (n) g.dragNode = n;
    else g.panning = true;
    canvas.style.cursor = "grabbing";
    canvas.setPointerCapture(ev.pointerId);
  };
  const onMove = (ev: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    if (g.dragNode) {
      g.moved += 1;
      const [wx, wy] = toWorld(sx, sy);
      g.dragNode.x = wx;
      g.dragNode.y = wy;
      g.dragNode.vx = 0;
      g.dragNode.vy = 0;
    } else if (g.panning) {
      g.moved += 1;
      g.panX += ev.movementX;
      g.panY += ev.movementY;
    } else {
      const n = pick(sx, sy);
      g.hover = n;
      canvas.style.cursor = n ? "pointer" : "grab";
    }
  };
  const onUp = (ev: PointerEvent) => {
    if (g.moved < 4) {
      const rect = canvas.getBoundingClientRect();
      const n = pick(ev.clientX - rect.left, ev.clientY - rect.top);
      g.selected = n ? n.stem : null;
      cb.onSelect(g.selected);
    }
    g.dragNode = null;
    g.panning = false;
    canvas.style.cursor = "grab";
  };
  const onLeave = () => {
    g.hover = null;
  };
  const onWheel = (ev: WheelEvent) => {
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const factor = Math.exp(-ev.deltaY * 0.0016);
    const z = Math.min(3.2, Math.max(0.35, g.zoom * factor));
    const [wx, wy] = toWorld(sx, sy);
    g.zoom = z;
    g.panX = sx - wx * z;
    g.panY = sy - wy * z;
    cb.onZoom(z);
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  return {
    setSearch(q) {
      g.search = q;
    },
    toggleFilter(type) {
      g.filters[type] = !g.filters[type];
    },
    filters() {
      return { ...g.filters };
    },
    setSelected(stem, center) {
      g.selected = stem;
      if (stem && center) {
        const n = byStem.get(stem);
        if (n) {
          g.panX = g.w / 2 - n.x * g.zoom;
          g.panY = g.h / 2 - n.y * g.zoom;
        }
      }
    },
    zoom() {
      return g.zoom;
    },
    destroy() {
      cancelAnimationFrame(g.raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    },
  };
}
