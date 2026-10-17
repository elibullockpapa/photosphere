export const DEFAULTS = {
  zoomSensitivity: 0.9,
  maxZoom: 4,
  pressureZoom: true,
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

const KEY = "photosphere.settings";
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

export function restoreDefaults() {
  for (const key of ["zoomSensitivity", "maxZoom", "pressureZoom", "fieldOfView", "smoothing", "dragSpeed", "invertDrag", "motion", "followScreenAngle"]) {
    set(key, DEFAULTS[key]);
  }
}

/** Trackpad force needed for full zoom: sensitivity 1 is a light touch, 0 a hard press. */
export const forceForFullZoom = (sensitivity) => 30 + (1 - sensitivity) * 600;

/** A resting finger reads a little force; ignore it. */
export const ZOOM_DEAD_ZONE = 8;
