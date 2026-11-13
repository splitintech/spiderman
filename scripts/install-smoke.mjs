import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const entries = JSON.parse(
  readFileSync("artifacts/packages/manifest.json", "utf8"),
).packages;
for (const entry of entries) {
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
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        resolve("artifacts/packages", entry.file),
      ],
      { cwd: temp, stdio: "pipe", timeout: 120000 },
    );
    if (entry.name.endsWith("-cli")) {
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          ["node_modules/@splitin/spiderman-cli/dist/index.js", "help"],
          { cwd: temp, encoding: "utf8" },
        ),
      );
      if (result.name !== "spiderman") throw Error("installed_cli_failed");
    } else
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(entry.name)});`,
        ],
        { cwd: temp, stdio: "pipe" },
      );
    if (
      [
        "@splitin/spiderman-mail-mime",
        "@splitin/spiderman-oauth-loopback",
      ].includes(entry.name)
    )
      execFileSync(
        process.execPath,
        ["-e", `require(${JSON.stringify(entry.name)});`],
        { cwd: temp, stdio: "pipe" },
      );
    console.log(entry.name + ": independent installation passed");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
console.log(
  `All ${entries.length} modules installed independently; no other Spiderman tarball was preinstalled.`,
);
