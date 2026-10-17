const { app, BrowserWindow, ipcMain, dialog, protocol, net, Menu, shell } = require("electron");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");
const path = require("node:path");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".bmp"]);
const isMac = process.platform === "darwin";
const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
const rendererDir = path.join(__dirname, "..", "dist");
const samplesDir = path.join(resources, "Samples");
const helperPath = app.isPackaged ? path.join(resources, "photosphere-sensors") : path.join(__dirname, "..", "build", "photosphere-sensors");
let photosDir;
let window;
const pendingOpens = [];

// Everything the window loads comes from app://, so photos and the page share an origin and WebGL can use them.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function serveFile(request) {
  const url = new URL(request.url);
  const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
  let file;
  if (parts[0] === "library" && parts.length === 2) file = path.join(photosDir, path.basename(parts[1]));
  else if (parts[0] === "samples" && parts.length === 2) file = path.join(samplesDir, path.basename(parts[1]));
  else {
    file = path.join(rendererDir, ...parts);
    if (!file.startsWith(rendererDir)) return new Response("Not found", { status: 404 });
    if (parts.length === 0) file = path.join(rendererDir, "index.html");
  }
  return net.fetch(pathToFileURL(file).toString());
}

// ---------- Library ----------

function isImage(file) {
  return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function niceName(file) {
  return path
    .basename(file, path.extname(file))
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function listPhotos() {
  const mine = fs
    .readdirSync(photosDir)
    .filter(isImage)
    .map((name) => ({ name, time: fs.statSync(path.join(photosDir, name)).birthtimeMs }))
    .sort((a, b) => b.time - a.time)
    .map(({ name }) => ({ id: `library/${name}`, name: niceName(name), url: `app://local/library/${encodeURIComponent(name)}`, sample: false }));
  const samples = fs.existsSync(samplesDir)
    ? fs
        .readdirSync(samplesDir)
        .filter(isImage)
        .sort()
        .map((name) => ({ id: `samples/${name}`, name: niceName(name), url: `app://local/samples/${encodeURIComponent(name)}`, sample: true }))
    : [];
  return [...mine, ...samples];
}

function uniqueDestination(name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(photosDir, name);
  for (let n = 2; fs.existsSync(candidate); n++) candidate = path.join(photosDir, `${base} ${n}${ext}`);
  return candidate;
}

function addPhotos(files) {
  const added = [];
  for (const file of files) {
    if (!file || !isImage(file) || !fs.existsSync(file)) continue;
    const destination = uniqueDestination(path.basename(file));
    fs.copyFileSync(file, destination);
    added.push(`library/${path.basename(destination)}`);
  }
  return added;
}

function photoPath(id) {
  const [folder, name] = id.split("/");
  if (folder === "library") return path.join(photosDir, path.basename(name));
  if (folder === "samples") return path.join(samplesDir, path.basename(name));
  return null;
}

async function showAddDialog() {
  const result = await dialog.showOpenDialog(window, {
    title: "Add 360° photos",
    message: "Choose 360° photos (equirectangular: twice as wide as they are tall)",
    buttonLabel: "Add",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Images", extensions: [...IMAGE_EXTENSIONS].map((e) => e.slice(1)) }],
  });
  return result.canceled ? [] : addPhotos(result.filePaths);
}

function sendAdded(added) {
  if (added.length && window) window.webContents.send("library-changed", { select: added[0] });
}

ipcMain.handle("library:list", () => listPhotos());
ipcMain.handle("library:add", (event, files) => addPhotos(files));
ipcMain.handle("library:add-dialog", () => showAddDialog());
ipcMain.handle("library:menu", (event, id) => {
  const file = photoPath(id);
  if (!file) return;
  const menu = Menu.buildFromTemplate([
    { label: isMac ? "Show in Finder" : "Show in Folder", click: () => shell.showItemInFolder(file) },
    ...(id.startsWith("library/")
      ? [{ type: "separator" }, { label: "Remove", click: async () => { await shell.trashItem(file); window.webContents.send("library-changed"); } }]
      : []),
  ]);
  menu.popup({ window });
});

// macOS "Open With" / dropping files on the Dock icon.
app.on("open-file", (event, file) => {
  event.preventDefault();
  if (photosDir && window) sendAdded(addPhotos([file]));
  else pendingOpens.push(file);
});

// ---------- Mac sensors ----------

let helper;
function startSensors() {
  if (!isMac || !fs.existsSync(helperPath)) return;
  helper = spawn(helperPath, [], { stdio: ["pipe", "pipe", "ignore"] });
  let buffer = "";
  helper.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    const last = lines[lines.length - 1];
    if (!last || !window || window.isDestroyed()) return;
    const v = last.split(" ").map(Number);
    window.webContents.send("sensors", { q: v.slice(0, 4), lid: v[4], force: v[5], ready: !!(v[6] & 1), motion: !!(v[6] & 2), lidSensor: !!(v[6] & 4) });
  });
  helper.on("exit", () => (helper = null));
}

// ---------- Window & menu ----------

function buildMenu() {
  const send = (channel) => () => window && window.webContents.send(channel);
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { label: "Settings…", accelerator: "Cmd+,", click: send("open-settings") },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }]
      : []),
    {
      label: "File",
      submenu: [
        { label: "Add Photos…", accelerator: "CmdOrCtrl+O", click: async () => sendAdded(await showAddDialog()) },
        ...(isMac ? [] : [{ label: "Settings…", accelerator: "Ctrl+,", click: send("open-settings") }]),
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "togglefullscreen" }, { type: "separator" }, { role: "toggleDevTools" }] },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  window = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    backgroundColor: "#000000",
    title: "Photosphere",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    titleBarOverlay: isMac ? false : { color: "#00000000", symbolColor: "#ffffff", height: 36 },
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: { preload: path.join(__dirname, "preload.js"), sandbox: false },
  });
  window.loadURL("app://local/index.html");
  window.webContents.once("did-finish-load", () => {
    if (pendingOpens.length) sendAdded(addPhotos(pendingOpens.splice(0)));
  });
  window.on("closed", () => (window = null));

  if (process.env.SNAPSHOT) {
    window.webContents.on("console-message", (event) => console.log("renderer:", event.message));
    window.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        if (process.env.SNAPSHOT_SETTINGS) window.webContents.send("open-settings");
        await new Promise((r) => setTimeout(r, 800));
        fs.writeFileSync(process.env.SNAPSHOT, (await window.webContents.capturePage()).toPNG());
        app.quit();
      }, 3000);
    });
  }
}

app.whenReady().then(() => {
  photosDir = path.join(app.getPath("userData"), "Photos");
  fs.mkdirSync(photosDir, { recursive: true });
  protocol.handle("app", serveFile);
  ipcMain.handle("platform", () => ({ isMac, hasSensors: isMac && fs.existsSync(helperPath) }));
  buildMenu();
  createWindow();
  startSensors();
  app.on("activate", () => {
    if (!window) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => helper && helper.kill());
