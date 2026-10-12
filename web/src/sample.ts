import data from "../../examples/sample-report.json" with { type: "json" };
import type { Report } from "./types.ts";

/** The bundled demo: an AI-written "partial refunds" PR (see examples/). */
export const sample = data as unknown as Report;
