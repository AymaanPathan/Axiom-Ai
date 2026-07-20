import { useEffect, useState } from "react";
import { getEnvStatus, submitEnvVars, type EnvStatus } from "../api/repos";

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
      .catch(() => setError("Failed to load env status"));
  }, [repositoryId]);

  useEffect(() => {
    if (status && status.missing.length === 0) {
      onAllSet();
    }
  }, [status, onAllSet]);

  if (!status) {
    return (
      <div className="rounded-xl border border-[#23252a] bg-[#0f1011] p-5">
        <p className="text-[13px] text-[#62666d]">
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
      setError("Failed to save environment variables");
    } finally {
      setSubmitting(false);
    }
  };

  const allFilled = status.missing.every((key) => values[key]?.trim());

  return (
    <div className="rounded-xl border border-[#23252a] bg-[#0f1011] p-5">
      <div className="mb-4 flex items-center gap-2">
        <span className="text-[13px] font-[510] text-white">
          Repository Connected ✅
        </span>
      </div>

      <p className="mb-3 text-[13px] text-[#8a8f98]">
        Missing Environment Variables
      </p>

      <div className="flex flex-col gap-3">
        {status.missing.map((key) => (
          <div key={key} className="flex flex-col gap-1">
            <label
              className="text-[11px] text-[#62666d]"
              style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
            >
              {key}
            </label>
            <input
              type="password"
              value={values[key] ?? ""}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [key]: e.target.value }))
              }
              placeholder={`Paste value for ${key}`}
              className="rounded-md border border-[#23252a] bg-[#08090a] px-3 py-2 text-[13px] text-[#d0d6e0] outline-none focus:border-[#27a644]/50"
              style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
            />
          </div>
        ))}
      </div>

      {error && <p className="mt-3 text-[12px] text-[#eb5757]">{error}</p>}

      <button
        type="button"
        disabled={!allFilled || submitting}
        onClick={handleSubmit}
        className="mt-4 rounded-md bg-[#27a644] px-4 py-2 text-[13px] font-[510] text-white transition-opacity disabled:opacity-40"
      >
        {submitting ? "Saving…" : "Save & Continue"}
      </button>
    </div>
  );
}
