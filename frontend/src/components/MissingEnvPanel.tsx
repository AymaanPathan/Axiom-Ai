// src/components/MissingEnvPanel.tsx
import { useEffect, useState } from "react";
import { getEnvStatus, submitEnvVars, type EnvStatus } from "../api/repos";
import {
  SANS,
  MONO,
  SURFACE,
  BG,
  BORDER,
  BORDER_STRONG,
  TEXT_PRIMARY,
  TEXT_SECONDARY,
  TEXT_TERTIARY,
  TEXT_QUIET,
  ACCENT,
  ACCENT_HOVER,
  ERROR,
} from "../theme";

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
        className="rounded-xl border p-5"
        style={{ borderColor: BORDER, background: SURFACE, fontFamily: SANS }}
      >
        <p className="text-[12.5px]" style={{ color: TEXT_TERTIARY }}>
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
      className="rounded-xl border p-5"
      style={{ borderColor: BORDER, background: SURFACE, fontFamily: SANS }}
    >
      <h3 className="text-[13px] font-semibold" style={{ color: TEXT_PRIMARY }}>
        Environment variables
      </h3>
      <p className="mt-1.5 text-[12.5px]" style={{ color: TEXT_TERTIARY }}>
        This repo needs values for {status.missing.length} key
        {status.missing.length > 1 ? "s" : ""} before it can boot.
      </p>

      <div className="mt-4 flex flex-col gap-3">
        {status.missing.map((key) => (
          <div key={key} className="flex flex-col gap-1">
            <label
              className="text-[11px] font-medium"
              style={{ color: TEXT_SECONDARY, fontFamily: MONO }}
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
              className="rounded-lg border px-3 py-2 text-[13px] outline-none transition-colors"
              style={{
                borderColor: BORDER,
                background: BG,
                color: TEXT_PRIMARY,
                fontFamily: MONO,
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = ACCENT)}
              onBlur={(e) => (e.currentTarget.style.borderColor = BORDER)}
            />
          </div>
        ))}
      </div>

      {error && (
        <p className="mt-3 text-[12px]" style={{ color: ERROR }}>
          {error}
        </p>
      )}

      <button
        type="button"
        disabled={!allFilled || submitting}
        onClick={handleSubmit}
        className="mt-4 w-full rounded-lg px-4 py-2.5 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed"
        style={
          allFilled && !submitting
            ? { background: ACCENT, color: TEXT_PRIMARY }
            : {
                background: BG,
                color: TEXT_QUIET,
                border: `1px solid ${BORDER_STRONG}`,
              }
        }
        onMouseEnter={(e) => {
          if (allFilled && !submitting)
            e.currentTarget.style.background = ACCENT_HOVER;
        }}
        onMouseLeave={(e) => {
          if (allFilled && !submitting)
            e.currentTarget.style.background = ACCENT;
        }}
      >
        {submitting ? "Saving…" : "Save & continue"}
      </button>
    </div>
  );
}
