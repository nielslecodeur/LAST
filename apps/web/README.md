# $LAST jackpot website (`apps/web`)

Live: **https://last-jackpot.vercel.app**

Single page that reads the jackpot contract `pot.heavycat9990.near` on NEAR mainnet over public RPC (no wallet needed) and shows:

- the round status, a countdown synced to chain time, the jackpot and the winner's 90% share;
- the crown holder, with a link to their crown-buy transaction;
- past rounds with their payout status;
- the contract, token and reporter, plus "Buy $LAST on Nearly" buttons.

React 19 + TypeScript + Vite + Tailwind 4. Amounts are `bigint` end to end.

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm test       # unit tests (contract reader parsing, RPC fallback, countdown)
pnpm build
```

Optional build-time settings (`.env.example`): `VITE_POT_ID` (default `pot.heavycat9990.near`) and `VITE_TOKEN_TRADE_URL` (default the Nearly token page).

```text
src/main.tsx           entry
src/pot/PotApp.tsx     the page
src/pot/potReader.ts   JSON-RPC views of contracts/last-pot, with endpoint fallback
src/pot/usePot.ts      polling (5 s) + chain-synced countdown
src/lib/               amounts (bigint formatting), countdown, account display
```

Deploy (Vercel CLI, from `apps/web`): `vercel deploy --prod`.
