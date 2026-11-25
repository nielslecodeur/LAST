import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EndedApp } from "./pot/EndedApp";
import "./index.css";

// The live jackpot page (PotApp) is kept in the source; the contract account was closed on 2026-11-25.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EndedApp />
  </StrictMode>,
);
