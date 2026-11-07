/**
 * Narrow an ARIA snapshot for read_page: one subtree, a depth limit, only
 * interactive elements, or a character cap. Snapshots are YAML-style lines,
 * two spaces of indent per level.
 */

export interface SnapshotFilter {
  /** "interactive" lists only elements you can act on, flattened. */
  filter?: "all" | "interactive";
  /** Levels to keep below the root (or below refId). */
  depth?: number;
  /** Keep only this element's subtree, e.g. "e12". */
  refId?: string;
  /** Truncate the result to this many characters. */
  maxChars?: number;
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
]);

const indentOf = (line: string): number => line.length - line.trimStart().length;
const roleOf = (line: string): string => /^-\s+([a-z]+)/.exec(line.trim())?.[1] ?? "";

export function filterSnapshot(snapshot: string, options: SnapshotFilter = {}): string {
  let lines = snapshot.split("\n").filter((l) => l.trim().length > 0);

  if (options.refId) {
    const marker = `[ref=${options.refId}]`;
    const start = lines.findIndex((l) => l.includes(marker));
    if (start === -1) throw new Error(`Ref "${options.refId}" not found. Call read_page again.`);
    const base = indentOf(lines[start]!);
    let end = start + 1;
    while (end < lines.length && indentOf(lines[end]!) > base) end++;
    lines = lines.slice(start, end).map((l) => l.slice(base));
  }

  if (options.depth !== undefined) {
    const levels = Math.max(1, options.depth);
    lines = lines.filter((l) => indentOf(l) / 2 < levels);
  }

  if (options.filter === "interactive") {
    lines = lines
      .filter((l) => l.includes("[ref=") && INTERACTIVE_ROLES.has(roleOf(l)))
      .map((l) => l.trim().replace(/:$/, ""));
  }

  const out = lines.join("\n");
  if (options.maxChars !== undefined && out.length > options.maxChars) {
    return `${out.slice(0, options.maxChars)}\n\n[truncated: ${out.length} chars total]`;
  }
  return out;
}
