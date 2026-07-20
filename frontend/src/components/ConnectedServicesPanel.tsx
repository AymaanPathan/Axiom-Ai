export interface ConnectedService {
  name: string;
  icon: string; // emoji, matches the rest of the app's icon language
}

interface ConnectedServicesPanelProps {
  entryLabel: string; // e.g. "POST /checkout"
  services?: ConnectedService[];
}

export default function ConnectedServicesPanel({
  entryLabel,
  services,
}: ConnectedServicesPanelProps) {
  const hasServices = services && services.length > 0;

  return (
    <div className="rounded-xl border border-[#23252a] bg-[#0f1011]">
      <div className="border-b border-[#23252a] px-5 py-3">
        <span
          className="text-[11px] text-[#62666d]"
          style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
        >
          Connected Services
        </span>
      </div>

      {!hasServices ? (
        <div className="px-5 py-8 text-center">
          <p className="text-[13px] text-[#d0d6e0]">
            No downstream services detected
          </p>
          <p className="mt-1 text-[12px] text-[#62666d]">
            Axiom traces service calls, DB clients, and external APIs referenced
            from this handler — coming soon.
          </p>
        </div>
      ) : (
        <div className="p-5">
          {/* Flow chain */}
          <div
            className="flex flex-col items-center gap-1"
            style={{ fontFamily: "'Berkeley Mono', ui-monospace, monospace" }}
          >
            <span className="rounded-md border border-[#23252a] bg-white/[0.03] px-3 py-1.5 text-[12px] text-[#d0d6e0]">
              {entryLabel}
            </span>
            {services.map((service) => (
              <div
                key={service.name}
                className="flex flex-col items-center gap-1"
              >
                <span className="text-[13px] leading-none text-[#4c4f54]">
                  ↓
                </span>
                <span className="rounded-md border border-[#23252a] bg-white/[0.03] px-3 py-1.5 text-[12px] text-[#d0d6e0]">
                  {service.icon} {service.name}
                </span>
              </div>
            ))}
          </div>

          {/* Card grid */}
          <div className="mt-6 grid grid-cols-2 gap-2 border-t border-[#161718] pt-5 sm:grid-cols-3">
            {services.map((service) => (
              <div
                key={`card-${service.name}`}
                className="flex items-center gap-2 rounded-md border border-[#23252a] bg-white/[0.02] px-3 py-2 text-[12px] text-[#d0d6e0]"
              >
                <span>{service.icon}</span>
                <span className="truncate">{service.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
