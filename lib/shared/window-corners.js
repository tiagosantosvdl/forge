// Pure helpers shared by the shell manager and its tests.
export const CSS_BEGIN = "/* BEGIN Forge window corners */";
export const CSS_END = "/* END Forge window corners */";

export function normalizeRadius(value) {
  const radius = Number.parseFloat(value);
  return Number.isFinite(radius) ? Math.max(0, Math.min(28, radius)) : 14;
}

export function gtkCornerCss(radius, version) {
  const window = version === 3 ? "window.csd" : "window";
  const decoration = version === 3 ? "window.csd decoration" : "window > contents";
  return `${window}, ${decoration} { border-radius: ${radius}px; }
${window} headerbar { border-top-left-radius: ${radius}px; border-top-right-radius: ${radius}px; }
${window}.maximized, ${window}.fullscreen,
${window}.maximized ${version === 3 ? "decoration" : "> contents"},
${window}.fullscreen ${version === 3 ? "decoration" : "> contents"},
${window}.maximized headerbar, ${window}.fullscreen headerbar { border-radius: 0; }`;
}

export function qtCornerCss(radius) {
  // QSS has no fullscreen pseudo-state, and property selectors can remain
  // cached after a state change. Keep a square theme base so clipping controls
  // the radius without introducing rounded backgrounds in fullscreen.
  return `/* Forge window corners: ${radius}px through compositor clipping. */
QWidget:window { border-radius: 0; }
`;
}

export function replaceCornerBlock(contents, css = null) {
  let clean = contents;
  let start;
  while ((start = clean.indexOf(CSS_BEGIN)) !== -1) {
    const end = clean.indexOf(CSS_END, start);
    if (end === -1) throw new Error("Incomplete Forge window corners block");
    let stop = end + CSS_END.length;
    if (clean[stop] === "\n") stop++;
    clean = clean.slice(0, start) + clean.slice(stop);
  }
  // The block owns all added whitespace, so removing it restores a file
  // without a final newline exactly as it was.
  if (css === null) return clean;
  return `${clean}${CSS_BEGIN}\n${css}\n${CSS_END}\n`;
}

// Keep existing QSettings list tokens verbatim, including quoted commas and
// escaped characters. GLib string lists use a different separator and cannot
// be used to read Qt's INI files.
export function qtListTokens(value) {
  if (!value || value.trim() === "@Invalid()") return [];
  const tokens = [];
  let quoted = false;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      tokens.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quoted || escaped) throw new Error("Malformed Qt stylesheet list");
  tokens.push(value.slice(start).trim());
  return tokens.filter(Boolean);
}

export function qtPathToken(path) {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function updateQtStylesheets(contents, path, enabled, previous = null) {
  const token = qtPathToken(path);
  let lines = contents.split("\n");
  let start = lines.findIndex((line) => /^\s*\[Interface\]\s*\r?$/.test(line));
  if (start === -1) {
    if (!enabled) return { contents, previous };
    previous = { original: null, applied: null, createdSection: "\n[Interface]\n" };
    lines = `${contents}${previous.createdSection}`.split("\n");
    start = lines.length - 2;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  let index = -1;
  for (let i = start + 1; i < end; i++) {
    if (/^\s*stylesheets\s*=/.test(lines[i])) {
      if (index !== -1) throw new Error("Duplicate Qt stylesheet keys");
      index = i;
    }
  }
  const original = index === -1 ? null : lines[index];
  const value = original?.slice(original.indexOf("=") + 1).trim() ?? "";
  const tokens = qtListTokens(value);
  const ownToken = (item) => item === token || item === path;
  const existing = tokens.filter((item) => !ownToken(item));
  if (enabled) {
    if (previous && original !== previous.applied) {
      // A settings UI may change the list while we are running. That becomes
      // the new baseline; never restore an older list over the user's edit.
      previous.original = tokens.some(ownToken) ? `stylesheets=${existing.join(", ")}` : original;
    }
    previous ??= { original, applied: null };
    const updated = `stylesheets=${[...existing, token].join(", ")}`;
    if (index === -1) lines.splice(start + 1, 0, updated);
    else lines[index] = updated;
    previous.applied = updated;
  } else if (index !== -1 && tokens.some(ownToken)) {
    if (original === previous?.applied) {
      if (previous.original === null) lines.splice(index, 1);
      else lines[index] = previous.original;
    } else {
      // Preserve edits made by Qt's settings UI while Forge was enabled.
      lines[index] = `stylesheets=${existing.join(", ")}`;
    }
  }
  let updatedContents = lines.join("\n");
  if (!enabled && previous?.createdSection) {
    // Remove our appended empty section only if no user keys were added to it.
    const section = lines.slice(start + 1, end - (original === previous.applied ? 1 : 0));
    if (section.every((line) => !line.trim())) {
      updatedContents = updatedContents.replace(previous.createdSection, "");
    }
  }
  return { contents: updatedContents, previous };
}

export function cornerGeometry(frame, buffer, width, height, radius) {
  if (width <= 0 || height <= 0 || buffer.width <= 0 || buffer.height <= 0) return null;
  const scaleX = width / buffer.width;
  const scaleY = height / buffer.height;
  const left = (frame.x - buffer.x) * scaleX;
  const top = (frame.y - buffer.y) * scaleY;
  const frameWidth = frame.width * scaleX;
  const frameHeight = frame.height * scaleY;
  if (frameWidth <= 0 || frameHeight <= 0) return null;
  return {
    size: [width, height],
    bounds: [left, top, left + frameWidth, top + frameHeight],
    radius: Math.min(radius * Math.min(scaleX, scaleY), frameWidth / 2, frameHeight / 2),
  };
}

// ClutterOffscreenEffect pads and quantizes the actor's paint volume before
// allocating its texture. Match _clutter_actor_box_enlarge_for_effects, then
// use the actual texture size so resource scaling and reallocations are handled.
export function cornerPaintGeometry(geometry, paint, textureWidth, textureHeight, scale) {
  const paddedX = Math.ceil(paint.x + paint.width + 0.75) - Math.round(paint.width) - 3;
  const paddedY = Math.ceil(paint.y + paint.height + 0.75) - Math.round(paint.height) - 3;
  return {
    ...geometry,
    size: [textureWidth / scale, textureHeight / scale],
    origin: [
      Math.trunc(paddedX - (paint.allocation ? paint.x : 0)),
      Math.trunc(paddedY - (paint.allocation ? paint.y : 0)),
    ],
  };
}
