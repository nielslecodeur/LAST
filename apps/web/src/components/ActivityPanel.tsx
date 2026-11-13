import { explorerAccountUrl, explorerTxUrl } from "../config";
import { useLast } from "../hooks/useLast";
import type { TxKind } from "../lib/transactions";
import type { TxPhase } from "../lib/txMachine";
import { Badge, Card, ExternalLink } from "./ui";

const TONE: Record<TxPhase, "acid" | "heat" | "gold" | "mute"> = {
  idle: "mute",
  signing: "gold",
  pending: "gold",
  confirmed: "acid",
  unresolved: "gold",
  failed: "heat",
  rejected: "mute",
};

const KIND: Record<TxKind, string> = {
  buy: "BUY",
  sell: "SELL",
  settle: "SETTLE",
  claim: "CLAIM",
  withdraw: "WITHDRAW",
  register: "REGISTER",
  session: "AUTO KEY",
  deposit: "DEPOSIT",
};

/**
 * Only transactions signed in this browser session, with their verified result. A full on-chain
 * feed needs an indexer, which the MVP deliberately does not have — we do not invent one.
 */
export function ActivityPanel() {
  const { sessionTxs, reader, simulated, deployed, config } = useLast();
  return (
    <Card title="Your activity" aside={<span className="text-[11px] text-mute">this session</span>}>
      {sessionTxs.length === 0 ? (
        <p className="text-sm text-mute">Transactions you sign here appear with their verified on-chain result and explorer link.</p>
      ) : (
        <ul className="space-y-2">
          {sessionTxs.map((t) => (
            <li key={t.id} className="rounded-lg border border-line/70 px-3 py-2 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="mr-2 font-mono text-[10px] font-bold text-mute">{KIND[t.kind]}</span>
                  <span className="break-words">{t.label}</span>
                </div>
                <Badge tone={TONE[t.phase]}>{t.phase}</Badge>
              </div>
              {t.note && <div className={t.phase === "confirmed" ? "mt-1 text-xs text-acid" : "mt-1 text-xs text-gold"}>{t.note}</div>}
              {t.error && <div className="mt-1 text-xs text-heat">{t.error}</div>}
              {t.hash &&
                (simulated ? (
                  <div className="mt-1 font-mono text-[11px] text-mute">{t.hash}</div>
                ) : (
                  <ExternalLink href={explorerTxUrl(t.hash, config.explorerUrl)} className="mt-1 inline-block font-mono text-[11px] text-mute">
                    {t.hash.slice(0, 10)}…
                  </ExternalLink>
                ))}
            </li>
          ))}
        </ul>
      )}
      {deployed && !simulated && reader && (
        <p className="mt-3 text-[11px] text-mute">
          Full history: every transaction is public on the{" "}
          <ExternalLink href={explorerAccountUrl(reader.contractId, config.explorerUrl)}>explorer</ExternalLink>. A live feed needs an indexer (not in the MVP).
        </p>
      )}
    </Card>
  );
}
