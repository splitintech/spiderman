import { execFileSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  readdirSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const manifest = JSON.parse(
  readFileSync("artifacts/packages/manifest.json", "utf8"),
);
for (const entry of manifest.packages) {
  const archive = resolve("artifacts/packages", entry.file);
  assert.equal(
    createHash("sha256").update(readFileSync(archive)).digest("hex"),
    entry.sha256,
  );
  const names = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n");
  for (const name of names)
    assert.match(
      name,
      /^package\/(?:node_modules\/@splitin\/spiderman-[a-z-]+\/)?(?:dist\/[a-zA-Z0-9_./-]+\.(?:js|cjs|d\.ts)|package\.json|README\.md|LICENSE|THIRD_PARTY_NOTICES\.md)$/,
      "unexpected archive entry: " + name,
    );
  const temp = mkdtempSync(join(tmpdir(), "spiderman-inspect-"));
  try {
    execFileSync("tar", ["-xzf", archive, "-C", temp]);
    const root = join(temp, "package");
    const packageJson = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    assert.equal(packageJson.name, entry.name);
    assert.equal(packageJson.version, entry.version);
    for (const bundled of entry.bundled) {
      const directory = join(root, "node_modules", bundled);
      for (const file of [
        "LICENSE",
        "THIRD_PARTY_NOTICES.md",
        "README.md",
        "package.json",
        "dist/index.js",
        "dist/index.d.ts",
      ])
        assert.ok(lstatSync(join(directory, file)).isFile());
    }
    const visit = (directory) => {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        assert.ok(!item.isSymbolicLink(), "archive symlink");
        if (item.isDirectory()) visit(path);
        else {
          const text = readFileSync(path, "utf8");
          for (const pattern of [
            /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
            /gh[pousr]_[A-Za-z0-9]{30,}/,
            /AKIA[A-Z0-9]{16}/,
            /\/Users\/[\w.-]+\//,
          ])
            assert.ok(!pattern.test(text), "sensitive signature in archive");
        }
      }
    };
    visit(root);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
console.log(
  `Inspected ${manifest.packages.length} distributable archives, bundled licenses, contents and digests.`,
);
