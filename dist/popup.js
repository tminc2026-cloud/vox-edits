(function VoxEditPopup() {
  const statusEl = document.getElementById("status");
  const toggleBtn = document.getElementById("toggle-btn");
  const refreshHint = document.getElementById("refresh-hint");
  let activeTabId = null;
  let isConnected = false;
  function setStatus(text, type) {
    statusEl.textContent = text;
    statusEl.className = type || "";
  }
  function showRefreshHint() {
    refreshHint.style.display = "block";
    toggleBtn.disabled = true;
    setStatus("Content script not reachable.", "error");
  }
  function onConnected() {
    isConnected = true;
    refreshHint.style.display = "none";
    toggleBtn.disabled = false;
    setStatus("Connected to Google Docs.", "success");
  }
  function sendToBackground(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            console.error("[VoxEdit Popup] runtime.lastError:", chrome.runtime.lastError.message);
            resolve(null);
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        console.error("[VoxEdit Popup] sendToBackground error:", e.message);
        resolve(null);
      }
    });
  }
  async function init() {
    setStatus("Checking connection…");
    let tabs;
    try {
      tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (e) {
      setStatus("Could not query tabs.", "error");
      return;
    }
    if (!tabs || tabs.length === 0) {
      setStatus("No active tab found.", "error");
      return;
    }
    const tab = tabs[0];
    if (!tab.url || !tab.url.startsWith("https://docs.google.com/document/")) {
      setStatus("Open a Google Docs document to use VoxEdit.", "error");
      toggleBtn.disabled = true;
      return;
    }
    activeTabId = tab.id;
    const pingResp = await sendToBackground({ type: "PING_TAB", tabId: activeTabId });
    if (pingResp && pingResp.ok && pingResp.alive) {
      onConnected();
    } else {
      showRefreshHint();
    }
  }
  toggleBtn.addEventListener("click", async function() {
    if (!isConnected || !activeTabId) return;
    toggleBtn.disabled = true;
    setStatus("Toggling sidebar…");
    const resp = await sendToBackground({ type: "TOGGLE_SIDEBAR", tabId: activeTabId });
    if (resp && resp.ok) {
      setStatus("Sidebar toggled.", "success");
    } else {
      setStatus("Failed to toggle sidebar.", "error");
    }
    toggleBtn.disabled = false;
  });
  document.addEventListener("DOMContentLoaded", init);
  if (document.readyState !== "loading") {
    init();
  }
})();
