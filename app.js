/* =====================================================================
   Nox Commoda — an Excalidraw-inspired vector whiteboard
   Plain JavaScript, no build step, no external dependencies.
   ===================================================================== */
'use strict';

(() => {
  // -------------------------------------------------------------------
  // DOM references & constants
  // -------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const canvas = $('#canvas');
  const ctx = canvas.getContext('2d');
  const wrap = $('#canvasWrap');
  const textEditor = $('#textEditor');
  const measureCtx = document.createElement('canvas').getContext('2d');

  const APP_ID = 'nox-commoda';
  const FILE_VERSION = 1;
  const AUTOSAVE_KEY = 'nox-commoda:autosave';
  const CLIP_MARKER = 'nox-commoda/elements:';
  const LINE_HEIGHT = 1.25;
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 8;
  const HANDLE_PX = 9;          // resize handle size in screen pixels
  const HISTORY_LIMIT = 150;

  const THEME = {
    bg: '#1a1b2e',
    gridDot: 'rgba(189, 147, 249, 0.18)',
    selection: '#06b6d4',
    handleFill: '#1a1b2e',
    handleStroke: '#f472b6',
    marqueeFill: 'rgba(6, 182, 212, 0.08)',
  };

  const PALETTE = ['#e2e8f0', '#bd93f9', '#7c3aed', '#8be9fd', '#06b6d4', '#ff79c6',
    '#f472b6', '#50fa7b', '#f1fa8c', '#ffb86c', '#ff5555', '#6272a4'];

  const BUILTIN_FONTS = ['Caveat', 'Inter', 'JetBrains Mono', 'Fira Code', 'Roboto Mono', 'Ubuntu Mono', 'Cascadia Code'];

  const TOOL_HINTS = {
    select: 'Clique para selecionar · arraste para mover · Shift+clique adiciona à seleção · duplo clique edita texto',
    hand: 'Arraste para navegar pelo quadro · roda do mouse para zoom',
    pencil: 'Clique e arraste para desenhar à mão livre',
    rect: 'Clique e arraste para desenhar um retângulo · Shift mantém um quadrado',
    ellipse: 'Clique e arraste para desenhar uma elipse · Shift mantém um círculo',
    line: 'Clique e arraste para desenhar uma linha · Shift trava em 45°',
    arrow: 'Clique e arraste para desenhar uma seta · Shift trava em 45°',
    text: 'Clique no quadro para escrever · Esc ou clique fora para concluir',
    eraser: 'Clique ou arraste sobre os elementos para apagá-los',
  };

  // Eraser cursor as an inline SVG (circle)
  const ERASER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="7" fill="rgba(244,114,182,0.25)" stroke="#f472b6" stroke-width="2"/></svg>'
  )}") 10 10, crosshair`;

  // -------------------------------------------------------------------
  // Application state
  // -------------------------------------------------------------------
  const state = {
    elements: [],             // drawing elements (bottom -> top)
    selected: new Set(),      // ids of selected elements
    tool: 'select',
    zoom: 1,
    panX: 0,
    panY: 0,
    showGrid: true,
    dirty: false,             // unsaved changes?
    style: {                  // default style for new elements
      strokeColor: '#bd93f9',
      fillColor: 'transparent',
      strokeWidth: 2,
      opacity: 100,
      strokeStyle: 'solid',
      fontFamily: 'Caveat',
      fontSize: 28,
    },
  };

  let history = [];           // undo stack (element snapshots)
  let future = [];            // redo stack
  let action = null;          // current pointer interaction
  let editing = null;         // current text edit session
  let spaceDown = false;
  let needsRender = true;
  let dashOffset = 0;
  let propSnapshot = null;    // snapshot taken when a slider drag starts
  let autosaveTimer = null;
  let autosaveWarned = false;
  let dpr = window.devicePixelRatio || 1;
  let lastPointer = { x: 0, y: 0 };  // last pointer pos in screen coords
  const imageCache = new Map();       // dataURL -> HTMLImageElement
  const fontGroups = { builtin: BUILTIN_FONTS.slice(), folder: [], imported: [], system: [] };

  // -------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const isBoxType = (t) => t === 'rect' || t === 'ellipse' || t === 'text' || t === 'image';
  const isPointType = (t) => t === 'line' || t === 'arrow' || t === 'pencil';
  const byId = (id) => state.elements.find((e) => e.id === id);
  const selectedEls = () => state.elements.filter((e) => state.selected.has(e.id));
  const isFilled = (el) => el.fillColor && el.fillColor !== 'transparent';
  const fontString = (size, family) => `${size}px "${family}", "Inter", sans-serif`;
  const requestRender = () => { needsRender = true; };

  function cloneEl(el) {
    const c = { ...el };
    if (el.points) c.points = el.points.map((p) => [p[0], p[1]]);
    return c;
  }
  const snapshot = () => state.elements.map(cloneEl);

  function isTypingTarget(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  function toast(msg, isError = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // -------------------------------------------------------------------
  // Coordinates
  // -------------------------------------------------------------------
  const screenToWorld = (sx, sy) => ({ x: (sx - state.panX) / state.zoom, y: (sy - state.panY) / state.zoom });
  const worldToScreen = (wx, wy) => ({ x: wx * state.zoom + state.panX, y: wy * state.zoom + state.panY });

  function eventScreenPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function viewCenterWorld() {
    return screenToWorld(wrap.clientWidth / 2, wrap.clientHeight / 2);
  }

  // -------------------------------------------------------------------
  // History (undo / redo) & dirty tracking
  // -------------------------------------------------------------------
  function pushHistory(snap = snapshot()) {
    history.push(snap);
    if (history.length > HISTORY_LIMIT) history.shift();
    future = [];
    markChanged();
  }

  function markChanged() {
    state.dirty = true;
    updateUI();
    scheduleAutosave();
    requestRender();
  }

  function restore(snap) {
    state.elements = snap;
    state.elements.forEach(ensureImage);
    const ids = new Set(state.elements.map((e) => e.id));
    state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
    markChanged();
    syncPanelFromSelection();
  }

  function undo() {
    if (editing) commitText();
    if (!history.length) return;
    future.push(snapshot());
    restore(history.pop());
  }

  function redo() {
    if (!future.length) return;
    history.push(snapshot());
    restore(future.pop());
  }

  // -------------------------------------------------------------------
  // Element geometry
  // -------------------------------------------------------------------
  function getBounds(el) {
    if (isPointType(el.type)) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of el.points) {
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    const x = Math.min(el.x, el.x + el.w), y = Math.min(el.y, el.y + el.h);
    return { x, y, w: Math.abs(el.w), h: Math.abs(el.h) };
  }

  function unionBounds(els) {
    if (!els.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of els) {
      const b = getBounds(el);
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  function normalizeBox(el) {
    if (!isBoxType(el.type)) return;
    if (el.w < 0) { el.x += el.w; el.w = -el.w; }
    if (el.h < 0) { el.y += el.h; el.h = -el.h; }
  }

  /** Recompute width/height of a text element from its content & font. */
  function measureTextEl(el) {
    measureCtx.font = fontString(el.fontSize, el.fontFamily);
    const lines = (el.text || '').split('\n');
    let w = 0;
    for (const l of lines) w = Math.max(w, measureCtx.measureText(l).width);
    el.w = Math.max(w, 2);
    el.h = lines.length * el.fontSize * LINE_HEIGHT;
  }

  const inRect = (p, b, pad = 0) =>
    p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;

  function distToSegment(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / len2 : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(p.x - (a[0] + t * dx), p.y - (a[1] + t * dy));
  }

  /** Does world point p touch element el? */
  function hitTest(el, p) {
    const tol = Math.max(6 / state.zoom, el.strokeWidth / 2 + 2 / state.zoom);
    const b = getBounds(el);
    switch (el.type) {
      case 'text':
      case 'image':
        return inRect(p, b, 3 / state.zoom);
      case 'rect': {
        if (!inRect(p, b, tol)) return false;
        if (isFilled(el)) return true;
        return !inRect(p, { x: b.x + tol, y: b.y + tol, w: b.w - 2 * tol, h: b.h - 2 * tol });
      }
      case 'ellipse': {
        const rx = b.w / 2, ry = b.h / 2;
        if (rx < 1 || ry < 1) return inRect(p, b, tol);
        const d = Math.hypot((p.x - (b.x + rx)) / rx, (p.y - (b.y + ry)) / ry);
        if (isFilled(el) && d <= 1) return true;
        return Math.abs(d - 1) * Math.min(rx, ry) <= tol;
      }
      default: {
        const pts = el.points;
        if (pts.length === 1) return Math.hypot(p.x - pts[0][0], p.y - pts[0][1]) <= tol;
        for (let i = 1; i < pts.length; i++) if (distToSegment(p, pts[i - 1], pts[i]) <= tol) return true;
        return false;
      }
    }
  }

  function topElementAt(p) {
    for (let i = state.elements.length - 1; i >= 0; i--) {
      const el = state.elements[i];
      if (editing && editing.el.id === el.id) continue;
      if (hitTest(el, p)) return el;
    }
    return null;
  }

  // -------------------------------------------------------------------
  // Images
  // -------------------------------------------------------------------
  function ensureImage(el) {
    if (el.type !== 'image' || !el.src || imageCache.has(el.src)) return;
    const img = new Image();
    img.onload = requestRender;
    img.src = el.src;
    imageCache.set(el.src, img);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  const readAsDataURL = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  /** Add an image file (from paste, drop or file picker) to the board. */
  async function addImageFile(file, atWorld = null) {
    try {
      const src = await readAsDataURL(file);
      const img = await loadImage(src);
      imageCache.set(src, img);
      // Fit into 60% of the visible area (in world units)
      const maxW = (wrap.clientWidth * 0.6) / state.zoom;
      const maxH = (wrap.clientHeight * 0.6) / state.zoom;
      const scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
      const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
      const c = atWorld || viewCenterWorld();
      const el = {
        id: uid(), type: 'image', src,
        x: c.x - w / 2, y: c.y - h / 2, w, h,
        strokeColor: state.style.strokeColor, fillColor: 'transparent',
        strokeWidth: state.style.strokeWidth, opacity: state.style.opacity, strokeStyle: 'solid',
      };
      pushHistory();
      state.elements.push(el);
      setTool('select');
      state.selected = new Set([el.id]);
      syncPanelFromSelection();
      markChanged();
      toast('Imagem adicionada ao quadro');
    } catch (err) {
      console.error(err);
      toast('Não foi possível carregar a imagem', true);
    }
  }

  // -------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------
  function resizeCanvas() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(wrap.clientWidth * dpr);
    canvas.height = Math.round(wrap.clientHeight * dpr);
    requestRender();
  }

  function dashFor(el) {
    const w = el.strokeWidth;
    if (el.strokeStyle === 'dashed') return [w * 4, w * 3 + 4];
    if (el.strokeStyle === 'dotted') return [0.1, w * 2 + 4];
    return [];
  }

  /** Smooth freehand path using quadratic curves through midpoints. */
  function tracePencil(c, pts) {
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    if (pts.length < 3) {
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
      return;
    }
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      c.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const last = pts[pts.length - 1];
    c.lineTo(last[0], last[1]);
  }

  /** Draw a single element into context c (world transform already set). */
  function drawElement(c, el) {
    c.save();
    c.globalAlpha = clamp(el.opacity, 0, 100) / 100;
    c.strokeStyle = el.strokeColor;
    c.fillStyle = isFilled(el) ? el.fillColor : 'transparent';
    c.lineWidth = el.strokeWidth;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.setLineDash(dashFor(el));

    switch (el.type) {
      case 'rect': {
        const b = getBounds(el);
        const r = Math.min(8, b.w / 4, b.h / 4);
        c.beginPath();
        if (c.roundRect) c.roundRect(b.x, b.y, b.w, b.h, r); else c.rect(b.x, b.y, b.w, b.h);
        if (isFilled(el)) c.fill();
        c.stroke();
        break;
      }
      case 'ellipse': {
        const b = getBounds(el);
        c.beginPath();
        c.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
        if (isFilled(el)) c.fill();
        c.stroke();
        break;
      }
      case 'line':
      case 'arrow': {
        const [a, b] = [el.points[0], el.points[el.points.length - 1]];
        c.beginPath();
        c.moveTo(a[0], a[1]);
        c.lineTo(b[0], b[1]);
        c.stroke();
        if (el.type === 'arrow' && Math.hypot(b[0] - a[0], b[1] - a[1]) > 1) {
          const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
          const len = Math.max(12, el.strokeWidth * 4);
          c.setLineDash([]);
          c.beginPath();
          c.moveTo(b[0] - len * Math.cos(ang - Math.PI / 7), b[1] - len * Math.sin(ang - Math.PI / 7));
          c.lineTo(b[0], b[1]);
          c.lineTo(b[0] - len * Math.cos(ang + Math.PI / 7), b[1] - len * Math.sin(ang + Math.PI / 7));
          c.stroke();
        }
        break;
      }
      case 'pencil': {
        const pts = el.points;
        if (pts.length === 1) {
          c.beginPath();
          c.arc(pts[0][0], pts[0][1], el.strokeWidth / 2, 0, Math.PI * 2);
          c.fillStyle = el.strokeColor;
          c.fill();
        } else {
          tracePencil(c, pts);
          c.stroke();
        }
        break;
      }
      case 'text': {
        c.font = fontString(el.fontSize, el.fontFamily);
        c.textBaseline = 'top';
        c.fillStyle = el.strokeColor;
        const lines = (el.text || '').split('\n');
        const lh = el.fontSize * LINE_HEIGHT;
        const offset = (lh - el.fontSize) / 2;
        lines.forEach((line, i) => c.fillText(line, el.x, el.y + i * lh + offset));
        break;
      }
      case 'image': {
        const img = imageCache.get(el.src);
        const b = getBounds(el);
        if (img && img.complete && img.naturalWidth) {
          c.drawImage(img, b.x, b.y, b.w, b.h);
        } else {
          c.setLineDash([6, 6]);
          c.strokeStyle = '#6272a4';
          c.strokeRect(b.x, b.y, b.w, b.h);
        }
        break;
      }
    }
    c.restore();
  }

  function drawGrid() {
    let step = 20 * state.zoom;
    while (step < 10) step *= 5;
    const w = canvas.width / dpr, h = canvas.height / dpr;
    const ox = ((state.panX % step) + step) % step;
    const oy = ((state.panY % step) + step) % step;
    ctx.fillStyle = THEME.gridDot;
    const s = state.zoom > 0.5 ? 1.5 : 1;
    for (let x = ox; x < w; x += step) {
      for (let y = oy; y < h; y += step) ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
  }

  /** Positions of the 8 resize handles for bounds b (world coords). */
  function handlePositions(b) {
    const { x, y, w, h } = b;
    return {
      nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + h / 2],
      se: [x + w, y + h], s: [x + w / 2, y + h], sw: [x, y + h], w: [x, y + h / 2],
    };
  }

  /** Selection bounds padded a little so the dashed box doesn't touch the shape. */
  function selectionBounds() {
    const b = unionBounds(selectedEls());
    if (!b) return null;
    const pad = 6 / state.zoom;
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  }

  /** Is the selection a single line/arrow (edited by endpoints instead of a box)? */
  function singleSegment() {
    if (state.selected.size !== 1) return null;
    const el = selectedEls()[0];
    return el && (el.type === 'line' || el.type === 'arrow') ? el : null;
  }

  function drawHandle(x, y, round = false) {
    const s = HANDLE_PX / state.zoom;
    ctx.beginPath();
    if (round) ctx.arc(x, y, s / 1.6, 0, Math.PI * 2);
    else if (ctx.roundRect) ctx.roundRect(x - s / 2, y - s / 2, s, s, 2 / state.zoom);
    else ctx.rect(x - s / 2, y - s / 2, s, s);
    ctx.fill();
    ctx.stroke();
  }

  function drawSelection() {
    if (!state.selected.size || (editing && state.selected.has(editing.el.id))) return;
    ctx.save();
    ctx.lineWidth = 1.5 / state.zoom;
    ctx.strokeStyle = THEME.selection;
    ctx.setLineDash([6 / state.zoom, 4 / state.zoom]);
    ctx.lineDashOffset = -dashOffset / state.zoom;

    // Individual outlines when more than one element is selected
    if (state.selected.size > 1) {
      ctx.globalAlpha = 0.5;
      for (const el of selectedEls()) {
        const b = getBounds(el);
        ctx.strokeRect(b.x, b.y, b.w, b.h);
      }
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = THEME.handleFill;
    const seg = singleSegment();
    if (seg) {
      const a = seg.points[0], b = seg.points[seg.points.length - 1];
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = THEME.handleStroke;
      drawHandle(a[0], a[1], true);
      drawHandle(b[0], b[1], true);
    } else {
      const b = selectionBounds();
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.setLineDash([]);
      ctx.strokeStyle = THEME.handleStroke;
      for (const [hx, hy] of Object.values(handlePositions(b))) drawHandle(hx, hy);
    }
    ctx.restore();
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    if (state.showGrid) drawGrid();

    // World transform
    ctx.setTransform(dpr * state.zoom, 0, 0, dpr * state.zoom, dpr * state.panX, dpr * state.panY);
    for (const el of state.elements) {
      if (editing && editing.el.id === el.id) continue;
      drawElement(ctx, el);
    }
    drawSelection();

    // Marquee (rubber band) selection
    if (action && action.type === 'marquee') {
      const r = action.rect;
      ctx.save();
      ctx.fillStyle = THEME.marqueeFill;
      ctx.strokeStyle = THEME.selection;
      ctx.lineWidth = 1 / state.zoom;
      ctx.setLineDash([4 / state.zoom, 3 / state.zoom]);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.restore();
    }
  }

  function loop() {
    if (state.selected.size) {          // animate the "marching ants"
      dashOffset = (dashOffset + 0.4) % 1000;
      needsRender = true;
    }
    if (needsRender) {
      needsRender = false;
      render();
    }
    requestAnimationFrame(loop);
  }

  // -------------------------------------------------------------------
  // Zoom & pan
  // -------------------------------------------------------------------
  function setZoom(z, sx = wrap.clientWidth / 2, sy = wrap.clientHeight / 2) {
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    const w = screenToWorld(sx, sy);
    state.zoom = z;
    state.panX = sx - w.x * z;
    state.panY = sy - w.y * z;
    $('#btnZoomReset').textContent = `${Math.round(z * 100)}%`;
    if (editing) positionTextEditor();
    requestRender();
  }

  const zoomBy = (factor) => setZoom(state.zoom * factor);

  // -------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------
  function setTool(tool) {
    if (editing) commitText();
    state.tool = tool;
    document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    if (tool !== 'select') state.selected.clear();
    $('#hint').textContent = TOOL_HINTS[tool] || '';
    updateCursor();
    updateUI();
    requestRender();
  }

  function updateCursor(hoverCursor) {
    let c;
    if (action && action.type === 'pan') c = 'grabbing';
    else if (spaceDown || state.tool === 'hand') c = 'grab';
    else if (hoverCursor) c = hoverCursor;
    else {
      c = {
        select: 'default', pencil: 'crosshair', rect: 'crosshair', ellipse: 'crosshair',
        line: 'crosshair', arrow: 'crosshair', text: 'text', eraser: ERASER_CURSOR,
      }[state.tool] || 'default';
    }
    canvas.style.cursor = c;
  }

  const HANDLE_CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  };

  /** Returns a handle id ('nw', 'e', 'p0', 'p1' …) under world point p, or null. */
  function handleAt(p) {
    if (!state.selected.size) return null;
    const r = HANDLE_PX / state.zoom;
    const seg = singleSegment();
    if (seg) {
      const pts = seg.points;
      if (Math.hypot(p.x - pts[0][0], p.y - pts[0][1]) <= r) return 'p0';
      const l = pts[pts.length - 1];
      if (Math.hypot(p.x - l[0], p.y - l[1]) <= r) return 'p1';
      return null;
    }
    const hs = handlePositions(selectionBounds());
    for (const [k, [hx, hy]] of Object.entries(hs)) {
      if (Math.abs(p.x - hx) <= r && Math.abs(p.y - hy) <= r) return k;
    }
    return null;
  }

  function newElement(type, p) {
    const s = state.style;
    const base = {
      id: uid(), type,
      strokeColor: s.strokeColor, fillColor: s.fillColor, strokeWidth: s.strokeWidth,
      opacity: s.opacity, strokeStyle: s.strokeStyle,
    };
    if (type === 'line' || type === 'arrow') return { ...base, points: [[p.x, p.y], [p.x, p.y]] };
    if (type === 'pencil') return { ...base, points: [[p.x, p.y]] };
    if (type === 'text') {
      return { ...base, x: p.x, y: p.y, w: 0, h: 0, text: '', fontFamily: s.fontFamily, fontSize: s.fontSize };
    }
    return { ...base, x: p.x, y: p.y, w: 0, h: 0 };
  }

  /** Snap vector (dx, dy) to the nearest 45° increment. */
  function snap45(dx, dy) {
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return [Math.cos(ang) * len, Math.sin(ang) * len];
  }

  // -------------------------------------------------------------------
  // Pointer interaction
  // -------------------------------------------------------------------
  function onPointerDown(e) {
    if (e.button === 2) return;
    const sp = eventScreenPos(e);
    const p = screenToWorld(sp.x, sp.y);
    lastPointer = sp;

    // Finish an ongoing text edit first (the click is consumed)
    if (editing) {
      commitText();
      if (state.tool === 'text') return;
    }

    canvas.setPointerCapture(e.pointerId);

    // Panning: middle button, space held or hand tool
    if (e.button === 1 || spaceDown || state.tool === 'hand') {
      e.preventDefault();
      action = { type: 'pan', sx: sp.x, sy: sp.y, panX: state.panX, panY: state.panY };
      updateCursor();
      return;
    }

    switch (state.tool) {
      case 'select': return startSelectAction(p, e);
      case 'eraser':
        action = { type: 'erase', before: snapshot(), erased: false };
        eraseAt(p);
        return;
      case 'text': {
        const hit = topElementAt(p);
        if (hit && hit.type === 'text') openTextEditor(hit, false);
        else openTextEditor(newElement('text', p), true);
        return;
      }
      default: {
        const el = newElement(state.tool, p);
        action = { type: 'create', el, start: p, before: snapshot() };
        state.elements.push(el);
        requestRender();
      }
    }
  }

  function startSelectAction(p, e) {
    const h = handleAt(p);
    if (h) {
      const els = selectedEls();
      action = {
        type: h.startsWith('p') ? 'endpoint' : 'resize',
        handle: h,
        before: snapshot(),
        originals: els.map(cloneEl),
        bounds: unionBounds(els),
        changed: false,
      };
      return;
    }
    const hit = topElementAt(p);
    if (hit) {
      if (e.shiftKey) {
        if (state.selected.has(hit.id)) state.selected.delete(hit.id); else state.selected.add(hit.id);
      } else if (!state.selected.has(hit.id)) {
        state.selected = new Set([hit.id]);
      }
      // Alt+drag duplicates the selection
      if (e.altKey) {
        const before = snapshot();
        const copies = selectedEls().map((el) => ({ ...cloneEl(el), id: uid() }));
        state.elements.push(...copies);
        state.selected = new Set(copies.map((c) => c.id));
        action = { type: 'move', start: p, before, originals: copies.map(cloneEl), changed: true };
      } else {
        action = { type: 'move', start: p, before: snapshot(), originals: selectedEls().map(cloneEl), changed: false };
      }
    } else {
      if (!e.shiftKey) state.selected.clear();
      action = { type: 'marquee', start: p, rect: { x: p.x, y: p.y, w: 0, h: 0 }, base: new Set(state.selected) };
    }
    syncPanelFromSelection();
    updateUI();
    requestRender();
  }

  function onPointerMove(e) {
    const sp = eventScreenPos(e);
    lastPointer = sp;
    const p = screenToWorld(sp.x, sp.y);

    if (!action) {
      // Hover feedback in select mode
      if (state.tool === 'select' && !spaceDown) {
        const h = handleAt(p);
        if (h) updateCursor(h.startsWith('p') ? 'pointer' : HANDLE_CURSORS[h]);
        else updateCursor(topElementAt(p) ? 'move' : null);
      }
      return;
    }

    switch (action.type) {
      case 'pan':
        state.panX = action.panX + (sp.x - action.sx);
        state.panY = action.panY + (sp.y - action.sy);
        break;
      case 'create': updateCreate(p, e); break;
      case 'move': updateMove(p); break;
      case 'resize': updateResize(p, e); break;
      case 'endpoint': {
        const el = byId(action.originals[0].id);
        const o = action.originals[0].points;
        const idx = action.handle === 'p0' ? 0 : el.points.length - 1;
        const anchor = idx === 0 ? o[o.length - 1] : o[0];
        let [dx, dy] = [p.x - anchor[0], p.y - anchor[1]];
        if (e.shiftKey) [dx, dy] = snap45(dx, dy);
        el.points[idx] = [anchor[0] + dx, anchor[1] + dy];
        action.changed = true;
        break;
      }
      case 'marquee': {
        const r = {
          x: Math.min(action.start.x, p.x), y: Math.min(action.start.y, p.y),
          w: Math.abs(p.x - action.start.x), h: Math.abs(p.y - action.start.y),
        };
        action.rect = r;
        const sel = new Set(action.base);
        for (const el of state.elements) {
          const b = getBounds(el);
          if (b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h) sel.add(el.id);
        }
        state.selected = sel;
        break;
      }
      case 'erase': eraseAt(p); break;
    }
    requestRender();
  }

  function updateCreate(p, e) {
    const el = action.el;
    const s = action.start;
    if (el.type === 'pencil') {
      const last = el.points[el.points.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) > 1.5 / state.zoom) el.points.push([p.x, p.y]);
    } else if (el.type === 'line' || el.type === 'arrow') {
      let [dx, dy] = [p.x - s.x, p.y - s.y];
      if (e.shiftKey) [dx, dy] = snap45(dx, dy);
      el.points[1] = [s.x + dx, s.y + dy];
    } else {
      let w = p.x - s.x, h = p.y - s.y;
      if (e.shiftKey) {
        const m = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * m;
        h = Math.sign(h || 1) * m;
      }
      el.w = w;
      el.h = h;
    }
  }

  function updateMove(p) {
    const dx = p.x - action.start.x, dy = p.y - action.start.y;
    if (dx || dy) action.changed = true;
    for (const o of action.originals) {
      const el = byId(o.id);
      if (!el) continue;
      if (el.points) el.points = o.points.map(([x, y]) => [x + dx, y + dy]);
      else { el.x = o.x + dx; el.y = o.y + dy; }
    }
  }

  function updateResize(p, e) {
    const B = action.bounds;
    const h = action.handle;
    let x1 = B.x, y1 = B.y, x2 = B.x + B.w, y2 = B.y + B.h;
    if (h.includes('w')) x1 = p.x;
    if (h.includes('e')) x2 = p.x;
    if (h.includes('n')) y1 = p.y;
    if (h.includes('s')) y2 = p.y;

    // Keep aspect ratio with Shift, or always for a single image / text
    const onlyKeepAspect = action.originals.length === 1 && (action.originals[0].type === 'image' || action.originals[0].type === 'text');
    const corner = h.length === 2;
    if (corner && (e.shiftKey || onlyKeepAspect) && B.w > 0 && B.h > 0) {
      const sx = (x2 - x1) / B.w, sy = (y2 - y1) / B.h;
      const sc = Math.max(Math.abs(sx), Math.abs(sy));
      const nw = Math.sign(sx || 1) * sc * B.w, nh = Math.sign(sy || 1) * sc * B.h;
      if (h.includes('w')) x1 = x2 - nw; else x2 = x1 + nw;
      if (h.includes('n')) y1 = y2 - nh; else y2 = y1 + nh;
    }

    const scaleX = B.w ? (x2 - x1) / B.w : 1;
    const scaleY = B.h ? (y2 - y1) / B.h : 1;
    const mapX = (x) => (B.w ? x1 + (x - B.x) * scaleX : x + (x1 - B.x));
    const mapY = (y) => (B.h ? y1 + (y - B.y) * scaleY : y + (y1 - B.y));
    action.changed = true;

    for (const o of action.originals) {
      const el = byId(o.id);
      if (!el) continue;
      if (el.points) {
        el.points = o.points.map(([x, y]) => [mapX(x), mapY(y)]);
      } else if (el.type === 'text') {
        const f = h === 'e' || h === 'w' ? Math.abs(scaleX) : Math.abs(scaleY);
        el.fontSize = Math.max(4, o.fontSize * f);
        measureTextEl(el);
        const nx = mapX(o.x), ny = mapY(o.y);
        el.x = scaleX < 0 ? nx - el.w : nx;
        el.y = scaleY < 0 ? ny - el.h : ny;
      } else {
        const ax = mapX(o.x), bx = mapX(o.x + o.w);
        const ay = mapY(o.y), by = mapY(o.y + o.h);
        el.x = Math.min(ax, bx); el.w = Math.abs(bx - ax);
        el.y = Math.min(ay, by); el.h = Math.abs(by - ay);
      }
    }
  }

  function eraseAt(p) {
    const hit = topElementAt(p);
    if (!hit) return;
    state.elements = state.elements.filter((el) => el.id !== hit.id);
    state.selected.delete(hit.id);
    action.erased = true;
    requestRender();
  }

  function onPointerUp(e) {
    if (!action) return;
    const a = action;
    action = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);

    switch (a.type) {
      case 'create': {
        const el = a.el;
        normalizeBox(el);
        const b = getBounds(el);
        const tiny = el.type !== 'pencil' && Math.max(b.w, b.h) < 2 / state.zoom;
        if (tiny) {
          state.elements = state.elements.filter((x) => x.id !== el.id);
        } else {
          pushHistory(a.before);
        }
        break;
      }
      case 'move':
      case 'resize':
      case 'endpoint':
        if (a.changed) pushHistory(a.before);
        break;
      case 'erase':
        if (a.erased) pushHistory(a.before);
        break;
    }
    syncPanelFromSelection();
    updateCursor();
    updateUI();
    requestRender();
  }

  function onDoubleClick(e) {
    if (state.tool !== 'select') return;
    const sp = eventScreenPos(e);
    const p = screenToWorld(sp.x, sp.y);
    const hit = topElementAt(p);
    if (hit && hit.type === 'text') openTextEditor(hit, false);
    else if (!hit) openTextEditor(newElement('text', p), true);
  }

  function onWheel(e) {
    e.preventDefault();
    const sp = eventScreenPos(e);
    if (e.shiftKey && !e.ctrlKey) {         // Shift+wheel pans
      state.panX -= e.deltaY || e.deltaX;
      requestRender();
      return;
    }
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    setZoom(state.zoom * Math.exp(-delta * 0.0015), sp.x, sp.y);
  }

  // -------------------------------------------------------------------
  // Text editing (textarea overlay)
  // -------------------------------------------------------------------
  function openTextEditor(el, isNew) {
    editing = { el, isNew, before: snapshot(), original: el.text || '' };
    textEditor.value = el.text || '';
    textEditor.hidden = false;
    positionTextEditor();
    updateUI();
    requestRender();
    requestAnimationFrame(() => {
      textEditor.focus();
      textEditor.select();
    });
  }

  function positionTextEditor() {
    if (!editing) return;
    const el = editing.el;
    const s = worldToScreen(el.x, el.y);
    const size = el.fontSize * state.zoom;
    Object.assign(textEditor.style, {
      left: `${s.x}px`,
      top: `${s.y}px`,
      font: fontString(size, el.fontFamily),
      lineHeight: String(LINE_HEIGHT),
      color: el.strokeColor,
      opacity: String(el.opacity / 100),
    });
    autosizeTextEditor();
  }

  function autosizeTextEditor() {
    if (!editing) return;
    const el = editing.el;
    measureCtx.font = fontString(el.fontSize * state.zoom, el.fontFamily);
    const lines = textEditor.value.split('\n');
    let w = 0;
    for (const l of lines) w = Math.max(w, measureCtx.measureText(l).width);
    textEditor.style.width = `${Math.ceil(w + el.fontSize * state.zoom)}px`;
    textEditor.style.height = `${Math.ceil(lines.length * el.fontSize * state.zoom * LINE_HEIGHT) + 4}px`;
  }

  function commitText() {
    if (!editing) return;
    const { el, isNew, before, original } = editing;
    editing = null;
    textEditor.hidden = true;
    const text = textEditor.value.replace(/\s+$/, '');
    textEditor.blur();

    if (isNew) {
      if (text) {
        el.text = text;
        measureTextEl(el);
        pushHistory(before);
        state.elements.push(el);
      }
    } else if (!text) {
      pushHistory(before);
      state.elements = state.elements.filter((x) => x.id !== el.id);
      state.selected.delete(el.id);
    } else if (text !== original) {
      pushHistory(before);
      el.text = text;
      measureTextEl(el);
    }
    updateUI();
    requestRender();
  }

  textEditor.addEventListener('input', autosizeTextEditor);
  textEditor.addEventListener('blur', () => { if (editing) commitText(); });
  textEditor.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      commitText();
    }
  });

  // -------------------------------------------------------------------
  // Element operations
  // -------------------------------------------------------------------
  function deleteSelected() {
    if (!state.selected.size) return;
    pushHistory();
    state.elements = state.elements.filter((el) => !state.selected.has(el.id));
    state.selected.clear();
    markChanged();
  }

  function duplicateSelected() {
    if (!state.selected.size) return;
    pushHistory();
    const off = 16 / state.zoom;
    const copies = selectedEls().map((el) => {
      const c = { ...cloneEl(el), id: uid() };
      if (c.points) c.points = c.points.map(([x, y]) => [x + off, y + off]);
      else { c.x += off; c.y += off; }
      return c;
    });
    state.elements.push(...copies);
    state.selected = new Set(copies.map((c) => c.id));
    markChanged();
  }

  function reorderSelected(toFront) {
    if (!state.selected.size) return;
    pushHistory();
    const sel = state.elements.filter((e) => state.selected.has(e.id));
    const rest = state.elements.filter((e) => !state.selected.has(e.id));
    state.elements = toFront ? [...rest, ...sel] : [...sel, ...rest];
    markChanged();
  }

  function nudgeSelected(dx, dy) {
    if (!state.selected.size) return;
    pushHistory();
    for (const el of selectedEls()) {
      if (el.points) el.points = el.points.map(([x, y]) => [x + dx, y + dy]);
      else { el.x += dx; el.y += dy; }
    }
    markChanged();
  }

  function selectAll() {
    setTool('select');
    state.selected = new Set(state.elements.map((e) => e.id));
    syncPanelFromSelection();
    updateUI();
    requestRender();
  }

  // -------------------------------------------------------------------
  // Clipboard: copy / cut / paste (elements, images and plain text)
  // -------------------------------------------------------------------
  document.addEventListener('copy', (e) => {
    if (isTypingTarget(e.target) || !state.selected.size) return;
    e.clipboardData.setData('text/plain', CLIP_MARKER + JSON.stringify(selectedEls()));
    e.preventDefault();
    toast(`${state.selected.size} elemento(s) copiado(s)`);
  });

  document.addEventListener('cut', (e) => {
    if (isTypingTarget(e.target) || !state.selected.size) return;
    e.clipboardData.setData('text/plain', CLIP_MARKER + JSON.stringify(selectedEls()));
    e.preventDefault();
    deleteSelected();
  });

  document.addEventListener('paste', (e) => {
    if (isTypingTarget(e.target)) return;
    const dt = e.clipboardData;
    if (!dt) return;

    // 1) Images (screenshots, copied images, copied image files)
    const files = [...(dt.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) {
      for (const item of dt.items || []) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
    }
    if (files.length) {
      e.preventDefault();
      files.forEach((f, i) => {
        const c = viewCenterWorld();
        addImageFile(f, { x: c.x + i * 24 / state.zoom, y: c.y + i * 24 / state.zoom });
      });
      return;
    }

    // 2) Our own elements / plain text
    const text = dt.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    if (text.startsWith(CLIP_MARKER)) {
      try {
        const els = JSON.parse(text.slice(CLIP_MARKER.length));
        pasteElements(els);
      } catch (err) {
        toast('Conteúdo da área de transferência inválido', true);
      }
      return;
    }
    const c = viewCenterWorld();
    const el = newElement('text', c);
    el.text = text.replace(/\r\n/g, '\n').trimEnd();
    measureTextEl(el);
    el.x -= el.w / 2;
    el.y -= el.h / 2;
    pushHistory();
    state.elements.push(el);
    setTool('select');
    state.selected = new Set([el.id]);
    markChanged();
  });

  /** Paste elements centred on the current view (or on the pointer). */
  function pasteElements(els) {
    if (!Array.isArray(els) || !els.length) return;
    const b = unionBounds(els);
    const target = screenToWorld(lastPointer.x, lastPointer.y);
    const inside = lastPointer.x > 0 && lastPointer.y > 0 && lastPointer.x < wrap.clientWidth && lastPointer.y < wrap.clientHeight;
    const c = inside ? target : viewCenterWorld();
    const dx = c.x - (b.x + b.w / 2), dy = c.y - (b.y + b.h / 2);
    pushHistory();
    const copies = els.map((el) => {
      const n = { ...cloneEl(el), id: uid() };
      if (n.points) n.points = n.points.map(([x, y]) => [x + dx, y + dy]);
      else { n.x += dx; n.y += dy; }
      ensureImage(n);
      return n;
    });
    state.elements.push(...copies);
    setTool('select');
    state.selected = new Set(copies.map((x) => x.id));
    syncPanelFromSelection();
    markChanged();
  }

  // -------------------------------------------------------------------
  // Drag & drop (images or project files)
  // -------------------------------------------------------------------
  wrap.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    const sp = eventScreenPos(e);
    const p = screenToWorld(sp.x, sp.y);
    for (const f of files) {
      if (f.type.startsWith('image/')) addImageFile(f, p);
      else if (f.name.endsWith('.json')) openProjectFile(f);
    }
  });

  // -------------------------------------------------------------------
  // Project files: new / save / open / export
  // -------------------------------------------------------------------
  function newDocument() {
    if (state.dirty && state.elements.length &&
        !confirm('Existem alterações não salvas. Deseja realmente começar um novo documento?')) return;
    if (editing) commitText();
    state.elements = [];
    state.selected.clear();
    history = [];
    future = [];
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    setZoom(1);
    state.dirty = false;
    saveAutosave();
    updateUI();
    requestRender();
    toast('Novo documento criado');
  }

  function serialize() {
    return {
      type: APP_ID,
      version: FILE_VERSION,
      savedAt: new Date().toISOString(),
      view: { zoom: state.zoom, panX: state.panX, panY: state.panY, showGrid: state.showGrid },
      style: state.style,
      elements: state.elements,
    };
  }

  function saveProject() {
    if (editing) commitText();
    const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    download(blob, `nox-commoda-${stamp}.json`);
    state.dirty = false;
    saveAutosave();
    toast('Projeto salvo');
  }

  /** Apply a parsed project object to the app. Returns true on success. */
  function loadProjectData(data, { silent = false } = {}) {
    if (!data || data.type !== APP_ID || !Array.isArray(data.elements)) {
      if (!silent) toast('Arquivo inválido: não é um projeto do Nox Commoda', true);
      return false;
    }
    state.elements = data.elements.filter((el) => el && el.type && el.id);
    state.elements.forEach(ensureImage);
    state.selected.clear();
    if (data.view) {
      state.zoom = clamp(Number(data.view.zoom) || 1, MIN_ZOOM, MAX_ZOOM);
      state.panX = Number(data.view.panX) || 0;
      state.panY = Number(data.view.panY) || 0;
      if (typeof data.view.showGrid === 'boolean') state.showGrid = data.view.showGrid;
    }
    if (data.style) Object.assign(state.style, data.style);
    $('#btnZoomReset').textContent = `${Math.round(state.zoom * 100)}%`;
    history = [];
    future = [];
    syncPanelFromStyle();
    updateUI();
    requestRender();
    // Make sure fonts used by text elements are available, then re-measure
    const families = new Set(state.elements.filter((e) => e.type === 'text').map((e) => e.fontFamily));
    families.forEach((f) => ensureFontOption(f));
    return true;
  }

  async function openProjectFile(file) {
    if (state.dirty && state.elements.length &&
        !confirm('Existem alterações não salvas. Deseja abrir outro projeto mesmo assim?')) return;
    try {
      const data = JSON.parse(await file.text());
      if (loadProjectData(data)) {
        state.dirty = false;
        saveAutosave();
        toast(`Projeto "${file.name}" aberto`);
      }
    } catch (err) {
      console.error(err);
      toast('Não foi possível ler o arquivo JSON', true);
    }
  }

  async function exportPNG() {
    if (editing) commitText();
    if (!state.elements.length) { toast('Nada para exportar — o quadro está vazio', true); return; }
    // Wait until all images are decoded
    await Promise.all(state.elements.filter((e) => e.type === 'image').map((e) => {
      const img = imageCache.get(e.src);
      return img && !img.complete ? new Promise((r) => { img.onload = img.onerror = r; }) : null;
    }));
    const b = unionBounds(state.elements);
    const pad = 32;
    const maxStroke = Math.max(...state.elements.map((e) => e.strokeWidth || 0));
    const scale = 2;
    const w = Math.ceil(b.w + (pad + maxStroke) * 2);
    const h = Math.ceil(b.h + (pad + maxStroke) * 2);
    const limit = 16000;
    const s = Math.min(scale, limit / w, limit / h);
    const out = document.createElement('canvas');
    out.width = Math.ceil(w * s);
    out.height = Math.ceil(h * s);
    const c = out.getContext('2d');
    if ($('#exportBg').checked) {
      c.fillStyle = THEME.bg;
      c.fillRect(0, 0, out.width, out.height);
    }
    c.setTransform(s, 0, 0, s, s * (pad + maxStroke - b.x), s * (pad + maxStroke - b.y));
    state.elements.forEach((el) => drawElement(c, el));
    out.toBlob((blob) => {
      if (!blob) { toast('Falha ao gerar o PNG', true); return; }
      download(blob, 'nox-commoda.png');
      toast('PNG exportado');
    }, 'image/png');
  }

  // -------------------------------------------------------------------
  // Autosave (localStorage) so a refresh doesn't lose work
  // -------------------------------------------------------------------
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveAutosave, 600);
  }

  function saveAutosave() {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ ...serialize(), dirty: state.dirty }));
    } catch (err) {
      if (!autosaveWarned) {
        autosaveWarned = true;
        toast('Autosalvamento indisponível (projeto grande demais). Use "Salvar projeto".', true);
      }
    }
  }

  function restoreAutosave() {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (loadProjectData(data, { silent: true })) state.dirty = !!data.dirty;
    } catch (err) {
      console.warn('Autosave restore failed', err);
    }
  }

  // -------------------------------------------------------------------
  // Fonts: built-in (Google Fonts), fonts/ folder manifest, imported, system
  // -------------------------------------------------------------------
  function allFonts() {
    return [...fontGroups.builtin, ...fontGroups.folder, ...fontGroups.imported, ...fontGroups.system];
  }

  function populateFontSelect() {
    const sel = $('#fontFamily');
    const current = state.style.fontFamily;
    sel.innerHTML = '';
    const groups = [
      ['Embutidas (Google Fonts)', fontGroups.builtin],
      ['Pasta fonts/', fontGroups.folder],
      ['Importadas nesta sessão', fontGroups.imported],
      ['Fontes do sistema', fontGroups.system],
    ];
    for (const [label, list] of groups) {
      if (!list.length) continue;
      const og = document.createElement('optgroup');
      og.label = label;
      for (const name of list) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        opt.style.fontFamily = `"${name}"`;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
    sel.value = allFonts().includes(current) ? current : fontGroups.builtin[0];
  }

  /** Make sure a family referenced by a loaded project appears in the list. */
  function ensureFontOption(family) {
    if (!family || allFonts().includes(family)) { refreshFont(family); return; }
    fontGroups.system.push(family);
    populateFontSelect();
    refreshFont(family);
  }

  /** Load a font face (if needed) and re-measure text elements that use it. */
  function refreshFont(family) {
    if (!family || !document.fonts) return;
    document.fonts.load(fontString(32, family)).then(() => {
      for (const el of state.elements) if (el.type === 'text' && el.fontFamily === family) measureTextEl(el);
      if (editing) positionTextEditor();
      requestRender();
    }).catch(() => {});
  }

  /**
   * Custom fonts from the fonts/ folder.
   * Browsers cannot list a directory, so fonts are declared in a manifest:
   *   - fonts/fonts.json  (read with fetch — works when served over http://)
   *   - fonts/fonts.js    (window.NOX_FONTS — works when opening index.html via file://)
   */
  async function loadFolderFonts() {
    let entries = [];
    // On file:// browsers block fetch(), so only fonts.js is used there
    if (location.protocol !== 'file:') try {
      const res = await fetch('fonts/fonts.json', { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        entries = Array.isArray(json) ? json : (json.fonts || []);
      }
    } catch (err) {
      // Expected on file:// in Chromium — fall back to fonts.js
    }
    if (Array.isArray(window.NOX_FONTS)) entries = entries.concat(window.NOX_FONTS);

    const seen = new Set();
    for (const entry of entries) {
      if (!entry || !entry.name || !entry.file || seen.has(entry.name)) continue;
      seen.add(entry.name);
      try {
        const face = new FontFace(entry.name, `url("fonts/${encodeURI(entry.file)}")`, {
          weight: entry.weight || 'normal',
          style: entry.style || 'normal',
        });
        await face.load();
        document.fonts.add(face);
        if (!fontGroups.folder.includes(entry.name)) fontGroups.folder.push(entry.name);
      } catch (err) {
        console.warn(`[NoxCommoda] Não foi possível carregar a fonte "${entry.name}" (fonts/${entry.file})`, err);
      }
    }
    populateFontSelect();
    state.elements.filter((e) => e.type === 'text').forEach((e) => refreshFont(e.fontFamily));
  }

  /** Import a font file picked by the user (valid for this session). */
  async function importFontFile(file) {
    try {
      const name = file.name.replace(/\.(ttf|otf|woff2?|)$/i, '').replace(/[-_]+/g, ' ').trim();
      const face = new FontFace(name, await file.arrayBuffer());
      await face.load();
      document.fonts.add(face);
      if (!fontGroups.imported.includes(name)) fontGroups.imported.push(name);
      populateFontSelect();
      $('#fontFamily').value = name;
      applyProp('fontFamily', name, true);
      toast(`Fonte "${name}" importada`);
    } catch (err) {
      console.error(err);
      toast('Arquivo de fonte inválido', true);
    }
  }

  /** Local Font Access API (Chromium only, needs user permission). */
  async function loadSystemFonts() {
    if (!('queryLocalFonts' in window)) {
      toast('Seu navegador não suporta a Local Font Access API (use Chrome/Edge)', true);
      return;
    }
    try {
      const fonts = await window.queryLocalFonts();
      const families = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
      const known = new Set(allFonts());
      fontGroups.system = fontGroups.system.concat(families.filter((f) => !known.has(f)));
      populateFontSelect();
      toast(`${families.length} fontes do sistema encontradas`);
    } catch (err) {
      console.error(err);
      toast('Permissão negada para acessar as fontes do sistema', true);
    }
  }

  // -------------------------------------------------------------------
  // Properties panel
  // -------------------------------------------------------------------
  function buildSwatches(containerId, key, withTransparent) {
    const box = $(containerId);
    const colors = withTransparent ? ['transparent', ...PALETTE.slice(0, 11)] : PALETTE;
    for (const color of colors) {
      const b = document.createElement('button');
      b.className = 'swatch' + (color === 'transparent' ? ' transparent' : '');
      b.style.background = color;
      b.style.color = color;
      b.dataset.color = color;
      b.dataset.tooltip = color === 'transparent' ? 'Sem preenchimento' : color;
      b.addEventListener('click', () => applyProp(key, color, true));
      box.appendChild(b);
    }
  }

  /**
   * Apply a style property to the defaults and to all selected elements.
   * @param {boolean} commit push an undo step immediately (buttons/selects)
   */
  function applyProp(key, value, commit = false) {
    state.style[key] = value;
    const targets = selectedEls().filter((el) => {
      if (key === 'fontFamily' || key === 'fontSize') return el.type === 'text';
      if (key === 'fillColor') return el.type === 'rect' || el.type === 'ellipse';
      return true;
    });
    if (editing && (key === 'fontFamily' || key === 'fontSize' || key === 'strokeColor' || key === 'opacity')) {
      editing.el[key] = value;
      positionTextEditor();
    }
    if (targets.length) {
      if (commit) pushHistory();
      else if (!propSnapshot) propSnapshot = snapshot();
      for (const el of targets) {
        el[key] = value;
        if (el.type === 'text') measureTextEl(el);
      }
      markChanged();
    }
    if (key === 'fontFamily') refreshFont(value);
    syncPanelFromStyle();
    requestRender();
  }

  /** Called on slider "change" (drag end) to record a single undo step. */
  function commitPropSnapshot() {
    if (propSnapshot) {
      pushHistory(propSnapshot);
      propSnapshot = null;
    }
  }

  /** Reflect state.style in the panel controls. */
  function syncPanelFromStyle() {
    const s = state.style;
    const hex = (c) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#7c3aed');
    $('#strokeColor').value = hex(s.strokeColor);
    $('#fillColor').value = hex(s.fillColor);
    $('#strokeWidth').value = s.strokeWidth;
    $('#strokeWidthValue').textContent = `${s.strokeWidth}px`;
    $('#opacity').value = s.opacity;
    $('#opacityValue').textContent = `${s.opacity}%`;
    $('#strokeStyle').value = s.strokeStyle;
    $('#fontSize').value = Math.round(s.fontSize);
    $('#fontSizeValue').textContent = `${Math.round(s.fontSize)}px`;
    if (allFonts().includes(s.fontFamily)) $('#fontFamily').value = s.fontFamily;
    document.querySelectorAll('#strokeSwatches .swatch').forEach((b) =>
      b.classList.toggle('selected', b.dataset.color.toLowerCase() === String(s.strokeColor).toLowerCase()));
    document.querySelectorAll('#fillSwatches .swatch').forEach((b) =>
      b.classList.toggle('selected', b.dataset.color.toLowerCase() === String(s.fillColor).toLowerCase()));
  }

  /** When the selection changes, load the first element's style into the panel. */
  function syncPanelFromSelection() {
    const el = selectedEls()[0];
    if (el) {
      for (const k of ['strokeColor', 'fillColor', 'strokeWidth', 'opacity', 'strokeStyle', 'fontFamily', 'fontSize']) {
        if (el[k] !== undefined) state.style[k] = el[k];
      }
    }
    syncPanelFromStyle();
  }

  /** Update enabled/visible state of buttons and panel sections. */
  function updateUI() {
    $('#btnUndo').disabled = !history.length;
    $('#btnRedo').disabled = !future.length;
    $('#btnGrid').classList.toggle('on', state.showGrid);
    $('#emptyState').classList.toggle('hidden', state.elements.length > 0 || !!editing);

    const sel = selectedEls();
    const hasText = sel.some((e) => e.type === 'text');
    $('#textSection').classList.toggle('hidden', !(state.tool === 'text' || hasText || editing));
    $('#arrangeSection').classList.toggle('hidden', !sel.length);
    const onlyNoFill = sel.length && sel.every((e) => e.type !== 'rect' && e.type !== 'ellipse');
    $('#fillSection').classList.toggle('hidden', !!onlyNoFill || state.tool === 'text' || ['pencil', 'line', 'arrow'].includes(state.tool));
    document.title = `${state.dirty ? '● ' : ''}Nox Commoda`;
  }

  // -------------------------------------------------------------------
  // Tooltips (single floating element — works inside scrollable panels)
  // -------------------------------------------------------------------
  function setupTooltips() {
    const tip = $('#tooltip');
    let current = null;
    document.addEventListener('mouseover', (e) => {
      const t = e.target.closest('[data-tooltip]');
      if (t === current) return;
      current = t;
      if (!t) { tip.classList.remove('show'); return; }
      tip.textContent = t.dataset.tooltip;
      const r = t.getBoundingClientRect();
      tip.classList.add('show');
      const tr = tip.getBoundingClientRect();
      let x, y;
      if (t.closest('.toolbar') && window.innerWidth > 640) { // tools: show on the right
        x = r.right + 10;
        y = r.top + r.height / 2 - tr.height / 2;
      } else {                                                 // others: below / above
        x = r.left + r.width / 2 - tr.width / 2;
        y = r.bottom + 8;
        if (y + tr.height > window.innerHeight - 4) y = r.top - tr.height - 8;
      }
      tip.style.left = `${clamp(x, 4, window.innerWidth - tr.width - 4)}px`;
      tip.style.top = `${clamp(y, 4, window.innerHeight - tr.height - 4)}px`;
    });
    document.addEventListener('pointerdown', () => { tip.classList.remove('show'); current = null; });
  }

  // -------------------------------------------------------------------
  // Keyboard shortcuts
  // -------------------------------------------------------------------
  const TOOL_KEYS = { v: 'select', s: 'select', h: 'hand', p: 'pencil', r: 'rect', e: 'ellipse', l: 'line', a: 'arrow', t: 'text', x: 'eraser' };

  function onKeyDown(e) {
    if (isTypingTarget(e.target) || $('#helpDialog').open) return;
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;

    if (e.code === 'Space') {
      e.preventDefault();
      if (!spaceDown) { spaceDown = true; updateCursor(); }
      return;
    }

    if (mod) {
      let handled = true;
      if (key === 'z' && !e.shiftKey) undo();
      else if (key === 'y' || (key === 'z' && e.shiftKey)) redo();
      else if (key === 's') saveProject();
      else if (key === 'o') $('#fileOpen').click();
      else if (key === 'e') exportPNG();
      else if (key === 'a') selectAll();
      else if (key === 'd') duplicateSelected();
      else if (key === '=' || key === '+') zoomBy(1.2);
      else if (key === '-') zoomBy(1 / 1.2);
      else if (key === '0') setZoom(1);
      else if (key === ']') reorderSelected(true);
      else if (key === '[') reorderSelected(false);
      else handled = false;         // let Ctrl+C / Ctrl+V / Ctrl+X reach the clipboard events
      if (handled) e.preventDefault();
      return;
    }
    if (e.altKey) return;

    if (TOOL_KEYS[key]) { setTool(TOOL_KEYS[key]); return; }

    const step = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'Delete':
      case 'Backspace': deleteSelected(); e.preventDefault(); break;
      case 'Escape':
        state.selected.clear();
        if (state.tool !== 'select') setTool('select');
        syncPanelFromSelection();
        updateUI();
        requestRender();
        break;
      case 'ArrowLeft': nudgeSelected(-step, 0); e.preventDefault(); break;
      case 'ArrowRight': nudgeSelected(step, 0); e.preventDefault(); break;
      case 'ArrowUp': nudgeSelected(0, -step); e.preventDefault(); break;
      case 'ArrowDown': nudgeSelected(0, step); e.preventDefault(); break;
      case 'g':
      case 'G': toggleGrid(); break;
      case '?': $('#helpDialog').showModal(); break;
    }
  }

  function toggleGrid() {
    state.showGrid = !state.showGrid;
    updateUI();
    scheduleAutosave();
    requestRender();
  }

  // -------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------
  function bindUI() {
    // Tools
    document.querySelectorAll('.tool[data-tool]').forEach((b) =>
      b.addEventListener('click', () => setTool(b.dataset.tool)));
    $('#btnInsertImage').addEventListener('click', () => $('#imageInput').click());

    // Top bar
    $('#btnNew').addEventListener('click', newDocument);
    $('#btnOpen').addEventListener('click', () => $('#fileOpen').click());
    $('#btnSave').addEventListener('click', saveProject);
    $('#btnExport').addEventListener('click', exportPNG);
    $('#btnUndo').addEventListener('click', undo);
    $('#btnRedo').addEventListener('click', redo);
    $('#btnZoomIn').addEventListener('click', () => zoomBy(1.2));
    $('#btnZoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
    $('#btnZoomReset').addEventListener('click', () => setZoom(1));
    $('#btnGrid').addEventListener('click', toggleGrid);
    $('#btnHelp').addEventListener('click', () => $('#helpDialog').showModal());
    $('#btnProps').addEventListener('click', () => $('#props').classList.toggle('open'));

    // Hidden file inputs
    $('#fileOpen').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) openProjectFile(f);
      e.target.value = '';
    });
    $('#imageInput').addEventListener('change', (e) => {
      [...e.target.files].forEach((f) => addImageFile(f));
      e.target.value = '';
    });
    $('#fontInput').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) importFontFile(f);
      e.target.value = '';
    });

    // Properties
    buildSwatches('#strokeSwatches', 'strokeColor', false);
    buildSwatches('#fillSwatches', 'fillColor', true);
    $('#strokeColor').addEventListener('input', (e) => applyProp('strokeColor', e.target.value));
    $('#fillColor').addEventListener('input', (e) => applyProp('fillColor', e.target.value));
    $('#strokeWidth').addEventListener('input', (e) => applyProp('strokeWidth', Number(e.target.value)));
    $('#opacity').addEventListener('input', (e) => applyProp('opacity', Number(e.target.value)));
    $('#fontSize').addEventListener('input', (e) => applyProp('fontSize', Number(e.target.value)));
    ['#strokeColor', '#fillColor', '#strokeWidth', '#opacity', '#fontSize'].forEach((id) =>
      $(id).addEventListener('change', commitPropSnapshot));
    $('#strokeStyle').addEventListener('change', (e) => applyProp('strokeStyle', e.target.value, true));
    $('#fontFamily').addEventListener('change', (e) => applyProp('fontFamily', e.target.value, true));
    $('#btnImportFont').addEventListener('click', () => $('#fontInput').click());
    $('#btnSystemFonts').addEventListener('click', loadSystemFonts);
    if (!('queryLocalFonts' in window)) $('#btnSystemFonts').title = 'Disponível apenas no Chrome/Edge';

    $('#btnFront').addEventListener('click', () => reorderSelected(true));
    $('#btnBack').addEventListener('click', () => reorderSelected(false));
    $('#btnDuplicate').addEventListener('click', duplicateSelected);
    $('#btnDelete').addEventListener('click', deleteSelected);

    // Canvas
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('auxclick', (e) => e.preventDefault());

    // Keyboard
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { spaceDown = false; updateCursor(); }
    });
    window.addEventListener('blur', () => { spaceDown = false; updateCursor(); });

    // Warn before closing with unsaved changes
    window.addEventListener('beforeunload', (e) => {
      saveAutosave();
      if (state.dirty && state.elements.length) { e.preventDefault(); e.returnValue = ''; }
    });

    new ResizeObserver(resizeCanvas).observe(wrap);
    setupTooltips();
  }

  // -------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------
  function init() {
    bindUI();
    populateFontSelect();
    restoreAutosave();
    syncPanelFromStyle();
    setTool('select');
    resizeCanvas();
    updateUI();
    loadFolderFonts();
    // Re-render once web fonts finish loading (text metrics change)
    if (document.fonts) {
      document.fonts.ready.then(() => {
        state.elements.filter((e) => e.type === 'text').forEach(measureTextEl);
        requestRender();
      });
      document.fonts.addEventListener('loadingdone', requestRender);
      BUILTIN_FONTS.forEach((f) => document.fonts.load(fontString(16, f)).catch(() => {}));
    }
    requestAnimationFrame(loop);
  }

  init();
})();
