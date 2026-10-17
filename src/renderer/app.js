import { Viewer } from "./viewer.js";
import { settings, set, onChange, restoreDefaults, forceForFullZoom } from "./settings.js";

const api = window.photosphere;
const $ = (selector) => document.querySelector(selector);

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  turn: svg('<path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"/>'),
  tilt: svg('<path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/>'),
  level: svg('<rect x="2.5" y="8" width="19" height="8" rx="4"/><circle cx="12" cy="12" r="1.6"/><path d="M8.5 8v8M15.5 8v8"/>'),
  freeze: svg('<path d="M9 5v14M15 5v14"/>'),
  recenter: svg('<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor"/><path d="M8 11V7a4 4 0 0 1 8 0v4" stroke-width="2.6"/>'),
};
const LOCKS = {
  lockTurn: { label: "Turn", icon: ICONS.turn },
  lockTilt: { label: "Tilt", icon: ICONS.tilt },
  level: { label: "Level", icon: ICONS.level },
  frozen: { label: "Freeze", icon: ICONS.freeze },
};

const viewer = new Viewer($("#stage"));
let photos = [];
let platform = { isMac: false, hasSensors: false };

// ---------- Library ----------

const thumbnails = new Map();
let thumbnailQueue = Promise.resolve();

function thumbnail(photo, element) {
  if (thumbnails.has(photo.id)) {
    element.style.backgroundImage = `url(${thumbnails.get(photo.id)})`;
    return;
  }
  thumbnailQueue = thumbnailQueue.then(async () => {
    try {
      const blob = await (await fetch(photo.url)).blob();
      const bitmap = await createImageBitmap(blob, { resizeWidth: 320, resizeHeight: 160, resizeQuality: "medium" });
      const canvas = new OffscreenCanvas(320, 160);
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
      const url = URL.createObjectURL(await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 }));
      thumbnails.set(photo.id, url);
      element.style.backgroundImage = `url(${url})`;
    } catch {}
  });
}

function renderStrip() {
  const strip = $("#strip");
  strip.replaceChildren(
    ...photos.map((photo) => {
      const button = document.createElement("button");
      button.className = "thumb" + (photo.id === settings.selected ? " selected" : "");
      button.title = photo.name + (photo.sample ? " (sample)" : "");
      button.onclick = () => select(photo.id);
      button.oncontextmenu = (event) => {
        event.preventDefault();
        api.menu(photo.id);
      };
      thumbnail(photo, button);
      return button;
    }),
  );
  strip.querySelector(".selected")?.scrollIntoView({ inline: "center", block: "nearest" });
}

async function refresh(selectId) {
  photos = await api.list();
  if (selectId) set("selected", selectId);
  if (!photos.some((p) => p.id === settings.selected)) set("selected", photos[0]?.id ?? null);
  renderStrip();
  show();
}

let shownId;
async function show() {
  const photo = photos.find((p) => p.id === settings.selected);
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
  renderStrip();
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

// ---------- Dock ----------

$("#add").innerHTML = ICONS.plus;
$("#add").onclick = addFromDialog;
$("#recenter").innerHTML = ICONS.recenter;
$("#recenter").onclick = () => viewer.recenter();
$("#open-settings").innerHTML = ICONS.gear;
$("#open-settings").onclick = () => openSettings();
$("#close-settings").innerHTML = ICONS.close;

const lockButtons = [...document.querySelectorAll(".lock")];
for (const button of lockButtons) {
  const lock = LOCKS[button.dataset.setting];
  button.innerHTML = `${lock.icon}<span>${lock.label}</span><span class="badge">${ICONS.lock}</span>`;
  button.onclick = () => toggleLock(button.dataset.setting);
}

function toggleLock(name) {
  if (name === "frozen") viewer.frozen = !viewer.frozen;
  else set(name, !settings[name]);
  renderLocks();
}

function renderLocks() {
  for (const button of lockButtons) {
    const name = button.dataset.setting;
    button.classList.toggle("on", name === "frozen" ? viewer.frozen : !!settings[name]);
  }
}

// Fade the dock out while you look around; bring it back on any mouse movement.
let idleTimer;
function wake() {
  $("#dock").classList.remove("hidden");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!$("#dock").matches(":hover") && $("#settings").hidden) $("#dock").classList.add("hidden");
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
  if (!$("#settings").hidden) {
    if (event.key === "Escape") closeSettings();
    return;
  }
  const key = event.key.toLowerCase();
  const lock = lockButtons.find((b) => b.dataset.key === key);
  if (lock && document.body.classList.contains("motion")) toggleLock(lock.dataset.setting);
  else if (key === " ") viewer.recenter();
  else if (key === "arrowleft") step(-1);
  else if (key === "arrowright") step(1);
  else if (key === "=" || key === "+") viewer.zoomBy(1.25);
  else if (key === "-") viewer.zoomBy(0.8);
  else if (key === "0") viewer.recenter();
  else return;
  event.preventDefault();
  wake();
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

// ---------- Settings ----------

const FORMAT = {
  zoomSensitivity: (v) => `${Math.round(v * 100)}%`,
  maxZoom: (v) => `${v}×`,
  fieldOfView: (v) => `${v}°`,
  smoothing: (v) => (v < 0.05 ? "Off" : `${Math.round((v / 0.9) * 100)}%`),
  dragSpeed: (v) => `${v.toFixed(2)}×`,
};

function syncControls() {
  for (const input of document.querySelectorAll(".sheet [data-setting]")) {
    const key = input.dataset.setting;
    if (input.type === "checkbox") input.checked = !!settings[key];
    else {
      input.value = settings[key];
      input.style.setProperty("--fill", `${((settings[key] - input.min) / (input.max - input.min)) * 100}%`);
    }
    const output = document.querySelector(`output[data-for="${key}"]`);
    if (output) output.textContent = FORMAT[key](settings[key]);
  }
}

for (const input of document.querySelectorAll(".sheet [data-setting]")) {
  input.addEventListener("input", () => set(input.dataset.setting, input.type === "checkbox" ? input.checked : Number(input.value)));
}
onChange(() => {
  syncControls();
  renderLocks();
});
$("#restore-defaults").onclick = restoreDefaults;
$("#close-settings").onclick = closeSettings;
$("#settings").addEventListener("mousedown", (event) => {
  if (event.target === $("#settings")) closeSettings();
});
api.onOpenSettings(() => ($("#settings").hidden ? openSettings() : closeSettings()));

const METER_MAX = 650;
function openSettings() {
  syncControls();
  $("#settings").hidden = false;
  wake();
  const tick = () => {
    if ($("#settings").hidden) return;
    const force = viewer.sensors ? viewer.sensors.force : 0;
    $(".meter-fill").style.width = `${Math.min(100, (force / METER_MAX) * 100)}%`;
    $(".meter-mark").style.left = `${(forceForFullZoom(settings.zoomSensitivity) / METER_MAX) * 100}%`;
    const s = viewer.sensors;
    $("#sensor-status").textContent = !s
      ? "Motion sensor not available on this Mac."
      : !s.motion
        ? "No motion sensor found. It's in MacBooks with Apple silicon."
        : `Motion sensor active${s.lidSensor ? ` · lid open ${Math.round(s.lid)}°` : ""}`;
    requestAnimationFrame(tick);
  };
  tick();
}

function closeSettings() {
  $("#settings").hidden = true;
}

// ---------- Start ----------

let motionAnnounced = false;
api.onSensors((data) => {
  viewer.sensors = data;
  const active = viewer.motionActive;
  document.body.classList.toggle("motion", active);
  if (active && !motionAnnounced) {
    motionAnnounced = true;
    viewer.recenter();
    hint("Move your Mac to look around");
  }
});

(async () => {
  platform = await api.platform();
  document.body.classList.toggle("mac", platform.hasSensors);
  renderLocks();
  await refresh();
  wake();
  if (!platform.hasSensors) hint("Drag to look around");
})();
