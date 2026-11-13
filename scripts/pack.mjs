import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
mkdirSync("artifacts/packages", { recursive: true });
const output = resolve("artifacts/packages"),
  manifest = [];
for (const name of readdirSync("packages")) {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", output, "./packages/" + name],
      {
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
    name: packed.name,
    version: packed.version,
    file: packed.filename,
    sha256: createHash("sha256")
      .update(readFileSync(output + "/" + packed.filename))
      .digest("hex"),
  });
}
writeFileSync(
  output + "/manifest.json",
  JSON.stringify({ schemaVersion: 1, packages: manifest }, null, 2) + "\n",
);
console.log(
  `Packed ${manifest.length} separately installable npm modules into artifacts/packages.`,
);
