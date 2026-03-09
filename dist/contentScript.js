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
    let mutationDebounceTimer = null;
    let renderScheduled = false;
    try {
      chrome.runtime.onMessage.addListener(function(message, _sender, sendResponse) {
        const { type } = message || {};
        if (!type) return false;
        switch (type) {
          case "PING":
            sendResponse({ type: "PONG" });
            return false;
          case "TOGGLE_SIDEBAR":
            toggleSidebar();
            sendResponse({ ok: true });
            return false;
          case "GET_SELECTION":
            sendResponse({ ok: true, selection: currentSelection });
            return false;
          case "RENDER_ANNOTATION":
            if (message.annotation) {
              addOrUpdateAnnotation(message.annotation);
              scheduleRender();
            }
            sendResponse({ ok: true });
            return false;
          case "DELETE_ANNOTATION":
            if (message.annotationId) {
              annotations = annotations.filter((a) => a.id !== message.annotationId);
              scheduleRender();
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
      const id = setInterval(() => {
        if (isEditorFrame()) {
          clearInterval(id);
          init();
        } else if (++attempts >= 60) {
          clearInterval(id);
          log("Editor frame not found after 30 s – not activating in this frame.");
        }
      }, 500);
    }
    waitForEditorAndInit();
    async function init() {
      log("Editor frame detected – initialising VoxEdit.");
      createOverlayRoot();
      setupSelectionListener();
      setupScrollResizeListeners();
      await loadAndRestoreAnnotations();
      setupMutationObserver();
    }
    function getDocId() {
      const match = window.location.pathname.match(/\/document\/d\/([^/]+)/);
      return match ? match[1] : null;
    }
    function getScrollOffsets() {
      const editor = document.querySelector(".kix-appview-editor");
      if (editor) {
        let el = editor.parentElement;
        while (el && el !== document.body) {
          if (el.scrollTop > 0 || el.scrollLeft > 0) {
            return { scrollX: el.scrollLeft, scrollY: el.scrollTop };
          }
          el = el.parentElement;
        }
      }
      return { scrollX: window.scrollX || 0, scrollY: window.scrollY || 0 };
    }
    function createOverlayRoot() {
      const existing = document.getElementById("voxedit-overlay-root");
      if (existing) {
        overlayRoot = existing;
        return;
      }
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
    function scheduleRender() {
      if (renderScheduled) return;
      renderScheduled = true;
      requestAnimationFrame(() => {
        renderScheduled = false;
        renderAllOverlays();
      });
    }
    function extractContext(range) {
      const CONTEXT_LEN = 80;
      const editor = document.querySelector(".kix-appview-editor") || document.body;
      try {
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
        let fullText = "";
        let startPos = -1;
        let endPos = -1;
        let node;
        while (node = walker.nextNode()) {
          const pos = fullText.length;
          if (node === range.startContainer) startPos = pos + range.startOffset;
          if (node === range.endContainer) endPos = pos + range.endOffset;
          fullText += node.textContent;
        }
        if (startPos === -1) return { contextBefore: "", contextAfter: "" };
        if (endPos === -1) endPos = fullText.length;
        return {
          contextBefore: fullText.slice(Math.max(0, startPos - CONTEXT_LEN), startPos),
          contextAfter: fullText.slice(endPos, Math.min(fullText.length, endPos + CONTEXT_LEN))
        };
      } catch (_) {
        return { contextBefore: "", contextAfter: "" };
      }
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
        const { contextBefore, contextAfter } = extractContext(range);
        const clientRects = Array.from(range.getClientRects());
        if (!clientRects.length) {
          currentSelection = null;
          return;
        }
        const { scrollX, scrollY } = getScrollOffsets();
        const docRects = clientRects.map((r) => ({
          top: r.top + scrollY,
          left: r.left + scrollX,
          right: r.right + scrollX,
          bottom: r.bottom + scrollY,
          width: r.width,
          height: r.height
        }));
        currentSelection = { text, contextBefore, contextAfter, rects: docRects, docId };
      } catch (e) {
        err("handleSelectionChange:", e.message);
        currentSelection = null;
      }
    }
    function setupSelectionListener() {
      document.addEventListener("selectionchange", debounce(handleSelectionChange, 150));
    }
    function toggleSidebar() {
      sidebarVisible ? hideSidebar() : showSidebar();
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
          boxShadow: "-2px 0 12px rgba(0,0,0,0.15)"
        });
        document.body.appendChild(sidebarFrame);
        sidebarVisible = true;
        log("Sidebar shown.");
      } catch (e) {
        err("showSidebar:", e.message);
      }
    }
    function hideSidebar() {
      if (sidebarFrame) sidebarFrame.style.display = "none";
      sidebarVisible = false;
    }
    function addOrUpdateAnnotation(annotation) {
      const idx = annotations.findIndex((a) => a.id === annotation.id);
      if (idx >= 0) annotations[idx] = annotation;
      else annotations.push(annotation);
    }
    function findRectsForAnnotation(annotation) {
      try {
        const editor = document.querySelector(".kix-appview-editor");
        if (!editor) return null;
        const target = annotation.selectedText;
        if (!target) return null;
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
        const segments = [];
        let fullText = "";
        let node;
        while (node = walker.nextNode()) {
          const t = node.textContent;
          if (!t.length) continue;
          segments.push({ node, start: fullText.length, end: fullText.length + t.length });
          fullText += t;
        }
        if (!fullText || !segments.length) return null;
        let targetStart = -1;
        if (annotation.contextBefore) {
          const probe = annotation.contextBefore.slice(-20) + target;
          const probeIdx = fullText.indexOf(probe);
          if (probeIdx !== -1) {
            targetStart = probeIdx + probe.length - target.length;
          }
        }
        if (targetStart === -1) {
          targetStart = fullText.indexOf(target);
        }
        if (targetStart === -1) return null;
        const targetEnd = targetStart + target.length;
        const startSeg = segments.find((s) => s.start <= targetStart && s.end > targetStart);
        const endSeg = segments.find((s) => s.start < targetEnd && s.end >= targetEnd);
        if (!startSeg || !endSeg) return null;
        const range = document.createRange();
        range.setStart(startSeg.node, targetStart - startSeg.start);
        range.setEnd(endSeg.node, targetEnd - endSeg.start);
        const rects = Array.from(range.getClientRects());
        return rects.length ? rects : null;
      } catch (e) {
        err("findRectsForAnnotation:", e.message);
        return null;
      }
    }
    function renderAllOverlays() {
      if (!overlayRoot) return;
      overlayRoot.innerHTML = "";
      const { scrollX, scrollY } = getScrollOffsets();
      for (const annotation of annotations) {
        renderAnnotationOverlay(annotation, scrollX, scrollY);
      }
    }
    function renderAnnotationOverlay(annotation, scrollX, scrollY) {
      if (!overlayRoot) return;
      const clientRects = findRectsForAnnotation(annotation);
      if (!clientRects || !clientRects.length) {
        annotation.orphaned = true;
        renderOrphanedBadge(annotation);
        return;
      }
      annotation.orphaned = false;
      for (const rect of clientRects) {
        const hl = document.createElement("div");
        hl.className = "voxedit-highlight";
        hl.dataset.annotationId = annotation.id;
        Object.assign(hl.style, {
          position: "absolute",
          top: `${rect.top + scrollY}px`,
          left: `${rect.left + scrollX}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          backgroundColor: "rgba(255, 193, 7, 0.3)",
          pointerEvents: "none",
          borderRadius: "2px"
        });
        overlayRoot.appendChild(hl);
      }
      const first = clientRects[0];
      const hasAudio = !!annotation.recordingDataUrl;
      const badge = document.createElement("div");
      badge.className = "voxedit-badge";
      badge.dataset.annotationId = annotation.id;
      badge.title = `VoxEdit: "${annotation.selectedText.slice(0, 50)}"`;
      Object.assign(badge.style, {
        position: "absolute",
        top: `${first.top + scrollY - 1}px`,
        left: `${first.right + scrollX + 6}px`,
        width: "24px",
        height: "24px",
        borderRadius: "50%",
        backgroundColor: hasAudio ? "#1565C0" : "#e53935",
        color: "white",
        fontSize: "11px",
        lineHeight: "24px",
        textAlign: "center",
        cursor: "pointer",
        pointerEvents: "all",
        zIndex: "1000000",
        fontFamily: "Arial, sans-serif",
        boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
        userSelect: "none",
        transition: "transform 0.1s ease, box-shadow 0.1s ease"
      });
      badge.textContent = hasAudio ? "▶" : "🎤";
      badge.addEventListener("mouseenter", () => {
        badge.style.transform = "scale(1.2)";
        badge.style.boxShadow = "0 3px 10px rgba(0,0,0,0.35)";
      });
      badge.addEventListener("mouseleave", () => {
        badge.style.transform = "";
        badge.style.boxShadow = "0 2px 6px rgba(0,0,0,0.25)";
      });
      badge.addEventListener("click", () => {
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
      badge.title = `[Text not found] "${annotation.selectedText}"`;
      Object.assign(badge.style, {
        position: "fixed",
        top: "56px",
        right: sidebarVisible ? "356px" : "16px",
        padding: "3px 8px",
        backgroundColor: "#9e9e9e",
        color: "white",
        fontSize: "11px",
        borderRadius: "4px",
        pointerEvents: "all",
        cursor: "pointer",
        zIndex: "1000001",
        fontFamily: "Arial, sans-serif",
        maxWidth: "160px",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      });
      badge.textContent = `⚠ ${annotation.selectedText.slice(0, 20)}`;
      overlayRoot.appendChild(badge);
    }
    function setupScrollResizeListeners() {
      const debouncedRender = debounce(scheduleRender, 60);
      window.addEventListener("scroll", debouncedRender, { passive: true });
      window.addEventListener("resize", debounce(scheduleRender, 100), { passive: true });
      const editor = document.querySelector(".kix-appview-editor");
      if (editor) {
        let el = editor.parentElement;
        while (el && el !== document.body) {
          el.addEventListener("scroll", debouncedRender, { passive: true });
          el = el.parentElement;
        }
      }
      window.addEventListener("message", (event) => {
        const { type } = event.data || {};
        if (type === "CLOSE_SIDEBAR") hideSidebar();
      });
    }
    function setupMutationObserver() {
      const target = document.querySelector(".kix-appview-editor");
      if (target) {
        startObserving(target);
        return;
      }
      let attempts = 0;
      const id = setInterval(() => {
        const t = document.querySelector(".kix-appview-editor");
        if (t) {
          clearInterval(id);
          startObserving(t);
        } else if (++attempts > 60) clearInterval(id);
      }, 500);
    }
    function startObserving(target) {
      if (mutationObserver) mutationObserver.disconnect();
      mutationObserver = new MutationObserver(() => {
        clearTimeout(mutationDebounceTimer);
        mutationDebounceTimer = setTimeout(scheduleRender, 300);
      });
      mutationObserver.observe(target, {
        childList: true,
        subtree: true,
        characterData: false,
        attributes: false
      });
      log("MutationObserver started on .kix-appview-editor.");
    }
    async function loadAndRestoreAnnotations() {
      try {
        const docId = getDocId();
        if (!docId) {
          log("No docId – skipping annotation restore.");
          return;
        }
        const response = await chrome.runtime.sendMessage({ type: "GET_ANNOTATIONS", docId });
        if (!response || !response.ok) {
          log("GET_ANNOTATIONS returned no data.");
          return;
        }
        annotations = response.annotations || [];
        log(`Restored ${annotations.length} annotation(s) for doc ${docId}.`);
        scheduleRender();
      } catch (e) {
        err("loadAndRestoreAnnotations:", e.message);
      }
    }
  })();
})();
