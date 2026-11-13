import { useEffect, useState } from "react";
import { classifyError } from "../lib/errors";

export interface QuoteState<T> {
  quote: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Debounced contract quote (`quote_buy` / `quote_sell`). `marketKey` changes whenever reserves
 * move, so a displayed quote is always against the latest confirmed reserves.
 */
export function useQuote<T>(
  fetcher: ((amount: bigint) => Promise<T>) | null,
  amount: bigint | null,
  marketKey: string,
  delayMs = 250,
): QuoteState<T> {
  const [state, setState] = useState<QuoteState<T>>({ quote: null, loading: false, error: null });

  useEffect(() => {
    if (!fetcher || amount === null || amount <= 0n) {
      setState({ quote: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      fetcher(amount)
        .then((q) => !cancelled && setState({ quote: q, loading: false, error: null }))
        .catch((e) => !cancelled && setState({ quote: null, loading: false, error: classifyError(e).message }));
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [fetcher, amount, marketKey, delayMs]);

  return state;
}
