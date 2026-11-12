import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Every test here is a unit/mocked test: no network, no wallet, no chain.
// The only real-network test is src/test/live.integration.test.ts and it is skipped unless
// LAST_LIVE_CONTRACT_ID is set (read-only views, never signs).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
