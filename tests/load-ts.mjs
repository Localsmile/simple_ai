import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const nativeRequire = createRequire(import.meta.url);

export function loadTs(entry, globals = {}) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const source = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const require = (name) => name.startsWith(".")
      ? load(resolve(dirname(filename), `${name.replace(/\.ts$/, "")}.ts`)) : nativeRequire(name);
    // Only trusted project modules are evaluated; each test gets isolated mocks.
    new Function("require", "module", "exports", ...Object.keys(globals), source)(
      require, module, module.exports, ...Object.values(globals),
    );
    return module.exports;
  }
  return load(resolve(root, entry));
}

export function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}
