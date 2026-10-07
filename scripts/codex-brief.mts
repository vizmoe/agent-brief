#!/usr/bin/env node
import { main } from "../adapters/codex/runtime.mts";
process.exitCode = await main();
