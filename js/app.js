// --- Navigation entre les onglets ---
const tabs = document.querySelectorAll(".tab-btn");
const views = document.querySelectorAll(".view");

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const name = tab.dataset.view;
    tabs.forEach((t) => t.classList.toggle("active", t === tab));
    views.forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  });
});

// --- Date du jour ---
const todayLabel = document.getElementById("today-label");
const jours = ["dimanche","lundi","mardi","mercredi","jeudi","vendredi","samedi"];
const mois = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
function formatDate(d) {
  return `${jours[d.getDay()]} ${d.getDate()} ${mois[d.getMonth()]}`;
}
todayLabel.textContent = formatDate(new Date());

// --- Chrono (pointage manuel — Phase 1 : logique de base seulement) ---
// La vraie logique (GPS, calcul de trajet, lieu inconnu) arrive en Phase 3-4.
// Ici on pose juste le squelette : un bouton qui démarre/arrête un chrono local.
const chronoTime = document.getElementById("chrono-time");
const chronoSub = document.getElementById("chrono-sub");
const statusBadge = document.getElementById("status-badge");
const btnPunch = document.getElementById("btn-punch");

let startedAt = null;
let tickHandle = null;

function pad(n) { return String(n).padStart(2, "0"); }

function renderChrono() {
  if (!startedAt) {
    chronoTime.textContent = "00:00:00";
    return;
  }
  const elapsedMs = Date.now() - startedAt;
  const totalSec = Math.floor(elapsedMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  chronoTime.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;
}

btnPunch.addEventListener("click", () => {
  if (!startedAt) {
    startedAt = Date.now();
    tickHandle = setInterval(renderChrono, 1000);
    statusBadge.textContent = "En cours";
    chronoSub.textContent = "Parti de l'entrepôt à " + new Date(startedAt).toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" });
    btnPunch.textContent = "Sortie / fin de journée";
  } else {
    clearInterval(tickHandle);
    statusBadge.textContent = "Pas encore parti";
    chronoSub.textContent = "Le compteur démarre au moment où tu quittes l'entrepôt.";
    btnPunch.textContent = "Départ de l'entrepôt";
    startedAt = null;
    renderChrono();
  }
});

// --- Service worker (rend l'app installable et utilisable hors ligne) ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch((err) => {
      console.warn("Service worker non enregistré :", err);
    });
  });
}
