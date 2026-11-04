// Captions in the preview: the same choices the export writes into its ASS file, drawn with CSS.
import { keyWordIndex, spokenIndex, type Line } from "../captions";
import type { CaptionStyle, Draft } from "../types";

const clamp = (v: number) => Math.max(0, Math.min(1, v));

function entrance(anim: CaptionStyle["anim"], dt: number): { opacity?: number; transform?: string } {
  if (anim === "fade") return { opacity: clamp(dt / 0.18) };
  if (anim === "rise") return { transform: `translateY(${(1 - clamp(dt / 0.24)) * 0.9}em)` };
  if (anim === "drop") return { transform: `translateY(${-(1 - clamp(dt / 0.24)) * 0.9}em)` };
  if (anim === "pop") return { transform: `scale(${0.7 + 0.3 * clamp(dt / 0.16)})` };
  return {};
}

export function CaptionView({ line, tr, st, show, t }: { line: Line | null; tr: Line | null; st: CaptionStyle; show: NonNullable<Draft["capShow"]>; t: number }) {
  const main = show === "tr" ? tr : line;
  const under = show === "both" ? tr : null;
  const edge = st.glow ? `0 0 .15em ${st.outline}, 0 0 .4em ${st.outline}, 0 0 .8em ${st.outline}` : `0 0 3px ${st.outline}, 0 0 3px ${st.outline}, 0 0 6px ${st.outline}`;
  const words = main && !main.custom ? main.words ?? [] : [];
  const anim = st.anim ?? "none";
  const byWord = st.animBy === "word" && anim !== "none" && words.length > 0;
  const reveal = (anim === "type" || byWord) && words.length > 0;
  const key = keyWordIndex(words, st.keyword);
  const k = main ? spokenIndex(main, t) : -1;
  const wordWise = words.length > 0 && (!!st.highlight || !!st.markColor || reveal || key >= 0);
  return (
    <div class={`caption ${st.position} ${st.box ? "boxed" : ""}`} style={{
      fontSize: `${st.size * 0.78}cqh`, color: st.color, fontWeight: st.bold === false ? 400 : 700, fontFamily: `"${st.font}", var(--font, sans-serif)`,
      fontStyle: st.italic ? "italic" : undefined, letterSpacing: st.spacing ? `${st.spacing}px` : undefined, textAlign: st.align ?? "center", textShadow: st.box ? "none" : edge,
    }}>
      {main && (
        <span style={{ display: "inline-block", whiteSpace: "pre-line", background: st.box ? st.boxColor || st.outline : undefined, ...(byWord || !main ? {} : entrance(anim, t - main.t0)) }}>
          {wordWise
            ? words.map((w, j) => {
                const spoken = j === k;
                if (reveal && j > k) return <>{j ? (w.br ? <br /> : " ") : ""}<span style={{ visibility: "hidden" }}>{w.t}</span></>;
                const color = spoken && st.highlight ? st.highlight : j === key && st.keyColor ? st.keyColor : undefined;
                const word: Record<string, string | number | undefined> = { color, display: "inline-block" };
                if (spoken && st.pop) word.transform = "scale(1.12)";
                if (spoken && st.markColor) { word.background = st.markColor; word.boxShadow = `0 0 0 .12em ${st.markColor}`; }
                if (spoken && byWord) Object.assign(word, entrance(anim === "pop" ? "pop" : "fade", t - (j === 0 ? main.t0 : w.t0)));
                return <>{j ? (w.br ? <br /> : " ") : ""}<span style={word}>{w.t}</span></>;
              })
            : main.text}
        </span>
      )}
      {under && <div class="caption-tr" style={{ fontSize: ".75em", fontWeight: 400 }}>{under.text}</div>}
    </div>
  );
}
