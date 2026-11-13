/**
 * Public-site notice: the game on this page is the NEAR Testnet demo; the real $LAST jackpot is a
 * separate mainnet contract fed by the Nearly launch. Shown above everything so token buyers never
 * mistake testnet figures for the real pot.
 *
 * Config (build-time, optional):
 *   VITE_MAINNET_POT_ID   mainnet jackpot contract (default pot.heavycat9990.near)
 *   VITE_TOKEN_TRADE_URL  where to buy $LAST (e.g. the Nearly token page); hidden when empty
 */
const env = import.meta.env as Record<string, string | undefined>;
const POT_ID = (env.VITE_MAINNET_POT_ID ?? "").trim() || "pot.heavycat9990.near";
const TRADE_URL = (env.VITE_TOKEN_TRADE_URL ?? "").trim();

export function MainnetBanner() {
  return (
    <div role="note" className="border-b-2 border-text bg-acid text-panel-2">
      <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          <strong className="font-poster mr-2 text-base uppercase tracking-wide">Testnet demo</strong>
          The game below runs on NEAR Testnet (no real value). The real $LAST jackpot lives on mainnet in{" "}
          <a
            href={`https://nearblocks.io/address/${POT_ID}`}
            target="_blank"
            rel="noreferrer noopener"
            className="font-mono underline underline-offset-4"
          >
            {POT_ID}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          .
        </p>
        {TRADE_URL && (
          <a
            href={TRADE_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="hard press shrink-0 bg-panel-2 px-3 py-1.5 font-semibold text-text"
          >
            Buy $LAST on Nearly
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </div>
    </div>
  );
}
