const fs = require("fs");
const path = require("path");

// Pull the heredoc body out of an already-generated installer script, then mimic
// exactly what scan.js + main.js do with the Exec line, to make sure the quoting
// survives the trip (.desktop -> scan -> tokenize -> wsl argv).
function extractDesktop(shFile) {
  const lines = fs.readFileSync(shFile, "utf8").split("\n");
  const start = lines.findIndex((l) => l.indexOf("<<'DESKTOP'") >= 0);
  if (start < 0) { throw new Error("heredoc start not found in " + shFile); }
  const end = lines.indexOf("DESKTOP", start);
  return lines.slice(start + 1, end);
}

// same parser as main.js
function tokenize(s) {
  const out = [];
  let cur = "";
  let inQ = false;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '"') { inQ = !inQ; started = true; continue; }
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

let bad = 0;
for (const name of ["CODEX", "DSH"]) {
  const shFile = path.join(__dirname, "_" + name + "_SCRIPT.sh");
  const body = extractDesktop(shFile);
  const text = body.join("\n");

  const execRaw = (text.match(/^Exec=(.*)$/m) || [])[1] || "";
  // scan.js line: strip field codes and collapse whitespace
  const exec = execRaw.replace(/%[a-zA-Z]/g, "").replace(/\s+/g, " ").trim();
  const argv = tokenize(exec);

  console.log("=== " + name + " ===");
  console.log("raw Exec : " + execRaw);
  console.log("argv     : " + JSON.stringify(argv, null, 0));
  console.log("argv len : " + argv.length);

  const need = ["xterm", "-e", "bash", "-lc"];
  const missing = need.filter((x) => argv.indexOf(x) < 0);
  // the shell payload must be ONE argument containing the command
  const payload = argv[argv.length - 1] || "";
  const payloadOk = argv.length >= 6 && payload.indexOf("exec bash") >= 0 &&
    argv[argv.length - 2] === "-lc";
  const ok = missing.length === 0 && payloadOk;
  if (!ok) { bad++; }
  console.log("verdict  : " + (ok ? "OK" : "FAIL") +
    (missing.length ? "  missing=" + missing.join(",") : "") +
    (payloadOk ? "" : "  payload-not-single-arg"));
  console.log("payload  : " + payload);
  console.log("");
}

process.exit(bad ? 1 : 0);
