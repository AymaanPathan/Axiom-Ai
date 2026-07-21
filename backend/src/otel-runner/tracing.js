"use strict";

const { diag, DiagConsoleLogger, DiagLogLevel } = require("@opentelemetry/api");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const {
  getNodeAutoInstrumentations,
} = require("@opentelemetry/auto-instrumentations-node");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-http");
const { Resource } = require("@opentelemetry/resources");
const { ATTR_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");

// Surface real SDK internals (span creation, batching, export attempts and
// failures) in stdout — normally silent, and that silence is exactly why
// we couldn't tell whether exports were failing.
if (process.env.OTEL_LOG_LEVEL === "debug") {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
  "http://host.docker.internal:4318/v1/traces";
const serviceName = process.env.OTEL_SERVICE_NAME || "axiom-unknown-service";

const sdk = new NodeSDK({
  resource: new Resource({ [ATTR_SERVICE_NAME]: serviceName }),
  traceExporter: new OTLPTraceExporter({ url: endpoint }),
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ],
});

sdk.start();
console.log(`✅ OpenTelemetry initialized for "${serviceName}" -> ${endpoint}`);

process.on("SIGTERM", async () => {
  try {
    await sdk.shutdown();
  } finally {
    process.exit(0);
  }
});
