import { Viewer } from "./viewer.js";
import { settings, set, onChange, restoreDefaults, zoomRange, ZOOM_RELEASE } from "./settings.js";

const api = window.photosphere;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  chevronRight: svg('<path d="m9 18 6-6-6-6"/>'),
  chevronLeft: svg('<path d="m15 18-6-6 6-6"/>'),
  chevronUp: svg('<path d="m18 15-6-6-6 6"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  recenter: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  turn: svg('<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>'),
  tilt: svg('<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/>'),
  level: svg('<rect x="2.5" y="8" width="19" height="8" rx="4"/><circle cx="12" cy="12" r="1.5"/>'),
  freeze: svg('<path d="M9 5v14M15 5v14"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
};

const viewer = new Viewer($("#stage"));
let photos = [];
let platform = { hasSensors: false };
const isMotion = () => document.body.classList.contains("motion");

// ---------- Library ----------

const thumbnails = new Map();
const waiting = new Map();
let thumbnailQueue = Promise.resolve();

/** A small JPEG of the photo, made once and kept for the session. */
function thumbnail(photo) {
  if (thumbnails.has(photo.id)) return Promise.resolve(thumbnails.get(photo.id));
  if (waiting.has(photo.id)) return waiting.get(photo.id);
  const job = (thumbnailQueue = thumbnailQueue.then(async () => {
    try {
      const blob = await (await fetch(photo.url)).blob();
      const bitmap = await createImageBitmap(blob, { resizeWidth: 320, resizeHeight: 160, resizeQuality: "medium" });
      const canvas = new OffscreenCanvas(320, 160);
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
      const url = URL.createObjectURL(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 }));
      thumbnails.set(photo.id, url);
      return url;
    } catch {
      return null;
    }
  }));
  waiting.set(photo.id, job);
  return job;
}

/** Fills every element with data-thumb with its photo, as thumbnails become ready. */
function paintThumbnails(root) {
  for (const element of $$("[data-thumb]", root)) {
    const photo = photos.find((p) => p.id === element.dataset.thumb);
    if (photo) thumbnail(photo).then((url) => url && (element.style.backgroundImage = `url(${url})`));
  }
}

const selectedPhoto = () => photos.find((p) => p.id === settings.selected);

async function refresh(selectId) {
  photos = await api.list();
  if (selectId) set("selected", selectId);
  if (!photos.some((p) => p.id === settings.selected)) set("selected", photos[0]?.id ?? null);
  render();
  show();
}

let shownId;
async function show() {
  const photo = selectedPhoto();
  if (!photo || photo.id === shownId) return;
  shownId = photo.id;
  try {
    const size = await viewer.show(photo.url);
    if (Math.abs(size.width / size.height - 2) > 0.05) {
      notify("360° photos are twice as wide as they are tall. This one isn't, so it may look stretched.");
    }
  } catch {
    notify(`Couldn't open ${photo.name}`);
  }
}

function select(id) {
  set("selected", id);
  show();
}

function step(offset) {
  if (!photos.length) return;
  const index = photos.findIndex((p) => p.id === settings.selected);
  select(photos[(index + offset + photos.length) % photos.length].id);
}

async function addFromDialog() {
  const added = await api.addWithDialog();
  if (added.length) refresh(added[0]);
}

api.onLibraryChanged(({ select: id } = {}) => refresh(id));

// ---------- What each part of the control center says ----------

const LOCKS = [
  { setting: "lockTurn", name: "Turn", key: "T", icon: ICON.turn, on: "Locked", off: "Follows you" },
  { setting: "lockTilt", name: "Tilt", key: "U", icon: ICON.tilt, on: "Eye level", off: "Follows you" },
  { setting: "level", name: "Level", key: "L", icon: ICON.level, on: "Horizon level", off: "Leans with you" },
  { setting: "frozen", name: "Freeze", key: "F", icon: ICON.freeze, on: "Frozen", off: "Live" },
];

const lockIsOn = (lock) => (lock.setting === "frozen" ? viewer.frozen : !!settings[lock.setting]);

function toggleLock(setting) {
  if (setting === "frozen") viewer.frozen = !viewer.frozen;
  else set(setting, !settings[setting]);
  sync();
}

const VALUE = {
  photosLabel: () => `Photos · ${photos.length}`,
  zoom: () => (platform.hasSensors && settings.pressureZoom ? `Pressure · up to ${settings.maxZoom}×` : `Scroll · up to ${settings.maxZoom}×`),
  view: () => `${settings.fieldOfView}° · ${settings.smoothing < 0.05 ? "Snappy" : settings.smoothing > 0.55 ? "Smooth" : "Balanced"}`,
  motion: () => {
    const s = viewer.sensors;
    if (!platform.hasSensors) return "Mac only";
    if (!s || !s.motion) return "Not found";
    return settings.motion ? "On" : "Off";
  },
  closedState: () => {
    if (!isMotion()) return platform.hasSensors && viewer.sensors?.motion ? "Motion off · drag to look" : "Drag to look around";
    if (viewer.frozen) return "Frozen · drag to look";
    const locked = LOCKS.filter((l) => l.setting !== "level" && l.setting !== "frozen" && lockIsOn(l)).map((l) => l.name);
    return locked.length ? `${locked.join(" and ")} locked` : "Move your Mac to look around";
  },
};

const FORMAT = {
  zoomActivation: (v) => (v < 100 ? "Light" : v < 200 ? "Medium" : v < 300 ? "Firm" : "Very firm"),
  zoomSensitivity: (v) => `${Math.round(v * 100)}%`,
  maxZoom: (v) => `${v}×`,
  fieldOfView: (v) => `${v}°`,
  smoothing: (v) => (v < 0.05 ? "Off" : `${Math.round((v / 0.9) * 100)}%`),
  dragSpeed: (v) => `${v.toFixed(2)}×`,
};

// ---------- Panes ----------

const TITLES = { overview: "Control center", library: "Photos", zoom: "Zoom", view: "View", motion: "Motion" };

function heading(view) {
  const back = view === "overview" ? "<span></span>" : `<button class="icon-button" data-action="back" title="Back">${ICON.chevronLeft}</button>`;
  return `<div class="heading">${back}<div class="title">${TITLES[view]}</div><button class="icon-button" data-action="close" title="Close (Esc)">${ICON.close}</button></div>`;
}

const tile = (name, label, extraClass = "") =>
  `<button class="tile ${extraClass}" data-open="${name}"><span class="label">${label}${ICON.chevronRight}</span><span class="value" data-value="${name}"></span></button>`;

const slider = (key, label, min, max, step, low, high, note = "") => `
  <div class="setting">
    <div class="line"><span>${label}${note ? `<small>${note}</small>` : ""}</span><output data-for="${key}"></output></div>
    <input type="range" min="${min}" max="${max}" step="${step}" data-setting="${key}" />
    ${low ? `<div class="scale"><span>${low}</span><span>${high}</span></div>` : ""}
  </div>`;

const toggle = (key, label, note = "") => `
  <label class="setting"><div class="line"><span>${label}${note ? `<small>${note}</small>` : ""}</span><input type="checkbox" class="switch" data-setting="${key}" /></div></label>`;

const PANES = {
  closed: () => {
    const photo = selectedPhoto();
    return `<div class="closed-wrap">
      <button class="closed" data-action="open" title="Open the control center">
        <span class="mini" ${photo ? `data-thumb="${photo.id}"` : ""}></span>
        <span class="text"><span class="name">${photo ? photo.name : "No photo"}</span><span class="state" data-value="closedState"></span></span>
        <span class="chev">${ICON.chevronUp}</span>
      </button>
      <button class="icon-button" data-action="recenter" title="Recenter (Space)">${ICON.recenter}</button>
    </div>`;
  },

  overview: () => {
    const strip = photos
      .slice(0, 5)
      .map((p) => `<span data-thumb="${p.id}" data-select="${p.id}" class="${p.id === settings.selected ? "selected" : ""}" title="${p.name}"></span>`)
      .join("");
    const locks = LOCKS.map(
      (l) => `<button class="lock" data-lock="${l.setting}" title="${l.name} (${l.key})">
        <span class="top">${l.icon}<span class="key">${l.key}</span></span>
        <span><span class="name">${l.name}</span></span><span class="status" data-lock-status="${l.setting}"></span>
      </button>`,
    ).join("");
    return `<div class="pane-open" style="width: 400px">
      ${heading("overview")}
      <div class="grid">
        <button class="tile photos-tile span-4" data-open="library">
          <span class="label"><span data-value="photosLabel"></span>${ICON.chevronRight}</span>
          <span class="strip">${strip}</span>
        </button>
        ${isMotion() ? locks : ""}
        ${tile("zoom", "Zoom", "span-2")}
        ${tile("view", "View", "span-2")}
        ${platform.hasSensors ? tile("motion", "Motion", "span-2") : ""}
        <button class="tile ${platform.hasSensors ? "span-2" : "span-4"}" data-action="recenter">
          <span class="label">Recenter</span><span class="value">Space</span>
        </button>
        <button class="row-button span-4" data-action="add">${ICON.plus}<span class="grow">Add 360° photos</span><span class="muted small">⌘O or drop</span></button>
      </div>
    </div>`;
  },

  library: () => {
    const cards = photos
      .map(
        (p) => `<button class="photo ${p.id === settings.selected ? "selected" : ""}" data-select="${p.id}" title="${p.name}">
          <span class="image" data-thumb="${p.id}"></span>
          <span class="caption-line"><span>${p.name}</span>${p.sample ? '<em class="muted small">Sample</em>' : ""}</span>
          ${p.sample ? "" : `<span class="remove" data-remove="${p.id}" title="Remove">${ICON.trash}</span>`}
        </button>`,
      )
      .join("");
    return `<div class="pane-open">${heading("library")}
      <div class="screen wide card"><div class="library">
        <button class="photo add-photo" data-action="add"><span class="image">${ICON.plus}</span><span class="caption-line"><span>Add photos</span></span></button>
        ${cards}
      </div></div>
      <p class="caption" style="padding-top: 8px">Drop 360° photos anywhere on the window to add them. Right-click a photo for more.</p>
    </div>`;
  },

  zoom: () => `<div class="pane-open">${heading("zoom")}
    <div class="screen">
      ${platform.hasSensors ? `
      <div class="card">
        ${toggle("pressureZoom", "Press harder to zoom", "On the trackpad, anywhere over the photo")}
        ${slider("zoomActivation", "Activation pressure", 40, 400, 5, "Light", "Firm", "How hard to press before zooming starts")}
        ${slider("zoomSensitivity", "Sensitivity", 0, 1, 0.01, "Gentle", "Quick", "How little extra pressure reaches full zoom")}
        <div class="setting">
          <div class="meter" title="Live trackpad pressure">
            <div class="track"><div class="zone"></div><div class="fill"></div></div>
            <div class="mark start"></div><div class="mark full"></div>
          </div>
          <div class="scale"><span>Press to try it</span><span data-live="zoomNow"></span></div>
        </div>
      </div>` : `<p class="caption" style="padding-top: 4px">Scroll or pinch to zoom.</p>`}
      <div class="card">
        ${slider("maxZoom", "Maximum zoom", 1.5, 8, 0.5)}
      </div>
      <button class="text-button caption" data-restore="pressureZoom,zoomActivation,zoomSensitivity,maxZoom">Restore defaults</button>
    </div>
  </div>`,

  view: () => `<div class="pane-open">${heading("view")}
    <div class="screen">
      <div class="card">
        ${slider("fieldOfView", "Field of view", 45, 110, 1, "Narrow", "Wide")}
        ${slider("smoothing", "Smoothing", 0, 0.9, 0.01, "Snappy", "Smooth")}
      </div>
      <div class="card">
        ${slider("dragSpeed", "Drag speed", 0.25, 3, 0.05)}
        ${toggle("invertDrag", "Invert drag")}
      </div>
      <button class="text-button caption" data-restore="fieldOfView,smoothing,dragSpeed,invertDrag">Restore defaults</button>
    </div>
  </div>`,

  motion: () => `<div class="pane-open">${heading("motion")}
    <div class="screen">
      <div class="card">
        ${toggle("motion", "Move your Mac to look around")}
        ${toggle("followScreenAngle", "Follow the screen angle", "Look straight out of the screen as you open or close the lid")}
      </div>
      <div class="card"><div class="setting"><span class="small" data-live="sensorStatus"></span></div></div>
      <p class="caption">There's no compass inside a Mac, so turning slowly drifts a little. Press Space to recenter.</p>
    </div>
  </div>`,
};

// ---------- The morphing panel ----------

const panel = $("#panel");
const holder = $("#pane-holder");
let view = "closed";
let origin = "50% 100%";
let size;
let observer;

function render() {
  const pane = document.createElement("div");
  pane.className = "pane";
  pane.style.transformOrigin = origin;
  pane.innerHTML = PANES[view]();
  holder.replaceChildren(pane);
  paintThumbnails(pane);
  sync();

  observer?.disconnect();
  const measure = () => {
    const width = pane.offsetWidth;
    const height = pane.offsetHeight;
    if (size && size.width === width && size.height === height) return;
    panel.classList.toggle("shrinking", !!size && width * height < size.width * size.height);
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    size = { width, height };
  };
  measure();
  observer = new ResizeObserver(measure);
  observer.observe(pane);
  wake();
}

/** Where `element` sits in the open pane, so the next pane grows out of it. */
function growFrom(element) {
  const pane = holder.firstElementChild;
  if (!pane || !element) return "50% 100%";
  const a = element.getBoundingClientRect();
  const b = pane.getBoundingClientRect();
  return `${Math.round(a.left + a.width / 2 - b.left)}px ${Math.round(a.top + a.height / 2 - b.top)}px`;
}

function go(next, from) {
  origin = from ? growFrom(from) : view === "closed" || next === "closed" ? "50% 100%" : "50% 0";
  view = next;
  render();
}

requestAnimationFrame(() => panel.classList.add("morphing"));

holder.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action],[data-open],[data-select],[data-lock],[data-remove],[data-restore]");
  if (!target) return;
  if (target.dataset.remove) {
    event.stopPropagation();
    api.remove(target.dataset.remove).then(() => refresh());
    return;
  }
  if (target.dataset.select && view === "overview") return select(target.dataset.select), render();
  if (target.dataset.select) return select(target.dataset.select), sync(), $$(".photo", holder).forEach((p) => p.classList.toggle("selected", p.dataset.select === settings.selected));
  if (target.dataset.lock) return toggleLock(target.dataset.lock);
  if (target.dataset.open) return go(target.dataset.open, target);
  if (target.dataset.restore) return restoreDefaults(target.dataset.restore.split(","));
  const action = target.dataset.action;
  if (action === "open") go("overview");
  else if (action === "close") go("closed");
  else if (action === "back") go("overview");
  else if (action === "recenter") viewer.recenter();
  else if (action === "add") addFromDialog();
});

holder.addEventListener("contextmenu", (event) => {
  const photo = event.target.closest("[data-select]");
  if (!photo) return;
  event.preventDefault();
  api.menu(photo.dataset.select);
});

holder.addEventListener("input", (event) => {
  const input = event.target;
  if (!input.dataset.setting) return;
  set(input.dataset.setting, input.type === "checkbox" ? input.checked : Number(input.value));
});

/** Brings every control and value on the pane up to date without rebuilding it. */
function sync() {
  for (const input of $$("[data-setting]", holder)) {
    const key = input.dataset.setting;
    if (input.type === "checkbox") input.checked = !!settings[key];
    else {
      if (document.activeElement !== input) input.value = settings[key];
      input.style.setProperty("--fill", `${((settings[key] - input.min) / (input.max - input.min)) * 100}%`);
    }
  }
  for (const output of $$("output[data-for]", holder)) output.textContent = FORMAT[output.dataset.for](settings[output.dataset.for]);
  for (const element of $$("[data-value]", holder)) element.textContent = VALUE[element.dataset.value]();
  for (const element of $$("[data-lock]", holder)) element.classList.toggle("on", lockIsOn(LOCKS.find((l) => l.setting === element.dataset.lock)));
  for (const element of $$("[data-lock-status]", holder)) {
    const lock = LOCKS.find((l) => l.setting === element.dataset.lockStatus);
    element.textContent = lockIsOn(lock) ? lock.on : lock.off;
  }
}
onChange(sync);

// Pressing a control is a click, not a zoom.
$("#center").addEventListener("pointerdown", () => (viewer.pressureBlocked = true));
window.addEventListener("pointerup", () => (viewer.pressureBlocked = false));

// Live readouts: the pressure meter, sensor status, and the zoom badge.
const METER_MAX = 600;
function live() {
  const s = viewer.sensors;
  const meter = $(".meter", holder);
  if (meter) {
    const force = s ? s.force : 0;
    const start = settings.zoomActivation;
    const full = start + zoomRange(settings.zoomSensitivity);
    const at = (v) => `${Math.min(100, (v / METER_MAX) * 100)}%`;
    $(".fill", meter).style.width = at(force);
    $(".fill", meter).classList.toggle("zooming", viewer.zoomEngaged);
    $(".mark.start", meter).style.left = at(start);
    $(".mark.full", meter).style.left = at(full);
    $(".zone", meter).style.left = at(start * ZOOM_RELEASE);
    $(".zone", meter).style.width = `calc(${at(start)} - ${at(start * ZOOM_RELEASE)})`;
    const now = $('[data-live="zoomNow"]', holder);
    if (now) now.textContent = viewer.zoomEngaged ? `Zooming · ${viewer.zoom.toFixed(1)}×` : force > 5 ? `Pressure ${Math.round(force)}` : "";
  }
  const status = $('[data-live="sensorStatus"]', holder);
  if (status) {
    status.innerHTML = !s || !s.motion
      ? '<span class="status-dot"></span>No motion sensor found. It\'s in MacBooks with Apple silicon.'
      : `<span class="status-dot ${settings.motion ? "live" : ""}"></span>Motion sensor ${settings.motion ? "live" : "off"}${s.lidSensor ? ` · lid open ${Math.round(s.lid)}°` : ""}`;
  }
  const badge = $("#zoom-badge");
  badge.hidden = viewer.zoom < 1.05;
  if (!badge.hidden) badge.textContent = `${viewer.zoom.toFixed(1)}×`;
  requestAnimationFrame(live);
}
live();

// The closed pill fades while you look around and comes back when the mouse moves.
let idleTimer;
function wake() {
  $("#center").classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (view === "closed" && !$("#center").matches(":hover")) $("#center").classList.add("idle");
  }, 2500);
}
window.addEventListener("mousemove", wake);

let noticeTimer;
function notify(text) {
  $("#notice").textContent = text;
  $("#notice").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => ($("#notice").hidden = true), 6000);
}

function hint(text) {
  $("#hint").textContent = text;
  $("#hint").hidden = false;
  setTimeout(() => ($("#hint").hidden = true), 3000);
}

// ---------- Look around ----------

const stage = $("#stage");
stage.addEventListener("pointerdown", (event) => {
  if (view !== "closed") go("closed");
  stage.setPointerCapture(event.pointerId);
  const move = (e) => viewer.drag(e.movementX, e.movementY);
  const up = () => {
    stage.removeEventListener("pointermove", move);
    stage.removeEventListener("pointerup", up);
  };
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", up);
});
stage.addEventListener("wheel", (event) => {
  event.preventDefault();
  viewer.zoomBy(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)));
}, { passive: false });

window.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "escape") {
    if (view === "closed") return;
    go(view === "overview" ? "closed" : "overview");
  } else if (event.target instanceof HTMLInputElement && event.target.type === "range" && key.startsWith("arrow")) {
    return;
  } else if (isMotion() && LOCKS.some((l) => l.key.toLowerCase() === key)) {
    toggleLock(LOCKS.find((l) => l.key.toLowerCase() === key).setting);
  } else if (key === " ") viewer.recenter();
  else if (key === "arrowleft") step(-1);
  else if (key === "arrowright") step(1);
  else if (key === "=" || key === "+") viewer.zoomBy(1.25);
  else if (key === "-") viewer.zoomBy(0.8);
  else return;
  event.preventDefault();
  wake();
});

api.onOpenSettings(() => go(view === "closed" ? "overview" : "closed"));

// Re-render the pane when the selected photo changes so names and thumbnails follow.
let renderedSelection = settings.selected;
onChange((key) => {
  if (key === "selected" && settings.selected !== renderedSelection) {
    renderedSelection = settings.selected;
    if (view === "closed") render();
  }
});

// ---------- Drag and drop ----------

let dragDepth = 0;
const carriesFiles = (event) => event.dataTransfer?.types.includes("Files");
window.addEventListener("dragenter", (event) => {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  if (++dragDepth === 1) $("#drop").hidden = false;
});
window.addEventListener("dragleave", (event) => {
  if (carriesFiles(event) && --dragDepth <= 0) {
    dragDepth = 0;
    $("#drop").hidden = true;
  }
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", async (event) => {
  event.preventDefault();
  if (!carriesFiles(event)) return;
  dragDepth = 0;
  $("#drop").hidden = true;
  const added = await api.addFiles(event.dataTransfer.files);
  if (added.length) refresh(added[0]);
  else notify("Drop image files (JPEG, PNG, WebP…) to add them.");
});

// ---------- Start ----------

let motionAnnounced = false;
api.onSensors((data) => {
  viewer.sensors = data;
  const active = viewer.motionActive;
  if (active !== isMotion()) {
    document.body.classList.toggle("motion", active);
    if (view === "overview" || view === "closed") render();
  }
  if (active && !motionAnnounced) {
    motionAnnounced = true;
    viewer.recenter();
    hint("Move your Mac to look around");
  }
});

(async () => {
  platform = await api.platform();
  await refresh();
  if (!platform.hasSensors) hint("Drag to look around");
  const startView = new URLSearchParams(location.search).get("view");
  if (startView && PANES[startView]) go(startView);
})();
