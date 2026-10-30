"use strict";

/*
 * scan.js - scans a WSL distro for GUI applications (.desktop files).
 *
 * Pure Node (no Electron dependency) so it can be unit-tested directly:
 *   node -e "require('./scan').scanApps().then(r => console.log(r.length))"
 *
 * Discovery uses the UNC channel \\wsl.localhost\<distro>. Keep in mind:
 *   - the WSL VM must be running for the UNC path to resolve
 *   - a few .desktop files are unreadable over 9p (broken symlinks) -> skipped
 */

const fs = require("fs");
const path = require("path");

const DISTRO = "Ubuntu";
const UNC_ROOT = "\\\\wsl.localhost\\" + DISTRO;

const ICON_SIZES = ["48x48", "64x64", "128x128", "256x256", "scalable"];
const ICON_THEMES = ["hicolor", "Adwaita", "Yaru"];

function toUnc(linuxPath) {
  return UNC_ROOT + String(linuxPath).replace(/\//g, "\\");
}

function readText(linuxPath) {
  try {
    return fs.readFileSync(toUnc(linuxPath), "utf8");
  } catch (e) {
    return null;
  }
}

function fileExists(linuxPath) {
  try {
    if (!linuxPath) { return false; }
    return fs.statSync(toUnc(linuxPath)).isFile();
  } catch (e) {
    return false;
  }
}

function desktopDirs() {
  const dirs = [
    "/usr/share/applications",
    "/usr/local/share/applications",
    "/var/lib/snapd/desktop/applications",
    "/var/lib/flatpak/exports/share/applications"
  ];
  let users = [];
  try {
    users = fs.readdirSync(path.join(UNC_ROOT, "home"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) { /* WSL not running */ }
  for (const u of users) {
    dirs.push("/home/" + u + "/.local/share/applications");
    dirs.push("/home/" + u + "/.local/share/flatpak/exports/share/applications");
  }
  dirs.push("/root/.local/share/applications");
  return dirs;
}

function listDesktopFiles() {
  const out = [];
  const seen = new Set();
  for (const dir of desktopDirs()) {
    let entries = [];
    try {
      entries = fs.readdirSync(toUnc(dir));
    } catch (e) {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".desktop")) { continue; }
      const linuxPath = dir.replace(/\/$/, "") + "/" + name;
      if (seen.has(linuxPath)) { continue; }
      seen.add(linuxPath);
      out.push(linuxPath);
    }
  }
  return out;
}

// pick a value honoring the common localization suffixes
function pickLocalized(h, key) {
  if (h[key] && String(h[key]).trim()) { return String(h[key]).trim(); }
  const prefer = ["zh_CN", "zh_TW", "zh_HK", "en_US", "en_GB", "C"];
  for (const lang of prefer) {
    const k = key + "[" + lang + "]";
    if (h[k] && String(h[k]).trim()) { return String(h[k]).trim(); }
  }
  const any = Object.keys(h).sort().find((k) => k.indexOf(key + "[") === 0 && String(h[k]).trim());
  return any ? String(h[any]).trim() : "";
}

function isTrue(v) {
  return String(v || "").toLowerCase() === "true";
}

function parseDesktop(content) {
  const h = Object.create(null);
  let section = "";
  for (const raw of String(content).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.charAt(0) === "#") { continue; }
    if (line.charAt(0) === "[" && line.charAt(line.length - 1) === "]") {
      section = line.slice(1, -1);
      continue;
    }
    if (section !== "Desktop Entry") { continue; }
    const i = line.indexOf("=");
    if (i < 1) { continue; }
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (!(k in h)) { h[k] = v; }
  }
  if (h.Type !== "Application") { return null; }
  if (isTrue(h.Terminal) || isTrue(h.NoDisplay) || isTrue(h.Hidden)) { return null; }
  const exec = String(h.Exec || "").replace(/%[a-zA-Z]/g, "").replace(/\s+/g, " ").trim();
  if (!exec) { return null; }
  return {
    name: pickLocalized(h, "Name"),
    desc: pickLocalized(h, "Comment") || pickLocalized(h, "GenericName"),
    exec: exec,
    icon: h.Icon || "",
    tryexec: h.TryExec || ""
  };
}

function iconCandidates(iconName) {
  if (!iconName) { return []; }
  if (iconName.charAt(0) === "/") { return [iconName]; }
  const list = [];
  for (const theme of ICON_THEMES) {
    for (const size of ICON_SIZES) {
      list.push("/usr/share/icons/" + theme + "/" + size + "/apps/" + iconName + ".png");
    }
    for (const size of ["scalable", "128x128", "64x64", "48x48"]) {
      list.push("/usr/share/icons/" + theme + "/" + size + "/apps/" + iconName + ".svg");
    }
  }
  list.push("/usr/share/pixmaps/" + iconName + ".png");
  list.push("/usr/share/pixmaps/" + iconName + ".svg");
  list.push("/usr/share/icons/" + iconName + ".png");
  return list;
}

function resolveIconDataUri(iconName) {
  for (const cand of iconCandidates(iconName)) {
    const ext = path.extname(cand).toLowerCase();
    if (ext !== ".png" && ext !== ".svg") { continue; }
    let buf = null;
    try {
      buf = fs.readFileSync(toUnc(cand));
    } catch (e) {
      continue;
    }
    if (!buf || buf.length < 16) { continue; }
    const mime = ext === ".svg" ? "image/svg+xml" : "image/png";
    return "data:" + mime + ";base64," + buf.toString("base64");
  }
  return "";
}

function scanApps() {
  const apps = [];
  const seen = new Set();
  const files = listDesktopFiles();
  for (const f of files) {
    const content = readText(f);
    if (!content) { continue; }
    const parsed = parseDesktop(content);
    if (!parsed) { continue; }
    if (parsed.tryexec && !fileExists(parsed.tryexec)) { continue; }
    const name = parsed.name || path.basename(f, ".desktop");
    if (!name) { continue; }
    const key = name + "|" + parsed.exec;
    if (seen.has(key)) { continue; }
    seen.add(key);
    apps.push({
      name: name,
      desc: parsed.desc || "",
      exec: parsed.exec,
      cmd: "wsl -d " + DISTRO + " -- " + parsed.exec,
      icon: resolveIconDataUri(parsed.icon),
      src: f
    });
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  return apps;
}

module.exports = { scanApps, DISTRO };
