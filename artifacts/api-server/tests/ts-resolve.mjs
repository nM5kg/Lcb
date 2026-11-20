// Test-only ESM resolve hook: lets `node --test` run .ts tests that import
// src modules with the repo's extensionless import style
// (e.g. "./hebrew-calendar" -> "./hebrew-calendar.ts").
// Node's built-in type stripping requires an explicit extension on relative
// imports; this hook appends ".ts" when the extensionless path resolves to
// a .ts file. It never touches production code.
//
// Run: node --test --import ./tests/register-ts-resolve.mjs tests/*.test.ts
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !/\.[a-zA-Z0-9]+$/.test(specifier)
  ) {
    const base = fileURLToPath(new URL(specifier, context.parentURL));
    const fileCandidate = base + ".ts";
    if (existsSync(fileCandidate)) {
      return { url: pathToFileURL(fileCandidate).href, shortCircuit: true };
    }
    // Directory import ("./schema" -> "./schema/index.ts"), used by
    // @workspace/db and needed to import the IVR engine (phoneTree,
    // menuPrompt) in tests. Node ESM does not resolve these on its own.
    if (existsSync(base) && existsSync(base + "/index.ts")) {
      return { url: pathToFileURL(base + "/index.ts").href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
