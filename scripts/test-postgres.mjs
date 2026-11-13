import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "spiderman-pg-")),
  data = join(root, "data"),
  socket = join(root, "socket");
mkdirSync(socket, { mode: 0o700 });
const bin =
  process.env.PG_BINDIR ??
  execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
let started = false;
try {
  execFileSync(
    join(bin, "initdb"),
    [
      "-D",
      data,
      "-U",
      "spidertest",
      "--auth-local=trust",
      "--auth-host=reject",
      "--no-locale",
      "--encoding=UTF8",
    ],
    { stdio: "pipe" },
  );
  execFileSync(
    join(bin, "pg_ctl"),
    [
      "-D",
      data,
      "-l",
      join(root, "postgres.log"),
      "-w",
      "start",
      "-o",
      `-k ${socket} -h '' -p 55439`,
    ],
    { stdio: "pipe" },
  );
  started = true;
  const result = spawnSync(
    process.execPath,
    ["--test", "tests/postgres.test.mjs"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        SPIDERMAN_TEST_DATABASE_URL: `postgresql://spidertest@localhost/postgres?host=${encodeURIComponent(socket)}&port=55439`,
      },
    },
  );
  process.exitCode = result.status ?? 1;
} catch (error) {
  process.stderr.write(
    "Native PostgreSQL test could not start: " + error.message + "\n",
  );
  try {
    process.stderr.write(readFileSync(join(root, "postgres.log"), "utf8"));
  } catch {}
  process.exitCode = 1;
} finally {
  if (started)
    execFileSync(
      join(bin, "pg_ctl"),
      ["-D", data, "-m", "immediate", "-w", "stop"],
      { stdio: "pipe" },
    );
  rmSync(root, { recursive: true, force: true });
}
