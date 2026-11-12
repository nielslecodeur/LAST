import { useLast } from "../hooks/useLast";
import { formatNear } from "../lib/amounts";
import { buildWithdrawTx } from "../lib/transactions";
import { isBusy } from "../lib/txMachine";
import { Button, Card, Row } from "./ui";

/** Sale proceeds are a pull payout: `sell` credits, `withdraw_near_credit` pays (Gate 2). */
export function CreditPanel() {
  const { account, accountId, walletError, capabilities, deployed, tx, run, reader } = useLast();
  const available = account?.creditAvailable ?? null;
  const inFlight = account?.creditInFlight ?? null;
  const can = capabilities.withdrawNearCredit;

  let label = "Withdraw NEAR";
  if (!deployed) label = "Contract not deployed";
  else if (!can) label = "Withdraw — pending Gate 2";
  else if (!accountId) label = "Connect wallet";
  else if (walletError) label = "Wrong network";
  else if (inFlight !== null && inFlight > 0n) label = "Withdrawal in flight…";
  else if (available === null || available === 0n) label = "No credit to withdraw";
  else if (isBusy(tx) && tx.kind === "withdraw") label = "Confirm in wallet…";

  const disabled = !deployed || !can || !accountId || !!walletError || !available || available === 0n || (inFlight ?? 0n) > 0n || isBusy(tx);

  return (
    <Card title="Withdraw NEAR">
      <Row label="Credit available" strong value={available === null ? "—" : `${formatNear(available, 6)} NEAR`} />
      <Row label="In flight" value={inFlight === null ? "—" : `${formatNear(inFlight, 6)} NEAR`} />
      <Button variant="secondary" className="mt-3 w-full" disabled={disabled} onClick={() => reader && void run(buildWithdrawTx(reader.contractId, capabilities))}>
        {label}
      </Button>
      <p className="mt-2 text-[11px] leading-relaxed text-mute">
        {can
          ? "Sends your whole available credit. It is only final once the contract's callback confirms the transfer (IN_FLIGHT → paid)."
          : "Your sale credit is safe in the contract ledger. Withdrawal unlocks when the deployed contract exports withdraw_near_credit (Gate 2)."}
      </p>
    </Card>
  );
}
