import React from "react";
import ReactDOM from "react-dom/client";
import SmashPointApp from "./SmashPointApp.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <SmashPointApp />
  </React.StrictMode>
);

// App instalable y notificaciones push (ver public/sw.js)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
}
