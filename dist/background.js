function log(...args) {
  console.log("[VoxEdit BG]", ...args);
}
function err(...args) {
  console.error("[VoxEdit BG]", ...args);
}
async function sendToTab(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response;
  } catch (e) {
    err("sendToTab failed:", e.message);
    return null;
  }
}
chrome.runtime.onInstalled.addListener((details) => {
  log("Installed / updated. Reason:", details.reason);
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type } = message || {};
  if (!type) {
    err("Received message with no type", message);
    sendResponse({ ok: false, error: "no_type" });
    return false;
  }
  if (type === "PING_TAB") {
    const { tabId } = message;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "no_tabId" });
      return false;
    }
    (async () => {
      const response = await sendToTab(tabId, { type: "PING" });
      if (response && response.type === "PONG") {
        sendResponse({ ok: true, alive: true });
      } else {
        sendResponse({ ok: true, alive: false });
      }
    })();
    return true;
  }
  if (type === "TOGGLE_SIDEBAR") {
    const { tabId } = message;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "no_tabId" });
      return false;
    }
    (async () => {
      const response = await sendToTab(tabId, { type: "TOGGLE_SIDEBAR" });
      sendResponse(response || { ok: false, error: "no_response" });
    })();
    return true;
  }
  if (type === "ATTACH_ANNOTATION") {
    const { annotation } = message;
    if (!annotation || !annotation.docId) {
      sendResponse({ ok: false, error: "invalid_annotation" });
      return false;
    }
    (async () => {
      try {
        await saveAnnotation(annotation);
        const tabs = await chrome.tabs.query({
          url: `https://docs.google.com/document/d/${annotation.docId}/*`
        });
        for (const tab of tabs) {
          await sendToTab(tab.id, { type: "RENDER_ANNOTATION", annotation });
        }
        sendResponse({ ok: true });
      } catch (e) {
        err("ATTACH_ANNOTATION failed:", e.message);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (type === "GET_ANNOTATIONS") {
    const { docId } = message;
    if (!docId) {
      sendResponse({ ok: false, error: "no_docId" });
      return false;
    }
    (async () => {
      const annotations = await loadAnnotations(docId);
      sendResponse({ ok: true, annotations });
    })();
    return true;
  }
  if (type === "DELETE_ANNOTATION") {
    const { docId, annotationId } = message;
    if (!docId || !annotationId) {
      sendResponse({ ok: false, error: "missing_fields" });
      return false;
    }
    (async () => {
      try {
        await deleteAnnotation(docId, annotationId);
        sendResponse({ ok: true });
      } catch (e) {
        err("DELETE_ANNOTATION failed:", e.message);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (type === "UPDATE_RECORDING") {
    const { docId, annotationId, recordingDataUrl } = message;
    if (!docId || !annotationId || !recordingDataUrl) {
      sendResponse({ ok: false, error: "missing_fields" });
      return false;
    }
    (async () => {
      try {
        await attachRecording(docId, annotationId, recordingDataUrl);
        sendResponse({ ok: true });
      } catch (e) {
        err("UPDATE_RECORDING failed:", e.message);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  err("Unknown message type:", type);
  sendResponse({ ok: false, error: "unknown_type" });
  return false;
});
async function loadAnnotations(docId) {
  var _a;
  try {
    const key = `doc_${docId}`;
    const result = await chrome.storage.local.get(key);
    return ((_a = result[key]) == null ? void 0 : _a.annotations) || [];
  } catch (e) {
    err("loadAnnotations failed:", e.message);
    return [];
  }
}
async function saveAnnotation(annotation) {
  const { docId } = annotation;
  const key = `doc_${docId}`;
  const result = await chrome.storage.local.get(key);
  const docData = result[key] || { annotations: [] };
  const existing = docData.annotations.findIndex((a) => a.id === annotation.id);
  if (existing >= 0) {
    docData.annotations[existing] = annotation;
  } else {
    docData.annotations.push(annotation);
  }
  await chrome.storage.local.set({ [key]: docData });
  log("Saved annotation", annotation.id, "for doc", docId);
}
async function deleteAnnotation(docId, annotationId) {
  const key = `doc_${docId}`;
  const result = await chrome.storage.local.get(key);
  const docData = result[key] || { annotations: [] };
  docData.annotations = docData.annotations.filter((a) => a.id !== annotationId);
  await chrome.storage.local.set({ [key]: docData });
  log("Deleted annotation", annotationId, "from doc", docId);
}
async function attachRecording(docId, annotationId, recordingDataUrl) {
  const key = `doc_${docId}`;
  const result = await chrome.storage.local.get(key);
  const docData = result[key] || { annotations: [] };
  const annotation = docData.annotations.find((a) => a.id === annotationId);
  if (annotation) {
    annotation.recordingDataUrl = recordingDataUrl;
    await chrome.storage.local.set({ [key]: docData });
    log("Attached recording to annotation", annotationId);
  } else {
    throw new Error(`Annotation ${annotationId} not found`);
  }
}
