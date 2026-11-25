import { CrownIcon, cx } from "../components/ui";

// Shown since 2026-11-25: the jackpot contract account was deleted, so there is nothing live to read.
const REPO_URL = "https://github.com/nielslecodeur/LAST";
const EXPLORER = "https://nearblocks.io";
const tx = (h: string) => `${EXPLORER}/txns/${h}`;

function Ext({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cx("underline decoration-line underline-offset-4 hover:text-acid hover:decoration-acid", className)}>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

const RECORD: [string, string, string][] = [
  ["Token launched on Nearly", "2026-11-13", "DXhHMngBAQd4xssXjW3zHacZruM4PniGjPuig3qSsCqp"],
  ["Jackpot contract deployed", "2026-11-13", "EvahQHgSZbYfbmQricYQRgG9hWASvmY1s8wEWxsSx6Lg"],
  ["First crown buy: 10 NEAR by wrapz-z.near", "2026-11-13", "6AvsPPGyn2SUH2gwmzkECrf2bctEJtZtW2i7GrYhGbcq"],
  ["Round 1 paid: 0.1763 NEAR to wrapz-z.near", "2026-11-13", "7PN8F3LGzPgGaP5QyF3xNiH1FQmsvptxGQpydwVRy9xk"],
  ["Contract account closed", "2026-11-25", "CjMZN9nUzH8TJAFbokbAjzdFAzepNG3GxFjSrDqaqmzj"],
];

export function EndedApp() {
  return (
    <div id="top">
      <header className="border-b-2 border-text bg-ink">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <span className="flex items-center gap-2">
            <CrownIcon className="h-7 w-7 text-acid" />
            <span className="font-poster riso text-3xl leading-none">$LAST</span>
          </span>
          <span className="border border-heat bg-heat px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-panel-2">Ended</span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6 lg:py-10">
        <section className="hard bg-panel p-5 sm:p-7">
          <h1 className="font-poster text-4xl uppercase sm:text-5xl">The $LAST jackpot has ended</h1>
          <div className="mt-4 max-w-2xl space-y-3">
            <p>
              $LAST ran live on NEAR mainnet from 2026-11-13 to 2026-11-25: a memecoin whose trading fees funded an on-chain
              last-buyer-wins jackpot, paid automatically by a smart contract. One full round was played and its winner was paid on-chain.
            </p>
            <p>
              We shut it down on 2026-11-25 because <strong>running it cost too much</strong> for what it brought in: about 1.53 NEAR
              stayed locked for the contract's storage, plus the upkeep of the bot, while trading had stopped. We only meant to keep it
              running until the NEAR Hackathon results, and <strong>we did not expect the winners to take this long to be announced</strong>.
            </p>
            <p className="text-sm text-mute">
              No round was running and no prize was owed. The contract account was deleted and its balance (the storage deposit plus 0.1455
              NEAR of fees that had not been won) returned to the team account <span className="font-mono">heavycat9990.near</span>. The
              token still exists on Nearly, but it no longer has a jackpot: buying it does not win anything.
            </p>
          </div>
        </section>

        <section className="hard bg-panel p-5 sm:p-7">
          <h2 className="font-poster mb-4 text-2xl uppercase">On-chain record</h2>
          <ul className="space-y-2 text-sm">
            {RECORD.map(([label, date, hash]) => (
              <li key={hash} className="flex flex-wrap items-baseline gap-x-3 border-t border-line pt-2">
                <span className="font-mono text-mute">{date}</span>
                <span className="font-semibold">{label}</span>
                <Ext href={tx(hash)} className="font-mono text-xs">
                  {hash.slice(0, 10)}…
                </Ext>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t-2 border-text">
        <div className="mx-auto max-w-4xl px-4 py-6 text-xs text-mute sm:px-6">
          Source code, contract and bot: <Ext href={REPO_URL}>github.com/nielslecodeur/LAST</Ext> · MIT license
        </div>
      </footer>
    </div>
  );
}
