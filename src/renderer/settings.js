export const DEFAULTS = {
  pressureZoom: true,
  zoomActivation: 150,
  zoomSensitivity: 0.85,
  maxZoom: 4,
  fieldOfView: 72,
  smoothing: 0.35,
  dragSpeed: 1,
  invertDrag: false,
  motion: true,
  followScreenAngle: true,
  lockTurn: false,
  lockTilt: false,
  level: true,
  selected: null,
};

const KEY = "photosphere.settings.v2";
const listeners = new Set();

export const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };

export function set(key, value) {
  settings[key] = value;
  localStorage.setItem(KEY, JSON.stringify(settings));
  listeners.forEach((listener) => listener(key, value));
}

export function onChange(listener) {
  listeners.add(listener);
}

export function restoreDefaults(keys) {
  for (const key of keys) set(key, DEFAULTS[key]);
}

/**
 * Pressure zoom does nothing until you press past the activation pressure (so ordinary clicks
 * never zoom), then goes from 1× to full zoom over a short extra push. Sensitivity sets how short:
 * at 1 a nudge is enough, at 0 it takes a long press harder.
 */
export const zoomRange = (sensitivity) => 15 + (1 - sensitivity) * 330;

/** Pressure has to stay past the activation point this long, so a click's spike doesn't zoom. */
export const ZOOM_HOLD_MS = 90;

/** Once zooming, it lets go only when pressure drops well below the activation point. */
export const ZOOM_RELEASE = 0.7;
