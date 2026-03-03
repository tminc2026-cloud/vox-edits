/**
 * VoxEdit Sidebar Script
 *
 * Runs inside the sidebar iframe injected by the content script.
 *
 * Responsibilities:
 *  - Show current text selection (polled from parent frame).
 *  - Record voice notes via MediaRecorder.
 *  - Attach recordings to selected text → save via background worker.
 *  - List all annotations for the current doc.
 *  - Allow deleting annotations.
 *  - Receive SHOW_ANNOTATION messages from content script badges.
 *
 * Constraints:
 *  - No inline JS / handlers in HTML.
 *  - No eval / new Function.
 *  - All chrome.runtime calls wrapped in try/catch.
 *  - MediaRecorder started only from user gesture.
 */

'use strict';

(function VoxEditSidebar() {

  // ─── DOM refs ─────────────────────────────────────────────────────────────

  const selectionPreview = document.getElementById('selection-preview');
  const recordBtn        = document.getElementById('record-btn');
  const recordStatus     = document.getElementById('record-status');
  const recordTimer      = document.getElementById('record-timer');
  const attachBtn        = document.getElementById('attach-btn');
  const playbackArea     = document.getElementById('playback-area');
  const playbackAudio    = document.getElementById('playback-audio');
  const annotationsList  = document.getElementById('annotations-list');
  const errorToast       = document.getElementById('error-toast');
  const closeBtn         = document.getElementById('close-btn');

  // ─── State ────────────────────────────────────────────────────────────────

  let mediaRecorder     = null;
  let audioChunks       = [];
  let recordingBlob     = null;
  let recordingDataUrl  = null;
  let isRecording       = false;
  let timerInterval     = null;
  let elapsedSeconds    = 0;
  const MAX_DURATION_S  = 60;

  /** @type {{ text: string, contextBefore: string, contextAfter: string, rects: DOMRect[], docId: string } | null} */
  let currentSelection  = null;

  /** @type {Array} */
  let annotations       = [];

  let currentDocId      = null;
  let highlightedId     = null;

  // ─── Utility ─────────────────────────────────────────────────────────────

  function log(...args) {
    console.log('[VoxEdit Sidebar]', ...args);
  }

  function showError(msg) {
    errorToast.textContent = msg;
    errorToast.style.display = 'block';
    setTimeout(() => { errorToast.style.display = 'none'; }, 4000);
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function formatTime(s) {
    const m = Math.floor(s / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  // ─── chrome.runtime wrapper ───────────────────────────────────────────────

  function sendToBackground(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            log('runtime.lastError:', chrome.runtime.lastError.message);
            resolve(null);
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        log('sendToBackground error:', e.message);
        resolve(null);
      }
    });
  }

  // ─── Selection polling ───────────────────────────────────────────────────
  //
  // The sidebar is an iframe; it cannot directly read the parent frame's
  // selection. We poll the content script via chrome.runtime messaging.

  async function pollSelection() {
    if (!currentDocId) return;

    try {
      // Ask the content script (in the parent tab) for current selection.
      // We use chrome.tabs.query to find the docs tab.
      const tabs = await chrome.tabs.query({
        url: `https://docs.google.com/document/d/${currentDocId}/*`,
        active: true,
      });

      // Fallback – search all matching tabs if no active match
      let tab = tabs[0];
      if (!tab) {
        const allTabs = await chrome.tabs.query({
          url: `https://docs.google.com/document/d/${currentDocId}/*`,
        });
        tab = allTabs[0];
      }

      if (!tab) return;

      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELECTION' });
      if (resp && resp.ok && resp.selection && resp.selection.text) {
        currentSelection = resp.selection;
        updateSelectionUI(currentSelection.text);
      } else {
        // Don't clear selection that is already set – user may have just
        // clicked the sidebar without deselecting
      }
    } catch (e) {
      // Silence – tab may not have content script yet
    }
  }

  function updateSelectionUI(text) {
    if (text) {
      selectionPreview.textContent = `"${text}"`;
      selectionPreview.classList.remove('empty');
    } else {
      selectionPreview.textContent = 'Select text in Google Docs to annotate…';
      selectionPreview.classList.add('empty');
    }
  }

  // Poll every 800 ms
  setInterval(pollSelection, 800);

  // ─── Recording ───────────────────────────────────────────────────────────

  recordBtn.addEventListener('click', function () {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks  = [];
      recordingBlob = null;
      recordingDataUrl = null;
      playbackArea.style.display = 'none';
      attachBtn.disabled = true;

      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };

      mediaRecorder.onstop = function () {
        // Stop all tracks to release mic
        stream.getTracks().forEach((t) => t.stop());
        recordingBlob = new Blob(audioChunks, { type: 'audio/webm' });
        blobToDataUrl(recordingBlob).then((dataUrl) => {
          recordingDataUrl = dataUrl;
          playbackAudio.src = dataUrl;
          playbackArea.style.display = 'block';
          attachBtn.disabled = !currentSelection;
        });
      };

      mediaRecorder.start(250); // collect in 250 ms chunks
      isRecording = true;

      recordBtn.classList.add('recording');
      recordBtn.textContent = '⏹';
      recordStatus.textContent = 'Recording…';
      elapsedSeconds = 0;
      recordTimer.textContent = `0:00 / ${formatTime(MAX_DURATION_S)}`;

      timerInterval = setInterval(() => {
        elapsedSeconds++;
        recordTimer.textContent = `${formatTime(elapsedSeconds)} / ${formatTime(MAX_DURATION_S)}`;
        if (elapsedSeconds >= MAX_DURATION_S) {
          stopRecording();
        }
      }, 1000);

    } catch (e) {
      log('startRecording error:', e.message);
      showError('Microphone access denied or unavailable.');
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    isRecording = false;
    clearInterval(timerInterval);
    timerInterval = null;

    recordBtn.classList.remove('recording');
    recordBtn.textContent = '🎤';
    recordStatus.textContent = 'Recording saved. Press Attach to link.';
    recordTimer.textContent = '';
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // ─── Attach annotation ───────────────────────────────────────────────────

  attachBtn.addEventListener('click', async function () {
    if (!currentSelection || !currentSelection.text) {
      showError('No text selected. Select text in Google Docs first.');
      return;
    }

    if (!recordingDataUrl) {
      showError('No recording. Record audio first.');
      return;
    }

    attachBtn.disabled = true;
    attachBtn.textContent = 'Attaching…';

    try {
      const annotation = {
        id:               generateId(),
        docId:            currentSelection.docId,
        selectedText:     currentSelection.text,
        contextBefore:    currentSelection.contextBefore,
        contextAfter:     currentSelection.contextAfter,
        recordingDataUrl: recordingDataUrl,
        createdAt:        new Date().toISOString(),
        orphaned:         false,
      };

      const resp = await sendToBackground({ type: 'ATTACH_ANNOTATION', annotation });

      if (resp && resp.ok) {
        recordingDataUrl = null;
        recordingBlob    = null;
        playbackArea.style.display = 'none';
        recordStatus.textContent = 'Annotation attached!';
        currentDocId = currentSelection.docId;
        await loadAnnotations();
      } else {
        showError('Failed to attach annotation. Please try again.');
      }
    } catch (e) {
      log('attach error:', e.message);
      showError('Unexpected error attaching annotation.');
    }

    attachBtn.textContent = 'Attach';
    attachBtn.disabled = true;
  });

  // ─── Load & render annotations ───────────────────────────────────────────

  async function loadAnnotations() {
    if (!currentDocId) return;

    const resp = await sendToBackground({ type: 'GET_ANNOTATIONS', docId: currentDocId });
    annotations = (resp && resp.ok && resp.annotations) ? resp.annotations : [];
    renderAnnotations();
  }

  function renderAnnotations() {
    annotationsList.innerHTML = '';

    if (!annotations.length) {
      const el = document.createElement('div');
      el.className = 'no-annotations';
      el.textContent = 'No annotations yet.';
      annotationsList.appendChild(el);
      return;
    }

    // Most recent first
    const sorted = [...annotations].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    for (const annotation of sorted) {
      annotationsList.appendChild(buildAnnotationCard(annotation));
    }
  }

  function buildAnnotationCard(annotation) {
    const card = document.createElement('div');
    card.className = 'annotation-card' +
      (annotation.orphaned ? ' orphaned' : '') +
      (annotation.id === highlightedId ? ' highlighted' : '');
    card.dataset.annotationId = annotation.id;

    // Header row
    const header = document.createElement('div');
    header.className = 'card-header';

    const textEl = document.createElement('div');
    textEl.className = 'card-text' + (annotation.orphaned ? ' orphaned-label' : '');
    textEl.textContent = `"${annotation.selectedText}"`;
    if (annotation.orphaned) {
      textEl.textContent = `⚠ [Text not found] "${annotation.selectedText}"`;
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'card-delete';
    deleteBtn.title = 'Delete annotation';
    deleteBtn.textContent = '✕';
    deleteBtn.addEventListener('click', function () {
      deleteAnnotation(annotation.id, annotation.docId);
    });

    header.appendChild(textEl);
    header.appendChild(deleteBtn);

    // Meta row
    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.textContent = new Date(annotation.createdAt).toLocaleString();

    card.appendChild(header);
    card.appendChild(meta);

    // Audio player
    if (annotation.recordingDataUrl) {
      const audio = document.createElement('audio');
      audio.className = 'card-audio';
      audio.controls = true;
      audio.src = annotation.recordingDataUrl;
      card.appendChild(audio);
    }

    return card;
  }

  async function deleteAnnotation(annotationId, docId) {
    const resp = await sendToBackground({
      type: 'DELETE_ANNOTATION',
      docId,
      annotationId,
    });

    if (resp && resp.ok) {
      annotations = annotations.filter((a) => a.id !== annotationId);
      renderAnnotations();
    } else {
      showError('Failed to delete annotation.');
    }
  }

  // ─── Receive messages from content script (via postMessage) ──────────────
  //
  // The content script badge click fires postMessage to the sidebar iframe.

  window.addEventListener('message', function (event) {
    const { type, annotationId } = event.data || {};
    if (type === 'SHOW_ANNOTATION' && annotationId) {
      highlightedId = annotationId;
      renderAnnotations();
      const card = annotationsList.querySelector(
        `[data-annotation-id="${annotationId}"]`
      );
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  // ─── Close button ─────────────────────────────────────────────────────────

  closeBtn.addEventListener('click', function () {
    // Tell the parent frame to hide the sidebar
    try {
      window.parent.postMessage({ type: 'CLOSE_SIDEBAR' }, '*');
    } catch (e) {
      log('Could not message parent:', e.message);
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────────────

  async function init() {
    log('Sidebar initialised.');

    // Extract docId from parent location (passed via URL or queried from tabs)
    try {
      // The sidebar iframe src doesn't know the docId, so we query it from the
      // active tab's URL. This works because the extension has activeTab permission.
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (tab && tab.url) {
        const match = tab.url.match(/\/document\/d\/([^/]+)/);
        currentDocId = match ? match[1] : null;
      }
    } catch (e) {
      log('Could not determine docId:', e.message);
    }

    if (currentDocId) {
      await loadAnnotations();
    }
  }

  // Run after DOM is ready (script is at end of body so DOM is already ready)
  init();

})();
