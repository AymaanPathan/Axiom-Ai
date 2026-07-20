// src/services/signoz.service.ts
import { signozClient } from "../config/signoz.js";

export interface RouteStat {
  route: string;
  requests: number;
  p50: number;
  p99: number;
  errors: number;
}

function lastMinutesRange(minutes: number) {
  const end = Date.now();
  return { start: end - minutes * 60 * 1000, end };
}

const nanoToMs = (v: unknown) => Math.round((Number(v) || 0) / 1_000_000);

// SigNoz doesn't publish a formal response schema, so this is defensive.
// First call: console.log(JSON.stringify(data)) once and adjust extractRows if the keys differ.
function extractRows(payload: any): any[] {
  const result = payload?.data?.result?.[0];
  return result?.table?.rows ?? result?.list ?? result?.series ?? [];
}

export async function hasRecentTraffic(
  serviceName: string,
  lookbackMinutes = 5,
) {
  const { start, end } = lastMinutesRange(lookbackMinutes);
  const { data } = await signozClient.post("/api/v5/query_range", {
    start,
    end,
    requestType: "raw",
    variables: {},
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "traces",
            filter: {
              expression: `serviceName = '${serviceName}' AND parentSpanID = ''`,
            },
            selectFields: [{ name: "serviceName" }],
            order: [{ key: { name: "timestamp" }, direction: "desc" }],
            limit: 1,
            offset: 0,
            disabled: false,
          },
        },
      ],
    },
  });
  return extractRows(data).length > 0;
}

export async function getRouteStats(
  serviceName: string,
  lookbackMinutes = 15,
): Promise<RouteStat[]> {
  const { start, end } = lastMinutesRange(lookbackMinutes);
  const base = {
    start,
    end,
    requestType: "scalar" as const,
    variables: {},
  };

  const [latencyRes, errorRes] = await Promise.all([
    signozClient.post("/api/v5/query_range", {
      ...base,
      compositeQuery: {
        queries: [
          {
            type: "builder_query",
            spec: {
              name: "A",
              signal: "traces",
              aggregations: [
                { expression: "count()", alias: "requests" },
                { expression: "p50(duration_nano)", alias: "p50" },
                { expression: "p99(duration_nano)", alias: "p99" },
              ],
              filter: {
                expression: `serviceName = '${serviceName}' AND parentSpanID = ''`,
              },
              groupBy: [{ name: "http.route" }],
              order: [{ key: { name: "requests" }, direction: "desc" }],
              disabled: false,
            },
          },
        ],
      },
    }),
    signozClient.post("/api/v5/query_range", {
      ...base,
      compositeQuery: {
        queries: [
          {
            type: "builder_query",
            spec: {
              name: "A",
              signal: "traces",
              aggregations: [{ expression: "count()", alias: "errors" }],
              filter: {
                expression: `serviceName = '${serviceName}' AND parentSpanID = '' AND hasError = true`,
              },
              groupBy: [{ name: "http.route" }],
              disabled: false,
            },
          },
        ],
      },
    }),
  ]);

  const errorsByRoute = new Map<string, number>();
  for (const row of extractRows(errorRes.data)) {
    errorsByRoute.set(row["http.route"] ?? "unknown", Number(row.errors ?? 0));
  }

  return extractRows(latencyRes.data).map((row) => {
    const route = row["http.route"] ?? "unknown";
    return {
      route,
      requests: Number(row.requests ?? 0),
      p50: nanoToMs(row.p50),
      p99: nanoToMs(row.p99),
      errors: errorsByRoute.get(route) ?? 0,
    };
  });
}
