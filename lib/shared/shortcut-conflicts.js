// Shared comparison rules; usable by both GNOME Shell and preferences without GTK.
const modifierAliases = {
  primary: "ctrl",
  control: "ctrl",
  ctl: "ctrl",
  mod1: "alt",
  mod4: "super",
};
const keyAliases = { ".": "period", "+": "plus", "-": "minus", " ": "space" };

export function canonicalAccelerator(accelerator) {
  if (typeof accelerator !== "string") return null;
  const text = accelerator.trim().toLowerCase();
  if (!text || text === "disabled") return null;
  const modifiers = [...text.matchAll(/<([^>]+)>/g)].map(
    ([, modifier]) => modifierAliases[modifier] ?? modifier
  );
  const key = text.replace(/<[^>]+>/g, "");
  if (!key || /[<>]/.test(key)) return null;
  return `${[...new Set(modifiers)].sort().join("+")}:${keyAliases[key] ?? key}`;
}

export function findShortcutConflicts(accelerators, records, owner) {
  const conflicts = [];
  const seen = new Set();
  for (const accelerator of accelerators) {
    const canonical = canonicalAccelerator(accelerator);
    if (!canonical) continue;
    if (seen.has(canonical)) {
      conflicts.push({ accelerator, kind: "duplicate" });
      continue;
    }
    seen.add(canonical);
    for (const record of records) {
      if (record.source === owner?.source && record.key === owner?.key) continue;
      if (record.accelerators.some((value) => canonicalAccelerator(value) === canonical)) {
        conflicts.push({ accelerator, kind: "binding", ...record });
      }
    }
  }
  return conflicts;
}
