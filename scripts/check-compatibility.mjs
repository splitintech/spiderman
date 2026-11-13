import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const before = JSON.parse(
    readFileSync("contracts/baselines/v1-alpha.1.json", "utf8"),
  ),
  after = JSON.parse(readFileSync("contracts/openapi.json", "utf8"));
const generalized = (path) => path.replace(/\{\w+\}/g, "{}");
for (const [path, methods] of Object.entries(before.paths))
  for (const method of Object.keys(methods)) {
    const found = Object.entries(after.paths).find(
      ([candidate]) =>
        generalized(candidate) === generalized(path) ||
        new RegExp("^" + candidate.replace(/\{\w+\}/g, "[^/]+") + "$").test(
          path,
        ),
    );
    assert.ok(found?.[1][method], `removed route ${method} ${path}`);
  }
function compatible(old, next, path) {
  if (old.type) assert.equal(next.type, old.type, "changed type " + path);
  for (const required of next.required ?? [])
    assert.ok(
      (old.required ?? []).includes(required),
      "new required field " + path + "." + required,
    );
  if (old.enum)
    for (const value of old.enum)
      assert.ok(next.enum?.includes(value), "removed enum " + path);
  for (const [key, value] of Object.entries(old.properties ?? {})) {
    assert.ok(next.properties?.[key], "removed property " + path + "." + key);
    compatible(value, next.properties[key], path + "." + key);
  }
  if (old.items && next.items) compatible(old.items, next.items, path + "[]");
}
for (const name of [
  "ActionRequest",
  "ConnectionInput",
  "PolicyInput",
  "ActionState",
])
  compatible(
    before.components.schemas[name],
    after.components.schemas[name],
    name,
  );
// Every emitted local reference must resolve in the generated document.
function refs(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "$ref" && item.startsWith("#/")) {
      let target = after;
      for (const part of item.slice(2).split("/")) target = target?.[part];
      assert.ok(target, "unresolved OpenAPI reference " + item);
    } else refs(item);
  }
}
refs(after);
console.log(
  "Existing v1 request shapes/routes retained; generated OpenAPI references resolve. Provider alpha changes are documented separately.",
);
