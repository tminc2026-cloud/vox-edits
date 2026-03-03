(function() {
  "use strict";
  (function VoxEditContentScript() {
    if (window.__voxEditLoaded) return;
    window.__voxEditLoaded = true;
    function log(...args) {
      console.log("[VoxEdit CS]", ...args);
    }
    function err(...args) {
      console.error("[VoxEdit CS]", ...args);
    }
    let annotations = [];
    let currentSelection = null;
    let sidebarVisible = false;
    let sidebarFrame = null;
    let overlayRoot = null;
    let mutationObserver = null;
    let mutationThrottleTimer = null;
    try {
      chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
        const { type } = message || {};
        if (!type) return false;
        if (type === "PING") {
          sendResponse({ type: "PONG" });
          return false;
        }
        if (type === "TOGGLE_SIDEBAR") {
          toggleSidebar();
          sendResponse({ ok: true });
          return false;
        }
        if (type === "GET_SELECTION") {
          sendResponse({ ok: true, selection: currentSelection });
          return false;
        }
        if (type === "RENDER_ANNOTATION") {
          const { annotation } = message;
          if (annotation) {
            addOrUpdateAnnotation(annotation);
            renderAllOverlays();
          }
          sendResponse({ ok: true });
          return false;
        }
        if (type === "DELETE_ANNOTATION") {
          const { annotationId } = message;
          if (annotationId) {
            annotations = annotations.filter((a) => a.id !== annotationId);
            renderAllOverlays();
          }
          sendResponse({ ok: true });
          return false;
        }
        return false;
      });
    } catch (e) {
      err("Failed to register message listener:", e.message);
    }
    function isEditorFrame() {
      return !!document.querySelector(".kix-appview-editor");
    }
    function waitForEditorAndInit() {
      if (isEditorFrame()) {
        init();
        return;
      }
      let attempts = 0;
      const maxAttempts = 60;
      const intervalId = setInterval(() => {
        attempts++;
        if (isEditorFrame()) {
          clearInterval(intervalId);
          init();
        } else if (attempts >= maxAttempts) {
          clearInterval(intervalId);
          log("Editor frame not found after 30 s – not activating in this frame.");
        }
      }, 500);
    }
    waitForEditorAndInit();
    async function init() {
      log("Editor frame detected – initialising VoxEdit.");
      createOverlayRoot();
      setupSelectionListener();
      setupMutationObserver();
      setupScrollResizeListeners();
      await loadAndRestoreAnnotations();
    }
    function getDocId() {
      const match = window.location.pathname.match(/\/document\/d\/([^/]+)/);
      return match ? match[1] : null;
    }
    function createOverlayRoot() {
      if (document.getElementById("voxedit-overlay-root")) return;
      overlayRoot = document.createElement("div");
      overlayRoot.id = "voxedit-overlay-root";
      Object.assign(overlayRoot.style, {
        position: "absolute",
        top: "0",
        left: "0",
        width: "0",
        height: "0",
        pointerEvents: "none",
        zIndex: "999999",
        overflow: "visible"
      });
      document.body.appendChild(overlayRoot);
      log("Overlay root created.");
    }
    function debounce(fn, delay) {
      let timer;
      return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
      };
    }
    function handleSelectionChange() {
      try {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          currentSelection = null;
          return;
        }
        const range = selection.getRangeAt(0);
        const text = selection.toString().trim();
        if (!text) {
          currentSelection = null;
          return;
        }
        const docId = getDocId();
        if (!docId) {
          currentSelection = null;
          return;
        }
        const fullText = range.startContainer.textContent || "";
        const startOffset = range.startOffset;
        const endOffset = range.endContainer === range.startContainer ? range.endOffset : range.startContainer.textContent.length;
        const contextBefore = fullText.substring(
          Math.max(0, startOffset - 50),
          startOffset
        );
        const contextAfter = fullText.substring(
          endOffset,
          Math.min(fullText.length, endOffset + 50)
        );
        const clientRects = Array.from(range.getClientRects());
        if (!clientRects.length) {
          currentSelection = null;
          return;
        }
        currentSelection = {
          text,
          contextBefore,
          contextAfter,
          rects: clientRects,
          docId
        };
      } catch (e) {
        err("handleSelectionChange:", e.message);
        currentSelection = null;
      }
    }
    function setupSelectionListener() {
      document.addEventListener(
        "selectionchange",
        debounce(handleSelectionChange, 150)
      );
    }
    function toggleSidebar() {
      if (sidebarVisible) {
        hideSidebar();
      } else {
        showSidebar();
      }
    }
    function showSidebar() {
      if (sidebarFrame) {
        sidebarFrame.style.display = "block";
        sidebarVisible = true;
        return;
      }
      try {
        sidebarFrame = document.createElement("iframe");
        sidebarFrame.id = "voxedit-sidebar-frame";
        sidebarFrame.src = chrome.runtime.getURL("sidebar.html");
        Object.assign(sidebarFrame.style, {
          position: "fixed",
          top: "0",
          right: "0",
          width: "340px",
          height: "100%",
          border: "none",
          zIndex: "2147483647",
          backgroundColor: "white",
          boxShadow: "-2px 0 8px rgba(0,0,0,0.2)"
        });
        document.body.appendChild(sidebarFrame);
        sidebarVisible = true;
        log("Sidebar shown.");
      } catch (e) {
        err("showSidebar:", e.message);
      }
    }
    function hideSidebar() {
      if (sidebarFrame) {
        sidebarFrame.style.display = "none";
      }
      sidebarVisible = false;
      log("Sidebar hidden.");
    }
    function addOrUpdateAnnotation(annotation) {
      const idx = annotations.findIndex((a) => a.id === annotation.id);
      if (idx >= 0) {
        annotations[idx] = annotation;
      } else {
        annotations.push(annotation);
      }
    }
    function renderAllOverlays() {
      if (!overlayRoot) return;
      overlayRoot.innerHTML = "";
      for (const annotation of annotations) {
        renderAnnotationOverlay(annotation);
      }
    }
    function renderAnnotationOverlay(annotation) {
      if (!overlayRoot) return;
      const rects = findRectsForAnnotation(annotation);
      if (!rects || rects.length === 0) {
        annotation.orphaned = true;
        renderOrphanedBadge(annotation);
        return;
      }
      annotation.orphaned = false;
      for (const rect of rects) {
        const highlight = document.createElement("div");
        highlight.className = "voxedit-highlight";
        highlight.dataset.annotationId = annotation.id;
        Object.assign(highlight.style, {
          position: "absolute",
          top: `${rect.top + window.scrollY}px`,
          left: `${rect.left + window.scrollX}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          backgroundColor: "rgba(255, 200, 0, 0.35)",
          pointerEvents: "none",
          borderRadius: "2px"
        });
        overlayRoot.appendChild(highlight);
      }
      const firstRect = rects[0];
      const badge = document.createElement("div");
      badge.className = "voxedit-badge";
      badge.dataset.annotationId = annotation.id;
      badge.title = annotation.selectedText;
      Object.assign(badge.style, {
        position: "absolute",
        top: `${firstRect.top + window.scrollY - 2}px`,
        left: `${firstRect.right + window.scrollX + 4}px`,
        width: "22px",
        height: "22px",
        borderRadius: "50%",
        backgroundColor: annotation.orphaned ? "#999" : "#e53935",
        color: "white",
        fontSize: "12px",
        lineHeight: "22px",
        textAlign: "center",
        cursor: "pointer",
        pointerEvents: "all",
        zIndex: "1000000",
        fontFamily: "Arial, sans-serif",
        fontWeight: "bold",
        boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
        userSelect: "none"
      });
      badge.textContent = annotation.recordingDataUrl ? "▶" : "🎤";
      badge.addEventListener("click", function() {
        showSidebar();
        if (sidebarFrame && sidebarFrame.contentWindow) {
          sidebarFrame.contentWindow.postMessage(
            { type: "SHOW_ANNOTATION", annotationId: annotation.id },
            "*"
          );
        }
      });
      overlayRoot.appendChild(badge);
    }
    function renderOrphanedBadge(annotation) {
      if (!overlayRoot) return;
      const badge = document.createElement("div");
      badge.className = "voxedit-badge voxedit-orphaned";
      badge.dataset.annotationId = annotation.id;
      badge.title = `[Orphaned] ${annotation.selectedText}`;
      Object.assign(badge.style, {
        position: "fixed",
        top: "50px",
        right: "350px",
        padding: "4px 8px",
        backgroundColor: "#999",
        color: "white",
        fontSize: "11px",
        borderRadius: "4px",
        pointerEvents: "all",
        cursor: "pointer",
        zIndex: "1000001",
        fontFamily: "Arial, sans-serif"
      });
      badge.textContent = `⚠ ${annotation.selectedText.substring(0, 20)}…`;
      overlayRoot.appendChild(badge);
    }
    function findRectsForAnnotation(annotation) {
      try {
        const editor = document.querySelector(".kix-appview-editor");
        if (!editor) return null;
        const target = annotation.selectedText;
        if (!target) return null;
        const walker = document.createTreeWalker(
          editor,
          NodeFilter.SHOW_TEXT,
          null
        );
        let node;
        while (node = walker.nextNode()) {
          const nodeText = node.textContent;
          const idx = nodeText.indexOf(target);
          if (idx === -1) continue;
          const before = nodeText.substring(
            Math.max(0, idx - annotation.contextBefore.length),
            idx
          );
          if (annotation.contextBefore && !before.endsWith(annotation.contextBefore.slice(-10))) {
            continue;
          }
          try {
            const range = document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + target.length);
            const rects = Array.from(range.getClientRects());
            if (rects.length) return rects;
          } catch (_) {
          }
        }
        return null;
      } catch (e) {
        err("findRectsForAnnotation:", e.message);
        return null;
      }
    }
    function setupScrollResizeListeners() {
      window.addEventListener("scroll", debounce(renderAllOverlays, 50), {
        passive: true
      });
      window.addEventListener("resize", debounce(renderAllOverlays, 100), {
        passive: true
      });
      window.addEventListener("message", function(event) {
        const { type } = event.data || {};
        if (type === "CLOSE_SIDEBAR") {
          hideSidebar();
        }
      });
    }
    function setupMutationObserver() {
      const target = document.querySelector(".kix-appview-editor");
      if (!target) {
        log("No editor element yet – will try to set up MutationObserver later.");
        waitForEditorThenObserve();
        return;
      }
      startObserving(target);
    }
    function waitForEditorThenObserve() {
      let attempts = 0;
      const intervalId = setInterval(() => {
        attempts++;
        const target = document.querySelector(".kix-appview-editor");
        if (target) {
          clearInterval(intervalId);
          startObserving(target);
        } else if (attempts > 60) {
          clearInterval(intervalId);
        }
      }, 500);
    }
    function startObserving(target) {
      if (mutationObserver) {
        mutationObserver.disconnect();
      }
      mutationObserver = new MutationObserver(function(_mutations) {
        if (mutationThrottleTimer) return;
        mutationThrottleTimer = setTimeout(function() {
          mutationThrottleTimer = null;
          renderAllOverlays();
        }, 250);
      });
      mutationObserver.observe(target, {
        childList: true,
        subtree: true,
        characterData: false,
        attributes: false
      });
      log("MutationObserver started on editor element.");
    }
    async function loadAndRestoreAnnotations() {
      try {
        const docId = getDocId();
        if (!docId) {
          log("No docId – skipping annotation restoration.");
          return;
        }
        const response = await chrome.runtime.sendMessage({
          type: "GET_ANNOTATIONS",
          docId
        });
        if (!response || !response.ok) {
          log("GET_ANNOTATIONS failed or returned no data.");
          return;
        }
        const loaded = response.annotations || [];
        annotations = loaded;
        log(`Restored ${annotations.length} annotation(s) for doc ${docId}.`);
        renderAllOverlays();
      } catch (e) {
        err("loadAndRestoreAnnotations:", e.message);
      }
    }
  })();
})();
