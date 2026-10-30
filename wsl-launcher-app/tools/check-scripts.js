const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const src = fs.readFileSync("main.js", "utf8");

function grab(name) {
  const start = src.indexOf("const " + name + " = [");
  if (start < 0) { throw new Error("not found: " + name); }
  const marker = '].join("\\n");';
  const end = src.indexOf(marker, start);
  if (end < 0) { throw new Error("end marker not found: " + name); }
  return src.slice(start, end + marker.length);
}

const code = [
  grab("NODE_BOOTSTRAP"),
  grab("CODEX_SCRIPT"),
  grab("DSH_SCRIPT"),
  "module.exports = { NODE_BOOTSTRAP, CODEX_SCRIPT, DSH_SCRIPT };"
].join("\n");

fs.writeFileSync("tools/_extract.js", code);
const mod = require(path.join(__dirname, "_extract.js"));

let bad = 0;
for (const name of Object.keys(mod)) {
  const text = mod[name];
  const f = "tools/_" + name + ".sh";
  fs.writeFileSync(f, text, "utf8");
  const r = spawnSync("bash", ["-n", f], { encoding: "utf8" });
  const ok = r.status === 0;
  if (!ok) { bad++; }
  console.log(name.padEnd(15) + " lines=" + String(text.split("\n").length).padStart(3) +
    "  syntax=" + (ok ? "OK" : "FAIL"));
  if (!ok) { console.log((r.stderr || "").slice(0, 500)); }
}

console.log("--- CODEX_SCRIPT tail ---");
console.log(mod.CODEX_SCRIPT.split("\n").slice(-8).join("\n"));
console.log("--- DSH_SCRIPT desktop block ---");
const dshLines = mod.DSH_SCRIPT.split("\n");
const i = dshLines.findIndex((l) => l.indexOf("dsh.desktop") >= 0);
console.log(dshLines.slice(i, i + 10).join("\n"));

process.exit(bad ? 1 : 0);
