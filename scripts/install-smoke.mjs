import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const files = JSON.parse(
  readFileSync("artifacts/packages/manifest.json", "utf8"),
).packages.map((p) => resolve("artifacts/packages", p.file));
const temp = mkdtempSync(join(tmpdir(), "spiderman-install-"));
try {
  writeFileSync(
    join(temp, "package.json"),
    JSON.stringify({
      name: "spiderman-install-smoke",
      private: true,
      type: "module",
    }),
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...files],
    { cwd: temp, stdio: "pipe" },
  );
  const result = execFileSync(
    process.execPath,
    ["node_modules/@splitin/spiderman-cli/dist/index.js", "help"],
    { cwd: temp, encoding: "utf8" },
  );
  if (JSON.parse(result).name !== "spiderman")
    throw Error("installed_cli_failed");
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import {Engine} from '@splitin/spiderman-core';import {SqliteStore} from '@splitin/spiderman-store-sqlite';const s=new SqliteStore(':memory:');await s.transaction(tx=>tx.put('test','id','owner',{ok:true}));await s.close();",
    ],
    { cwd: temp, stdio: "pipe" },
  );
  console.log(
    "All npm tarballs installed together in a clean directory; installed CLI and SQLite core passed.",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
