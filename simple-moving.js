/**
 * Simple Moving - Foundry VTT v14 module.
 *
 * Flow: select token(s) on the Tokens layer, then left-click somewhere visible to the token.
 *   first click -> movement route preview (path, destination marker, distance label)
 *   second click on/near that point -> the tokens move there via TokenDocument#move()
 *   Ctrl+click  -> add an intermediate waypoint; right-click or Escape cancels the plan.
 *
 * Only documented v14 APIs are used: CONFIG-driven TokenLayer/Token subclasses,
 * Token#findMovementPath, Token#measureMovementPath, TokenDocument#move,
 * TokenDocument#getSnappedPosition/getCenterPoint, BaseGrid#getSnappedPoint,
 * GridLayer highlight API, canvas.app.ticker, PreciseText.
 */

const MODULE_ID = "simple-moving";
const STRINGS = "SIMPLEMOVING";
const HIGHLIGHT_NAME = `${MODULE_ID}.destination`;

/* ------------------------------------------------------------------ *
 *  Setting vocabulary                                                *
 *                                                                    *
 *  Settings are registered with a `type:` DataField (that is the key  *
 *  ClientSettings.register reads). Choice fields render as <select>   *
 *  dropdowns in v14, so every on/off preference below stores "on" or  *
 *  "off" instead of being a checkbox.                                 *
 * ------------------------------------------------------------------ */


/** Fallback accent colour when nothing usable is configured. */
const DEFAULT_ACCENT = "#ff9829";

/** Colour swatches offered by the accent colour picker. */
const ACCENT_PALETTE = [
  "#ff9829", "#ffb300", "#ffd54f", "#9ccc65", "#4caf50", "#26a69a",
  "#4fc3f7", "#2196f3", "#3f51b5", "#7e57c2", "#ab47bc", "#ec4899",
  "#ef5350", "#e91e63", "#8d6e63", "#78909c", "#b0bec5", "#f5f5f5"
];

/**
 * Coerce anything colour-shaped into a plain CSS hex string. v14 hands out
 * foundry.utils.Color instances (a Number subclass) rather than strings, so the
 * conversion has to happen before these values reach templates or PIXI.
 */
function cssHex(value, fallback = DEFAULT_ACCENT) {
  if (value == null || value === "") return fallback;

  // We store plain hex strings ourselves, so recognise those before any conversion happens.
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (/^#?[0-9a-f]{6}$/.test(text)) return `#${text.replace("#", "")}`;
  const shorthand = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (shorthand) return `#${shorthand[1]}${shorthand[1]}${shorthand[2]}${shorthand[2]}${shorthand[3]}${shorthand[3]}`;

  try {
    // v14 hands out foundry.utils.Color instances, and Color#from also understands numbers,
    // arrays and strings. The plain constructor would feed a string to Number() and get NaN.
    const color = foundry.utils.Color.from(value);
    if (color?.valid === true) return String(color.css).toLowerCase();
  } catch { /* fall through to the textual fallbacks below */ }

  // Values written by hand or by older versions may still be rgb()/rgba() triples.
  const rgbMatch = /^rgba?\(\s*(\d{1,3})\D+(\d{1,3})\D+(\d{1,3})/.exec(text);
  if (rgbMatch) {
    const [r, g, b] = rgbMatch.slice(1, 4).map(n => Math.max(0, Math.min(255, Number(n))));
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
  }

  return fallback;
}

/** The colour assigned to the acting user, used as the default accent. */
function userColor() {
  return cssHex(game.user?.color, DEFAULT_ACCENT);
}

/** Read an on/off setting tolerating values written by older versions. */
function isOn(key) {
  const value = game.settings.get(MODULE_ID, key);
  if (value === true || value === 1) return true;
  if (typeof value === "string") return ["on", "true", "1"].includes(value.toLowerCase());
  return false;
}

/** Accent colour as a CSS hex string. */
function accentHex() {
  const stored = game.settings.get(MODULE_ID, "accentColor");
  if (stored != null && stored !== "") {
    const converted = cssHex(stored, null);
    if (converted) return converted;
  }
  return userColor();
}

/** Normalise values saved by versions which registered these as text fields. */
function migrateLegacyValues() {
  for (const key of ["enabled", "showDistance", "highlightDestination"]) {
    const value = game.settings.get(MODULE_ID, key);
    if (value === "on" || value === "off") continue;
    const next = (value === true) ? "on" : (value === false ? "off" : isOn(key) ? "on" : "off");
    game.settings.set(MODULE_ID, key, next).catch(() => {});
  }

  // Stored values must be plain hex strings: older versions kept text, v14 may hand us a Color object.
  const stored = game.settings.get(MODULE_ID, "accentColor");
  const normalized = cssHex(stored, null);
  if (normalized === null || normalized !== String(stored)) {
    game.settings.set(MODULE_ID, "accentColor", normalized ?? userColor()).catch(() => {});
  }

  const radius = Number(game.settings.get(MODULE_ID, "confirmRadius"));
  if (!Number.isFinite(radius) || radius < 0.25 || radius > 3) {
    game.settings.set(MODULE_ID, "confirmRadius", 0.75).catch(() => {});
  }
}

/* Injected instead of a manifest stylesheet so the module needs no restart. */
const STYLES = `
#simple-moving-accent .sm-accent-preview {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  height: 34px; padding: 0 12px; border-radius: 6px; color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, .55); font-variant-numeric: tabular-nums;
}
#simple-moving-accent .sm-accent-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(34px, 1fr)); gap: 6px;
}
#simple-moving-accent .sm-accent-swatch {
  height: 32px; padding: 0; border: 1px solid rgba(0, 0, 0, .5); border-radius: 6px;
  cursor: pointer; transition: transform .08s ease, box-shadow .08s ease; background-clip: padding-box;
}
#simple-moving-accent .sm-accent-swatch:hover { transform: translateY(-1px); }
#simple-moving-accent .sm-accent-swatch.active {
  outline: 2px solid #fff; outline-offset: -3px; box-shadow: 0 0 6px rgba(255, 255, 255, .45);
}
#simple-moving-accent .sm-accent-custom { display: flex; align-items: center; gap: 8px; }
#simple-moving-accent input[type="color"] { height: 34px; width: 60px; padding: 2px; cursor: pointer; }
`;

function injectStyles() {
  if (document.getElementById(`${MODULE_ID}-styles`) || !document.head) return;
  const style = document.createElement("style");
  style.id = `${MODULE_ID}-styles`;
  style.textContent = STYLES;
  document.head.appendChild(style);
}

/* ------------------------------------------------------------------ *
 *  Settings                                                          *
 * ------------------------------------------------------------------ */

function registerSettings() {
  const fields = foundry.data.fields;

  game.settings.register(MODULE_ID, "enabled", {
    name: "SIMPLEMOVING.Settings.Enabled.Name",
    hint: "SIMPLEMOVING.Settings.Enabled.Hint",
    scope: "client",
    config: true,
    default: "on",
    type: new fields.StringField({
      initial: "on",
      required: true,
      blank: false,
      choices: { on: `${STRINGS}.Settings.Choices.Enabled`, off: `${STRINGS}.Settings.Choices.Disabled` }
    })
  });

  game.settings.register(MODULE_ID, "activation", {
    name: "SIMPLEMOVING.Settings.Activation.Name",
    hint: "SIMPLEMOVING.Settings.Activation.Hint",
    scope: "client",
    config: true,
    default: "always",
    type: new fields.StringField({
      initial: "always",
      required: true,
      blank: false,
      choices: {
        always: "SIMPLEMOVING.Settings.Activation.Always",
        alt: "SIMPLEMOVING.Settings.Activation.Alt"
      }
    })
  });

  game.settings.register(MODULE_ID, "accentColor", {
    name: "SIMPLEMOVING.Settings.Color.Name",
    hint: "SIMPLEMOVING.Settings.Color.Hint",
    scope: "client",
    config: false,
    default: userColor(),
    type: new fields.ColorField({ initial: () => userColor() })
  });

  game.settings.registerMenu(MODULE_ID, "accentColorPicker", {
    name: "SIMPLEMOVING.Settings.Color.Name",
    label: "SIMPLEMOVING.Color.Button",
    hint: "SIMPLEMOVING.Settings.Color.Hint",
    icon: "fa-solid fa-palette",
    type: AccentColorConfig,
    restricted: false
  });

  game.settings.register(MODULE_ID, "showDistance", {
    name: "SIMPLEMOVING.Settings.Distance.Name",
    hint: "SIMPLEMOVING.Settings.Distance.Hint",
    scope: "client",
    config: true,
    default: "on",
    type: new fields.StringField({
      initial: "on",
      required: true,
      blank: false,
      choices: { on: `${STRINGS}.Settings.Choices.Show`, off: `${STRINGS}.Settings.Choices.Hide` }
    })
  });

  game.settings.register(MODULE_ID, "highlightDestination", {
    name: "SIMPLEMOVING.Settings.Highlight.Name",
    hint: "SIMPLEMOVING.Settings.Highlight.Hint",
    scope: "client",
    config: true,
    default: "on",
    type: new fields.StringField({
      initial: "on",
      required: true,
      blank: false,
      choices: { on: `${STRINGS}.Settings.Choices.Highlight`, off: `${STRINGS}.Settings.Choices.NoHighlight` }
    })
  });

  game.settings.register(MODULE_ID, "confirmRadius", {
    name: "SIMPLEMOVING.Settings.Radius.Name",
    hint: "SIMPLEMOVING.Settings.Radius.Hint",
    scope: "client",
    config: true,
    default: 0.75,
    type: new fields.NumberField({ initial: 0.75, min: 0.25, max: 3, step: 0.05 })
  });

  game.settings.register(MODULE_ID, "hintShown", {
    name: "SIMPLEMOVING.Settings.HintShown.Name",
    scope: "client",
    config: false,
    default: false,
    type: new fields.BooleanField({ initial: false })
  });
}

/* ------------------------------------------------------------------ *
 *  Small helpers                                                     *
 * ------------------------------------------------------------------ */

/** Resolve a CSS/hex color setting to a numeric RGB value. */
function toColor(value, fallback = 0xff9829) {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  // v14 colours are foundry.utils.Color instances, which subclass Number.
  if (value instanceof foundry.utils.Color) return value.valid === true ? Number(value) : fallback;

  const hex = cssHex(value, null);
  if (hex) return Number.parseInt(hex.slice(1), 16);

  const text = String(value ?? "").trim();
  const six = text.match(/^#?([0-9a-f]{6})$/i);
  if (six) return Number.parseInt(six[1], 16);
  const short = text.match(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) {
    return Number.parseInt(short[1].repeat(2) + short[2].repeat(2) + short[3].repeat(2), 16);
  }
  const rgb = text.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (rgb) return (Number(rgb[1]) << 16) | (Number(rgb[2]) << 8) | Number(rgb[3]);
  const numeric = Number.parseInt(text.replace("#", ""), 16);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/** Smallest visible grid extent, used to scale the overlay with the scene. */
function cellSize() {
  const grid = canvas.grid;
  const size = Math.max(grid?.size ?? 50, grid?.sizeY ?? 0, grid?.sizeX ?? 0);
  return Number.isFinite(size) && size > 0 ? size : 50;
}

/* ------------------------------------------------------------------ *
 *  Movement planner and its canvas overlay                           *
 * ------------------------------------------------------------------ */

class MovementPlanner {
  /** @type {Set<foundry.canvas.placeables.Token>} Tokens taking part in the current plan. */
  #tokens = new Set();
  /** @type {object[]} Clicked destination points (grid-space centres) forming the waypoint chain. */
  #destinations = [];
  /** @type {{token: foundry.canvas.placeables.Token, points: object[], end: object, blocked: boolean, distance: number, cost: ?number}[]} Computed routes. */
  #routes = [];

  #container = null;
  #glow = null;
  #line = null;
  #ants = null;
  #marker = null;
  #label = null;
  #highlightName = null;

  #phase = 0;
  #animating = false;
  #altKey = false;
  /** @type {Map<string, string>} Token position snapshot used to notice when a plan goes stale. */
  #snapshot = new Map();

  /* ------------------------------ state -------------------------- */

  get active() {
    return this.#routes.length > 0;
  }

  /** Is the given TokenDocument part of the current plan? */
  owns(document) {
    for (const token of this.#tokens) if (token.document === document) return true;
    return false;
  }

  /** Discard the current plan and hide its overlay. */
  cancel() {
    if (this.#routes.length === 0 && this.#destinations.length === 0) {
      this.#stopAnimation();
      return;
    }
    this.#tokens.clear();
    this.#routes = [];
    this.#destinations = [];
    this.#snapshot.clear();
    this.#clearOverlay();
  }

  /* --------------------------- click routing -------------------- */

  /** May the planner consume a left-click right now? */
  get enabled() {
    if (!isOn("enabled")) return false;
    if (!canvas.ready || canvas.tokens?.active !== true) return false;

    const tool = ui.controls?.tool;
    if (!tool || tool.creation === true) return false;
    if (CONFIG.Canvas.rulerClass.canMeasure === true) return false;
    if (canvas.controls?.ruler?.active === true) return false;

    // Optional modifier-gated mode.
    if (game.settings.get(MODULE_ID, "activation") === "alt" && !this.#altKey) return false;
    return true;
  }

  /**
   * Handle a left-click on the Tokens layer or on a token of that layer.
   * @param {PIXI.FederatedPointerEvent} event                 Pointer-down event
   * @param {foundry.canvas.layers.TokenLayer} layer           Layer whose coordinate space the click uses
   * @param {{onToken?: boolean}} [options]                    Set `onToken` when the click landed on a token object
   * @returns {boolean|Promise<boolean>} true when this module consumed the click
   */
  handleClick(event, layer, { onToken = false } = {}) {
    this.#altKey = Boolean(event.altKey);
    if (!this.enabled || !layer) return false;

    const point = event.interactionData?.origin ?? event.getLocalPosition(layer);

    // A second click on the planned destination performs the move. This also wins when another token is standing there.
    if (this.active && this.#isDestinationClick(point)) {
      event.stopPropagation();
      return this.move();
    }

    // Clicking a token while the preview is up means "work with that token", not "extend my route to it".
    // Drop the overlay and let core handle the selection like it does without this module.
    if (onToken === true) {
      if (this.active) this.cancel();
      return false;
    }

    const tokens = this.#collectTokens();
    if (tokens.length === 0) return false;

    const append = Boolean(event.ctrlKey || event.metaKey);
    event.stopPropagation();
    return this.plan(tokens, point, { append });
  }

  /** Tokens of the current scene that may take part in a click-driven move. */
  #collectTokens() {
    const tokens = [];
    for (const token of canvas.tokens?.controlled ?? []) {
      if (!token || token.isPreview === true) continue;
      const document = token.document;
      if (!document || document.parent !== canvas.scene) continue;
      if (document.locked === true) continue;
      if (game.user.isGM !== true && document.isOwner !== true) continue;
      tokens.push(token);
    }
    return tokens;
  }

  /** Did the click land on (or very near) a planned destination? */
  #isDestinationClick(point) {
    const radius = cellSize() * Number(game.settings.get(MODULE_ID, "confirmRadius") || 0.75);
    for (const point2 of this.#destinations.concat(this.#routes.map((route) => route.end))) {
      if (Math.hypot(point.x - point2.x, point.y - point2.y) <= radius) return true;
    }
    return false;
  }

  /* ----------------------------- planning ----------------------- */

  /**
   * Build the movement preview for the given tokens towards a clicked point.
   * @param {foundry.canvas.placeables.Token[]} tokens
   * @param {{x: number, y: number}} point      Clicked position in Tokens-layer coordinates
   * @param {{append?: boolean}} [options]      Append the point to the waypoint chain instead of replacing it
   */
  async plan(tokens, point, { append = false } = {}) {
    const destination = this.#snapDestination(point);
    if (append && this.active) this.#destinations.push(destination);
    else this.#destinations = [destination];

    this.#tokens = new Set(tokens);
    await this.#computeRoutes();
    this.#drawOverlay();
    this.#showHintOnce();
    return true;
  }

  /** Snap a clicked point to the centre of the nearest grid space. */
  #snapDestination(point) {
    const grid = canvas.grid;
    if (grid.isGridless === true || typeof grid.getSnappedPoint !== "function") {
      return { x: Math.round(point.x), y: Math.round(point.y) };
    }
    const modes = CONST.GRID_SNAPPING_MODES;
    const snapped = grid.getSnappedPoint({ x: point.x, y: point.y }, {
      mode: modes.CENTER | modes.EDGE_MIDPOINT,
      resolution: 1
    });
    return { x: snapped.x, y: snapped.y };
  }

  /** Token position (top-left anchor) whose centre matches the given grid-space point. */
  #waypointForCentre(document, point, elevation) {
    const grid = canvas.grid;
    let candidate;
    if (grid.isGridless === true) {
      candidate = { x: point.x - (document.width / 2), y: point.y - (document.height / 2) };
    } else {
      const sizeX = grid.sizeX ?? grid.size;
      const sizeY = grid.sizeY ?? grid.size;
      candidate = {
        x: point.x - ((document.width * sizeX) / 2),
        y: point.y - ((document.height * sizeY) / 2)
      };
    }
    const snapped = document.getSnappedPosition(candidate);
    return { x: snapped.x, y: snapped.y, elevation };
  }

  /** Ask the core pathfinder for every token's route and measure it. */
  async #computeRoutes() {
    this.#routes = [];
    const jobs = [];

    for (const token of this.#tokens) {
      const document = token.document;
      const origin = { x: document.x, y: document.y, elevation: document.elevation };
      const waypoints = [origin];
      for (const destination of this.#destinations) {
        waypoints.push(this.#waypointForCentre(document, destination, origin.elevation));
      }

      // preview:true stops the route where token vision ends, exactly like a core drag.
      const job = token.findMovementPath(waypoints, { preview: true });
      jobs.push({ token, document, target: waypoints.at(-1), promise: job.promise });
    }

    for (const job of jobs) {
      let path;
      try {
        path = await job.promise;
      } catch (error) {
        console.error(error);
      }

      const positions = Array.isArray(path) ? path.filter((p) => Number.isFinite(p?.x)) : [];
      if (positions.length === 0) {
        // No route at all: show the destination as unreachable.
        this.#routes.push(this.#buildRoute(job, [job.target], { blocked: true }));
        continue;
      }

      let cost = null;
      try {
        const measured = job.token.measureMovementPath(positions, {});
        cost = Number.isFinite(measured.cost) ? measured.cost : (measured.cost === Infinity ? Infinity : null);
      } catch (error) {
        console.debug(error);
      }

      // The core pathfinder truncates a route at walls and unexplored fog.
      const landed = positions.at(-1);
      const drifted = Math.hypot(landed.x - job.target.x, landed.y - job.target.y) > 0.5;
      const blocked = drifted || (cost === Infinity);

      this.#routes.push(this.#buildRoute(job, positions, { blocked }));
    }

    // Remember where the participating tokens are so we can detect a stale plan.
    this.#snapshot.clear();
    for (const token of this.#tokens) {
      const document = token.document;
      this.#snapshot.set(document.id, `${document.x}|${document.y}|${document.elevation}`);
    }
  }

  /** Turn found waypoints into drawable centre points plus measurement data. */
  #buildRoute(job, positions, { blocked }) {
    const document = job.document;
    const start = this.#centreOf(document, { x: document.x, y: document.y });
    const points = [start];

    for (const waypoint of positions) {
      if ((waypoint.x === document.x) && (waypoint.y === document.y)) continue;
      points.push(this.#centreOf(document, waypoint));
    }

    const end = points.at(-1);
    let distance = Math.hypot(end.x - start.x, end.y - start.y);
    try {
      const measured = job.token.measureMovementPath(positions.length > 0 ? positions : [job.target], {});
      if (Number.isFinite(measured.distance)) distance = measured.distance;
    } catch {}

    return { token: job.token, points, end, blocked, distance };
  }

  #centreOf(document, waypoint) {
    try {
      const center = document.getCenterPoint({ x: waypoint.x, y: waypoint.y });
      if (Number.isFinite(center?.x)) return center;
    } catch {}
    return { x: waypoint.x, y: waypoint.y };
  }

  /* ------------------------------- moving ----------------------- */

  /** Perform the planned movement. */
  async move() {
    const routes = this.#routes;
    if (routes.length === 0) return false;

    if (game.paused === true && game.user.isGM !== true) {
      ui.notifications.warn("GAME.PausedWarning", { localize: true });
      return true;
    }

    const blocked = routes.filter((route) => route.blocked);
    if (blocked.length === routes.length) {
      this.cancel();
      ui.notifications.warn(game.i18n.format(`${STRINGS}.Notify.Blocked`));
      return true;
    }

    const destinations = this.#destinations.slice();
    const autoRotate = game.settings.get("core", "tokenAutoRotate") === true;

    // Hide the preview before the core animation so they do not overlap.
    this.cancelOverlayOnly();

    try {
      const tasks = [];
      for (const token of routes.map((route) => route.token)) {
        if (!token || token.isPreview === true) continue;
        const document = token.document;
        if (!document || document.parent !== canvas.scene) continue;
        const waypoints = [{ x: document.x, y: document.y, elevation: document.elevation }];
        for (const destination of destinations) {
          waypoints.push(this.#waypointForCentre(document, destination, document.elevation));
        }
        tasks.push(document.move(waypoints, { autoRotate, showRuler: false }));
      }
      await Promise.all(tasks);
    } catch (error) {
      console.error(error);
      ui.notifications.warn(game.i18n.format(`${STRINGS}.Notify.Failed`));
    } finally {
      this.cancel();
    }

    if ((blocked.length > 0) && (blocked.length < routes.length)) {
      ui.notifications.warn(game.i18n.format(`${STRINGS}.Notify.BlockedSome`, { count: blocked.length }));
    }
    return true;
  }

  /* ------------------------------ overlay ----------------------- */

  #ensureContainer() {
    const layer = canvas.tokens;
    if (!layer || !canvas.ready) return null;
    if ((this.#container?.parent === layer) && this.#glow && (this.#glow.destroyed !== true)) return layer;

    this.#destroyOverlay();
    const container = new PIXI.Container();
    container.eventMode = "none";
    container.zIndex = 1000;

    // Core replaces PIXI.Graphics with the smoothed variant (canvas/extensions/graphics-extension).
    this.#glow = container.addChild(new PIXI.Graphics());
    this.#line = container.addChild(new PIXI.Graphics());
    this.#ants = container.addChild(new PIXI.Graphics());
    this.#marker = container.addChild(new PIXI.Graphics());

    layer.addChild(container);
    this.#container = container;
    return layer;
  }

  #destroyOverlay() {
    if (this.#label && !this.#label.destroyed) this.#label.destroy({ children: true });
    if (this.#container && !this.#container.destroyed) this.#container.destroy({ children: true });
    this.#label = null;
    this.#container = null;
    this.#glow = this.#line = this.#ants = this.#marker = null;
  }

  #clearOverlay() {
    for (const graphics of [this.#glow, this.#line, this.#ants, this.#marker]) {
      if (graphics && !graphics.destroyed) graphics.clear();
    }
    if (this.#label && !this.#label.destroyed) this.#label.visible = false;
    if (this.#highlightName) canvas.interface?.grid?.clearHighlightLayer(this.#highlightName);
  }

  #accentColor() {
    return toColor(accentHex(), 0xff9829);
  }

  /** Re-draw the preview with current settings, keeping the plan intact. */
  redraw() {
    if (this.#routes.length > 0) this.#drawOverlay();
  }

  /** Redraw the whole route preview. */
  #drawOverlay() {
    if (!this.#ensureContainer()) return;
    this.#stopAnimation();
    this.#clearOverlay();
    if (this.#routes.length === 0) return;

    const uiScale = canvas.dimensions?.uiScale ?? 1;
    const accent = this.#accentColor();
    const width = Math.max(3 * uiScale, 2);

    for (const route of this.#routes) {
      if (route.points.length < 2) continue;
      // Dark halo + coloured line.
      this.#strokePolyline(this.#glow, route.points, width * 3.6, accent, 0.14);
      this.#strokePolyline(this.#glow, route.points, width * 2.1, 0x000000, 0.5);
      this.#strokePolyline(this.#line, route.points, width, accent, 0.95);
    }

    if (isOn("highlightDestination")) this.#highlightDestinations(accent);
    if (isOn("showDistance")) this.#drawLabel(accent);

    this.#phase = 0;
    this.#drawMarkers();
    this.#drawAnts();
    this.#startAnimation();
  }

  #strokePolyline(graphics, points, width, color, alpha) {
    if (!graphics || graphics.destroyed || points.length === 0) return;
    graphics.lineStyle({ width, color, alpha, cap: "round", join: "round" });
    graphics.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) graphics.lineTo(points[i].x, points[i].y);
    if (points.length === 1) graphics.drawCircle(points[0].x, points[0].y, width / 2);
  }

  #highlightDestinations(accent) {
    const grid = canvas.interface?.grid;
    if (!grid || typeof grid.addHighlightLayer !== "function") return;
    if (canvas.grid.isGridless === true) return;

    const layer = grid.addHighlightLayer(HIGHLIGHT_NAME);
    if (!layer) return;
    this.#highlightName = HIGHLIGHT_NAME;

    for (const route of this.#routes) {
      const document = route.token.document;
      if (game.user.isGM !== true && !document.isOwner) continue;
      grid.highlightPosition(HIGHLIGHT_NAME, {
        x: Math.round(route.end.x - ((canvas.grid.sizeX ?? canvas.grid.size) / 2)),
        y: Math.round(route.end.y - ((canvas.grid.sizeY ?? canvas.grid.size) / 2)),
        color: accent,
        alpha: 0.35
      });
    }
  }

  #drawLabel(accent) {
    const route = this.#routes.find((entry) => entry.blocked === true) ?? this.#routes[0];
    if (!route || !this.#container || this.#container.destroyed) return;

    const unitsKey = canvas.grid?.units;
    const units = unitsKey ? game.i18n.localize(unitsKey) : "";
    const distance = Math.round(route.distance);

    let text;
    if (route.blocked === true) {
      text = game.i18n.format(`${STRINGS}.Label.Blocked`, { distance, units });
    } else {
      text = game.i18n.format(`${STRINGS}.Label.Distance`, { distance, units });
    }

    if (!this.#label || this.#label.destroyed) {
      const PreciseText = foundry.canvas.containers.PreciseText;
      const style = PreciseText.getTextStyle({ fontSize: 20, fill: route.blocked === true ? 0xff6b57 : accent });
      this.#label = this.#container.addChild(new PreciseText("", style));
    }

    this.#label.text = text;
    this.#label.visible = true;
    if (this.#label.style) {
      const fill = route.blocked === true ? 0xff6b57 : accent;
      this.#label.style.fill = fill;
      // Adaptive contrast stroke, as PreciseText does by default.
      this.#label.style.stroke = route.blocked === true ? 0xffffff : 0x000000;
    }
    this.#positionLabel(route);
  }

  #positionLabel(route) {
    const label = this.#label;
    if (!label || !route) return;
    // PreciseText has no anchor: measure at scale 1, then centre the scaled text on the marker.
    const unscaledWidth = Math.abs(label.width / (label.scale.x || 1));
    const scale = this.#textScale();
    label.scale.set(scale);
    label.x = route.end.x - ((unscaledWidth * scale) / 2);
    label.y = route.end.y - Math.max(cellSize() * 0.6, 34);
  }

  /** Keep the label at a constant on-screen size regardless of canvas zoom. */
  #textScale() {
    let applied = this.#container?.worldTransform?.a ?? NaN;
    if (!Number.isFinite(applied) || (applied === 0)) applied = canvas.app?.stage?.scale?.x ?? 1;
    if (!Number.isFinite(applied) || (applied === 0)) applied = 1;
    return ((canvas.dimensions?.uiScale ?? 1) * 0.9) / applied;
  }

  #drawMarkers() {
    const marker = this.#marker;
    if (!marker || marker.destroyed) return;
    marker.clear();

    const uiScale = canvas.dimensions?.uiScale ?? 1;
    const size = cellSize();
    const accent = this.#accentColor();
    const pulse = (Math.sin(this.#phase) + 1) / 2;

    for (const route of this.#routes) {
      if (game.user.isGM !== true && !route.token.document.isOwner) continue;
      const color = route.blocked === true ? 0xff6b57 : accent;
      const radius = Math.max(size * 0.28, 10);

      // Intermediate Ctrl+click waypoints along the chain.
      marker.lineStyle({ width: Math.max(1.5 * uiScale, 1), color: accent, alpha: 0.7, cap: "round" });
      for (let i = 1; i < route.points.length - 1; i += 1) {
        marker.drawCircle(route.points[i].x, route.points[i].y, Math.max(radius * 0.32, 4));
      }

      // Origin ring at the token being moved.
      const start = route.points[0];
      if (start) {
        marker.lineStyle({ width: Math.max(1.5 * uiScale, 1), color: accent, alpha: 0.38, cap: "round" });
        marker.drawCircle(start.x, start.y, Math.min(radius, size * 0.26));
      }

      // Destination: pulsing outer ring, solid inner ring, translucent hub.
      marker.lineStyle({ width: Math.max(2 * uiScale, 1.5), color, alpha: (0.8 - (pulse * 0.4)), cap: "round" });
      marker.drawCircle(route.end.x, route.end.y, radius + pulse * radius * 0.3);

      marker.lineStyle({ width: Math.max(2.6 * uiScale, 1.75), color, alpha: 1, cap: "round", join: "round" });
      marker.drawCircle(route.end.x, route.end.y, radius);

      const hub = Math.max(radius * 0.45, 5);
      marker.lineStyle(0);
      marker.beginFill(color, 0.3);
      marker.drawCircle(route.end.x, route.end.y, hub);
      if (route.blocked === true) {
        // Cross over the hub marks an unreachable destination.
        const arm = Math.max(radius * 0.45, 6);
        for (const sign of [-1, 1]) {
          marker.moveTo(route.end.x - (arm * sign), route.end.y - arm);
          marker.lineTo(route.end.x + (arm * sign), route.end.y + arm);
        }
      }
      marker.endFill();

      // Cross-hair ticks.
      const inner = radius + (2 * uiScale);
      const outer = radius + Math.max(7 * uiScale, 4);
      marker.lineStyle({ width: Math.max(1.6 * uiScale, 1), color, alpha: 0.9, cap: "round" });
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        marker.moveTo(route.end.x + (inner * dx), route.end.y + (inner * dy));
        marker.lineTo(route.end.x + (outer * dx), route.end.y + (outer * dy));
      }

      // Corner brackets around the landing space read as a "drop here" target.
      if (route.blocked !== true) {
        const half = Math.max(size / 2, radius);
        const armLen = half * 0.45;
        marker.lineStyle({ width: Math.max(1.6 * uiScale, 1), color, alpha: (0.35 + pulse * 0.35), cap: "round" });
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const cx = route.end.x + (half * sx);
          const cy = route.end.y + (half * sy);
          marker.moveTo(cx - (armLen * sx), cy);
          marker.lineTo(cx, cy);
          marker.lineTo(cx, cy - (armLen * sy));
        }
      }
    }
  }

  /** Marching-ants dots along the route so it reads as a plan rather than a measurement. */
  #drawAnts() {
    const ants = this.#ants;
    if (!ants || ants.destroyed) return;
    ants.clear();

    const spacing = Math.max(cellSize() * 0.4, 16);
    const dotRadius = Math.max(1.5 * (canvas.dimensions?.uiScale ?? 1), 1);

    // Forward travel: as the phase advances, dots shift from the token toward the destination.
    const travel = ((this.#phase * spacing) / 2.2) % spacing;

    for (const route of this.#routes) {
      if (route.points.length < 2) continue;
      ants.lineStyle(0);
      ants.beginFill(0xffffff, route.blocked === true ? 0.45 : 0.8);

      let along = travel - spacing;
      for (let i = 1; i < route.points.length; i += 1) {
        const from = route.points[i - 1];
        const to = route.points[i];
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        if (length <= 0.001) continue;
        while (along < length) {
          if (along > spacing * 0.35) {
            const t = along / length;
            ants.drawCircle(from.x + ((to.x - from.x) * t), from.y + ((to.y - from.y) * t), dotRadius);
          }
          along += spacing;
        }
        along -= length;
      }
      ants.endFill();
    }
  }

  /* ----------------------------- animation ---------------------- */

  #startAnimation() {
    if (this.#animating || !canvas.app?.ticker) return;
    canvas.app.ticker.add(this._onTick, this);
    this.#animating = true;
  }

  #stopAnimation() {
    if (!this.#animating) return;
    canvas.app?.ticker?.remove(this._onTick, this);
    this.#animating = false;
  }

  /** Ticker callback: animate the overlay and drop it once it is stale. */
  _onTick() {
    if (!canvas.ready || !this.active) {
      this.cancel();
      return;
    }
    if (this.#isStale()) {
      this.cancel();
      return;
    }

    const elapsed = canvas.app?.ticker?.elapsedMS ?? 16;
    this.#phase += ((Number.isFinite(elapsed) ? elapsed : 16) / 1000) * 3.4;

    this.#drawMarkers();
    this.#drawAnts();

    if (this.#label && (this.#label.visible === true)) {
      const scale = this.#textScale();
      if (Math.abs(this.#label.scale.x - scale) > 0.01) {
        const route = this.#routes.find((entry) => entry.blocked === true) ?? this.#routes[0];
        this.#positionLabel(route);
      }
    }
  }

  #isStale() {
    if (canvas.tokens?.active !== true) return true;
    const controlled = canvas.tokens.controlled ?? [];
    for (const token of this.#tokens) {
      if (!controlled.includes(token)) return true;
      const document = token.document;
      const previous = this.#snapshot.get(document.id);
      if (previous === undefined) return true;
      if (previous !== `${document.x}|${document.y}|${document.elevation}`) return true;
    }
    return controlled.length !== this.#tokens.size;
  }

  /** Hide graphics but keep the plan state (used right before moving). */
  cancelOverlayOnly() {
    this.#stopAnimation();
    this.#clearOverlay();
    if (this.#highlightName) canvas.interface?.grid?.destroyHighlightLayer?.(this.#highlightName);
    this.#highlightName = null;
  }

  #showHintOnce() {
    if (isOn("hintShown")) return;
    game.settings.set(MODULE_ID, "hintShown", true).catch((error) => console.debug(error));
    ui.notifications.info(game.i18n.format(`${STRINGS}.Notify.Hint`));
  }
}

const planner = new MovementPlanner();

/* ------------------------------------------------------------------ *
 *  Layer and Token subclasses                                        *
 * ------------------------------------------------------------------ */

function registerCanvasClasses() {
  const layerConfig = CONFIG.Canvas.layers.tokens;
  const BaseLayerClass = layerConfig.layerClass ?? foundry.canvas.layers.TokenLayer;

  class SimpleMovingTokenLayer extends BaseLayerClass {
    /** @override */
    _onClickLeft(event) {
      const result = planner.handleClick(event, this);
      if ((result === true) || (result instanceof Promise)) return result;
      return super._onClickLeft(event);
    }

    /** @override */
    _onClickRight(event) {
      // A right-click discards the current plan without moving anything.
      if (planner.active) planner.cancel();
      return super._onClickRight(event);
    }
  }

  layerConfig.layerClass = SimpleMovingTokenLayer;

  const BaseObjectClass = CONFIG.Token.objectClass ?? foundry.canvas.placeables.Token;

  class SimpleMovingToken extends BaseObjectClass {
    /** @override */
    _onClickLeft(event) {
      // Clicks on tokens only confirm a move when they land on the marked destination; otherwise the preview is
      // discarded and core selection takes over, so a click never silently reroutes to another token.
      if (!this.isPreview && this.document?.parent === canvas.scene) {
        const result = planner.handleClick(event, this.layer, { onToken: true });
        if ((result === true) || (result instanceof Promise)) return result;
      }
      return super._onClickLeft(event);
    }

    /** @override */
    _onClickRight(event) {
      if (planner.active) planner.cancel();
      return super._onClickRight(event);
    }
  }

  CONFIG.Token.objectClass = SimpleMovingToken;
}

/* ------------------------------------------------------------------ *
 *  Accent colour picker - a palette instead of a hex text field        *
 * ------------------------------------------------------------------ */

/** Persist an accent colour and refresh the open dialog plus any live preview. */
async function saveAccent(app, hex) {
  if (!hex) return;
  try {
    await game.settings.set(MODULE_ID, "accentColor", hex);
  } catch (error) {
    console.error(`Simple moving | could not store the accent colour`, error);
    ui.notifications.warn(game.i18n.format(`${STRINGS}.Notify.ColorFailed`));
    return;
  }
  planner.redraw();
  if (app?.rendered === true) await app.render(true);
}

function pickAccentSwatch(_event, target) {
  return saveAccent(this, target.dataset.color);
}

function useUserColorAction() {
  return saveAccent(this, userColor());
}

class AccentColorConfig extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  /** @override */
  static DEFAULT_OPTIONS = {
    id: "simple-moving-accent",
    tag: "div",
    classes: ["simple-moving"],
    window: {
      title: `${STRINGS}.Color.Title`,
      icon: "fa-solid fa-palette",
      resizable: false,
      contentClasses: ["standard-form"]
    },
    position: { width: 420 },
    actions: {
      pickAccent: pickAccentSwatch,
      useUserColor: useUserColorAction
    }
  };

  /** @override */
  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/accent-color.hbs`, root: true },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /** @override */
  async _prepareContext() {
    const current = accentHex();
    const mine = userColor();
    // The player's own colour leads the grid; the palette entry duplicating it is dropped.
    const swatches = [mine, ...ACCENT_PALETTE.filter((hex) => hex.toLowerCase() !== mine.toLowerCase())].map(
      (hex) => ({
        hex,
        active: hex.toLowerCase() === current.toLowerCase(),
        tooltip: hex.toLowerCase() === mine.toLowerCase() ? `${STRINGS}.Color.User` : hex
      })
    );

    return {
      current,
      customValue: cssHex(current, DEFAULT_ACCENT),
      swatches,
      buttons: [
        { type: "button", action: "useUserColor", icon: "fa-solid fa-user", label: `${STRINGS}.Color.UseUser` },
        { type: "button", action: "close", label: `${STRINGS}.Color.Done`, default: true }
      ]
    };
  }

  /** @override */
  _onRender(context, options) {
    injectStyles();

    // The custom colour field is an ordinary native picker; write it out on change.
    const input = this.element?.querySelector("input[data-edit=\"customAccent\"]");
    if (input) {
      // A re-render keeps the element alive, so mirror the selection into it by hand.
      const current = cssHex(accentHex(), DEFAULT_ACCENT);
      if (input.value !== current) input.value = current;
      if (!input.dataset.bound) {
        input.dataset.bound = "true";
        input.addEventListener("change", () => saveAccent(this, input.value));
      }
    }

    return super._onRender(context, options);
  }
}

/* ------------------------------------------------------------------ *
 *  Hooks                                                             *
 * ------------------------------------------------------------------ */

Hooks.once("init", () => {
  registerSettings();
  registerCanvasClasses();
  injectStyles();
});

// Values written by earlier versions were plain text/booleans; bring them into the new vocabulary.
Hooks.once("ready", () => migrateLegacyValues());

// The overlay lives on the tokens layer, so it must be rebuilt for every canvas.
Hooks.on("canvasInit", () => planner.cancel());
Hooks.on("canvasReady", () => planner.cancel());
Hooks.on("canvasTearDown", () => planner.cancel());

// A core-initiated movement of one of our tokens (drag, keyboard, API) supersedes the click plan.
Hooks.on("preMoveToken", (document) => {
  if (planner.owns(document)) planner.cancel();
  return true;
});

Hooks.on("updateToken", (_scene, document, change) => {
  if (planner.active && change?.moves && planner.owns(document)) planner.cancel();
});

// Escape cancels the plan before core sees it.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !planner.active) return;
  const target = event.target;
  if (target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
  event.stopPropagation();
  planner.cancel();
}, true);
