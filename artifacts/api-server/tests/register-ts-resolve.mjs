// Entry point for the test-only resolve hook (see ts-resolve.mjs).
// Run: node --test --import ./tests/register-ts-resolve.mjs tests/*.test.ts
import { register } from "node:module";

register("./ts-resolve.mjs", import.meta.url);
