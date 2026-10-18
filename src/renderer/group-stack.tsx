// The icon in front of a player's name when they are in a group of friends in this lobby: assets/grouped-lobby/
// two-stack.svg for two friends, three-stack.svg for three, four-stack.svg, five-stack.svg (five or more).

/**
 * Vite bundles whichever of the icon files exist, so the app builds and runs without them: the group is then shown
 * as the text label ("3 friends") instead.
 */
const STACK_ICONS = import.meta.glob("../../assets/grouped-lobby/*-stack.svg", {
  eager: true, query: "?url", import: "default",
}) as Record<string, string>;

const WORDS = ["", "", "two", "three", "four", "five"];

/** `size` is how many players of the lobby are in the group; nothing is shown for fewer than two. */
export function GroupStack({ size, label }: { size: number; label: string | null }) {
  const n = Math.min(5, Math.floor(size));
  if (n < 2) return null;
  const url = STACK_ICONS[`../../assets/grouped-lobby/${WORDS[n]}-stack.svg`];
  const title = `${label ?? `${size} friends`} in this lobby`;
  if (!url) return label ? <span className="group-badge" title={title}>{label}</span> : null;
  return <img className="group-stack" src={url} alt={label ?? `${size} friends`} title={title} draggable={false} />;
}
