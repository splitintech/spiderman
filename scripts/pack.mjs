import { execFileSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  cpSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
mkdirSync("artifacts/packages", { recursive: true });
const output = resolve("artifacts/packages"),
  manifest = [];
const directories = readdirSync("packages").map((name) =>
  resolve("packages", name),
);
const packages = new Map(
  directories.map((path) => {
    const metadata = JSON.parse(
      readFileSync(join(path, "package.json"), "utf8"),
    );
    return [metadata.name, { path, metadata }];
  }),
);
function closure(name, result = new Set()) {
  for (const dep of Object.keys(packages.get(name).metadata.dependencies ?? {}))
    if (packages.has(dep) && !result.has(dep)) {
      result.add(dep);
      closure(dep, result);
    }
  return result;
}
function copyPackage(name, target) {
  const { path, metadata } = packages.get(name);
  mkdirSync(target, { recursive: true });
  for (const entry of [
    "dist",
    "README.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ])
    cpSync(join(path, entry), join(target, entry), { recursive: true });
  writeFileSync(
    join(target, "package.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
}
for (const [name, { metadata }] of packages) {
  const temp = mkdtempSync(join(tmpdir(), "spiderman-package-"));
  try {
    copyPackage(name, temp);
    const internal = [...closure(name)];
    for (const dep of internal)
      copyPackage(dep, join(temp, "node_modules", ...dep.split("/")));
    const dependencies = { ...metadata.dependencies };
    for (const dep of internal)
      for (const [external, version] of Object.entries(
        packages.get(dep).metadata.dependencies ?? {},
      ))
        if (!packages.has(external)) {
          if (dependencies[external] && dependencies[external] !== version)
            throw Error("dependency_version_conflict:" + external);
          dependencies[external] = version;
        }
    writeFileSync(
      join(temp, "package.json"),
      JSON.stringify(
        { ...metadata, dependencies, bundledDependencies: internal },
        null,
        2,
      ) + "\n",
    );
    const result = JSON.parse(
      execFileSync(
        "npm",
        [
          "pack",
          "--offline",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          output,
        ],
        {
          cwd: temp,
          encoding: "utf8",
          env: {
            ...process.env,
            npm_config_cache:
              process.env.npm_config_cache ?? "/tmp/spiderman-npm-cache",
          },
        },
      ),
    )[0];
    manifest.push({
      name: metadata.name,
      version: metadata.version,
      file: result.filename,
      bundled: internal,
      sha256: createHash("sha256")
        .update(readFileSync(join(output, result.filename)))
        .digest("hex"),
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
writeFileSync(
  join(output, "manifest.json"),
  JSON.stringify({ schemaVersion: 1, source: {
    commit: execFileSync("git", ["rev-parse", "HEAD"], {encoding:"utf8"}).trim(),
    dirty: !!execFileSync("git", ["status", "--porcelain"], {encoding:"utf8"}).trim(),
  }, packages: manifest }, null, 2) + "\n",
);
console.log(
  `Packed ${manifest.length} modules with complete internal dependency closures.`,
);
