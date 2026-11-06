#!/usr/bin/env node
// Thin launcher: registers tsx so the TypeScript sources run directly.
import { register } from "tsx/esm/api";
register();
await import("../src/cli.ts");
