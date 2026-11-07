// Click pe iconița extensiei => se deschide panoul din dreapta.
// Chrome (și Opera 136+) au API-ul chrome.sidePanel.
// Opera mai vechi folosește "sidebar_action" din manifest, gestionat automat de browser.
// Orice alt browser Chromium fără niciunul dintre cele două primește un popup clasic ca fallback,
// ca extensia să rămână utilizabilă oriunde.
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else if (!chrome.sidebarAction) {
  chrome.action.setPopup({ popup: "sidepanel.html" }).catch(() => {});
}