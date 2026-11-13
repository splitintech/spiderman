import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")),
  dependencies = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.includes("node_modules/") || entry.link) continue;
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path + "/package.json", "utf8"));
  } catch {
    pkg = entry;
  }
  dependencies.push({
    name: pkg.name ?? path.split("node_modules/").at(-1),
    version: entry.version,
    license: pkg.license ?? "REVIEW_REQUIRED",
    path,
    dev: !!entry.dev,
    optional: !!entry.optional,
  });
}
mkdirSync("artifacts", { recursive: true });
writeFileSync(
  "artifacts/dependency-licenses.json",
  JSON.stringify({ dependencies }, null, 2) + "\n",
);
console.log(
  `Recorded ${dependencies.length} dependency licenses; review artifacts/dependency-licenses.json before release.`,
);
