import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PotApp } from "./pot/PotApp";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PotApp />
  </StrictMode>,
);
