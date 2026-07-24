// src/components/MissingEnvPanel.tsx
import { useEffect, useState } from "react";
import { getEnvStatus, submitEnvVars, type EnvStatus } from "../api/repos";
import { SANS, MONO } from "../theme";
import { GLASS } from "../styles/glass";

interface MissingEnvPanelProps {
  repositoryId: string;
  onAllSet: () => void;
}

export default function MissingEnvPanel({
  repositoryId,
  onAllSet,
}: MissingEnvPanelProps) {
  const [status, setStatus] = useState<EnvStatus | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getEnvStatus(repositoryId)
      .then(setStatus)
      .catch(() => setError("Couldn't load environment status."));
  }, [repositoryId]);

  useEffect(() => {
    if (status && status.missing.length === 0) {
      onAllSet();
    }
  }, [status, onAllSet]);

  if (!status) {
    return (
      <div
        className="rounded-3xl border p-6 backdrop-blur-xl"
        style={{
          borderColor: GLASS.border,
          background: GLASS.glassBg,
          boxShadow: GLASS.shadow,
          fontFamily: SANS,
        }}
      >
        <p className="text-[12.5px]" style={{ color: GLASS.textTertiary }}>
          Checking environment variables…
        </p>
      </div>
    );
  }

  if (status.missing.length === 0) {
    return null;
  }

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitEnvVars(repositoryId, values);
      setStatus((prev) => (prev ? { ...prev, ...result } : prev));
      setValues({});
    } catch {
      setError("Couldn't save environment variables. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const allFilled = status.missing.every((key) => values[key]?.trim());

  return (
    <div
      className="rounded-3xl border p-6 backdrop-blur-xl"
      style={{
        borderColor: GLASS.border,
        background: GLASS.glassBg,
        boxShadow: GLASS.shadow,
        fontFamily: SANS,
      }}
    >
      <h3 className="text-[14px] font-bold" style={{ color: GLASS.text }}>
        Environment variables
      </h3>
      <p className="mt-1.5 text-[12.5px]" style={{ color: GLASS.textTertiary }}>
        This repo needs values for {status.missing.length} key
        {status.missing.length > 1 ? "s" : ""} before it can boot.
      </p>

      <div className="mt-4 flex flex-col gap-3">
        {status.missing.map((key) => (
          <div key={key} className="flex flex-col gap-1.5">
            <label
              className="text-[11px] font-semibold"
              style={{ color: GLASS.textSecondary, fontFamily: MONO }}
            >
              {key}
            </label>
            <input
              type="password"
              value={values[key] ?? ""}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [key]: e.target.value }))
              }
              placeholder="Paste value"
              className="rounded-xl border px-3.5 py-2.5 text-[13px] outline-none transition-all"
              style={{
                borderColor: GLASS.border,
                background: GLASS.fieldBg,
                color: GLASS.text,
                fontFamily: MONO,
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = GLASS.accent;
                e.currentTarget.style.boxShadow = `0 0 0 3px ${GLASS.accentSoft}`;
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = GLASS.border;
                e.currentTarget.style.boxShadow = "none";
              }}
            />
          </div>
        ))}
      </div>

      {error && (
        <p className="mt-3 text-[12px]" style={{ color: GLASS.error }}>
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={!allFilled || submitting}
        onClick={handleSubmit}
        className="mt-4 w-full rounded-xl px-4 py-2.5 text-[13px] font-bold transition-all disabled:cursor-not-allowed"
        style={
          allFilled && !submitting
            ? {
                background: GLASS.accent,
                color: GLASS.accentOn,
                boxShadow: "0 8px 20px rgba(255,198,41,0.35)",
              }
            : {
                background: GLASS.fieldBg,
                color: GLASS.textQuiet,
                border: `1px solid ${GLASS.borderStrong}`,
              }
        }
        onMouseEnter={(e) => {
          if (allFilled && !submitting)
            e.currentTarget.style.background = GLASS.accentHover;
        }}
        onMouseLeave={(e) => {
          if (allFilled && !submitting)
            e.currentTarget.style.background = GLASS.accent;
        }}
      >
        {submitting ? "Saving…" : "Save & continue"}
      </button>
    </div>
  );
}
