import React from "react";
import ReactDOM from "react-dom/client";
import SmashPointApp from "./SmashPointApp.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <SmashPointApp />
  </React.StrictMode>
);

// Instalar la app (Android y compu): el navegador avisa una sola vez, a veces antes de que arranque
// React; se guarda el pedido para el botón "Instalar la app" (ver useInstalarApp)
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  window.__pedidoInstalar = e;
  window.dispatchEvent(new Event("smashpoint-instalar"));
});
window.addEventListener("appinstalled", () => {
  window.__pedidoInstalar = null;
  window.dispatchEvent(new Event("smashpoint-instalar"));
});

// App instalable y notificaciones push (ver public/sw.js)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
}
