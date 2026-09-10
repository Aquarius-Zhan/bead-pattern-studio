/**
 * Bead Studio App Main Controller
 * Interactive mobile-optimized Canvas engine for fuse bead patterns.
 */

(function() {
  'use strict';

  // State
  const state = {
    currentImage: null, // HTMLImageElement
    activePaletteKey: 'mard',
    dimensions: {
      mode: 'board', // 'board' or 'custom'
      boardSize: 50, // 50 for 2.6mm, 29 for 5mm
      boardsX: 1,
      boardsY: 1,
      customW: 50,
      customH: 50,
      lockRatio: true,
      fitMode: 'contain' // 'contain' | 'cover' | 'stretch'
    },
    quantizeOptions: {
      dither: 'none', // 'none' | 'floyd-steinberg' | 'bayer'
      ditherStrength: 0.7,
      distanceMetric: 'cie76',
      ignoreBgColor: false, // Default false to prevent false background holes in photos/illustrations
      bgTolerance: 20,
      maxColors: 0
    },
    pattern: null, // { width, height, grid, bomList, totalBeads, uniqueColors }
    // Viewport
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    minScale: 0.1,
    maxScale: 60,
    // Interaction
    interactionMode: 'view', // 'view' | 'highlight' | 'progress'
    highlightColorCode: null,
    progressMap: {}, // key `${x}_${y}` -> true
    showLabels: true,
    showGrid: true,
    beadShape: 'circle' // 'circle' | 'square'
  };

  // DOM Elements
  let canvas, ctx;
  let viewportEl;
  let worker = null;
  let currentRequestId = 0;
  let quantizeWatchdog = null;

  // Initialize Web Worker
  function initWorker() {
    try {
      if (worker) {
        try { worker.terminate(); } catch (e) {}
      }
      worker = new Worker('js/worker.js');

      worker.onmessage = function(e) {
        if (!e.data) return;
        // Ignore stale responses from earlier canceled requests
        if (e.data.requestId && e.data.requestId !== currentRequestId) {
          return;
        }

        clearTimeout(quantizeWatchdog);
        hideLoading();

        if (e.data.status === 'success') {
          state.pattern = e.data.result;
          onPatternGenerated();
        } else {
          console.warn('Worker error returned, falling back to fast main thread engine:', e.data.error);
          fallbackToMainThread();
        }
      };

      worker.onerror = function(err) {
        console.error('Web Worker onerror triggered:', err);
        clearTimeout(quantizeWatchdog);
        hideLoading();
        try { worker.terminate(); } catch (e) {}
        worker = null;
        fallbackToMainThread();
      };
    } catch (err) {
      console.warn('Web Worker not supported or restricted, falling back to main thread', err);
      worker = null;
    }
  }

  function fallbackToMainThread() {
    if (!state.currentImage) return;
    const { width, height } = getTargetResolution();
    const imageData = prepareImageData(width, height);
    const palette = window.BEAD_PALETTES[state.activePaletteKey];
    if (!palette) return;
    runMainThreadQuantize(currentRequestId, imageData, palette.colors, state.quantizeOptions);
  }

  // Lifecycle Entry Point
  window.addEventListener('DOMContentLoaded', () => {
    canvas = document.getElementById('bead-canvas');
    ctx = canvas.getContext('2d', { alpha: false });
    viewportEl = document.getElementById('canvas-container');

    initWorker();
    setupCanvasGestures();
    setupUIControls();
    loadProgress();

    // Resize listener
    window.addEventListener('resize', () => {
      resizeCanvas();
      draw();
    });

    resizeCanvas();

    // Create default sample pattern so user sees a working demo immediately
    createDefaultSample();
  });

  function resizeCanvas() {
    if (!viewportEl || !canvas) return;
    const rect = viewportEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Generates default demo image (Pixel Art Star & Heart)
   */
  function createDefaultSample() {
    const off = document.createElement('canvas');
    off.width = 64;
    off.height = 64;
    const offCtx = off.getContext('2d');

    // Transparent background
    offCtx.clearRect(0, 0, 64, 64);

    // Draw cute pixel-style heart
    offCtx.fillStyle = '#FF3366';
    offCtx.beginPath();
    offCtx.arc(24, 24, 14, Math.PI, 0, false);
    offCtx.arc(40, 24, 14, Math.PI, 0, false);
    offCtx.lineTo(32, 52);
    offCtx.closePath();
    offCtx.fill();

    // Cute eye dots
    offCtx.fillStyle = '#FFFFFF';
    offCtx.fillRect(20, 22, 4, 4);
    offCtx.fillRect(36, 22, 4, 4);

    const img = new Image();
    img.onload = () => {
      state.currentImage = img;
      generatePattern();
    };
    img.src = off.toDataURL();
  }

  /**
   * Calculate Target Resolution based on '几乘几' settings
   */
  function getTargetResolution() {
    if (state.dimensions.mode === 'board') {
      const bSize = state.dimensions.boardSize;
      const w = state.dimensions.boardsX * bSize;
      const h = state.dimensions.boardsY * bSize;
      return { width: w, height: h };
    } else {
      return {
        width: Math.max(5, Math.min(300, parseInt(state.dimensions.customW) || 50)),
        height: Math.max(5, Math.min(300, parseInt(state.dimensions.customH) || 50))
      };
    }
  }

  /**
   * Convert current image to target dimensions ImageData
   */
  function prepareImageData(targetW, targetH) {
    if (!state.currentImage) return null;
    const off = document.createElement('canvas');
    off.width = targetW;
    off.height = targetH;
    const offCtx = off.getContext('2d');
    offCtx.imageSmoothingEnabled = false; // Nearest neighbor pixel art preservation

    const img = state.currentImage;
    const fit = state.dimensions.fitMode;

    let sx = 0, sy = 0, sw = img.width, sh = img.height;
    let dx = 0, dy = 0, dw = targetW, dh = targetH;

    if (fit === 'contain') {
      const imgRatio = img.width / img.height;
      const targetRatio = targetW / targetH;
      if (imgRatio > targetRatio) {
        dw = targetW;
        dh = Math.round(targetW / imgRatio);
        dy = Math.round((targetH - dh) / 2);
      } else {
        dh = targetH;
        dw = Math.round(targetH * imgRatio);
        dx = Math.round((targetW - dw) / 2);
      }
    } else if (fit === 'cover') {
      const imgRatio = img.width / img.height;
      const targetRatio = targetW / targetH;
      if (imgRatio > targetRatio) {
        sw = Math.round(img.height * targetRatio);
        sx = Math.round((img.width - sw) / 2);
      } else {
        sh = Math.round(img.width / targetRatio);
        sy = Math.round((img.height - sh) / 2);
      }
    }

    offCtx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    return offCtx.getImageData(0, 0, targetW, targetH);
  }

  /**
   * Run Quantization Engine
   */
  function generatePattern() {
    if (!state.currentImage) return;
    showLoading('正在计算 CIELAB 拼豆色彩量化...');

    const { width, height } = getTargetResolution();
    const imageData = prepareImageData(width, height);
    const palette = window.BEAD_PALETTES[state.activePaletteKey];
    if (!palette) {
      hideLoading();
      showToast('色卡未找到: ' + state.activePaletteKey);
      return;
    }

    const options = Object.assign({}, state.quantizeOptions);
    const reqId = ++currentRequestId;

    // Set 4-second watchdog timer: if worker hangs or drops message, auto-recover on main thread!
    clearTimeout(quantizeWatchdog);
    quantizeWatchdog = setTimeout(() => {
      console.warn('Worker computation timed out (4s watchdog), automatically switching to main thread engine');
      if (worker) {
        try { worker.terminate(); } catch (e) {}
        worker = null;
        initWorker(); // Spawn fresh worker for next operation
      }
      runMainThreadQuantize(reqId, imageData, palette.colors, options);
    }, 4000);

    if (worker) {
      try {
        worker.postMessage({
          requestId: reqId,
          imageData: imageData,
          paletteColors: palette.colors,
          options: options
        });
      } catch (postErr) {
        console.warn('Worker postMessage failed, executing on main thread:', postErr);
        clearTimeout(quantizeWatchdog);
        runMainThreadQuantize(reqId, imageData, palette.colors, options);
      }
    } else {
      runMainThreadQuantize(reqId, imageData, palette.colors, options);
    }
  }

  function runMainThreadQuantize(reqId, imageData, paletteColors, options) {
    clearTimeout(quantizeWatchdog);
    setTimeout(() => {
      if (reqId !== currentRequestId) return; // Stale request
      try {
        state.pattern = window.BeadQuantizer.quantizeImage(imageData, paletteColors, options);
        onPatternGenerated();
      } catch (e) {
        console.error('Quantization error:', e);
        showToast('生成图纸出错: ' + e.message);
      } finally {
        hideLoading();
      }
    }, 16);
  }

  function onPatternGenerated() {
    fitToScreen();
    renderBOMBar();
    renderBOMModal();
    updateHeaderStats();
    draw();
  }

  function updateHeaderStats() {
    const statsEl = document.getElementById('pattern-stats');
    if (!statsEl || !state.pattern) return;
    const { width, height, totalBeads, uniqueColors } = state.pattern;
    statsEl.innerHTML = `<span class="status-indicator"></span><span>${width}×${height} 豆 (${totalBeads}颗 / ${uniqueColors}色)</span>`;
  }

  /**
   * Viewport Math: Fit Pattern to Screen
   */
  function fitToScreen() {
    if (!state.pattern || !viewportEl) return;
    const rect = viewportEl.getBoundingClientRect();
    const pw = state.pattern.width;
    const ph = state.pattern.height;

    // Margin padding
    const pad = 40;
    const availW = rect.width - pad * 2;
    const availH = rect.height - pad * 2;

    const scaleW = availW / pw;
    const scaleH = availH / ph;
    state.scale = Math.max(1, Math.min(scaleW, scaleH));

    state.offsetX = (rect.width - pw * state.scale) / 2;
    state.offsetY = (rect.height - ph * state.scale) / 2;
  }

  /**
   * Main Canvas Rendering Loop
   */
  function draw() {
    if (!ctx || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Clear background (pegboard table surface)
    ctx.fillStyle = '#1A1B23';
    ctx.fillRect(0, 0, width, height);

    if (!state.pattern) {
      ctx.restore();
      return;
    }

    const { width: pw, height: ph, grid } = state.pattern;
    const scale = state.scale;
    const ox = state.offsetX;
    const oy = state.offsetY;

    // Visible bounds culling for peak performance
    const startX = Math.max(0, Math.floor(-ox / scale));
    const endX = Math.min(pw, Math.ceil((width - ox) / scale));
    const startY = Math.max(0, Math.floor(-oy / scale));
    const endY = Math.min(ph, Math.ceil((height - oy) / scale));

    // Draw Board Background Plate
    ctx.fillStyle = '#252836';
    ctx.fillRect(ox, oy, pw * scale, ph * scale);

    // Render Beads
    const isHighlightActive = state.interactionMode === 'highlight' && state.highlightColorCode;
    const radius = (scale * 0.88) / 2;
    const innerRadius = radius * 0.38; // Bead center hole

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const bead = grid[y][x];
        const cx = ox + (x + 0.5) * scale;
        const cy = oy + (y + 0.5) * scale;

        if (!bead) {
          // Clean pegboard empty hole indicator
          if (scale > 5) {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(cx, cy, radius * 0.75, 0, Math.PI * 2);
            ctx.stroke();

            ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(1, scale * 0.08), 0, Math.PI * 2);
            ctx.fill();
          }
          continue;
        }

        const isCompleted = state.progressMap[`${x}_${y}`];
        let isHighlighted = true;
        if (isHighlightActive) {
          isHighlighted = (bead.code === state.highlightColorCode);
        }

        ctx.save();

        if (!isHighlighted) {
          ctx.globalAlpha = 0.18; // Dim non-highlighted beads
        }

        if (state.beadShape === 'circle') {
          // Solid Flat Bead Circle without center white hole or dark dot
          ctx.fillStyle = bead.hex;
          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.fill();

          // Subtle clean outer stroke for bead definition
          if (scale > 8) {
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        } else {
          // Square Bead
          ctx.fillStyle = bead.hex;
          const sMargin = Math.max(0.5, scale * 0.06);
          ctx.fillRect(ox + x * scale + sMargin, oy + y * scale + sMargin, scale - sMargin * 2, scale - sMargin * 2);
        }

        // Highlight Glow Ring
        if (isHighlightActive && isHighlighted && scale > 6) {
          ctx.strokeStyle = '#38BDF8';
          ctx.lineWidth = Math.max(2, scale * 0.12);
          ctx.beginPath();
          ctx.arc(cx, cy, radius + 1, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Completed Checkmark / Overlay
        if (isCompleted) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.fill();

          // Green checkmark
          if (scale > 10) {
            ctx.strokeStyle = '#10B981';
            ctx.lineWidth = Math.max(1.5, scale * 0.12);
            ctx.beginPath();
            ctx.moveTo(cx - radius * 0.45, cy);
            ctx.lineTo(cx - radius * 0.1, cy + radius * 0.35);
            ctx.lineTo(cx + radius * 0.45, cy - radius * 0.35);
            ctx.stroke();
          }
        }

        // Color Code Label (when zoomed in)
        if (state.showLabels && scale >= 16 && !isCompleted) {
          // Determine black or white text with contrasting stroke for crystal clear readability
          const lum = (bead.r * 299 + bead.g * 587 + bead.b * 114) / 1000;
          const textColor = lum > 140 ? '#000000' : '#FFFFFF';
          const strokeColor = lum > 140 ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.9)';
          const fontSize = Math.max(8, Math.floor(scale * 0.35));

          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          // Stroke halo for maximum contrast
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = Math.max(1.5, scale * 0.06);
          ctx.strokeText(bead.code, cx, cy);

          ctx.fillStyle = textColor;
          ctx.fillText(bead.code, cx, cy);
        }

        ctx.restore();
      }
    }

    // Grid Lines & Board Boundaries
    if (state.showGrid && scale >= 5) {
      drawGridLines(startX, endX, startY, endY, pw, ph, scale, ox, oy);
    }

    // Coordinate Numbers along Left and Top
    if (state.showGrid && scale >= 14) {
      drawCoordinates(startX, endX, startY, endY, scale, ox, oy, width, height);
    }

    ctx.restore();
  }

  /**
   * Draw Grid Lines (1-bead fine, 5-bead medium, 10-bead bold, and board seams)
   */
  function drawGridLines(startX, endX, startY, endY, pw, ph, scale, ox, oy) {
    const boardSize = state.dimensions.boardSize || 50;

    // 1. Fine 1-bead lines
    if (scale >= 10) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (let x = startX; x <= endX; x++) {
        const lx = ox + x * scale;
        ctx.moveTo(lx, oy + startY * scale);
        ctx.lineTo(lx, oy + endY * scale);
      }
      for (let y = startY; y <= endY; y++) {
        const ly = oy + y * scale;
        ctx.moveTo(ox + startX * scale, ly);
        ctx.lineTo(ox + endX * scale, ly);
      }
      ctx.stroke();
    }

    // 2. Medium 5-bead lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    for (let x = Math.floor(startX / 5) * 5; x <= endX; x += 5) {
      if (x % 10 !== 0) {
        const lx = ox + x * scale;
        ctx.moveTo(lx, oy + startY * scale);
        ctx.lineTo(lx, oy + endY * scale);
      }
    }
    for (let y = Math.floor(startY / 5) * 5; y <= endY; y += 5) {
      if (y % 10 !== 0) {
        const ly = oy + y * scale;
        ctx.moveTo(ox + startX * scale, ly);
        ctx.lineTo(ox + endX * scale, ly);
      }
    }
    ctx.stroke();

    // 3. Bold 10-bead lines
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = Math.floor(startX / 10) * 10; x <= endX; x += 10) {
      if (x % boardSize !== 0) {
        const lx = ox + x * scale;
        ctx.moveTo(lx, oy + startY * scale);
        ctx.lineTo(lx, oy + endY * scale);
      }
    }
    for (let y = Math.floor(startY / 10) * 10; y <= endY; y += 10) {
      if (y % boardSize !== 0) {
        const ly = oy + y * scale;
        ctx.moveTo(ox + startX * scale, ly);
        ctx.lineTo(ox + endX * scale, ly);
      }
    }
    ctx.stroke();

    // 4. Pegboard Joint Seams (e.g. every 50 beads)
    if (state.dimensions.mode === 'board') {
      ctx.strokeStyle = '#F59E0B'; // Amber orange board seam
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      for (let x = boardSize; x < pw; x += boardSize) {
        const lx = ox + x * scale;
        ctx.moveTo(lx, oy);
        ctx.lineTo(lx, oy + ph * scale);
      }
      for (let y = boardSize; y < ph; y += boardSize) {
        const ly = oy + y * scale;
        ctx.moveTo(ox, ly);
        ctx.lineTo(ox + pw * scale, ly);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /**
   * Draw Coordinates on 10s and 50s
   */
  function drawCoordinates(startX, endX, startY, endY, scale, ox, oy, viewW, viewH) {
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    // Top horizontal numbers
    for (let x = Math.max(1, Math.floor(startX / 5) * 5); x <= endX; x += 5) {
      const cx = ox + (x - 0.5) * scale;
      const cy = Math.max(16, Math.min(viewH - 10, oy - 4));
      ctx.fillText(x.toString(), cx, cy);
    }

    // Left vertical numbers
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let y = Math.max(1, Math.floor(startY / 5) * 5); y <= endY; y += 5) {
      const cx = Math.max(24, Math.min(viewW - 10, ox - 4));
      const cy = oy + (y - 0.5) * scale;
      ctx.fillText(y.toString(), cx, cy);
    }
  }

  /**
   * Canvas Gesture Interaction: Single-finger pan, two-finger pinch-to-zoom
   */
  function setupCanvasGestures() {
    let isDragging = false;
    let dragStartX = 0, dragStartY = 0;
    let initialPinchDist = 0;
    let initialPinchScale = 1;
    let pinchCenter = { x: 0, y: 0 };
    let hasMoved = false;

    // Mouse drag
    viewportEl.addEventListener('mousedown', (e) => {
      isDragging = true;
      hasMoved = false;
      dragStartX = e.clientX - state.offsetX;
      dragStartY = e.clientY - state.offsetY;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      hasMoved = true;
      state.offsetX = e.clientX - dragStartX;
      state.offsetY = e.clientY - dragStartY;
      draw();
    });

    window.addEventListener('mouseup', (e) => {
      if (isDragging && !hasMoved) {
        // Handle click on canvas
        const rect = viewportEl.getBoundingClientRect();
        handleCanvasTap(e.clientX - rect.left, e.clientY - rect.top);
      }
      isDragging = false;
    });

    // Mouse wheel zoom
    viewportEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = viewportEl.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
      zoomAtPoint(mouseX, mouseY, zoomFactor);
    }, { passive: false });

    // Touch events for Mobile
    viewportEl.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        isDragging = true;
        hasMoved = false;
        dragStartX = e.touches[0].clientX - state.offsetX;
        dragStartY = e.touches[0].clientY - state.offsetY;
      } else if (e.touches.length === 2) {
        isDragging = false;
        hasMoved = true;
        initialPinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        initialPinchScale = state.scale;
        const rect = viewportEl.getBoundingClientRect();
        pinchCenter = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top
        };
      }
    }, { passive: true });

    viewportEl.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1 && isDragging) {
        hasMoved = true;
        state.offsetX = e.touches[0].clientX - dragStartX;
        state.offsetY = e.touches[0].clientY - dragStartY;
        draw();
      } else if (e.touches.length === 2) {
        hasMoved = true;
        const currentDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        if (initialPinchDist > 0) {
          const factor = currentDist / initialPinchDist;
          zoomAtPoint(pinchCenter.x, pinchCenter.y, factor * (initialPinchScale / state.scale));
        }
      }
    }, { passive: true });

    viewportEl.addEventListener('touchend', (e) => {
      if (e.touches.length === 0) {
        if (!hasMoved) {
          const touch = e.changedTouches[0];
          const rect = viewportEl.getBoundingClientRect();
          handleCanvasTap(touch.clientX - rect.left, touch.clientY - rect.top);
        }
        isDragging = false;
        initialPinchDist = 0;
      } else if (e.touches.length === 1) {
        isDragging = true;
        dragStartX = e.touches[0].clientX - state.offsetX;
        dragStartY = e.touches[0].clientY - state.offsetY;
      }
    }, { passive: true });
  }

  function zoomAtPoint(px, py, factor) {
    const prevScale = state.scale;
    let newScale = state.scale * factor;
    newScale = Math.max(state.minScale, Math.min(state.maxScale, newScale));

    state.offsetX = px - (px - state.offsetX) * (newScale / prevScale);
    state.offsetY = py - (py - state.offsetY) * (newScale / prevScale);
    state.scale = newScale;
    draw();
  }

  /**
   * Handle Tap on a Bead in the Grid
   */
  function handleCanvasTap(px, py) {
    if (!state.pattern) return;
    const gridX = Math.floor((px - state.offsetX) / state.scale);
    const gridY = Math.floor((py - state.offsetY) / state.scale);

    if (gridX < 0 || gridX >= state.pattern.width || gridY < 0 || gridY >= state.pattern.height) {
      return;
    }

    const bead = state.pattern.grid[gridY][gridX];
    if (!bead) return;

    if (state.interactionMode === 'progress') {
      // Toggle progress checkmark
      const key = `${gridX}_${gridY}`;
      state.progressMap[key] = !state.progressMap[key];
      saveProgress();
      updateProgressStats();
      draw();
      // Provide light haptic vibration on mobile
      if (navigator.vibrate) navigator.vibrate(25);
    } else if (state.interactionMode === 'highlight') {
      // Set highlight to this bead's color
      state.highlightColorCode = (state.highlightColorCode === bead.code) ? null : bead.code;
      renderBOMBar();
      draw();
    } else {
      // View Mode: Show info toast
      showToast(`[${bead.code}] ${bead.name} | 坐标: (${gridX + 1}, ${gridY + 1})`);
    }
  }

  /**
   * Progress Persistence (LocalStorage)
   */
  function saveProgress() {
    try {
      localStorage.setItem('bead_progress', JSON.stringify(state.progressMap));
    } catch (e) {}
  }

  function loadProgress() {
    try {
      const saved = localStorage.getItem('bead_progress');
      if (saved) state.progressMap = JSON.parse(saved);
    } catch (e) {}
  }

  function updateProgressStats() {
    if (!state.pattern) return;
    const total = state.pattern.totalBeads;
    let done = 0;
    const grid = state.pattern.grid;
    for (let y = 0; y < state.pattern.height; y++) {
      for (let x = 0; x < state.pattern.width; x++) {
        if (grid[y][x] && state.progressMap[`${x}_${y}`]) {
          done++;
        }
      }
    }
    const percent = total > 0 ? ((done / total) * 100).toFixed(1) : 0;
    const progEl = document.getElementById('progress-stats');
    if (progEl) {
      progEl.textContent = `已拼: ${done}/${total} (${percent}%)`;
    }
  }

  /**
   * Bottom BOM Quick Strip
   */
  function renderBOMBar() {
    const bar = document.getElementById('bom-bar');
    if (!bar || !state.pattern) return;
    bar.innerHTML = '';

    const list = state.pattern.bomList;
    if (list.length === 0) return;

    // "Show All" / Clear Highlight button
    const allBtn = document.createElement('div');
    allBtn.className = `bom-chip ${!state.highlightColorCode ? 'active' : ''}`;
    allBtn.innerHTML = `<span class="bom-chip-name">全部</span>`;
    allBtn.onclick = () => {
      state.highlightColorCode = null;
      renderBOMBar();
      draw();
    };
    bar.appendChild(allBtn);

    list.slice(0, 40).forEach(item => {
      const bead = item.bead;
      const isSel = (state.highlightColorCode === bead.code);
      const chip = document.createElement('div');
      chip.className = `bom-chip ${isSel ? 'active' : ''}`;
      chip.innerHTML = `
        <span class="bom-chip-color" style="background-color: ${bead.hex}"></span>
        <span class="bom-chip-code">${bead.code}</span>
        <span class="bom-chip-count">${item.count}</span>
      `;
      chip.onclick = () => {
        state.interactionMode = 'highlight';
        updateModeButtons();
        state.highlightColorCode = isSel ? null : bead.code;
        renderBOMBar();
        draw();
      };
      bar.appendChild(chip);
    });
  }

  /**
   * Full BOM Modal Table
   */
  function renderBOMModal() {
    const container = document.getElementById('bom-table-body');
    if (!container || !state.pattern) return;
    container.innerHTML = '';

    state.pattern.bomList.forEach((item, index) => {
      const bead = item.bead;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${index + 1}</td>
        <td><span class="bom-table-swatch" style="background-color: ${bead.hex}"></span></td>
        <td><strong>${bead.code}</strong></td>
        <td>${bead.name}</td>
        <td>${item.count}</td>
        <td>${item.percentage}%</td>
        <td>
          <button class="btn btn-sm btn-secondary highlight-btn" data-code="${bead.code}">
            ${state.highlightColorCode === bead.code ? '取消' : '高亮'}
          </button>
        </td>
      `;
      tr.querySelector('.highlight-btn').onclick = () => {
        state.interactionMode = 'highlight';
        updateModeButtons();
        state.highlightColorCode = (state.highlightColorCode === bead.code) ? null : bead.code;
        renderBOMBar();
        renderBOMModal();
        draw();
      };
      container.appendChild(tr);
    });
  }

  function updateModeButtons() {
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === state.interactionMode);
    });
  }

  /**
   * Setup UI Event Listeners
   */
  function setupUIControls() {
    // Mode Buttons (View | Highlight | Progress)
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.interactionMode = btn.dataset.mode;
        if (state.interactionMode !== 'highlight') {
          state.highlightColorCode = null;
          renderBOMBar();
        }
        updateModeButtons();
        draw();
      });
    });

    // Zoom Buttons
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
      const rect = viewportEl.getBoundingClientRect();
      zoomAtPoint(rect.width / 2, rect.height / 2, 1.3);
    });
    document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
      const rect = viewportEl.getBoundingClientRect();
      zoomAtPoint(rect.width / 2, rect.height / 2, 0.77);
    });
    document.getElementById('btn-zoom-reset')?.addEventListener('click', () => {
      fitToScreen();
      draw();
    });

    // Toggle Labels & Grid
    document.getElementById('btn-toggle-labels')?.addEventListener('click', (e) => {
      state.showLabels = !state.showLabels;
      e.currentTarget.classList.toggle('active', state.showLabels);
      draw();
    });
    document.getElementById('btn-toggle-grid')?.addEventListener('click', (e) => {
      state.showGrid = !state.showGrid;
      e.currentTarget.classList.toggle('active', state.showGrid);
      draw();
    });

    // Image Upload
    const fileInput = document.getElementById('image-upload');
    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
          state.currentImage = img;
          state.progressMap = {};
          saveProgress();
          generatePattern();
        };
        img.src = event.target.result;
      };
      reader.readAsDataURL(file);
    });

    // Cancel Loading Button
    document.getElementById('btn-cancel-loading')?.addEventListener('click', () => {
      clearTimeout(quantizeWatchdog);
      hideLoading();
      showToast('已取消本次生成');
    });

    // Dimension Modal Logic
    setupDimensionModal();
    // Palette Modal Logic
    setupPaletteModal();
    // Settings Modal Logic
    setupSettingsModal();
    // Export Modal Logic
    setupExportModal();
  }

  /**
   * "几乘几" Dimension Selection Logic
   */
  function setupDimensionModal() {
    const modal = document.getElementById('modal-dimensions');
    const openBtn = document.getElementById('btn-open-dimensions');
    const applyBtn = document.getElementById('btn-apply-dimensions');

    openBtn?.addEventListener('click', () => {
      openModal(modal);
    });

    // Quick Board Preset Chips (1x1, 1x2, 2x2, 3x3)
    document.querySelectorAll('.preset-board-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.preset-board-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const bx = parseInt(btn.dataset.bx);
        const by = parseInt(btn.dataset.by);
        const bSize = parseInt(btn.dataset.bsize);

        state.dimensions.mode = 'board';
        state.dimensions.boardsX = bx;
        state.dimensions.boardsY = by;
        state.dimensions.boardSize = bSize;

        document.getElementById('input-bx').value = bx;
        document.getElementById('input-by').value = by;
      });
    });

    // Dimension Tabs
    document.querySelectorAll('.dim-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.dim-tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.dim-tab-content').forEach(c => c.classList.add('hidden'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.target).classList.remove('hidden');
        state.dimensions.mode = btn.dataset.mode;
      });
    });

    // Custom Width / Height with Aspect Ratio Lock
    const customWInput = document.getElementById('input-custom-w');
    const customHInput = document.getElementById('input-custom-h');
    const lockRatioCheck = document.getElementById('check-lock-ratio');

    customWInput?.addEventListener('input', () => {
      if (lockRatioCheck.checked && state.currentImage) {
        const ratio = state.currentImage.height / state.currentImage.width;
        customHInput.value = Math.max(1, Math.round(parseInt(customWInput.value || 50) * ratio));
      }
    });

    applyBtn?.addEventListener('click', () => {
      if (state.dimensions.mode === 'custom') {
        state.dimensions.customW = parseInt(customWInput.value) || 50;
        state.dimensions.customH = parseInt(customHInput.value) || 50;
      } else {
        state.dimensions.boardsX = parseInt(document.getElementById('input-bx').value) || 1;
        state.dimensions.boardsY = parseInt(document.getElementById('input-by').value) || 1;
      }

      state.dimensions.fitMode = document.getElementById('select-fit-mode').value;
      closeModal(modal);
      generatePattern();
    });
  }

  /**
   * Palette Selection Modal Logic
   */
  function setupPaletteModal() {
    const modal = document.getElementById('modal-palettes');
    const openBtn = document.getElementById('btn-open-palette');
    const listContainer = document.getElementById('palette-list');

    openBtn?.addEventListener('click', () => {
      renderPaletteList();
      openModal(modal);
    });

    function renderPaletteList() {
      if (!listContainer) return;
      listContainer.innerHTML = '';
      Object.keys(window.BEAD_PALETTES).forEach(key => {
        const p = window.BEAD_PALETTES[key];
        const isSel = (state.activePaletteKey === key);
        const card = document.createElement('div');
        card.className = `palette-card ${isSel ? 'active' : ''}`;
        card.innerHTML = `
          <div class="palette-card-header">
            <h4>${p.name}</h4>
            <span class="badge">${p.beadSize}</span>
          </div>
          <p class="palette-card-desc">${p.description}</p>
          <div class="palette-card-stats">${p.colors.length} 色预设色号</div>
          <div class="palette-color-preview">
            ${p.colors.slice(0, 16).map(c => `<span class="preview-dot" style="background:${c.hex}"></span>`).join('')}
          </div>
        `;
        card.onclick = () => {
          state.activePaletteKey = key;
          document.getElementById('palette-name-display').textContent = p.brand;
          closeModal(modal);
          generatePattern();
        };
        listContainer.appendChild(card);
      });
    }
  }

  /**
   * Settings Modal Logic (Dither, Lab/CIE, Background)
   */
  function setupSettingsModal() {
    const modal = document.getElementById('modal-settings');
    const openBtn = document.getElementById('btn-open-settings');
    const applyBtn = document.getElementById('btn-apply-settings');

    openBtn?.addEventListener('click', () => {
      document.getElementById('select-dither').value = state.quantizeOptions.dither;
      document.getElementById('range-dither-strength').value = state.quantizeOptions.ditherStrength * 100;
      document.getElementById('dither-strength-val').textContent = `${Math.round(state.quantizeOptions.ditherStrength * 100)}%`;
      document.getElementById('select-metric').value = state.quantizeOptions.distanceMetric;
      document.getElementById('check-ignore-bg').checked = state.quantizeOptions.ignoreBgColor;
      document.getElementById('select-max-colors').value = state.quantizeOptions.maxColors;
      openModal(modal);
    });

    document.getElementById('range-dither-strength')?.addEventListener('input', (e) => {
      document.getElementById('dither-strength-val').textContent = `${e.target.value}%`;
    });

    applyBtn?.addEventListener('click', () => {
      state.quantizeOptions.dither = document.getElementById('select-dither').value;
      state.quantizeOptions.ditherStrength = parseInt(document.getElementById('range-dither-strength').value) / 100;
      state.quantizeOptions.distanceMetric = document.getElementById('select-metric').value;
      state.quantizeOptions.ignoreBgColor = document.getElementById('check-ignore-bg').checked;
      state.quantizeOptions.maxColors = parseInt(document.getElementById('select-max-colors').value) || 0;
      closeModal(modal);
      if (!state.currentImage) {
        showToast('设置已保存！请先导入图片生成图纸。');
        return;
      }
      showToast('设置已保存，正在重新生成拼豆图纸...');
      generatePattern();
    });
  }

  /**
   * High-Resolution Pattern & Multi-Board Export
   */
  let currentPreviewDataUrl = '';
  let currentPreviewFilename = '';

  function setupExportModal() {
    const modal = document.getElementById('modal-export');
    const openBtn = document.getElementById('btn-open-export');

    openBtn?.addEventListener('click', () => {
      if (!state.pattern) {
        showToast('请先上传图片并生成拼豆图纸！');
        return;
      }
      openModal(modal);
    });

    // 1. Export Full PNG
    document.getElementById('btn-export-full')?.addEventListener('click', () => {
      closeModal(modal);
      exportFullPatternImage();
    });

    // 2. Export Split Boards
    document.getElementById('btn-export-split')?.addEventListener('click', () => {
      closeModal(modal);
      exportSplitBoards();
    });

    // 3. Copy BOM text
    document.getElementById('btn-copy-bom')?.addEventListener('click', () => {
      copyBOMText();
    });

    // 4. Preview Modal Action Buttons
    document.getElementById('btn-save-to-album')?.addEventListener('click', () => {
      if (!currentPreviewDataUrl) return;
      if (window.AndroidBridge && typeof window.AndroidBridge.saveBase64Image === 'function') {
        window.AndroidBridge.saveBase64Image(currentPreviewDataUrl, currentPreviewFilename);
      } else {
        triggerBrowserDownload(currentPreviewDataUrl, currentPreviewFilename);
        showToast('已尝试发起下载，您也可长按上方图片直接保存！');
      }
    });

    document.getElementById('btn-share-image')?.addEventListener('click', () => {
      if (!currentPreviewDataUrl) return;
      if (window.AndroidBridge && typeof window.AndroidBridge.shareBase64Image === 'function') {
        window.AndroidBridge.shareBase64Image(currentPreviewDataUrl, currentPreviewFilename);
      } else if (navigator.share) {
        fetch(currentPreviewDataUrl)
          .then(res => res.blob())
          .then(blob => {
            const file = new File([blob], currentPreviewFilename, { type: 'image/png' });
            navigator.share({
              files: [file],
              title: currentPreviewFilename,
              text: '拼豆工坊生成的图纸'
            }).catch(e => console.log('Share canceled or not supported', e));
          });
      } else {
        showToast('请直接长按上方图片选择「发送给朋友」');
      }
    });
  }

  function exportFullPatternImage() {
    if (!state.pattern) {
      showToast('请先上传图片并生成图纸！');
      return;
    }
    showLoading();

    setTimeout(() => {
      const { width: pw, height: ph, grid } = state.pattern;

      // Dynamic bead pixel size to prevent mobile Canvas GPU memory overflow (keep <= 3200px)
      const maxDim = Math.max(pw, ph);
      let beadPx = 36;
      if (maxDim * beadPx > 3200) {
        beadPx = Math.max(16, Math.floor(3200 / maxDim));
      }

      const pad = 60;
      const outW = pw * beadPx + pad * 2;
      const outH = ph * beadPx + pad * 2;

      const expCanvas = document.createElement('canvas');
      expCanvas.width = outW;
      expCanvas.height = outH;
      const expCtx = expCanvas.getContext('2d');

      // White background for printing / export
      expCtx.fillStyle = '#FFFFFF';
      expCtx.fillRect(0, 0, outW, outH);

      // Title & metadata banner
      expCtx.fillStyle = '#111827';
      expCtx.font = 'bold 24px sans-serif';
      expCtx.fillText(`拼豆图纸 (${pw}×${ph} 豆) - ${window.BEAD_PALETTES[state.activePaletteKey].name}`, pad, pad - 20);

      // Draw Beads
      for (let y = 0; y < ph; y++) {
        for (let x = 0; x < pw; x++) {
          const bead = grid[y][x];
          const bx = pad + x * beadPx;
          const by = pad + y * beadPx;

          if (bead) {
            // Flat solid bead circle without center white dot
            expCtx.fillStyle = bead.hex;
            expCtx.beginPath();
            expCtx.arc(bx + beadPx / 2, by + beadPx / 2, beadPx * 0.45, 0, Math.PI * 2);
            expCtx.fill();

            // Subtle border around bead
            expCtx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
            expCtx.lineWidth = 0.5;
            expCtx.stroke();

            // Bead Code Label with contrast outline
            const lum = (bead.r * 299 + bead.g * 587 + bead.b * 114) / 1000;
            const textColor = lum > 140 ? '#000000' : '#FFFFFF';
            const strokeColor = lum > 140 ? '#FFFFFF' : '#000000';
            expCtx.font = `bold ${Math.floor(beadPx * 0.35)}px sans-serif`;
            expCtx.textAlign = 'center';
            expCtx.textBaseline = 'middle';
            expCtx.strokeStyle = strokeColor;
            expCtx.lineWidth = 2.0;
            expCtx.strokeText(bead.code, bx + beadPx / 2, by + beadPx / 2);
            expCtx.fillStyle = textColor;
            expCtx.fillText(bead.code, bx + beadPx / 2, by + beadPx / 2);
          }
        }
      }

      // Draw Grids (fine 1-bead, medium 5-bead, bold 10-bead)
      expCtx.strokeStyle = '#D1D5DB';
      expCtx.lineWidth = 0.5;
      for (let x = 0; x <= pw; x++) {
        expCtx.beginPath();
        expCtx.moveTo(pad + x * beadPx, pad);
        expCtx.lineTo(pad + x * beadPx, pad + ph * beadPx);
        expCtx.stroke();
      }
      for (let y = 0; y <= ph; y++) {
        expCtx.beginPath();
        expCtx.moveTo(pad, pad + y * beadPx);
        expCtx.lineTo(pad + pw * beadPx, pad + y * beadPx);
        expCtx.stroke();
      }

      // 10-bead bold lines
      expCtx.strokeStyle = '#2563EB';
      expCtx.lineWidth = 2.0;
      for (let x = 0; x <= pw; x += 10) {
        expCtx.beginPath();
        expCtx.moveTo(pad + x * beadPx, pad);
        expCtx.lineTo(pad + x * beadPx, pad + ph * beadPx);
        expCtx.stroke();
      }
      for (let y = 0; y <= ph; y += 10) {
        expCtx.beginPath();
        expCtx.moveTo(pad, pad + y * beadPx);
        expCtx.lineTo(pad + pw * beadPx, pad + y * beadPx);
        expCtx.stroke();
      }

      // Coordinates numbers
      expCtx.fillStyle = '#1E3A8A';
      expCtx.font = 'bold 14px monospace';
      expCtx.textAlign = 'center';
      for (let x = 10; x <= pw; x += 10) {
        expCtx.fillText(x.toString(), pad + (x - 0.5) * beadPx, pad - 8);
      }
      expCtx.textAlign = 'right';
      expCtx.textBaseline = 'middle';
      for (let y = 10; y <= ph; y += 10) {
        expCtx.fillText(y.toString(), pad - 8, pad + (y - 0.5) * beadPx);
      }

      const filename = `拼豆图纸_${pw}x${ph}.png`;
      saveAndPreviewCanvas(expCanvas, filename);
      hideLoading();
    }, 100);
  }

  function exportSplitBoards() {
    if (!state.pattern) {
      showToast('请先上传图片并生成图纸！');
      return;
    }
    const bSize = state.dimensions.boardSize || 50;
    const { width: pw, height: ph } = state.pattern;

    const numX = Math.ceil(pw / bSize);
    const numY = Math.ceil(ph / bSize);

    if (numX * numY <= 1) {
      showToast('当前图纸仅为单板规格，已直接为您导出整图！');
      exportFullPatternImage();
      return;
    }

    showLoading();
    showToast(`正在生成 ${numX}×${numY} = ${numX * numY} 张单板切片图纸并保存...`);

    setTimeout(() => {
      let firstSliceCanvas = null;
      let firstSliceName = '';

      for (let by = 0; by < numY; by++) {
        for (let bx = 0; bx < numX; bx++) {
          const sliceCanvas = generateBoardSliceCanvas(bx, by, bSize);
          const sliceName = `拼豆分板_第(${bx + 1},${by + 1})板.png`;
          if (!firstSliceCanvas) {
            firstSliceCanvas = sliceCanvas;
            firstSliceName = sliceName;
          }

          if (window.AndroidBridge && typeof window.AndroidBridge.saveBase64Image === 'function') {
            window.AndroidBridge.saveBase64Image(sliceCanvas.toDataURL('image/png'), sliceName);
          } else {
            triggerBrowserDownload(sliceCanvas.toDataURL('image/png'), sliceName);
          }
        }
      }

      hideLoading();

      if (firstSliceCanvas) {
        saveAndPreviewCanvas(firstSliceCanvas, firstSliceName);
        if (window.AndroidBridge) {
          showToast(`已成功将 ${numX * numY} 张分板图纸全部保存至手机相册！`);
        }
      }
    }, 100);
  }

  function generateBoardSliceCanvas(bx, by, bSize) {
    const { width: pw, height: ph, grid } = state.pattern;
    const startX = bx * bSize;
    const startY = by * bSize;
    const endX = Math.min(pw, startX + bSize);
    const endY = Math.min(ph, startY + bSize);
    const curW = endX - startX;
    const curH = endY - startY;

    const beadPx = 36;
    const pad = 60;
    const outW = curW * beadPx + pad * 2;
    const outH = curH * beadPx + pad * 2;

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, outW, outH);

    ctx.fillStyle = '#111827';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(`单板图纸 [第 ${bx + 1} 列, 第 ${by + 1} 行] (本地 1~${bSize} 钉)`, pad, pad - 20);

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const bead = grid[y][x];
        const lx = x - startX;
        const ly = y - startY;
        const px = pad + lx * beadPx;
        const py = pad + ly * beadPx;

        if (bead) {
          // Flat solid bead circle without center white dot
          ctx.fillStyle = bead.hex;
          ctx.beginPath();
          ctx.arc(px + beadPx / 2, py + beadPx / 2, beadPx * 0.45, 0, Math.PI * 2);
          ctx.fill();

          // Subtle border around bead
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
          ctx.lineWidth = 0.5;
          ctx.stroke();

          // Bead Code Label with contrast outline
          const lum = (bead.r * 299 + bead.g * 587 + bead.b * 114) / 1000;
          const textColor = lum > 140 ? '#000000' : '#FFFFFF';
          const strokeColor = lum > 140 ? '#FFFFFF' : '#000000';
          ctx.font = `bold ${Math.floor(beadPx * 0.35)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = 2.0;
          ctx.strokeText(bead.code, px + beadPx / 2, py + beadPx / 2);
          ctx.fillStyle = textColor;
          ctx.fillText(bead.code, px + beadPx / 2, py + beadPx / 2);
        }
      }
    }

    // Grid lines & coordinate ruler for this slice
    ctx.strokeStyle = '#D1D5DB';
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= curW; x++) {
      ctx.beginPath();
      ctx.moveTo(pad + x * beadPx, pad);
      ctx.lineTo(pad + x * beadPx, pad + curH * beadPx);
      ctx.stroke();
    }
    for (let y = 0; y <= curH; y++) {
      ctx.beginPath();
      ctx.moveTo(pad, pad + y * beadPx);
      ctx.lineTo(pad + curW * beadPx, pad + y * beadPx);
      ctx.stroke();
    }

    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 2.0;
    for (let x = 0; x <= curW; x += 10) {
      ctx.beginPath();
      ctx.moveTo(pad + x * beadPx, pad);
      ctx.lineTo(pad + x * beadPx, pad + curH * beadPx);
      ctx.stroke();
    }
    for (let y = 0; y <= curH; y += 10) {
      ctx.beginPath();
      ctx.moveTo(pad, pad + y * beadPx);
      ctx.lineTo(pad + curW * beadPx, pad + y * beadPx);
      ctx.stroke();
    }

    ctx.fillStyle = '#1E3A8A';
    ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'center';
    for (let x = 10; x <= curW; x += 10) {
      ctx.fillText(x.toString(), pad + (x - 0.5) * beadPx, pad - 8);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let y = 10; y <= curH; y += 10) {
      ctx.fillText(y.toString(), pad - 8, pad + (y - 0.5) * beadPx);
    }

    return canvas;
  }

  function saveAndPreviewCanvas(cvs, filename) {
    const dataUrl = cvs.toDataURL('image/png');
    currentPreviewDataUrl = dataUrl;
    currentPreviewFilename = filename;

    // 1. In native Android App, auto-save directly to system photo gallery
    if (window.AndroidBridge && typeof window.AndroidBridge.saveBase64Image === 'function') {
      window.AndroidBridge.saveBase64Image(dataUrl, filename);
    } else {
      // Regular browser auto-download trigger
      triggerBrowserDownload(dataUrl, filename);
    }

    // 2. Open preview modal for immediate verification, zoom & long-press save
    const previewModal = document.getElementById('modal-image-preview');
    const previewImg = document.getElementById('preview-image');
    const infoEl = document.getElementById('preview-image-info');
    if (previewImg) previewImg.src = dataUrl;
    if (infoEl) infoEl.textContent = `${filename}（分辨率: ${cvs.width}×${cvs.height} 像素）`;
    openModal(previewModal);
  }

  function triggerBrowserDownload(dataUrl, filename) {
    try {
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e) {
      console.warn('Browser download trigger error:', e);
    }
  }

  function downloadCanvasImage(cvs, filename) {
    saveAndPreviewCanvas(cvs, filename);
  }

  function copyBOMText() {
    if (!state.pattern) return;
    let text = `【拼豆物料采购清单】\n品牌：${window.BEAD_PALETTES[state.activePaletteKey].name}\n总豆数：${state.pattern.totalBeads} 颗\n颜色种类：${state.pattern.uniqueColors} 色\n------------------------\n`;
    state.pattern.bomList.forEach((item, idx) => {
      text += `${idx + 1}. [${item.bead.code}] ${item.bead.name}: ${item.count} 颗 (${item.percentage}%)\n`;
    });

    navigator.clipboard.writeText(text).then(() => {
      showToast('用量清单已成功复制到剪贴板！');
    }).catch(() => {
      showToast('清单已复制');
    });
  }

  // Modal Helpers
  function openModal(el) {
    if (!el) return;
    el.classList.add('active');
  }

  function closeModal(el) {
    if (!el) return;
    el.classList.remove('active');
  }

  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal');
      if (modal) closeModal(modal);
    });
  });

  // Toast Helper
  let toastTimer = null;
  function showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  }

  let globalLoadingFailsafe = null;

  function showLoading(text) {
    const overlay = document.getElementById('loading-overlay');
    if (!overlay) return;
    const textEl = document.getElementById('loading-text');
    if (textEl && text) textEl.textContent = text;
    overlay.classList.remove('hidden');

    // Never let loading overlay hang indefinitely on screen (6-second absolute limit)
    clearTimeout(globalLoadingFailsafe);
    globalLoadingFailsafe = setTimeout(() => {
      if (!overlay.classList.contains('hidden')) {
        console.warn('Loading overlay dismissed by absolute failsafe timer');
        overlay.classList.add('hidden');
        showToast('处理完成或超时，已恢复操作');
      }
    }, 6000);
  }

  function hideLoading() {
    clearTimeout(globalLoadingFailsafe);
    clearTimeout(quantizeWatchdog);
    document.getElementById('loading-overlay')?.classList.add('hidden');
  }

})();
