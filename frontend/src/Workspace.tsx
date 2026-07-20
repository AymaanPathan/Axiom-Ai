import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import ConnectGithubButton from "../components/ConnectGithubButton";
import { useAppDispatch, useAppSelector } from "../store/hooks";
import { checkSession } from "../store/slices/authSlice";

/**
 * Axiom AI — Landing Page
 * Styled after Linear's design system (void/carbon/acid-lime tokens).
 * Purely public: no repo list, no user state rendered here. If a signed-in
 * user lands here, they're bounced straight to /workspace.
 */

const NAV_LINKS = ["Product", "Workflow", "Benchmarks", "Pricing", "Docs"];

const FEATURES = [
  {
    tag: "1.0  Connect",
    title: "Connect your stack in one click",
    body: "Point Axiom AI at your GitHub repository and your SigNoz instance. It automatically discovers every service, API, database, queue, and cache in your backend — no manual instrumentation.",
  },
  {
    tag: "2.0  Diagnose",
    title: "Stop guessing at bottlenecks",
    body: "Axiom AI reads live traces, logs, and metrics, then explains the root cause in plain engineering language — missing indexes, N+1 queries, sequential calls, cold caches — ranked by impact.",
  },
  {
    tag: "3.0  Generate",
    title: "Multiple strategies, not one guess",
    body: "Instead of a single suggested fix, Axiom AI proposes several independent optimization strategies, each with an estimated latency and resource improvement before a single line ships.",
  },
  {
    tag: "4.0  Prove",
    title: "Benchmark before you believe it",
    body: "Every strategy is deployed to an isolated Performance Lab and load-tested. SigNoz measures latency, CPU, memory, DB queries, and error rate for each — live, side by side.",
  },
];

const BENCHMARK_ROWS = [
  { metric: "Latency (p99)", original: "2.5 s", a: "1.3 s", b: "620 ms", c: "780 ms" },
  { metric: "CPU", original: "72%", a: "61%", b: "38%", c: "42%" },
  { metric: "Memory", original: "510 MB", a: "480 MB", b: "320 MB", c: "360 MB" },
  { metric: "DB Queries", original: "28", a: "18", b: "4", c: "12" },
  { metric: "Error Rate", original: "8%", a: "2%", b: "0.2%", c: "0.6%" },
];

const STEPS = [
  "Connect a backend",
  "Axiom AI discovers every API automatically",
  "Select an endpoint — e.g. POST /checkout",
  "Live traces, metrics, and logs stream in",
  "AI diagnoses: N+1 query, missing index",
  "Three optimization strategies are generated",
  "Each strategy runs a real load test",
  "SigNoz updates the benchmark live",
  "Winning strategy: p99 latency 2.5s → 620ms",
  "Axiom AI opens the GitHub PR",
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

  // If someone lands on "/" already signed in (bookmark, back button, etc),
  // send them straight to the workspace — the landing page never shows
  // logged-in state.
  useEffect(() => {
    if (status === "idle") {
      dispatch(checkSession());
    }
  }, [status, dispatch]);

  useEffect(() => {
    if (status === "authenticated") {
      navigate("/workspace", { replace: true });
    }
  }, [status, navigate]);

  return (
    <div
      className="min-h-screen bg-[#08090a] text-[#d0d6e0] antialiased"
      style={{
        fontFamily:
          "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        fontFeatureSettings: '"cv01" on, "ss03" on, "zero" on',
      }}
    >
      {/* ---------- NAV ---------- */}
      <header
        className={`fixed top-0 left-0 right-0 z-50 transition-colors duration-300 ${
          scrolled
            ? "bg-[#08090a]/90 backdrop-blur-md border-b border-[#23252a]"
            : "bg-transparent"
        }`}
      >
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M10 0L20 10L10 20L0 10L10 0Z" stroke="#ffffff" strokeWidth="1.2" fill="none" />
            </svg>
            <span className="text-[16px] font-[510] tracking-[-0.011em] text-white">Axiom AI</span>
          </div>

          <nav className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map((link) => (
              <a
                key={link}
                href="#"
                className="rounded-md px-3 py-2 text-[13px] font-normal text-[#d0d6e0] transition-colors hover:text-white"
              >
                {link}
              </a>
            ))}
          </nav>

          <ConnectGithubButton />
        </div>
      </header>

      {/* ---------- HERO ---------- */}
      <section className="relative overflow-hidden px-6 pt-44 pb-24">
        <div className="mx-auto max-w-[1200px]">
          <div className="flex flex-col items-start gap-6">
            <span className="rounded-full border border-[#23252a] bg-white/[0.03] px-3 py-1 text-[12px] font-normal text-[#8a8f98]">
              Now observing production backends
            </span>

            <h1 className="max-w-[820px] text-[56px] md:text-[64px] font-[510] leading-[1.0] tracking-[-0.022em] text-white">
              Prove your backend
              <br />
              is fast. Before you ship.
            </h1>

            <p className="max-w-[540px] text-[16px] font-normal leading-[1.5] text-[#8a8f98]">
              Axiom AI is an autonomous backend performance engineer. It reads
              your SigNoz telemetry, diagnoses bottlenecks, generates multiple
              optimization strategies, and benchmarks every one in an isolated
              lab — before a single line hits production.
            </p>

            <div className="mt-2 flex items-center gap-3">
              <ConnectGithubButton />
              <a
                href="#"
                className="rounded-md border border-[#23252a] px-4 py-[10px] text-[13px] font-normal text-[#d0d6e0] transition-colors hover:border-[#383b3f] hover:text-white"
              >
                Watch the demo →
              </a>
            </div>
          </div>

          {/* product screenshot frame */}
          <div className="relative mt-20 rounded-xl border border-[#23252a] bg-[#0f1011] p-6 shadow-[0_0_0_1px_#23252a_inset]">
            <div className="mb-4 flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[#383b3f]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#383b3f]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#383b3f]" />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
              {[
                { label: "Services", value: "14" },
                { label: "Healthy APIs", value: "32" },
                { label: "Needs Optimization", value: "5" },
                { label: "Critical", value: "2" },
              ].map((s) => (
                <div key={s.label} className="rounded-md bg-white/[0.02] p-4 shadow-[0_2px_4px_rgba(0,0,0,0.4)]">
                  <div className="text-[24px] font-normal text-white tracking-[-0.012em]">{s.value}</div>
                  <div className="mt-1 text-[12px] text-[#8a8f98]">{s.label}</div>
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-md border border-[#23252a] bg-white/[0.015] p-4">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-[#62666d]" style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}>
                  POST /checkout
                </span>
                <span className="rounded-[4px] bg-[#eb5757]/10 px-[6px] py-0 text-[12px] text-[#eb5757]">Critical</span>
              </div>
              <p className="mt-2 text-[13px] text-[#8a8f98]">
                Root cause: missing database index · N+1 queries · Redis cache not utilized
              </p>
            </div>
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-[#d0d6e0]/[0.06]" />
        </div>
      </section>

      {/* ---------- FEATURE SECTIONS ---------- */}
      <section className="px-6 py-24">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-24">
          {FEATURES.map((f, i) => (
            <div
              key={f.title}
              className={`grid grid-cols-1 items-center gap-10 md:grid-cols-2 ${
                i % 2 === 1 ? "md:[&>*:first-child]:order-2" : ""
              }`}
            >
              <div>
                <span className="text-[12px] text-[#62666d]" style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}>
                  {f.tag}
                </span>
                <h3 className="mt-3 text-[32px] font-normal leading-[1.13] tracking-[-0.012em] text-white">{f.title}</h3>
                <p className="mt-4 max-w-[440px] text-[16px] leading-[1.5] text-[#8a8f98]">{f.body}</p>
              </div>

              <div className="rounded-xl border border-[#23252a] bg-[#0f1011] p-6">
                <div className="flex flex-col gap-2.5">
                  {STEPS.slice(i * 2, i * 2 + 3).map((step, idx) => (
                    <div key={step} className="flex items-center gap-3 rounded-md bg-white/[0.02] px-3 py-2.5">
                      <span
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-[510]"
                        style={{
                          background: idx === 0 ? "#e4f222" : "rgba(255,255,255,0.06)",
                          color: idx === 0 ? "#08090a" : "#8a8f98",
                        }}
                      >
                        {i * 2 + idx + 1}
                      </span>
                      <span className="text-[13px] text-[#d0d6e0]">{step}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- BENCHMARK TABLE ---------- */}
      <section className="px-6 py-24">
        <div className="mx-auto max-w-[1200px]">
          <div className="mb-10 flex flex-col items-start gap-3">
            <span className="text-[12px] text-[#62666d]" style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}>
              5.0 Performance Lab
            </span>
            <h2 className="text-[48px] font-[510] leading-[1.0] tracking-[-0.022em] text-white">Every strategy, measured.</h2>
            <p className="max-w-[560px] text-[16px] text-[#8a8f98]">
              No guessing which fix is best. Axiom AI runs real load tests against every candidate and reports the numbers.
            </p>
          </div>

          <div className="overflow-hidden rounded-xl border border-[#23252a] bg-[#0f1011]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-[#23252a]">
                  <th className="px-6 py-4 text-[12px] font-normal text-[#62666d]">Metric</th>
                  <th className="px-6 py-4 text-[12px] font-normal text-[#62666d]">Original</th>
                  <th className="px-6 py-4 text-[12px] font-normal text-[#62666d]">Strategy A</th>
                  <th className="px-6 py-4 text-[12px] font-[510] text-[#e4f222]">Strategy B</th>
                  <th className="px-6 py-4 text-[12px] font-normal text-[#62666d]">Strategy C</th>
                </tr>
              </thead>
              <tbody>
                {BENCHMARK_ROWS.map((row, idx) => (
                  <tr key={row.metric} className={idx !== BENCHMARK_ROWS.length - 1 ? "border-b border-[#161718]" : ""}>
                    <td className="px-6 py-4 text-[13px] text-[#d0d6e0]">{row.metric}</td>
                    <td className="px-6 py-4 text-[13px] text-[#62666d]">{row.original}</td>
                    <td className="px-6 py-4 text-[13px] text-[#8a8f98]">{row.a}</td>
                    <td className="px-6 py-4">
                      <span className="rounded-[4px] bg-[#27a644]/10 px-[6px] py-[2px] text-[13px] font-[510] text-[#27a644]">{row.b}</span>
                    </td>
                    <td className="px-6 py-4 text-[13px] text-[#8a8f98]">{row.c}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 rounded-xl border border-[#23252a] bg-white/[0.02] p-6">
            <p className="text-[15px] leading-[1.6] text-[#8a8f98]">
              <span className="text-white">Strategy B</span> won because it eliminated N+1 queries, added a composite database
              index, and parallelized inventory and payment requests — cutting database round-trips by 86% and dropping p99
              latency from 2.5s to 620ms.
            </p>
          </div>
        </div>
      </section>

      {/* ---------- LOGOS / TRUST STRIP ---------- */}
      <section className="border-y border-[#161718] px-6 py-16">
        <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-8">
          <span className="text-[13px] text-[#62666d]">Built for teams already running on SigNoz</span>
          <div className="flex flex-wrap items-center justify-center gap-x-14 gap-y-6 opacity-70">
            {["Vercel", "Cursor", "Coinbase", "Ramp", "Boom", "Cash App"].map((name) => (
              <span key={name} className="text-[15px] font-[510] tracking-[-0.011em] text-[#8a8f98]">
                {name}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- FINAL CTA ---------- */}
      <section className="px-6 py-32">
        <div className="mx-auto flex max-w-[1200px] flex-col items-center gap-6 text-center">
          <h2 className="max-w-[600px] text-[48px] font-[510] leading-[1.0] tracking-[-0.022em] text-white">
            Ship the strategy that actually works.
          </h2>
          <p className="max-w-[420px] text-[16px] text-[#8a8f98]">
            Connect your backend and let Axiom AI find, prove, and ship your next optimization.
          </p>
          <div className="mt-2 flex items-center gap-3">
            <ConnectGithubButton />
            <a
              href="#"
              className="rounded-md border border-[#23252a] px-5 py-[10px] text-[13px] text-[#d0d6e0] transition-colors hover:border-[#383b3f] hover:text-white"
            >
              Talk to sales
            </a>
          </div>
        </div>
      </section>

      {/* ---------- FOOTER ---------- */}
      <footer className="border-t border-[#161718] px-6 py-12">
        <div className="mx-auto flex max-w-[1200px] flex-col items-center justify-between gap-6 sm:flex-row">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
              <path d="M10 0L20 10L10 20L0 10L10 0Z" stroke="#8a8f98" strokeWidth="1.2" fill="none" />
            </svg>
            <span className="text-[13px] text-[#62666d]">© {new Date().getFullYear()} Axiom AI. All rights reserved.</span>
          </div>
          <div className="flex items-center gap-6">
            {["Privacy", "Terms", "Status"].map((l) => (
              <a key={l} href="#" className="text-[13px] text-[#62666d] transition-colors hover:text-[#d0d6e0]">
                {l}
              </a>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}
