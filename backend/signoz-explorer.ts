
import {
  getConfig,
  runRawTraceQuerySafe,
  SERVICE_ATTRIBUTE,
  ROUTE_ATTRIBUTE,
  SEMCONV,
  DURATION_ATTRIBUTE,
} from "./src/services/signoz.service.js";

const DEFAULT_WINDOW_MINUTES = 60 * 24; // last 24h — services list needs a wide net

async function listServices(start: number, end: number): Promise<unknown> {
  const { baseUrl, apiKey } = getConfig();

  const body = {
    start,
    end,
    requestType: "scalar",
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "traces",
            aggregations: [{ expression: "count()", alias: "span_count" }],
            groupBy: [{ name: SERVICE_ATTRIBUTE }],
            filter: { expression: `${SERVICE_ATTRIBUTE} EXISTS` },
            disabled: false,
          },
        },
      ],
    },
  };

  console.log("[explorer] POST /api/v5/query_range (groupBy service.name)");
  console.log(
    "[explorer] window:",
    new Date(start).toISOString(),
    "..",
    new Date(end).toISOString(),
  );

  const res = await fetch(`${baseUrl}/api/v5/query_range`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "SIGNOZ-API-KEY": apiKey },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();

  if (!res.ok) {
    console.error(
      `[explorer] service list FAILED (${res.status}):`,
      rawText.slice(0, 1000),
    );
    throw new Error(`SigNoz API error (${res.status})`);
  }

  return JSON.parse(rawText);
}

// Pulls unique service.name-ish string values out of whatever shape the
// groupBy response comes back in, without assuming the exact structure.
function extractServiceNames(
  node: unknown,
  found: Set<string> = new Set(),
): Set<string> {
  if (node === null || node === undefined) return found;

  if (Array.isArray(node)) {
    for (const item of node) extractServiceNames(item, found);
    return found;
  }

  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (
        key.toLowerCase().includes("service") &&
        typeof value === "string" &&
        value.length > 0
      ) {
        found.add(value);
      }
      extractServiceNames(value, found);
    }
  }

  return found;
}

function printFieldNames(node: unknown, label: string) {
  const keys = new Set<string>();

  function walk(n: unknown) {
    if (n === null || n === undefined) return;
    if (Array.isArray(n)) {
      for (const item of n) walk(item);
      return;
    }
    if (typeof n === "object") {
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        keys.add(k);
        walk(v);
      }
    }
  }

  walk(node);
  console.log(`\n[explorer] all keys seen anywhere in ${label} response:`);
  console.log([...keys].sort().join(", "));
}

async function main() {
  const [, , serviceArg, limitArg] = process.argv;
  const end = Date.now();
  const start = end - DEFAULT_WINDOW_MINUTES * 60 * 1000;

  if (!serviceArg) {
    console.log("=== Services ===\n");
    const raw = await listServices(start, end);
    console.log("\n[explorer] RAW response:\n", JSON.stringify(raw, null, 2));

    const services = extractServiceNames(raw);
    printFieldNames(raw, "service list");

    console.log("\n[explorer] service.name values found:");
    if (services.size === 0) {
      console.log(
        "  (none — check SERVICE_ATTRIBUTE, or widen the time window)",
      );
    } else {
      for (const s of services) console.log(" -", s);
    }

    console.log("\nRun again with a service name to dump raw traces for it:");
    console.log("  npx tsx signoz-explorer.ts <serviceName>");
    return;
  }

  const limit = limitArg ? Number(limitArg) : 5;
  console.log(`=== Raw traces for "${serviceArg}" (limit ${limit}) ===\n`);

  const warnings: string[] = [];
  const escapedService = serviceArg.replace(/'/g, "\\'");

  const raw = await runRawTraceQuerySafe(
    start,
    end,
    `${SERVICE_ATTRIBUTE} = '${escapedService}' AND ${ROUTE_ATTRIBUTE} EXISTS`,
    [
      "traceID",
      "spanID",
      SEMCONV.method,
      ROUTE_ATTRIBUTE,
      DURATION_ATTRIBUTE,
      "hasError",
      "timestamp",
    ],
    limit,
    "explorer raw trace dump",
    warnings,
  );

  if (raw === null) {
    console.error("[explorer] query failed:", warnings);
    process.exitCode = 1;
    return;
  }

  console.log("\n[explorer] RAW response:\n", JSON.stringify(raw, null, 2));
  printFieldNames(raw, "raw trace list");

  if (warnings.length > 0) {
    console.warn("\n[explorer] warnings:", warnings);
  }

  console.log(
    "\nNext step: compare the field names above against what extractRows()/pick() in " +
      "observability.service.ts expect (traceid, durationnano, haserror, route, method, timestamp). " +
      "Adjust the hint strings there to match exactly.",
  );
}

main().catch((err) => {
  console.error("[explorer] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
