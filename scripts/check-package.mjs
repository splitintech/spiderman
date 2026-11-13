import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { join } from "node:path";
const packages = readdirSync("packages").map((name) => join("packages", name));
const names = new Set(
  packages.map(
    (path) => JSON.parse(readFileSync(join(path, "package.json"), "utf8")).name,
  ),
);
for (const path of packages) {
  const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.publishConfig.access, "public");
  for (const name of [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "README.md",
    "dist/index.js",
    "dist/index.d.ts",
  ])
    assert.ok(existsSync(join(path, name)), path + "/" + name);
  for (const [name, version] of Object.entries(manifest.dependencies ?? {}))
    if (names.has(name))
      assert.equal(version, manifest.version, "internal dependency mismatch");
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--offline", "--ignore-scripts", "--dry-run", "--json", "./" + path], {
      encoding: "utf8",
      timeout: 30000,
      env: {
        ...process.env,
        npm_config_cache:
          process.env.npm_config_cache ?? "/tmp/spiderman-npm-cache",
      },
    }),
  )[0];
  for (const { path: file } of packed.files)
    assert.ok(
      /^(dist\/[\w./-]+\.(?:js|d\.ts)|README\.md|LICENSE|THIRD_PARTY_NOTICES\.md|package\.json)$/.test(
        file,
      ),
      "unexpected packaged file: " + file,
    );
  if (path.includes("/provider-"))
    for (const source of readdirSync(join(path, "src")).filter((f) =>
      f.endsWith(".ts"),
    )) {
      const text = readFileSync(join(path, "src", source), "utf8");
      assert.ok(
        !/@splitin\/spiderman-(?:server|cli|mcp|store-)/.test(text),
        "provider boundary violation",
      );
    }
}
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const forbidden = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /AKIA[A-Z0-9]{16}/,
  /\/Users\/[\w.-]+\//,
];
for (const file of files) {
  if (!/\.(?:ts|mjs|py|json|md|yml|yaml|txt)$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const expression of forbidden)
    assert.ok(
      !expression.test(text),
      "secret/private path signature in " + file,
    );
}
console.log(
  `Inspected ${packages.length} package manifests and archives; source signatures and provider boundaries passed.`,
);
