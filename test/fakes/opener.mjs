#!/usr/bin/env node
/** Fake URL opener for tests: records the URL in FAKE_OPENER_LOG. */
import { appendFileSync } from "node:fs";

if (process.env.FAKE_OPENER_LOG) {
  appendFileSync(process.env.FAKE_OPENER_LOG, `${process.argv[2] ?? ""}\n`);
}
process.exit(Number(process.env.FAKE_OPENER_EXIT ?? "0"));
