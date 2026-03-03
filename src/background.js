/**
 * VoxEdit Background Service Worker (MV3)
 *
 * Responsibilities:
 *  - Relay messages between popup and content script
 *  - Manage sidebar injection lifecycle
 *  - Handle storage operations on behalf of other contexts
 *
 * Design principles:
 *  - No eval, no dynamic code
 *  - Wrap every chrome API call in try/catch
 *  - Log all errors without crashing
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const PING_TIMEOUT_MS = 800;

// ─── Utility helpers ─────────────────────────────────────────────────────────

function log(...args) {
  console.log('[VoxEdit BG]', ...args);
}

function err(...args) {
  console.error('[VoxEdit BG]', ...args);
}

/**
 * Send a message to a specific tab's content script.
 * Returns null on any failure rather than throwing.
 */
async function sendToTab(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response;
  } catch (e) {
    err('sendToTab failed:', e.message);
    return null;
  }
}

// ─── Extension install / update ───────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  log('Installed / updated. Reason:', details.reason);
  // Nothing to initialise in storage at install time – each docId gets
  // its own namespace created lazily on first annotation.
});

// ─── Message handler ──────────────────────────────────────────────────────────
//
// All messages from popup or content scripts funnel through here.
// We use a synchronous outer handler and return true only when we will
// respond asynchronously, preventing the port from closing prematurely.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type } = message || {};

  if (!type) {
    err('Received message with no type', message);
    sendResponse({ ok: false, error: 'no_type' });
    return false;
  }

  // ---------- PING from popup → relay to content script ----------
  if (type === 'PING_TAB') {
    const { tabId } = message;
    if (typeof tabId !== 'number') {
      sendResponse({ ok: false, error: 'no_tabId' });
      return false;
    }

    (async () => {
      const response = await sendToTab(tabId, { type: 'PING' });
      if (response && response.type === 'PONG') {
        sendResponse({ ok: true, alive: true });
      } else {
        sendResponse({ ok: true, alive: false });
      }
    })();

    return true; // async response
  }

  // ---------- TOGGLE_SIDEBAR from popup ----------
  if (type === 'TOGGLE_SIDEBAR') {
    const { tabId } = message;
    if (typeof tabId !== 'number') {
      sendResponse({ ok: false, error: 'no_tabId' });
      return false;
    }

    (async () => {
      const response = await sendToTab(tabId, { type: 'TOGGLE_SIDEBAR' });
      sendResponse(response || { ok: false, error: 'no_response' });
    })();

    return true;
  }

  // ---------- ATTACH_ANNOTATION from sidebar ----------
  if (type === 'ATTACH_ANNOTATION') {
    const { annotation } = message;
    if (!annotation || !annotation.docId) {
      sendResponse({ ok: false, error: 'invalid_annotation' });
      return false;
    }

    (async () => {
      try {
        await saveAnnotation(annotation);
        // Forward to content script so the overlay is rendered immediately.
        // We must find the correct tab for this docId.
        const tabs = await chrome.tabs.query({
          url: `https://docs.google.com/document/d/${annotation.docId}/*`,
        });
        for (const tab of tabs) {
          await sendToTab(tab.id, { type: 'RENDER_ANNOTATION', annotation });
        }
        sendResponse({ ok: true });
      } catch (e) {
        err('ATTACH_ANNOTATION failed:', e.message);
        sendResponse({ ok: false, error: e.message });
      }
    })();

    return true;
  }

  // ---------- GET_ANNOTATIONS from content script / sidebar ----------
  if (type === 'GET_ANNOTATIONS') {
    const { docId } = message;
    if (!docId) {
      sendResponse({ ok: false, error: 'no_docId' });
      return false;
    }

    (async () => {
      const annotations = await loadAnnotations(docId);
      sendResponse({ ok: true, annotations });
    })();

    return true;
  }

  // ---------- DELETE_ANNOTATION ----------
  if (type === 'DELETE_ANNOTATION') {
    const { docId, annotationId } = message;
    if (!docId || !annotationId) {
      sendResponse({ ok: false, error: 'missing_fields' });
      return false;
    }

    (async () => {
      try {
        await deleteAnnotation(docId, annotationId);
        sendResponse({ ok: true });
      } catch (e) {
        err('DELETE_ANNOTATION failed:', e.message);
        sendResponse({ ok: false, error: e.message });
      }
    })();

    return true;
  }

  // ---------- UPDATE_RECORDING ----------
  if (type === 'UPDATE_RECORDING') {
    const { docId, annotationId, recordingDataUrl } = message;
    if (!docId || !annotationId || !recordingDataUrl) {
      sendResponse({ ok: false, error: 'missing_fields' });
      return false;
    }

    (async () => {
      try {
        await attachRecording(docId, annotationId, recordingDataUrl);
        sendResponse({ ok: true });
      } catch (e) {
        err('UPDATE_RECORDING failed:', e.message);
        sendResponse({ ok: false, error: e.message });
      }
    })();

    return true;
  }

  // ---------- Unknown ----------
  err('Unknown message type:', type);
  sendResponse({ ok: false, error: 'unknown_type' });
  return false;
});

// ─── Storage helpers ──────────────────────────────────────────────────────────

/**
 * Load all annotations for a document.
 * @param {string} docId
 * @returns {Promise<Array>}
 */
async function loadAnnotations(docId) {
  try {
    const key = `doc_${docId}`;
    const result = await chrome.storage.local.get(key);
    return result[key]?.annotations || [];
  } catch (e) {
    err('loadAnnotations failed:', e.message);
    return [];
  }
}

/**
 * Persist a new annotation, or update an existing one by id.
 * @param {Object} annotation
 */
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
  log('Saved annotation', annotation.id, 'for doc', docId);
}

/**
 * Delete a single annotation by id.
 * @param {string} docId
 * @param {string} annotationId
 */
async function deleteAnnotation(docId, annotationId) {
  const key = `doc_${docId}`;
  const result = await chrome.storage.local.get(key);
  const docData = result[key] || { annotations: [] };
  docData.annotations = docData.annotations.filter((a) => a.id !== annotationId);
  await chrome.storage.local.set({ [key]: docData });
  log('Deleted annotation', annotationId, 'from doc', docId);
}

/**
 * Attach a base64 recording dataURL to an existing annotation.
 * @param {string} docId
 * @param {string} annotationId
 * @param {string} recordingDataUrl
 */
async function attachRecording(docId, annotationId, recordingDataUrl) {
  const key = `doc_${docId}`;
  const result = await chrome.storage.local.get(key);
  const docData = result[key] || { annotations: [] };
  const annotation = docData.annotations.find((a) => a.id === annotationId);
  if (annotation) {
    annotation.recordingDataUrl = recordingDataUrl;
    await chrome.storage.local.set({ [key]: docData });
    log('Attached recording to annotation', annotationId);
  } else {
    throw new Error(`Annotation ${annotationId} not found`);
  }
}
