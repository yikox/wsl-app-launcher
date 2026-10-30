"use strict";

/*
 * main.js - Electron main process for the WSL app launcher.
 *
 * Responsibilities:
 *   - create the single application window (no browser chrome, no HTTP server)
 *   - scan installed GUI apps in the WSL distro (scan.js)
 *   - spawn wsl.exe for a launch / selftest / install and stream its output back
 *     to the renderer over IPC (no console window ever appears)
 *
 * Everything is logged to launcher-log.txt next to the exe (or in %TEMP%)
 * so startup problems can be diagnosed from the outside.
 */

const { app, BrowserWindow, ipcMain, clipboard, Menu, dialog, shell, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { scanApps, DISTRO } = require("./scan");

const WIN_DIR = process.env.WINDIR || "C:\\Windows";
const WSL = path.join(WIN_DIR, "System32", "wsl.exe");

// The exe itself is just an Electron runtime shell; all launcher logic lives in
// resources\app. Surfacing this version in the UI makes it obvious which code
// is actually running, without having to inspect file timestamps.
const APP_VERSION = (() => {
  try { return require("./package.json").version || "0.0.0"; } catch (e) { return "0.0.0"; }
})();

const LOG_PATH = (() => {
  const candidates = [
    path.join(path.dirname(process.execPath), "launcher-log.txt"),
    path.join(process.env.TEMP || ".", "wsl-launcher-log.txt")
  ];
  for (const c of candidates) {
    try {
      fs.appendFileSync(c, "");
      return c;
    } catch (e) { /* try next */ }
  }
  return null;
})();

let logBytes = 0;
try { logBytes = fs.statSync(LOG_PATH).size; } catch (e) { logBytes = 0; }

function log(msg) {
  const line = new Date().toISOString() + "  " + msg + "\n";
  try {
    if (!LOG_PATH) { return; }
    if (logBytes > 512 * 1024) {
      fs.writeFileSync(LOG_PATH, "");
      logBytes = 0;
    }
    fs.appendFileSync(LOG_PATH, line);
    logBytes += line.length;
  } catch (e) { /* ignore */ }
}

process.on("uncaughtException", (err) => {
  log("UNCAUGHT: " + (err && err.stack ? err.stack : err));
});

let win = null;

// A launcher UI gains nothing from GPU compositing, and software rendering
// avoids a whole class of driver / remote-session GPU crashes.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
// some locked-down environments cannot spawn a separate GPU process
if (process.env.WSL_LAUNCHER_GPU_INPROC === "1") {
  app.commandLine.appendSwitch("in-process-gpu");
}
// diagnostics only (never set by the shipped app): lets the renderer start in
// heavily restricted environments used for automated smoke tests
if (process.env.WSL_LAUNCHER_NO_SANDBOX === "1") {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-setuid-sandbox");
}

function createWindow() {
  win = new BrowserWindow({
    width: 1260,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f4f5f7",
    title: "WSL 应用启动台",
    icon: path.join(__dirname, "assets", "icon.png"),
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.on("show", () => { log("window shown"); });
  win.webContents.on("did-finish-load", () => { log("did-finish-load"); });
  win.webContents.on("render-process-gone", (e, details) => {
    log("render-process-gone: " + JSON.stringify(details));
  });
  win.webContents.on("preload-error", (e, preloadPath, error) => {
    log("preload-error: " + preloadPath + " -> " + (error && error.message));
  });
  win.on("unresponsive", () => { log("window unresponsive"); });

  // self-test hook: WSL_LAUNCHER_SHOT=<file> captures the window and exits
  if (process.env.WSL_LAUNCHER_SHOT) {
    // WSL_LAUNCHER_PAGE=apps|install 切换页面后再截图
    if (process.env.WSL_LAUNCHER_PAGE) {
      setTimeout(() => {
        win.webContents.executeJavaScript(
          "setPage('" + process.env.WSL_LAUNCHER_PAGE + "'); 'page=' + CURRENT_PAGE"
        ).then((r) => log("page switch: " + r)).catch((e) => log("page switch failed: " + e.message));
      }, 1200);
    }
    if (process.env.WSL_LAUNCHER_HINTDEMO === "1") {
      setTimeout(() => {
        win.webContents.executeJavaScript([
          "dockOpen('启动 · Zutty');",
          "typeLine('wsl -d Ubuntu -- zutty', function(){});",
          "dockLine('ok','● 进程运行中 — WSLg 窗口应已出现在 Windows 桌面；本面板保持连接，关掉应用后会显示退出码');",
          "dockLine('dim','Failed to call method: org.freedesktop.DBus.Properties.GetAll: The name org.freedesktop.UPower was not provided by any .service files');",
          "dockLine('err',\"E [fontpack.cc:218] Error: No Regular variant of the requested font '9x18' could be identified.\");",
          "dockLine('exit','[退出码 134]');",
          "dockHint('缺少 X11 核心字体（zutty 启动时必须加载 9x18），装上 xfonts-base 即可','xfonts-base');",
          "true"
        ].join("\n")).then(() => log("hint demo rendered")).catch((e) => log("hint demo failed: " + e.message));
      }, 1400);
    }
    if (process.env.WSL_LAUNCHER_OPENFOLDER === "1") {
      setTimeout(() => {
        openWslFolder(process.env.WSL_LAUNCHER_OPENFOLDER_REL || "")
          .then((r) => log("openWslFolder -> " + JSON.stringify(r)))
          .catch((e) => log("openWslFolder failed: " + e.message));
      }, 1200);
    }
    if (process.env.WSL_LAUNCHER_IMEDEMO === "1") {
      setTimeout(() => {
        win.webContents.executeJavaScript([
          "IME = { installed: false, checked: true, running: false, inject: 'auto' };",
          "markIme();",
          "true"
        ].join("\n")).then(() => log("ime demo rendered")).catch((e) => log("ime demo failed: " + e.message));
      }, 1500);
    }
    if (process.env.WSL_LAUNCHER_INSTDEMO === "1") {
      setTimeout(() => {
        win.webContents.executeJavaScript([
          "setPage('install');",
          "INSTALLED = { gedit: 1, nautilus: 1, xterm: 1, 'xfonts-base': 1, gimp: 1 };",
          "markInstalled();",
          "TOOL_INSTALLED = { codex_app: true, dsh_app: true, qoder_app: true };",
          "markTools();",
          "var pi = document.getElementById('pkgInput'); if (pi) { pi.value = 'meld htop'; }",
          "var sc = document.getElementById('scroller'); if (sc) { sc.scrollTop = sc.scrollHeight; }",
          "true"
        ].join("\n")).then(() => log("install demo rendered")).catch((e) => log("install demo failed: " + e.message));
      }, 1600);
    }
    if (process.env.WSL_LAUNCHER_DEMO === "1") {
      setTimeout(() => {
        win.webContents.executeJavaScript(
          "var b=document.querySelector('button[data-exec]'); if(b){b.click(); true} else {false}"
        ).then((ok) => log("demo click: " + ok)).catch((e) => log("demo click failed: " + e.message));
      }, 1400);
    }
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        const out = process.env.WSL_LAUNCHER_SHOT;
        fs.writeFileSync(out, img.toPNG());
        log("screenshot saved: " + out + " " + img.getSize().width + "x" + img.getSize().height);
      } catch (e) {
        log("screenshot failed: " + e.message);
      }
      app.quit();
    }, 3500);
  }

  // keep devtools reachable for troubleshooting, but no menu bar
  win.webContents.on("before-input-event", (event, input) => {
    if (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i")) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  win.webContents.on("did-fail-load", (e, code, desc) => {
    log("did-fail-load: " + code + " " + desc);
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

// ---------------- wsl helpers ----------------

function send(target, obj) {
  try {
    if (target && !target.isDestroyed()) { target.send("launch:event", obj); }
  } catch (e) { /* ignore */ }
}

const PRECHECK = [
  "echo '===== WSL 环境自检 ====='",
  // /etc/os-release is a symlink to /usr/lib/os-release; parse the real file
  // instead of sourcing it so nothing depends on shell variable scoping.
  "REL=/usr/lib/os-release; [ -r \"$REL\" ] || REL=/etc/os-release",
  "D=$(sed -n 's/^PRETTY_NAME=//p' \"$REL\" 2>/dev/null | head -1 | tr -d '\"')",
  "[ -z \"$D\" ] && D=$(lsb_release -ds 2>/dev/null)",
  "printf 'distro : %s\\n' \"${D:-unknown}\"",
  "printf 'kernel : %s\\n' \"$(uname -r)\"",
  "printf 'user   : %s\\n' \"$(id -un)\"",
  "printf 'DISPLAY: %s\\n' \"${DISPLAY:-<empty>}\"",
  "printf 'WAYLAND: %s\\n' \"${WAYLAND_DISPLAY:-<empty>}\"",
  "if [ -e /mnt/wslg ]; then echo 'WSLg   : OK (/mnt/wslg present)'; else echo 'WSLg   : MISSING - GUI windows cannot show'; fi",
  "if [ -d /usr/share/fonts/X11/misc ]; then echo 'X fonts: OK'; else echo 'X fonts: MISSING - zutty/xterm need xfonts-base'; fi",
  "echo '===== 开始执行 ====='"
].join("\n");

// A multi-line script passed as a single argv gets re-interpreted by the
// Windows command line parser on the way into wsl.exe: quotes are stripped and
// variable expansions travel as literal text, which is why sourcing
// /etc/os-release used to yield "unknown". base64 output is free of quotes,
// spaces and newlines, so it survives the trip byte-for-byte.
function bashB64(script) {
  const payload = Buffer.from(script, "utf8").toString("base64");
  return ["bash", "-c", "printf %s " + payload + " | base64 -d | bash"];
}

// Known failure signatures: turn a bare non-zero exit code into an actionable
// next step that the terminal dock renders with a one-click install button.
const DIAGNOSTICS = [
  { re: /fontpack\.cc|No suitable files for/i,
    msg: "缺少 X11 核心字体（zutty 启动时必须加载 9x18），装上 xfonts-base 即可",
    pkg: "xfonts-base" },
  { re: /Can't open display|cannot open display|Unable to init server/i,
    msg: "连不上 X 显示服务：WSLg 未就绪。在 Windows 终端执行 wsl --update，然后 wsl --shutdown 再打开",
    pkg: "" },
  { re: /Running as root without --no-sandbox|No usable sandbox/i,
    msg: "该应用在 WSL 内以 root 运行时需要追加 --no-sandbox 参数",
    pkg: "" },
  { re: /error while loading shared libraries: ([^:\s]+)/i,
    msg: "缺少动态库依赖，按提示安装对应运行库包后重试",
    pkg: "" },
  { re: /GLIBC_[\d.]+.*not found/i,
    msg: "应用要求的 glibc 高于 WSL 内版本，需要升级发行版（sudo do-release-upgrade）",
    pkg: "" },
  { re: /command not found|No such file or directory/i,
    msg: "启动命令不存在，可能程序已被卸载；点右上角「重新扫描」刷新列表",
    pkg: "" },
  { re: /Permission denied|EACCES|EPERM/i,
    msg: "权限被拒绝：可能是系统安全策略拦截了 wsl.exe，或文件缺少可执行权限",
    pkg: "" }
];

// Renderer-side comfort: chatter that never affects whether the window shows
// up. Typical sources are WSLg's missing GPU/DBus/UPower daemons and Chromium's
// telemetry. Shown dimmed instead of as red errors.
const NOISE = new RegExp([
  "^libEGL warning",
  "^DRI[23] (error|warning)",
  "MESA-LOADER",
  "^libGL error",
  "^libva (error|warning)",
  "org\\.freedesktop\\.(DBus|UPower)",
  "Failed to call method",
  "Failed to connect to the bus",
  "DEPRECATED_ENDPOINT",
  "^Created TensorFlow Lite",
  "^Fontconfig warning",
  "^Gtk-WARNING",
  "^(GLib-)?Gtk-Message",
  "^Warning: locale not supported",
  // ChatGPT / Codex 桌面版内置 app-server 的遥测与后台会话恢复日志：
  // 不是启动失败，详见 pipeLines 里的一次性解释
  "^\\[AppServerConnection\\]",
  "^\\[electron-message-handler\\]",
  "thread access denied",
  "\"code\":-32003"
].join("|"), "i");

// split a .desktop Exec string into argv, honoring double quotes
function tokenize(s) {
  const out = [];
  let cur = "";
  let inQ = false;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "\"") { inQ = !inQ; started = true; continue; }
    if (!inQ && (c === " " || c === "\t")) {
      if (started) { out.push(cur); cur = ""; started = false; }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) { out.push(cur); }
  return out;
}

function pipeLines(proc, target, sink) {
  let explainedThreadDenied = false;
  const emit = (line, isErr) => {
    if (sink) {
      sink.push(line);
      // keep only a bounded tail: diagnostics only need recent output
      if (sink.length > 400) { sink.shift(); }
    }
    send(target, { t: isErr ? (NOISE.test(line) ? "dim" : "err") : "out", line: line });
    // 一次性解释：这类告警每次启动都会刷，但含义固定，别让用户以为装坏了
    if (isErr && !explainedThreadDenied && /thread access denied|-32003/.test(line)) {
      explainedThreadDenied = true;
      send(target, {
        t: "hint",
        text: "ChatGPT / Codex 桌面版的会话恢复告警（-32003 thread access denied）：它想打开的历史会话在本机 .codex 里已不存在，属后台预热失败，不影响新建对话。",
        pkg: ""
      });
    }
  };
  let obuf = "";
  proc.stdout.on("data", (d) => {
    obuf += d.toString("utf8");
    let idx;
    while ((idx = obuf.indexOf("\n")) >= 0) {
      let line = obuf.slice(0, idx);
      obuf = obuf.slice(idx + 1);
      if (line.endsWith("\r")) { line = line.slice(0, -1); }
      if (line.length) { emit(line, false); }
    }
  });
  let ebuf = "";
  proc.stderr.on("data", (d) => {
    ebuf += d.toString("utf8");
    let idx;
    while ((idx = ebuf.indexOf("\n")) >= 0) {
      let line = ebuf.slice(0, idx);
      ebuf = ebuf.slice(idx + 1);
      if (line.endsWith("\r")) { line = line.slice(0, -1); }
      if (line.length) { emit(line, true); }
    }
  });
}

// Emit one hint per distinct matching signature, in table order.
function diagnose(lines, target) {
  const text = lines.join("\n");
  const seen = new Set();
  for (const d of DIAGNOSTICS) {
    if (d.re.test(text) && !seen.has(d.msg)) {
      seen.add(d.msg);
      send(target, { t: "hint", text: d.msg, pkg: d.pkg || "" });
    }
  }
}

function runWsl(args, target, onDone) {
  let proc = null;
  try {
    proc = spawn(WSL, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    send(target, { t: "err", line: "spawn failed: " + e.message });
    onDone(-1);
    return null;
  }
  pipeLines(proc, target);
  proc.on("error", (e) => send(target, { t: "err", line: "spawn failed: " + e.message }));
  proc.on("close", (code) => onDone(code));
  return proc;
}

// ---------------- interface scaling ----------------
// WSLg hands X clients a 96 DPI screen no matter what the Windows display
// scaling is, so a 150%-scaled monitor makes every Linux app render at 2/3
// size. Inject the scale before exec: Xft.dpi drives Xft/GTK/Qt text, the
// toolkit env vars cover GTK/Qt widgets, and Chromium needs its own flag
// because GTK's scale factor does not move web content.
const SETTINGS_DEFAULT = { scale: "auto", ime: "auto" };
let settings = Object.assign({}, SETTINGS_DEFAULT);

function settingsPath() {
  try { return path.join(app.getPath("userData"), "settings.json"); }
  catch (e) { return path.join(process.env.TEMP || ".", "wsl-launcher-settings.json"); }
}

function loadSettings() {
  try {
    const obj = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    if (obj && typeof obj === "object") {
      settings = Object.assign({}, SETTINGS_DEFAULT, obj);
    }
  } catch (e) { /* first run / unreadable: keep defaults */ }
  return settings;
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
  } catch (e) {
    log("saveSettings failed: " + e.message);
  }
}

function windowsScale() {
  try {
    const s = screen.getPrimaryDisplay().scaleFactor;
    return s && s > 0 ? s : 1;
  } catch (e) {
    return 1;
  }
}

function launchScale() {
  const raw = settings.scale;
  if (!raw || raw === "auto") { return windowsScale(); }
  const v = parseFloat(raw);
  return v > 0 ? v : 1;
}

function shellQuote(s) {
  return "'" + String(s).split("'").join("'\\''") + "'";
}

function buildLaunchScript(argv, scale, ime) {
  const cmd = argv.map(shellQuote).join(" ");
  const dpi = Math.round(96 * scale);
  const cursor = Math.round(24 * scale);
  const intScale = Math.max(1, Math.round(scale));
  const fontScale = (scale / intScale).toFixed(3);
  // WSLg 不转发 Windows 输入法，Linux 端必须自带 IM（fcitx5）。装了就把守护进程
  // 拉起并导出环境变量；GDK_BACKEND=x11 是因为 fcitx5 的 wayland 前端在 WSLg 的
  // weston 上拿不到 text-input，走 XWayland + XIM 才稳。fcitx5 的 GTK/Qt 前端靠
  // D-Bus 找守护进程，所以每个应用必须拿到同一条 session bus，否则各连各的。
  const imeLines = (ime === "off") ? [] : [
    "# --- 中文输入法（fcitx5）---",
    "U=$(id -u)",
    "if [ -z \"${DBUS_SESSION_BUS_ADDRESS:-}\" ]; then",
    "  if [ -S \"/run/user/$U/bus\" ]; then",
    "    export DBUS_SESSION_BUS_ADDRESS=\"unix:path=/run/user/$U/bus\"",
    "  else",
    "    SOCK=\"/tmp/wsl-dbus-$U.sock\"",
    "    [ -S \"$SOCK\" ] || dbus-daemon --session --fork --nopidfile --address=\"unix:path=$SOCK\" >/dev/null 2>&1 || true",
    "    [ -S \"$SOCK\" ] && export DBUS_SESSION_BUS_ADDRESS=\"unix:path=$SOCK\"",
    "  fi",
    "fi",
    "if command -v fcitx5 >/dev/null 2>&1; then",
    "  if ! pgrep -x fcitx5 >/dev/null 2>&1; then",
    "    nohup fcitx5 -d --disable=wayland --replace >/dev/null 2>&1 &",
    "    sleep 1",
    "  fi",
    "  export INPUT_METHOD=fcitx XMODIFIERS=@im=fcitx",
    "  export GTK_IM_MODULE=fcitx QT_IM_MODULE=fcitx QT4_IM_MODULE=fcitx",
    "  export SDL_IM_MODULE=fcitx GDK_BACKEND=x11",
    "fi"
  ];
  return [
    "set -u",
    "printf 'Xft.dpi: " + dpi + "\\nXcursor.size: " + cursor + "\\n' | xrdb -merge >/dev/null 2>&1 || true"
  ].concat(imeLines).concat([
    "P=" + shellQuote(argv[0]),
    "case \"$P\" in */*) ;; *) P=$(command -v " + shellQuote(argv[0]) + " 2>/dev/null || echo " + shellQuote(argv[0]) + ") ;; esac",
    "P=$(readlink -f \"$P\" 2>/dev/null || echo \"$P\")",
    "D=$(dirname \"$P\")",
    "ELECTRON=0",
    "if [ -e \"$D/icudtl.dat\" ] || [ -e \"$D/chrome-sandbox\" ] || [ -e \"$D/resources/app.asar\" ]; then ELECTRON=1; fi",
    "if [ \"$ELECTRON\" = 1 ]; then",
    "  exec " + cmd + " --force-device-scale-factor=" + scale,
    "fi",
    "export GDK_SCALE=" + intScale,
    "export GDK_DPI_SCALE=" + fontScale,
    "export QT_SCALE_FACTOR=" + scale,
    "export QT_SCREEN_SCALE_FACTORS=" + scale,
    "export QT_AUTO_SCREEN_SCALE_FACTOR=0",
    "exec " + cmd
  ]).join("\n");
}

function launchApp(exec, target) {
  // .desktop 的 Exec 里可能带 %U / %F 之类的占位符，直接透传会被应用当成参数
  const argv = tokenize(exec || "").filter((a) => !/^%[fFuUdDnNickvm]$/.test(a));
  if (!argv.length) {
    send(target, { t: "err", line: "empty command" });
    send(target, { t: "exit", code: -1 });
    return;
  }
  const scale = launchScale();
  const ime = settings.ime === "off" ? "off" : "auto";
  log("launch: " + exec + " (scale x" + scale + ", ime " + ime + ")");
  runWsl(["-d", DISTRO, "--"].concat(bashB64(PRECHECK)), target, (code) => {
    if (code !== 0) {
      send(target, { t: "err", line: "环境自检失败 (exit " + code + ") - WSL 可能未在运行" });
    }
    send(target, { t: "info", line: "正在启动应用… WSLg 窗口应出现在 Windows 桌面；本终端保持连接，应用退出后显示退出码。" });
    if (scale > 1) {
      send(target, { t: "info", line: "界面缩放 " + Math.round(scale * 100) + "%（DPI " + Math.round(96 * scale) + "）已注入，避免 WSLg 按 96 DPI 渲染导致字体偏小。" });
    }
    if (ime !== "off") {
      send(target, { t: "dim", line: "已注入输入法环境变量（装了 fcitx5 才有中文；未装见「一键安装 → 中文输入法」）。" });
    }

    let proc = null;
    try {
      proc = spawn(WSL, ["-d", DISTRO, "--"].concat(bashB64(buildLaunchScript(argv, scale, ime))), {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (e) {
      send(target, { t: "err", line: "无法启动 wsl.exe: " + e.message });
      send(target, { t: "exit", code: -1 });
      return;
    }
    const tail = [];
    pipeLines(proc, target, tail);
    // A healthy GUI app prints next to nothing, so "no output" is ambiguous.
    // Once the process has survived a couple of seconds, say so out loud.
    const aliveTimer = setTimeout(() => {
      send(target, { t: "ok", line: "● 进程运行中 — WSLg 窗口应已出现在 Windows 桌面；本面板保持连接，关掉应用后会显示退出码" });
    }, 2500);
    proc.on("error", (e) => {
      clearTimeout(aliveTimer);
      send(target, { t: "err", line: "无法启动 wsl.exe: " + e.message });
      send(target, { t: "exit", code: -1 });
    });
    proc.on("close", (code) => {
      clearTimeout(aliveTimer);
      send(target, { t: "exit", code: code });
      if (code !== 0) { diagnose(tail, target); }
      send(target, { t: "info", line: "应用已退出。可清空终端，或直接启动下一个应用。" });
    });
  });
}

function selftest(target) {
  log("selftest");
  runWsl(["-d", DISTRO, "--"].concat(bashB64(PRECHECK)), target, (code) => {
    send(target, { t: "exit", code: code });
  });
}

// apt install as root: no sudo password prompt needed, output streamed live
// One dpkg-query round trip reports which of the offered packages are already
// present, so the UI can mark them instead of letting the user reinstall blindly.
// Windows Explorer can browse the distro filesystem directly through the UNC
// channel - no Linux file manager needed. Preferred because it is instant, uses
// the user's familiar shortcuts, and survives WSL being restarted.
const WSL_UNC = "\\\\wsl.localhost\\" + DISTRO;

function wslHomeUnc() {
  const homeRoot = path.join(WSL_UNC, "home");
  try {
    const users = fs.readdirSync(homeRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    if (users.length) { return path.join(homeRoot, users[0]); }
  } catch (e) {
    log("wslHomeUnc probe failed: " + e.message);
  }
  return WSL_UNC;
}

async function openWslFolder(rel) {
  const target = rel ? path.join(WSL_UNC, String(rel).replace(/\//g, "\\")) : wslHomeUnc();
  if (!fs.existsSync(target)) {
    log("open folder missing: " + target);
    return { ok: false, path: target, error: "路径不存在，WSL 可能未启动" };
  }
  let err = "";
  try {
    err = await shell.openPath(target);
  } catch (e) {
    err = e.message;
  }
  log("open folder: " + target + (err ? " -> " + err : " -> ok"));
  return { ok: !err, path: target, error: err || "" };
}

// Runs a bash script inside the distro and returns its stdout as a string.
// Used for short read-only probes (package list, whether a CLI is on PATH).
function runWslCollect(script, timeoutMs) {
  return new Promise((resolve) => {
    let proc = null;
    try {
      proc = spawn(WSL, ["-d", DISTRO, "--"].concat(bashB64(script)), {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (e) {
      log("runWslCollect spawn failed: " + e.message);
      resolve("");
      return;
    }

    let buf = "";
    let done = false;
    const finish = (val) => {
      if (done) { return; }
      done = true;
      try { proc.kill(); } catch (e) { /* already gone */ }
      resolve(val);
    };
    proc.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.length > 65536) { buf = buf.slice(0, 65536); }
    });
    proc.on("error", (e) => { log("runWslCollect error: " + e.message); finish(""); });
    proc.on("close", () => finish(buf));
    setTimeout(() => finish(""), timeoutMs || 15000);
  });
}

// One dpkg-query round trip reports which of the offered packages are already
// present, so the UI can mark them instead of letting the user reinstall blindly.
async function queryInstalled(pkgs) {
  const list = (Array.isArray(pkgs) ? pkgs : [])
    .map((p) => String(p || "").replace(/[^a-zA-Z0-9._+-]/g, ""))
    .filter(Boolean)
    .slice(0, 120);
  if (!list.length) { return []; }

  const script = [
    "dpkg-query -W -f='${Package}\\t${Status}\\n' " + list.join(" ") + " 2>/dev/null",
    "exit 0"
  ].join("\n");

  const raw = await runWslCollect(script, 15000);
  const out = [];
  raw.split(/\r?\n/).forEach((line) => {
    const parts = line.split("\t");
    if (parts.length === 2 && parts[1].indexOf("install ok installed") === 0) {
      out.push(parts[0].trim());
    }
  });
  return out;
}

function installPkg(pkg, target) {
  const safe = String(pkg || "")
    .split(/\s+/)
    .map((s) => s.replace(/[^a-zA-Z0-9._+-]/g, ""))
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");
  if (!safe) {
    send(target, { t: "err", line: "非法包名" });
    send(target, { t: "exit", code: -1 });
    return;
  }
  log("install: " + safe);
  send(target, { t: "cmd", line: "wsl -d " + DISTRO + " -u root -- apt-get install -y " + safe });
  const script = [
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -qq || true",
    "apt-get install -y " + safe
  ].join("\n");
  runWsl(["-d", DISTRO, "-u", "root", "--"].concat(bashB64(script)), target, (code) => {
    send(target, { t: "exit", code: code });
    if (code === 0) {
      send(target, { t: "rescanned" });
    } else {
      send(target, { t: "hint", text: "安装失败：包名可能需要更新索引，或该版本没有此包", pkg: "" });
    }
  });
}

// ---------------- 中文输入法（fcitx5） ----------------
// WSLg 只把画面与键盘事件转发过来，不会把 Windows 的输入法送进 Linux 窗口
// （microsoft/wslg#9 至今仍是 open），所以 Linux 侧必须自带一套 IM。
// 又因为 WSLg 的 weston 不提供 fcitx5 需要的 text-input 协议，守护进程必须
// --disable=wayland 走 XWayland，应用侧再用 XIM / GTK / Qt 前端接上。
const IME_PKGS = "fcitx5 fcitx5-chinese-addons fcitx5-frontend-gtk3 fcitx5-frontend-gtk4 fcitx5-frontend-qt5 fcitx5-config-qt dbus-x11 fonts-noto-cjk";

const IME_ROOT_SCRIPT = [
  "set -u",
  "export DEBIAN_FRONTEND=noninteractive",
  "echo '==> 安装 Fcitx5 中文输入法（拼音）'",
  "apt-get update -qq || true",
  "PKGS='" + IME_PKGS + "'",
  "apt-get install -y --no-install-recommends $PKGS || {",
  "  echo '[提示] 整体安装失败，改为逐个安装以定位缺包'",
  "  for p in $PKGS; do apt-get install -y \"$p\" || echo \"[跳过] $p\"; done",
  "}",
  "if ! command -v fcitx5 >/dev/null 2>&1; then",
  "  echo '[失败] fcitx5 未安装成功，请检查 apt 源与网络'",
  "  exit 1",
  "fi",
  "echo '[完成] 包已安装：'$(fcitx5 --version 2>/dev/null | head -1)"
].join("\n");

const IME_PROFILE = [
  "[Groups/0]",
  "Name=Default",
  "Default Layout=us",
  "DefaultIM=pinyin",
  "",
  "[Groups/0/Items/0]",
  "Name=keyboard-us",
  "Layout=",
  "",
  "[Groups/0/Items/1]",
  "Name=pinyin",
  "Layout=",
  "",
  "[GroupOrder]",
  "0=Default"
].join("\n");

const IME_CONFIG = [
  "[Hotkey]",
  "# Windows 侧常把 Ctrl+space 抢走（系统输入法切换），所以再挂一个 Ctrl+semicolon",
  "TriggerKeys=Control+space",
  "AltTriggerKeys=Control+semicolon"
].join("\n");

const IME_USER_SCRIPT = [
  "set -u",
  "U=$(id -u)",
  "if [ -z \"${DBUS_SESSION_BUS_ADDRESS:-}\" ]; then",
  "  if [ -S \"/run/user/$U/bus\" ]; then",
  "    export DBUS_SESSION_BUS_ADDRESS=\"unix:path=/run/user/$U/bus\"",
  "  else",
  "    SOCK=\"/tmp/wsl-dbus-$U.sock\"",
  "    [ -S \"$SOCK\" ] || dbus-daemon --session --fork --nopidfile --address=\"unix:path=$SOCK\" >/dev/null 2>&1 || true",
  "    [ -S \"$SOCK\" ] && export DBUS_SESSION_BUS_ADDRESS=\"unix:path=$SOCK\"",
  "  fi",
  "fi",
  "mkdir -p \"$HOME/.config/fcitx5\"",
  "if [ ! -f \"$HOME/.config/fcitx5/profile\" ]; then",
  "cat > \"$HOME/.config/fcitx5/profile\" <<'PROFILE_EOF'",
  IME_PROFILE,
  "PROFILE_EOF",
  "  echo '[完成] 默认输入法：英文键盘 + 拼音'",
  "else",
  "  echo '[跳过] 已有输入法配置，保留你的设置'",
  "fi",
  "if [ ! -f \"$HOME/.config/fcitx5/config\" ]; then",
  "cat > \"$HOME/.config/fcitx5/config\" <<'CONFIG_EOF'",
  IME_CONFIG,
  "CONFIG_EOF",
  "  echo '[完成] 切换键：Ctrl+空格（备用 Ctrl+;）'",
  "fi",
  "pkill -x fcitx5 >/dev/null 2>&1 || true",
  "sleep 0.4",
  "nohup fcitx5 -d --disable=wayland --replace >/dev/null 2>&1 &",
  "sleep 2",
  "if pgrep -x fcitx5 >/dev/null 2>&1; then",
  "  fcitx5-remote -o >/dev/null 2>&1 || true",
  "  echo '[完成] fcitx5 已在运行，当前输入法：拼音'",
  "  echo '用法：在 Linux 应用里按 Ctrl+空格 切中英文（被 Windows 抢了就用 Ctrl+;）；需要调候选词/皮肤就运行 fcitx5-configtool'",
  "else",
  "  echo '[失败] fcitx5 未能启动；可手动运行 fcitx5 -d --disable=wayland 看报错'",
  "  exit 1",
  "fi"
].join("\n");

function installIme(target) {
  log("install ime (fcitx5)");
  send(target, { t: "cmd", line: "wsl -d " + DISTRO + " -u root -- apt-get install -y " + IME_PKGS });
  send(target, { t: "info", line: "WSLg 不会转发 Windows 输入法，所以要在 Linux 里装一套。Fcitx5 + 拼音 + GTK/Qt 前端约 40~60MB，装完自动配置并启动。" });
  runWsl(["-d", DISTRO, "-u", "root", "--"].concat(bashB64(IME_ROOT_SCRIPT)), target, (code) => {
    if (code !== 0) {
      send(target, { t: "exit", code: code });
      send(target, { t: "hint", text: "Fcitx5 安装失败：多为 apt 源或网络问题，可稍后重试", pkg: "fcitx5" });
      return;
    }
    send(target, { t: "info", line: "包已就绪，正在以你的用户身份写入配置并启动 fcitx5…" });
    runWsl(["-d", DISTRO, "--"].concat(bashB64(IME_USER_SCRIPT)), target, (code2) => {
      send(target, { t: "exit", code: code2 });
      if (code2 === 0) {
        send(target, { t: "info", line: "输入法已就绪。已经开着的 Linux 应用要重启一次才会挂上输入法。" });
        send(target, { t: "imeready" });
      } else {
        send(target, { t: "hint", text: "fcitx5 已装好但没能启动，手动运行 fcitx5 -d --disable=wayland 可看到具体报错", pkg: "" });
      }
    });
  });
}

async function queryIme() {
  const raw = await runWslCollect([
    "if command -v fcitx5 >/dev/null 2>&1; then echo 'installed 1'; else echo 'installed 0'; fi",
    "if pgrep -x fcitx5 >/dev/null 2>&1; then echo 'running 1'; else echo 'running 0'; fi"
  ].join("\n"), 12000);
  const out = { installed: false, running: false, inject: settings.ime === "off" ? "off" : "auto" };
  raw.split(/\r?\n/).forEach((line) => {
    const m = line.trim().match(/^(installed|running)\s+([01])$/);
    if (m) { out[m[1]] = m[2] === "1"; }
  });
  return out;
}

// ---------------- npm tool kits (Codex CLI / DeepSeek Harness) ----------------
// Both are npm packages that need Node >= 22 and a terminal to live in, so the
// installer also provisions Node 24 and xterm, then writes a .desktop entry so
// the app shows up in the launcher grid like any distro package.
const NODE_BOOTSTRAP = [
  "set -u",
  "export DEBIAN_FRONTEND=noninteractive",
  "",
  "say() { echo; echo \"==> $*\"; }",
  "",
  "say \"准备基础组件（xterm 终端 / curl / xz）\"",
  "apt-get update -qq || true",
  "apt-get install -y --no-install-recommends xterm ca-certificates curl xz-utils >/dev/null 2>&1 || apt-get install -y xterm ca-certificates curl xz-utils",
  "",
  "node_major() {",
  "  if command -v node >/dev/null 2>&1; then node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; else echo 0; fi",
  "}",
  "",
  "say \"检查 Node.js（需要 >= 22）\"",
  "M=$(node_major)",
  "if command -v node >/dev/null 2>&1; then echo \"    当前: $(node -v)\"; else echo \"    当前: 未安装\"; fi",
  "",
  "if [ \"${M:-0}\" -lt 22 ] 2>/dev/null; then",
  "  say \"安装 Node.js 24（先试 NodeSource，失败回退 npmmirror 二进制）\"",
  "  ok=0",
  "  if curl -fsSL --max-time 25 https://deb.nodesource.com/setup_24.x -o /tmp/nodesetup.sh 2>/dev/null; then",
  "    if bash /tmp/nodesetup.sh >/dev/null 2>&1 && apt-get install -y nodejs >/dev/null 2>&1; then ok=1; fi",
  "  fi",
  "  if [ \"$ok\" -eq 0 ]; then",
  "    echo '    NodeSource 不可达，改用 npmmirror 二进制包'",
  "    V=$(curl -fsSL --max-time 25 https://npmmirror.com/mirrors/node/index.json 2>/dev/null | tr ',' '\\n' | grep -o 'v24[0-9.]*' | head -1)",
  "    [ -n \"${V:-}\" ] || V=v24.11.1",
  "    T=\"node-$V-linux-x64.tar.xz\"",
  "    echo \"    下载 $T\"",
  "    curl -fL --max-time 900 \"https://npmmirror.com/mirrors/node/$V/$T\" -o \"/tmp/$T\" || exit 1",
  "    mkdir -p /usr/local/lib/nodejs",
  "    tar -xJf \"/tmp/$T\" -C /usr/local/lib/nodejs || exit 1",
  "    ln -sf \"/usr/local/lib/nodejs/node-$V-linux-x64/bin/node\" /usr/local/bin/node",
  "    ln -sf \"/usr/local/lib/nodejs/node-$V-linux-x64/bin/npm\" /usr/local/bin/npm",
  "    ln -sf \"/usr/local/lib/nodejs/node-$V-linux-x64/bin/npx\" /usr/local/bin/npx",
  "    hash -r 2>/dev/null || true",
  "  fi",
  "fi",
  "",
  "hash -r 2>/dev/null || true",
  "M2=$(node_major)",
  "if [ \"${M2:-0}\" -lt 22 ] 2>/dev/null; then",
  "  echo '[失败] Node 仍低于 22，请检查网络后重试。'",
  "  exit 2",
  "fi",
  "say 'Node 环境就绪'",
  "node -v",
  "npm -v"
].join("\n");

/* ---- 桌面版（官方/社区 deb）---- */

const DEB_PRELUDE = [
  "set -u",
  "export DEBIAN_FRONTEND=noninteractive",
  "say() { echo; echo \"==> $*\"; }"
].join("\n");

const CODEX_DESKTOP_SCRIPT = [
  DEB_PRELUDE,
  "",
  "say 'Codex 桌面版：下载 OpenAI 官方 Linux deb（约 500MB）'",
  "U='https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_amd64.deb'",
  "F=/tmp/chatgpt_amd64.deb",
  "echo \"    来源: $U\"",
  "rm -f \"$F\" 2>/dev/null || true",
  "curl -fL --retry 3 --retry-delay 2 -o \"$F\" \"$U\" &",
  "CPID=$!",
  "while kill -0 $CPID 2>/dev/null; do",
  "  S=$(stat -c %s \"$F\" 2>/dev/null || echo 0)",
  "  echo \"    已下载 $((S/1048576)) MB / ~502 MB\"",
  "  sleep 5",
  "done",
  "wait $CPID || { echo '[失败] deb 下载失败，检查网络后重试'; exit 1; }",
  "ls -lh \"$F\"",
  "",
  "say '安装（apt 自动补齐 GTK3 / Electron 运行库）'",
  "apt-get update -qq || true",
  "DEBIAN_FRONTEND=noninteractive apt-get install -y \"$F\" || exit 1",
  "",
  "say '校验'",
  "dpkg-query -W -f='${Package} ${Version} ${Status}\\n' chatgpt || true",
  "ls /usr/share/applications 2>/dev/null | grep -i chatgpt || echo '    (未发现 chatgpt.desktop)'",
  "echo",
  "echo '完成：ChatGPT / Codex 桌面版已安装。首次启动需登录 ChatGPT 账号，应用会自动出现在上方启动台。'"
].join("\n");

const DSH_DESKTOP_SCRIPT = [
  DEB_PRELUDE,
  "",
  "say 'DeepSeek Harness 桌面版：查询 GitHub 最新 release'",
  "API='https://api.github.com/repos/citrusli2026/dsh-desktop/releases/latest'",
  "J=$(curl -fsSL --max-time 40 \"$API\") || { echo '[失败] GitHub API 不可达（网络受限），可改用同组的 DSH CLI'; exit 1; }",
  "U=$(printf '%s' \"$J\" | grep -o 'https://[^\"]*amd64\\.deb' | head -1)",
  "TAG=$(printf '%s' \"$U\" | sed 's#.*/download/##; s#/.*##')",
  "echo \"    最新版本: ${TAG:-unknown}\"",
  "[ -n \"$U\" ] || { echo '[失败] 该 release 没有 amd64.deb'; exit 1; }",
  "echo \"    来源: $U\"",
  "F=/tmp/dsh-desktop-amd64.deb",
  "rm -f \"$F\" 2>/dev/null || true",
  "curl -fL --retry 3 --retry-delay 2 -o \"$F\" \"$U\" &",
  "CPID=$!",
  "while kill -0 $CPID 2>/dev/null; do",
  "  S=$(stat -c %s \"$F\" 2>/dev/null || echo 0)",
  "  echo \"    已下载 $((S/1048576)) MB / ~223 MB\"",
  "  sleep 5",
  "done",
  "wait $CPID || { echo '[失败] deb 下载失败（GitHub 直连可能很慢），可改用 CLI 版'; exit 1; }",
  "ls -lh \"$F\"",
  "",
  "say '安装（apt 自动补齐 Electron 运行库）'",
  "apt-get update -qq || true",
  "DEBIAN_FRONTEND=noninteractive apt-get install -y \"$F\" || exit 1",
  "",
  "say '校验'",
  "dpkg-query -W -f='${Package} ${Version} ${Status}\\n' dsh-desktop || true",
  "command -v dsh-desktop || echo '    (dsh-desktop 未进入 PATH)'",
  "echo",
  "echo '完成：DSH 桌面版已安装（自带 Node 与 Harness 运行时）。首次启动在设置里填 DeepSeek API Key。'"
].join("\n");

/* Qoder IDE（VS Code 内核的 Electron 应用）。官方 CDN 偶发中途断流，
   所以带断点续传 + dpkg-deb 完整性校验的循环重试。 */
const QODER_DESKTOP_SCRIPT = [
  DEB_PRELUDE,
  "",
  "say 'Qoder IDE 桌面版：下载官方 Linux deb（约 169MB）'",
  "M=$(uname -m)",
  "if [ \"$M\" != x86_64 ]; then echo \"[不支持] 当前架构 $M：Qoder 目前只发布 amd64 的 deb\"; exit 1; fi",
  "U='https://download.qoder.com/release/latest/qoder_amd64.deb'",
  "F=/tmp/qoder_amd64.deb",
  "echo \"    来源: $U\"",
  "OK=0",
  "i=0",
  "while [ $i -lt 5 ]; do",
  "  i=$((i+1))",
  "  S0=$(stat -c %s \"$F\" 2>/dev/null || echo 0)",
  "  echo \"    第 $i 次尝试（已有 $((S0/1048576)) MB）\"",
  "  curl -fL --retry 3 --retry-delay 2 -C - -o \"$F\" \"$U\" &",
  "  CPID=$!",
  "  while kill -0 $CPID 2>/dev/null; do",
  "    S=$(stat -c %s \"$F\" 2>/dev/null || echo 0)",
  "    echo \"    已下载 $((S/1048576)) MB / ~169 MB\"",
  "    sleep 5",
  "  done",
  "  wait $CPID || true",
  "  if dpkg-deb -f \"$F\" Package >/dev/null 2>&1; then OK=1; break; fi",
  "  echo '    本次没下完，断点续传重试…'",
  "done",
  "[ \"$OK\" = 1 ] || { echo '[失败] deb 下载不完整（CDN 中途断流）。重跑即可继续断点续传。'; exit 1; }",
  "ls -lh \"$F\"",
  "echo \"    包版本: $(dpkg-deb -f \"$F\" Version)\"",
  "",
  "say '安装（apt 自动补齐 GTK3 / Electron 运行库）'",
  "apt-get update -qq || true",
  "DEBIAN_FRONTEND=noninteractive apt-get install -y \"$F\" || exit 1",
  "",
  "say '校验'",
  "dpkg-query -W -f='${Package} ${Version} ${Status}\\n' qoder || true",
  "ls /usr/share/applications 2>/dev/null | grep -i qoder || echo '    (未发现 qoder.desktop)'",
  "echo",
  "echo '完成：Qoder IDE 已安装，会自动出现在上方启动台。首次启动需登录 Qoder 账号。'",
  "echo '提示：它是 Electron 应用，从启动台进入会自动带上界面缩放参数。'"
].join("\n");

/* ---- CLI 版（npm 全局，作为桌面版装不上时的兜底）---- */

const CODEX_SCRIPT = [
  NODE_BOOTSTRAP,
  "",
  "say '安装 Codex CLI（npm 全局）'",
  "npm install -g --unsafe-perm=true --registry=https://registry.npmmirror.com @openai/codex || exit 1",
  "command -v codex >/dev/null 2>&1 || { echo '[失败] codex 未进入 PATH'; exit 1; }",
  "codex --version || true",
  "",
  "say '写入启动项'",
  "cat > /usr/share/applications/codex.desktop <<'DESKTOP'",
  "[Desktop Entry]",
  "Type=Application",
  "Name=Codex CLI",
  "Comment=OpenAI Codex coding agent (terminal)",
  "Exec=xterm -T Codex -e bash -lc \"codex; echo; echo '[Codex 已退出，按 Ctrl+D 关闭窗口]'; exec bash\"",
  "Icon=utilities-terminal",
  "Terminal=false",
  "Categories=Development;",
  "StartupNotify=false",
  "DESKTOP",
  "update-desktop-database /usr/share/applications >/dev/null 2>&1 || true",
  "echo",
  "echo '完成：Codex CLI 已加入启动台（首次运行需登录 ChatGPT 账号或填 API Key）。'"
].join("\n");

const DSH_SCRIPT = [
  NODE_BOOTSTRAP,
  "",
  "say '安装 DeepSeek Harness（dsh）'",
  "npm install -g --unsafe-perm=true --registry=https://registry.npmmirror.com @deepseek-ai/dsh || exit 1",
  "command -v dsh >/dev/null 2>&1 || { echo '[失败] dsh 未进入 PATH'; exit 1; }",
  "dsh --version || true",
  "",
  "say '写入启动项'",
  "cat > /usr/share/applications/dsh.desktop <<'DESKTOP'",
  "[Desktop Entry]",
  "Type=Application",
  "Name=DeepSeek Harness",
  "Comment=DeepSeek Harness agent (local web UI)",
  "Exec=xterm -T \"DeepSeek Harness\" -e bash -lc \"dsh web; echo; echo '[dsh web 已退出，按 Ctrl+D 关闭窗口]'; exec bash\"",
  "Icon=utilities-terminal",
  "Terminal=false",
  "Categories=Development;",
  "StartupNotify=false",
  "DESKTOP",
  "update-desktop-database /usr/share/applications >/dev/null 2>&1 || true",
  "echo",
  "echo '完成：DeepSeek Harness 已加入启动台。启动后在终端里点开 http://127.0.0.1:3080 填 DeepSeek API Key。'"
].join("\n");

const DPKG_OK = (pkg) =>
  "dpkg-query -W -f='${Status}' " + pkg + " 2>/dev/null | grep -q 'install ok installed'";

const TOOLS = {
  codex_app: {
    label: "ChatGPT / Codex 桌面版",
    detect: DPKG_OK("chatgpt"),
    script: CODEX_DESKTOP_SCRIPT,
    note: "OpenAI 官方 Linux deb：下载约 500MB，装完约 1.7GB，需要外网。首次启动登录 ChatGPT 账号。",
    hint: "多为下载中断或外网受限；若报依赖缺失，按提示 apt-get install 对应包即可重试"
  },
  dsh_app: {
    label: "DeepSeek Harness 桌面版",
    detect: DPKG_OK("dsh-desktop"),
    script: DSH_DESKTOP_SCRIPT,
    note: "社区维护的 dsh-desktop（MIT，非 DeepSeek 官方）：自带 Node 24 与 Harness，deb 约 223MB。",
    hint: "多在 GitHub 直连太慢或 API 不可达；可先用「CLI 版」替代"
  },
  qoder_app: {
    label: "Qoder IDE 桌面版",
    detect: DPKG_OK("qoder"),
    script: QODER_DESKTOP_SCRIPT,
    note: "阿里 Qoder 官方 Linux deb（Agentic IDE，VS Code 内核）：下载约 169MB，装完约 750MB，脚本带断点续传。",
    hint: "多为 CDN 中途断流（重跑会继续断点续传）或外网受限"
  },
  codex_cli: {
    label: "Codex CLI",
    detect: "command -v codex >/dev/null 2>&1",
    script: CODEX_SCRIPT,
    note: "先补齐 Node.js 24 与 xterm，再 npm 全局安装，最后写入启动项。",
    hint: "多为网络受限（npm 源/NodeSource 不可达）或 Node 版本不足"
  },
  dsh_cli: {
    label: "DSH CLI",
    detect: "command -v dsh >/dev/null 2>&1",
    script: DSH_SCRIPT,
    note: "先补齐 Node.js 24 与 xterm，再 npm 全局安装 dsh。",
    hint: "多为网络受限（npm 源/NodeSource 不可达）或 Node 版本不足"
  }
};

function installTool(id, target) {
  const tool = TOOLS[id];
  if (!tool) {
    send(target, { t: "err", line: "未知工具: " + id });
    send(target, { t: "exit", code: -1 });
    return;
  }
  log("install tool: " + id);
  send(target, { t: "cmd", line: "wsl -d " + DISTRO + " -u root -- bash -lc '<安装 " + tool.label + " 的脚本>'" });
  send(target, { t: "info", line: tool.note });
  runWsl(["-d", DISTRO, "-u", "root", "--"].concat(bashB64(tool.script)), target, (code) => {
    send(target, { t: "exit", code: code });
    if (code === 0) {
      send(target, { t: "rescanned" });
    } else {
      send(target, { t: "hint", text: tool.label + " 安装失败：" + tool.hint, pkg: "" });
    }
  });
}

async function queryTools() {
  const ids = Object.keys(TOOLS);
  const script = ids.map((k) =>
    "if " + TOOLS[k].detect + "; then echo \"1 " + k + "\"; else echo \"0 " + k + "\"; fi"
  ).join("\n");
  const raw = await runWslCollect(script, 12000);
  const out = {};
  raw.split(/\r?\n/).forEach((line) => {
    const m = line.trim().match(/^([01])\s+(\S+)$/);
    if (m) { out[m[2]] = m[1] === "1"; }
  });
  return out;
}

// ---------------- IPC ----------------

ipcMain.handle("apps:list", async () => {
  const started = Date.now();
  const apps = scanApps();
  log("scan: " + apps.length + " apps in " + (Date.now() - started) + "ms");
  return { apps: apps, distro: DISTRO, version: APP_VERSION };
});

ipcMain.on("app:launch", (event, payload) => {
  launchApp(payload && payload.exec, event.sender);
});

ipcMain.on("app:selftest", (event) => {
  selftest(event.sender);
});

ipcMain.handle("shell:openWsl", async (event, rel) => {
  return openWslFolder(rel);
});

ipcMain.handle("apps:installed", async (event, pkgs) => {
  const installed = await queryInstalled(pkgs);
  return { installed: installed };
});

ipcMain.handle("tools:status", async () => {
  return { tools: await queryTools() };
});

ipcMain.handle("ime:status", async () => {
  return await queryIme();
});

ipcMain.handle("settings:get", async () => {
  return {
    scale: settings.scale,
    ime: settings.ime === "off" ? "off" : "auto",
    windowsScale: windowsScale(),
    effective: launchScale()
  };
});

ipcMain.handle("settings:set", async (event, payload) => {
  const scale = payload && payload.scale;
  if (typeof scale === "string" && (scale === "auto" || parseFloat(scale) > 0)) {
    settings.scale = scale;
    saveSettings();
    log("settings: scale=" + scale + " effective=" + launchScale());
  }
  const ime = payload && payload.ime;
  if (ime === "auto" || ime === "off") {
    settings.ime = ime;
    saveSettings();
    log("settings: ime=" + ime);
  }
  return {
    scale: settings.scale,
    ime: settings.ime === "off" ? "off" : "auto",
    windowsScale: windowsScale(),
    effective: launchScale()
  };
});

ipcMain.on("app:installIme", (event) => {
  installIme(event.sender);
});

ipcMain.on("app:installTool", (event, payload) => {
  installTool(payload && payload.id, event.sender);
});

ipcMain.on("app:install", (event, payload) => {
  installPkg(payload && payload.pkg, event.sender);
});

ipcMain.handle("clipboard:write", (event, text) => {
  clipboard.writeText(String(text || ""));
  return true;
});

// ---------------- app lifecycle ----------------

// Screenshot smoke tests must not be blocked by a running instance.
const TEST_RUN = !!process.env.WSL_LAUNCHER_SHOT;

if (!TEST_RUN && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) { win.restore(); }
      win.focus();
    }
  });

  app.whenReady().then(() => {
    log("app ready, exe=" + process.execPath);
    loadSettings();
    log("settings scale=" + settings.scale + " windows=" + windowsScale());
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) { createWindow(); }
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
