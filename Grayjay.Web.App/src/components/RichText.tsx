import { For } from "solid-js";

/**
 * Renders plain description text safely (no innerHTML): links become anchors and timestamps (1:23, 1:02:03)
 * become buttons that seek the player.
 */
export default function RichText(props: { text?: string; onTimestamp?: (seconds: number) => void }) {
  const parts = () => {
    const text = (props.text ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
    const re = /(https?:\/\/[^\s<>"']+)|(\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b)/g;
    const out: { t: "text" | "link" | "time"; v: string }[] = [];
    let last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
      out.push({ t: m[1] ? "link" : "time", v: m[0] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ t: "text", v: text.slice(last) });
    return out;
  };
  const toSeconds = (s: string) => s.split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
  return (
    <span class="rich-text">
      <For each={parts()}>
        {(p) =>
          p.t === "link" ? <a href={p.v} target="_blank" rel="noreferrer noopener">{p.v.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}</a>
            : p.t === "time" && props.onTimestamp ? <button class="ts-link" onClick={() => props.onTimestamp!(toSeconds(p.v))}>{p.v}</button>
              : <>{p.v}</>
        }
      </For>
    </span>
  );
}
