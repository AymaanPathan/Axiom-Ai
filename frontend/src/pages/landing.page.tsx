import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Highlight, themes } from "prism-react-renderer";
import {
  Sparkles,
  Loader2,
  Check,
  GitPullRequest,
  Cpu,
  MemoryStick,
  Activity,
} from "lucide-react";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import ConnectGithubButton from "../components/ConnectGithubButton";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { checkSession } from "../store/slices/authSlice";
import {
  SANS,
  BG,
  SURFACE,
  BORDER,
  BORDER_STRONG,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  TEXT_QUIET,
  ACCENT,
  ACCENT_HOVER,
  ACCENT_TEXT,
  LIVE,
  LIVE_SOFT,
  ERROR,
} from "../theme";


const NAV_LINKS = ["Product", "How it works", "Benchmarks", "Docs"];


const ADD_BG = "#0f2415";
const ADD_FG = "#7ee2a8";
const DEL_BG = "#2a1414";
const DEL_FG = "#f29b9b";
const HUNK_FG = "#6e6e6e";
const CTX_FG = "#b3b3b3";
const GUTTER_FG = "#5a5a58";
const DIFF_MONO = "'Berkeley Mono', ui-monospace, monospace";

const WINDOW_BG = "#111110";
const WINDOW_BORDER = "#26261f";
const TAB_BG = "#1a1a17";

type DiffRow = {
  type: "add" | "del" | "ctx" | "hunk" | "meta";
  content: string;
  oldLine: number | null;
  newLine: number | null;
};

function parseUnifiedDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNum = 0;
  let newNum = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNum = parseInt(m[1], 10);
        newNum = parseInt(m[2], 10);
      }
      rows.push({ type: "hunk", content: raw, oldLine: null, newLine: null });
    } else if (raw.startsWith("+++") || raw.startsWith("---")) {
      rows.push({ type: "meta", content: raw, oldLine: null, newLine: null });
    } else if (raw.startsWith("+")) {
      rows.push({
        type: "add",
        content: raw.slice(1),
        oldLine: null,
        newLine: newNum,
      });
      newNum++;
    } else if (raw.startsWith("-")) {
      rows.push({
        type: "del",
        content: raw.slice(1),
        oldLine: oldNum,
        newLine: null,
      });
      oldNum++;
    } else {
      rows.push({
        type: "ctx",
        content: raw.startsWith(" ") ? raw.slice(1) : raw,
        oldLine: oldNum,
        newLine: newNum,
      });
      oldNum++;
      newNum++;
    }
  }
  return rows;
}

function CodeWindowChrome({
  fileName,
  badge,
}: {
  fileName: string;
  badge?: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center justify-between border-b px-4 py-2.5"
      style={{ borderColor: WINDOW_BORDER, background: TAB_BG }}
    >
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: "#3a3a35" }}
          />
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: "#3a3a35" }}
          />
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: "#3a3a35" }}
          />
        </div>
        <span
          className="text-[12.5px]"
          style={{ fontFamily: DIFF_MONO, color: "#9a9a92" }}
        >
          {fileName}
        </span>
      </div>
      {badge}
    </div>
  );
}

function DiffViewer({
  fileName,
  unifiedDiff,
}: {
  fileName: string;
  unifiedDiff: string;
}) {
  const rows = parseUnifiedDiff(unifiedDiff);
  const additions = rows.filter((r) => r.type === "add").length;
  const deletions = rows.filter((r) => r.type === "del").length;

  return (
    <div
      className="overflow-hidden rounded-xl border shadow-[0_20px_60px_-20px_rgba(0,0,0,0.5)]"
      style={{ borderColor: WINDOW_BORDER, background: WINDOW_BG }}
    >
      <CodeWindowChrome
        fileName={fileName}
        badge={
          <div className="flex items-center gap-3">
            <span
              className="flex items-center gap-1.5 text-[11.5px] font-medium"
              style={{ fontFamily: DIFF_MONO }}
            >
              <span style={{ color: ADD_FG }}>+{additions}</span>
              <span style={{ color: DEL_FG }}>-{deletions}</span>
            </span>
            <span
              className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
              style={{ background: ACCENT, color: "#1a1400" }}
            >
              <Check size={11} /> Applied automatically
            </span>
          </div>
        }
      />
      <pre
        className="m-0 py-2"
        style={{
          fontFamily: DIFF_MONO,
          fontSize: 12.5,
          lineHeight: 1.7,
          overflow: "hidden",
        }}
      >
        {rows.map((row, i) => {
          let bg = "transparent";
          let color = CTX_FG;
          if (row.type === "hunk" || row.type === "meta") color = HUNK_FG;
          else if (row.type === "add") {
            bg = ADD_BG;
            color = ADD_FG;
          } else if (row.type === "del") {
            bg = DEL_BG;
            color = DEL_FG;
          }
          const showGutter =
            row.type === "add" || row.type === "del" || row.type === "ctx";
          return (
            <div key={i} style={{ background: bg, display: "flex" }}>
              {showGutter && (
                <span
                  className="flex shrink-0 select-none"
                  style={{ fontSize: 11.5, color: GUTTER_FG }}
                >
                  <span
                    style={{ width: 32, textAlign: "right", paddingRight: 8 }}
                  >
                    {row.oldLine ?? ""}
                  </span>
                  <span
                    style={{ width: 32, textAlign: "right", paddingRight: 12 }}
                  >
                    {row.newLine ?? ""}
                  </span>
                </span>
              )}
              <span
                style={{
                  color,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  paddingRight: 20,
                  paddingLeft: showGutter ? 0 : 16,
                }}
              >
                {row.content || " "}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

const WINNING_DIFF = `--- a/src/routes/orders.ts
+++ b/src/routes/orders.ts
@@ -12,15 +12,14 @@ router.post("/checkout", async (req, res) => {
   const cart = await Cart.findById(req.body.cartId);
-  const items = [];
-  for (const line of cart.lines) {
-    const product = await Product.findById(line.productId);
-    items.push({ ...line, product });
-  }
+  const productIds = cart.lines.map((line) => line.productId);
+  const products = await Product.find({ _id: { $in: productIds } }).lean();
+  const byId = new Map(products.map((p) => [p._id.toString(), p]));
+  const items = cart.lines.map((line) => ({
+    ...line,
+    product: byId.get(line.productId.toString()),
+  }));
 
-  const inventory = await checkInventory(items);
-  const payment = await chargeCard(req.body.token, cart.total);
+  const [inventory, payment] = await Promise.all([
+    checkInventory(items),
+    chargeCard(req.body.token, cart.total),
+  ]);
`;


const DEMO_SCRIPT = `import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 100,
  duration: "30s",
};

export default function () {
  const productId = Math.ceil(Math.random() * 200);
  const res = http.post(
    \`\${__ENV.BASE_URL}/checkout\`,
    JSON.stringify({ cartId: "cart_demo", productId }),
    { headers: { "Content-Type": "application/json" } },
  );

  check(res, {
    "status is 200": (r) => r.status === 200,
    "latency < 800ms": (r) => r.timings.duration < 800,
  });

  sleep(1);
}`;

const DEMO_SCENARIO =
  "100 concurrent users checking out with random products for 30 seconds.";

function ScriptDemo() {
  const [state, setState] = useState<"idle" | "generating" | "done">("idle");

  const handleGenerate = () => {
    setState("generating");
    window.setTimeout(() => setState("done"), 900);
  };

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 lg:items-start">
      <div
        className="rounded-2xl border p-6"
        style={{ borderColor: BORDER, background: SURFACE }}
      >
        <div className="mb-3 flex items-center gap-2">
          <Sparkles size={15} style={{ color: ACCENT_TEXT }} />
          <span
            className="text-[13px] font-semibold"
            style={{ color: TEXT_PRIMARY }}
          >
            Describe a load-test scenario
          </span>
        </div>
        <textarea
          value={DEMO_SCENARIO}
          readOnly
          spellCheck={false}
          rows={3}
          className="w-full resize-none rounded-lg border bg-transparent p-3 text-[14px] leading-[1.55] outline-none"
          style={{
            borderColor: BORDER_STRONG,
            color: TEXT_PRIMARY,
            cursor: "default",
          }}
        />
        <button
          onClick={handleGenerate}
          disabled={state === "generating"}
          className="mt-4 flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold transition-colors disabled:opacity-40"
          style={{ background: ACCENT, color: "#1a1400" }}
        >
          {state === "generating" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Sparkles size={14} />
          )}
          {state === "generating" ? "Writing script…" : "Generate script"}
        </button>
        <p
          className="mt-4 text-[13px] leading-[1.6]"
          style={{ color: TEXT_TERTIARY }}
        >
          This is the same generator running inside the product plain English
          in, a runnable k6 script out, wired to the exact route you're
          diagnosing.
        </p>
      </div>

      <div
        className="overflow-hidden rounded-xl border transition-opacity duration-300"
        style={{
          borderColor: WINDOW_BORDER,
          background: WINDOW_BG,
          opacity: state === "done" ? 1 : 0.4,
        }}
      >
        <CodeWindowChrome fileName="checkout-load.k6.js" />
        {state === "done" ? (
          <Highlight
            code={DEMO_SCRIPT}
            language="javascript"
            theme={themes.vsDark}
          >
            {({ className, tokens, getLineProps, getTokenProps }) => (
              <pre
                className={className}
                style={{
                  margin: 0,
                  padding: "14px 16px",
                  background: "transparent",
                  fontFamily: DIFF_MONO,
                  fontSize: 12.5,
                  lineHeight: 1.7,
                  overflow: "auto",
                }}
              >
                {tokens.map((line, i) => (
                  <div key={i} {...getLineProps({ line })}>
                    {line.map((token, key) => (
                      <span key={key} {...getTokenProps({ token })} />
                    ))}
                  </div>
                ))}
              </pre>
            )}
          </Highlight>
        ) : (
          <div
            className="flex h-[220px] items-center justify-center text-[13px]"
            style={{ color: "#6b6b64" }}
          >
            {state === "generating"
              ? "Writing script…"
              : "Waiting on a scenario"}
          </div>
        )}
      </div>
    </div>
  );
}


interface TelemetryTick {
  t: number;
  cpu: number;
  memory: number;
  p50: number;
  p95: number;
}

function useLiveTelemetry() {
  const [history, setHistory] = useState<TelemetryTick[]>([]);
  const stateRef = useRef({ cpu: 34, memory: 310, p50: 68, p95: 142 });

  useEffect(() => {
    const step = () => {
      const s = stateRef.current;
      s.cpu = Math.min(92, Math.max(18, s.cpu + (Math.random() - 0.5) * 10));
      s.memory = Math.min(
        560,
        Math.max(260, s.memory + (Math.random() - 0.5) * 24),
      );
      s.p50 = Math.min(140, Math.max(38, s.p50 + (Math.random() - 0.5) * 12));
      s.p95 = Math.min(
        320,
        Math.max(s.p50 + 30, s.p95 + (Math.random() - 0.5) * 22),
      );
      setHistory((prev) =>
        [
          ...prev,
          {
            t: Date.now(),
            cpu: s.cpu,
            memory: s.memory,
            p50: s.p50,
            p95: s.p95,
          },
        ].slice(-24),
      );
    };
    step();
    const id = window.setInterval(step, 1400);
    return () => window.clearInterval(id);
  }, []);

  return history;
}

function LiveStat({
  icon: Icon,
  label,
  value,
  alert,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <div
      className="rounded-xl border px-4 py-3"
      style={{ borderColor: BORDER_STRONG, background: BG }}
    >
      <div
        className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.06em]"
        style={{ color: TEXT_QUIET }}
      >
        <Icon size={11} />
        {label}
      </div>
      <div
        className="mt-1.5 flex items-center gap-1.5 text-[18px] font-semibold"
        style={{
          color: TEXT_PRIMARY,
          fontFamily: "'Berkeley Mono', ui-monospace, monospace",
        }}
      >
        {value}
        {alert && (
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: ERROR }}
          />
        )}
      </div>
    </div>
  );
}

function LiveTelemetryDemo() {
  const history = useLiveTelemetry();
  const latest = history[history.length - 1];

  return (
    <div
      className="rounded-2xl border p-6"
      style={{ borderColor: BORDER, background: SURFACE }}
    >
      <div className="mb-5 flex items-center justify-between">
        <span
          className="flex items-center gap-1.5 text-[13px] font-semibold"
          style={{ color: TEXT_PRIMARY }}
        >
          <Activity size={14} style={{ color: TEXT_TERTIARY }} />
          Container health · POST /checkout
        </span>
        <span
          className="flex items-center gap-1.5 text-[11px] font-semibold"
          style={{ color: ACCENT_TEXT }}
        >
          <span
            className="h-1.5 w-1.5 animate-pulse rounded-full"
            style={{ background: ACCENT }}
          />
          Live
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <LiveStat
          icon={Cpu}
          label="CPU"
          value={latest ? `${latest.cpu.toFixed(1)}%` : "—"}
          alert={!!latest && latest.cpu > 80}
        />
        <LiveStat
          icon={MemoryStick}
          label="Memory"
          value={latest ? `${latest.memory.toFixed(0)} MB` : "—"}
        />
        <LiveStat
          icon={Activity}
          label="Latency p50"
          value={latest ? `${latest.p50.toFixed(0)} ms` : "—"}
        />
        <LiveStat
          icon={Activity}
          label="Latency p95"
          value={latest ? `${latest.p95.toFixed(0)} ms` : "—"}
          alert={!!latest && latest.p95 > 260}
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div>
          <div
            className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em]"
            style={{ color: TEXT_QUIET }}
          >
            CPU %
          </div>
          <ResponsiveContainer width="100%" height={140}>
            <LineChart data={history}>
              <CartesianGrid stroke={BORDER} vertical={false} />
              <XAxis dataKey="t" hide />
              <YAxis
                stroke={TEXT_QUIET}
                fontSize={10}
                width={28}
                domain={[0, 100]}
              />
              <Tooltip
                contentStyle={{
                  background: BG,
                  border: `1px solid ${BORDER_STRONG}`,
                  borderRadius: 8,
                  fontSize: 11.5,
                }}
                labelFormatter={() => ""}
                formatter={(v: number) => [`${v.toFixed(1)}%`, "CPU"]}
              />
              <Line
                type="monotone"
                dataKey="cpu"
                stroke={ACCENT_HOVER}
                dot={false}
                strokeWidth={2}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div>
          <div
            className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em]"
            style={{ color: TEXT_QUIET }}
          >
            API latency (ms)
          </div>
          <ResponsiveContainer width="100%" height={140}>
            <LineChart data={history}>
              <CartesianGrid stroke={BORDER} vertical={false} />
              <XAxis dataKey="t" hide />
              <YAxis stroke={TEXT_QUIET} fontSize={10} width={28} />
              <Tooltip
                contentStyle={{
                  background: BG,
                  border: `1px solid ${BORDER_STRONG}`,
                  borderRadius: 8,
                  fontSize: 11.5,
                }}
                labelFormatter={() => ""}
              />
              <Line
                type="monotone"
                dataKey="p50"
                stroke={TEXT_TERTIARY}
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
                name="p50"
              />
              <Line
                type="monotone"
                dataKey="p95"
                stroke={ACCENT_HOVER}
                dot={false}
                strokeWidth={2}
                isAnimationActive={false}
                name="p95"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

const STAGES = [
  {
    tag: "1.0  Diagnose",
    title: "Here's what's wrong. Nothing else.",
    body: "No fix, no diff, no code yet. Axiom reads live traces, logs, and metrics from SigNoz and hands back a plain-English root cause missing index, N+1 queries, a cold cache exactly like a senior engineer would before touching anything.",
  },
  {
    tag: "2.0  Propose",
    title: "One bug, several fixes",
    body: "There is rarely only one way to solve an N+1 query. Axiom proposes multiple independent strategies, each with an estimated latency and resource improvement, before a single line ships.",
  },
  {
    tag: "3.0  Arena",
    title: "Three isolated environments. One fair fight.",
    body: "Every candidate strategy is deployed to its own sandbox and hit with the exact same workload, back to back so the comparison that follows is never apples to oranges.",
  },
];

const BENCHMARK_ROWS = [
  {
    metric: "Latency (p99)",
    original: "2.5 s",
    a: "1.3 s",
    b: "620 ms",
    c: "780 ms",
  },
  { metric: "CPU", original: "72%", a: "61%", b: "38%", c: "42%" },
  {
    metric: "Memory",
    original: "510 MB",
    a: "480 MB",
    b: "320 MB",
    c: "360 MB",
  },
  { metric: "DB Queries", original: "28", a: "18", b: "4", c: "12" },
  { metric: "Error Rate", original: "8%", a: "2%", b: "0.2%", c: "0.6%" },
];

export default function Landing() {
  const [scrolled, setScrolled] = useState(false);
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { status } = useAppSelector((s) => s.auth);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (status === "idle") dispatch(checkSession());
  }, [status, dispatch]);

  useEffect(() => {
    if (status === "authenticated") navigate("/workspace", { replace: true });
  }, [status, navigate]);

  return (
    <div
      className="min-h-screen antialiased"
      style={{ background: BG, color: TEXT_SECONDARY, fontFamily: SANS }}
    >
      {/* ---------- NAV ---------- */}
      <header
        className="fixed top-0 left-0 right-0 z-50 transition-colors duration-300"
        style={{
          background: scrolled ? `${BG}E6` : "transparent",
          borderBottom: scrolled
            ? `1px solid ${BORDER}`
            : "1px solid transparent",
          backdropFilter: scrolled ? "blur(10px)" : "none",
        }}
      >
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M10 0L20 10L10 20L0 10L10 0Z" fill={ACCENT} />
            </svg>
            <span
              className="text-[16px] font-semibold tracking-[-0.011em]"
              style={{ color: TEXT_PRIMARY }}
            >
              Axiom AI
            </span>
          </div>
          <nav className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map((link) => (
              <a
                key={link}
                href="#"
                className="rounded-md px-3 py-2 text-[13px] font-medium transition-colors"
                style={{ color: TEXT_SECONDARY }}
              >
                {link}
              </a>
            ))}
          </nav>
          <ConnectGithubButton />
        </div>
      </header>

      {/* ---------- HERO ---------- */}
      <section className="relative overflow-hidden px-6 pt-40 pb-24">
        <div className="mx-auto grid max-w-[1200px] grid-cols-1 items-center gap-14 lg:grid-cols-2">
          <div className="flex flex-col items-start gap-6">
            <h1
              className="max-w-[520px] text-[46px] md:text-[56px] font-semibold leading-[1.05] tracking-[-0.02em]"
              style={{ color: TEXT_PRIMARY }}
            >
              Prove your backend is fast. Before you ship.
            </h1>
            <p
              className="max-w-[460px] text-[16px] leading-[1.55]"
              style={{ color: TEXT_TERTIARY }}
            >
              Axiom AI diagnoses the bottleneck, proposes several independent
              fixes, benchmarks every one in an isolated sandbox, and opens the
              pull request for the one that actually wins with the numbers to
              prove it.
            </p>
            <div className="mt-2 flex items-center gap-3">
              <ConnectGithubButton />
              <a
                href="#diff"
                className="flex items-center gap-1.5 rounded-md border px-4 py-[10px] text-[13px] font-medium"
                style={{ borderColor: BORDER_STRONG, color: TEXT_SECONDARY }}
              >
                <GitPullRequest size={14} /> See the diff
              </a>
            </div>
          </div>

          <DiffViewer
            fileName="src/routes/orders.ts"
            unifiedDiff={WINNING_DIFF}
          />
        </div>
      </section>

      {/* ---------- LIVE TELEMETRY ---------- */}
      <section className="px-6 pb-24">
        <div className="mx-auto max-w-[1200px]">
          <div className="mb-8 flex flex-col items-start gap-3">
            <span
              className="text-[12px]"
              style={{ fontFamily: "monospace", color: TEXT_QUIET }}
            >
              0.0 Observability
            </span>
            <h2
              className="text-[32px] font-semibold leading-[1.1] tracking-[-0.02em]"
              style={{ color: TEXT_PRIMARY }}
            >
              Watching the route while you read this.
            </h2>
            <p
              className="max-w-[560px] text-[15.5px]"
              style={{ color: TEXT_TERTIARY }}
            >
              CPU, memory, and p50/p95 latency for the endpoint above, streamed
              straight from telemetry this is the same panel that sits inside
              the workspace.
            </p>
          </div>
          <LiveTelemetryDemo />
        </div>
      </section>

      {/* ---------- STAGES ---------- */}
      <section
        id="how-it-works"
        className="px-6 py-20"
        style={{ background: SURFACE }}
      >
        <div className="mx-auto max-w-[1200px]">
          <div className="grid grid-cols-1 gap-10 md:grid-cols-3">
            {STAGES.map((stage) => (
              <div key={stage.title}>
                <span
                  className="text-[12px]"
                  style={{ fontFamily: "monospace", color: TEXT_QUIET }}
                >
                  {stage.tag}
                </span>
                <h3
                  className="mt-2 text-[20px] font-semibold leading-[1.25]"
                  style={{ color: TEXT_PRIMARY }}
                >
                  {stage.title}
                </h3>
                <p
                  className="mt-3 text-[14.5px] leading-[1.6]"
                  style={{ color: TEXT_TERTIARY }}
                >
                  {stage.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- SCRIPT GENERATOR DEMO ---------- */}
      <section className="px-6 py-24">
        <div className="mx-auto max-w-[1200px]">
          <div className="mb-10 flex flex-col items-start gap-3">
            <span
              className="text-[12px]"
              style={{ fontFamily: "monospace", color: TEXT_QUIET }}
            >
              2.0 Load Generator
            </span>
            <h2
              className="text-[38px] font-semibold leading-[1.1] tracking-[-0.02em]"
              style={{ color: TEXT_PRIMARY }}
            >
              Describe it. Watch it write the load test.
            </h2>
            <p
              className="max-w-[560px] text-[15.5px]"
              style={{ color: TEXT_TERTIARY }}
            >
              Say what you want tested in plain
              English and get back a runnable script wired to the route you're
              benchmarking.
            </p>
          </div>
          <ScriptDemo />
        </div>
      </section>

      {/* ---------- DIFF SHOWCASE ---------- */}
      <section id="diff" className="px-6 py-24" style={{ background: SURFACE }}>
        <div className="mx-auto max-w-[1200px]">
          <div className="mb-10 flex flex-col items-start gap-3">
            <span
              className="text-[12px]"
              style={{ fontFamily: "monospace", color: TEXT_QUIET }}
            >
              4.0 Verdict
            </span>
            <h2
              className="text-[38px] font-semibold leading-[1.1] tracking-[-0.02em]"
              style={{ color: TEXT_PRIMARY }}
            >
              The fix, reviewed like a pull request.
            </h2>
            <p
              className="max-w-[560px] text-[15.5px]"
              style={{ color: TEXT_TERTIARY }}
            >
              Once a strategy wins the benchmark, Axiom opens the exact diff
              against your repo nothing hidden behind an AI's opinion, just
              the change and the numbers behind it.
            </p>
          </div>
          <DiffViewer
            fileName="src/routes/orders.ts"
            unifiedDiff={WINNING_DIFF}
          />
        </div>
      </section>

      {/* ---------- BENCHMARK TABLE ---------- */}
      <section className="px-6 py-24">
        <div className="mx-auto max-w-[1200px]">
          <div className="mb-10 flex flex-col items-start gap-3">
            <span
              className="text-[12px]"
              style={{ fontFamily: "monospace", color: TEXT_QUIET }}
            >
              5.0 Performance Lab
            </span>
            <h2
              className="text-[38px] font-semibold leading-[1.1] tracking-[-0.02em]"
              style={{ color: TEXT_PRIMARY }}
            >
              Every strategy, measured.
            </h2>
            <p
              className="max-w-[560px] text-[15.5px]"
              style={{ color: TEXT_TERTIARY }}
            >
              No guessing which fix is best. Axiom AI runs real load tests
              against every candidate and reports the numbers.
            </p>
          </div>
          <div
            className="overflow-hidden rounded-2xl border"
            style={{ borderColor: BORDER, background: BG }}
          >
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b" style={{ borderColor: BORDER }}>
                  <th
                    className="px-6 py-4 text-[12px] font-medium"
                    style={{ color: TEXT_QUIET }}
                  >
                    Metric
                  </th>
                  <th
                    className="px-6 py-4 text-[12px] font-medium"
                    style={{ color: TEXT_QUIET }}
                  >
                    Original
                  </th>
                  <th
                    className="px-6 py-4 text-[12px] font-medium"
                    style={{ color: TEXT_QUIET }}
                  >
                    Strategy A
                  </th>
                  <th
                    className="px-6 py-4 text-[12px] font-semibold"
                    style={{ color: ACCENT_TEXT }}
                  >
                    Strategy B
                  </th>
                  <th
                    className="px-6 py-4 text-[12px] font-medium"
                    style={{ color: TEXT_QUIET }}
                  >
                    Strategy C
                  </th>
                </tr>
              </thead>
              <tbody>
                {BENCHMARK_ROWS.map((row, idx) => (
                  <tr
                    key={row.metric}
                    style={{
                      borderBottom:
                        idx !== BENCHMARK_ROWS.length - 1
                          ? `1px solid ${BORDER}`
                          : undefined,
                    }}
                  >
                    <td
                      className="px-6 py-4 text-[13px]"
                      style={{ color: TEXT_PRIMARY }}
                    >
                      {row.metric}
                    </td>
                    <td
                      className="px-6 py-4 text-[13px]"
                      style={{ color: TEXT_QUIET }}
                    >
                      {row.original}
                    </td>
                    <td
                      className="px-6 py-4 text-[13px]"
                      style={{ color: TEXT_TERTIARY }}
                    >
                      {row.a}
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className="rounded-[4px] px-[6px] py-[2px] text-[13px] font-semibold"
                        style={{ background: LIVE_SOFT, color: LIVE }}
                      >
                        {row.b}
                      </span>
                    </td>
                    <td
                      className="px-6 py-4 text-[13px]"
                      style={{ color: TEXT_TERTIARY }}
                    >
                      {row.c}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ---------- FINAL CTA ---------- */}
      <section className="px-6 py-32">
        <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-6 text-center">
          <h2
            className="max-w-[600px] text-[40px] font-semibold leading-[1.1] tracking-[-0.02em]"
            style={{ color: TEXT_PRIMARY }}
          >
            Ship the strategy that actually works.
          </h2>
          <p
            className="max-w-[420px] text-[15.5px]"
            style={{ color: TEXT_TERTIARY }}
          >
            Connect your backend and let Axiom AI find, prove, and ship your
            next optimization.
          </p>
          <div className="mt-2 flex items-center gap-3">
            <ConnectGithubButton />
          </div>
        </div>
      </section>

      {/* ---------- FOOTER ---------- */}
      <footer className="border-t px-6 py-12" style={{ borderColor: BORDER }}>
        <div className="mx-auto flex max-w-[1200px] flex-col items-center justify-between gap-6 sm:flex-row">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
              <path
                d="M10 0L20 10L10 20L0 10L10 0Z"
                stroke={TEXT_TERTIARY}
                strokeWidth="1.2"
                fill="none"
              />
            </svg>
            <span className="text-[13px]" style={{ color: TEXT_QUIET }}>
              © {new Date().getFullYear()} Axiom AI. All rights reserved.
            </span>
          </div>
          <div className="flex items-center gap-6">
            {["Privacy", "Terms", "Status"].map((l) => (
              <a
                key={l}
                href="#"
                className="text-[13px]"
                style={{ color: TEXT_QUIET }}
              >
                {l}
              </a>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
