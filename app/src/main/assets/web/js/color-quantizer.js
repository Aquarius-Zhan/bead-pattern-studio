/**
 * Bead Color Quantizer Engine
 * Supports CIELAB conversion, Delta-E (CIE76 / CIEDE2000),
 * Floyd-Steinberg error diffusion dithering, Bayer ordered dithering,
 * and transparent/background color detection.
 */

(function(global) {
  'use strict';

  // D65 Standard Illuminant Reference White
  const Xn = 0.95047;
  const Yn = 1.00000;
  const Zn = 1.08883;

  /**
   * Convert sRGB [0..255] to Linear sRGB [0..1]
   */
  function sRGBtoLinear(c) {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  /**
   * Convert Linear sRGB [0..1] back to sRGB [0..255]
   */
  function linearTosRGB(v) {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  }

  /**
   * Convert RGB [0..255] to CIELAB [L, a, b]
   */
  function rgbToLab(r, g, b) {
    const lr = sRGBtoLinear(r);
    const lg = sRGBtoLinear(g);
    const lb = sRGBtoLinear(b);

    // sRGB to XYZ (D65)
    const x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / Xn;
    const y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750) / Yn;
    const z = (lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041) / Zn;

    function f(t) {
      return t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + (16 / 116);
    }

    const fx = f(x);
    const fy = f(y);
    const fz = f(z);

    const L = (116 * fy) - 16;
    const a = 500 * (fx - fy);
    const b_val = 200 * (fy - fz);

    return [L, a, b_val];
  }

  /**
   * CIE76 Color Difference Delta-E
   * Perceptually uniform Euclidean distance in Lab space
   */
  function deltaE76(lab1, lab2) {
    const dL = lab1[0] - lab2[0];
    const da = lab1[1] - lab2[1];
    const db = lab1[2] - lab2[2];
    return Math.sqrt(dL * dL + da * da + db * db);
  }

  /**
   * CIEDE2000 Color Difference Formula
   * Most advanced human vision perceptual color difference standard
   */
  function deltaE00(lab1, lab2) {
    const L1 = lab1[0], a1 = lab1[1], b1 = lab1[2];
    const L2 = lab2[0], a2 = lab2[1], b2 = lab2[2];

    const avgLp = (L1 + L2) / 2;
    const C1 = Math.sqrt(a1 * a1 + b1 * b1);
    const C2 = Math.sqrt(a2 * a2 + b2 * b2);
    const avgC = (C1 + C2) / 2;

    const G = 0.5 * (1 - Math.sqrt(Math.pow(avgC, 7) / (Math.pow(avgC, 7) + Math.pow(25, 7))));
    const a1p = (1 + G) * a1;
    const a2p = (1 + G) * a2;

    const C1p = Math.sqrt(a1p * a1p + b1 * b1);
    const C2p = Math.sqrt(a2p * a2p + b2 * b2);
    const avgCp = (C1p + C2p) / 2;

    const rad2deg = 180 / Math.PI;
    const deg2rad = Math.PI / 180;

    let h1p = Math.atan2(b1, a1p) * rad2deg;
    if (h1p < 0) h1p += 360;
    let h2p = Math.atan2(b2, a2p) * rad2deg;
    if (h2p < 0) h2p += 360;

    let avghp = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + 360) / 2 : (h1p + h2p) / 2;

    const T = 1 - 0.17 * Math.cos((avghp - 30) * deg2rad)
              + 0.24 * Math.cos((2 * avghp) * deg2rad)
              + 0.32 * Math.cos((3 * avghp + 6) * deg2rad)
              - 0.20 * Math.cos((4 * avghp - 63) * deg2rad);

    let deltahp = h2p - h1p;
    if (Math.abs(deltahp) > 180) {
      if (h2p <= h1p) deltahp += 360;
      else deltahp -= 360;
    }
    const deltaLp = L2 - L1;
    const deltaCp = C2p - C1p;
    const deltaHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((deltahp / 2) * deg2rad);

    const Sl = 1 + ((0.015 * Math.pow(avgLp - 50, 2)) / Math.sqrt(20 + Math.pow(avgLp - 50, 2)));
    const Sc = 1 + 0.045 * avgCp;
    const Sh = 1 + 0.015 * avgCp * T;

    const deltaTheta = 30 * Math.exp(-Math.pow((avghp - 275) / 25, 2));
    const Rc = 2 * Math.sqrt(Math.pow(avgCp, 7) / (Math.pow(avgCp, 7) + Math.pow(25, 7)));
    const Rt = -Rc * Math.sin(2 * deltaTheta * deg2rad);

    const kl = 1, kc = 1, kh = 1;
    const v1 = deltaLp / (kl * Sl);
    const v2 = deltaCp / (kc * Sc);
    const v3 = deltaHp / (kh * Sh);

    return Math.sqrt(v1 * v1 + v2 * v2 + v3 * v3 + Rt * v2 * v3);
  }

  /**
   * Find closest bead in palette to target RGB
   */
  function findClosestBead(r, g, b, paletteColors, distanceMetric = 'cie76') {
    const targetLab = rgbToLab(r, g, b);
    let bestDist = Infinity;
    let bestBead = paletteColors[0];

    const distFn = distanceMetric === 'ciede2000' ? deltaE00 : deltaE76;

    for (let i = 0; i < paletteColors.length; i++) {
      const bead = paletteColors[i];
      const beadLab = bead.lab || rgbToLab(bead.r, bead.g, bead.b);
      const d = distFn(targetLab, beadLab);
      if (d < bestDist) {
        bestDist = d;
        bestBead = bead;
        if (d < 0.8) break; // Exact match perceptual shortcut
      }
    }

    return bestBead;
  }

  /**
   * Bayer 4x4 Dither Matrix (normalized -0.5 .. 0.5)
   */
  const BAYER_4X4 = [
    [ 0/16 - 0.5,  8/16 - 0.5,  2/16 - 0.5, 10/16 - 0.5 ],
    [12/16 - 0.5,  4/16 - 0.5, 14/16 - 0.5,  6/16 - 0.5 ],
    [ 3/16 - 0.5, 11/16 - 0.5,  1/16 - 0.5,  9/16 - 0.5 ],
    [15/16 - 0.5,  7/16 - 0.5, 13/16 - 0.5,  5/16 - 0.5 ]
  ];

  /**
   * Main Quantization Engine
   */
  function quantizeImage(imageData, paletteColors, options = {}) {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;

    const dither = options.dither || 'none';
    const ditherStrength = options.ditherStrength !== undefined ? options.ditherStrength : 0.7;
    const distanceMetric = options.distanceMetric || 'cie76';
    const transparentThreshold = options.transparentThreshold !== undefined ? options.transparentThreshold : 64;
    const maxColors = options.maxColors || 0;

    // Detect solid background if requested
    let bgR = 255, bgG = 255, bgB = 255;
    let removeBg = !!options.ignoreBgColor;
    let bgTolerance = options.bgTolerance || 20;

    if (removeBg && options.customBgColor) {
      bgR = options.customBgColor.r;
      bgG = options.customBgColor.g;
      bgB = options.customBgColor.b;
    } else if (removeBg) {
      // Auto-sample 4 corners to detect background
      const corners = [
        [0, 0],
        [width - 1, 0],
        [0, height - 1],
        [width - 1, height - 1]
      ];
      let cr = 0, cg = 0, cb = 0, count = 0;
      for (const [cx, cy] of corners) {
        const idx = (cy * width + cx) * 4;
        if (data[idx + 3] > 128) {
          cr += data[idx];
          cg += data[idx + 1];
          cb += data[idx + 2];
          count++;
        }
      }
      if (count > 0) {
        bgR = Math.round(cr / count);
        bgG = Math.round(cg / count);
        bgB = Math.round(cb / count);
      }
    }

    // Working buffer for RGB channels (float for error diffusion)
    const bufR = new Float32Array(width * height);
    const bufG = new Float32Array(width * height);
    const bufB = new Float32Array(width * height);
    const isEmpty = new Uint8Array(width * height);

    // Initial pass: mark transparent alpha
    for (let i = 0; i < width * height; i++) {
      const idx = i * 4;
      const a = data[idx + 3];
      if (a < transparentThreshold) {
        isEmpty[i] = 1;
      }
      bufR[i] = data[idx];
      bufG[i] = data[idx + 1];
      bufB[i] = data[idx + 2];
    }

    // If edge-connected background removal is enabled, run flood-fill from outer perimeter only
    if (removeBg) {
      function colorMatchesBg(x, y) {
        const idx = (y * width + x) * 4;
        const dr = data[idx] - bgR;
        const dg = data[idx + 1] - bgG;
        const db = data[idx + 2] - bgB;
        return Math.sqrt(dr * dr + dg * dg + db * db) <= bgTolerance;
      }

      const queue = [];
      const visited = new Uint8Array(width * height);

      // Check 4 outer borders for seeds
      for (let x = 0; x < width; x++) {
        // Top border
        if (colorMatchesBg(x, 0)) {
          const idx = x;
          queue.push(idx);
          visited[idx] = 1;
          isEmpty[idx] = 1;
        }
        // Bottom border
        if (colorMatchesBg(x, height - 1)) {
          const idx = (height - 1) * width + x;
          queue.push(idx);
          visited[idx] = 1;
          isEmpty[idx] = 1;
        }
      }

      for (let y = 0; y < height; y++) {
        // Left border
        if (colorMatchesBg(0, y)) {
          const idx = y * width;
          if (!visited[idx]) {
            queue.push(idx);
            visited[idx] = 1;
            isEmpty[idx] = 1;
          }
        }
        // Right border
        if (colorMatchesBg(width - 1, y)) {
          const idx = y * width + (width - 1);
          if (!visited[idx]) {
            queue.push(idx);
            visited[idx] = 1;
            isEmpty[idx] = 1;
          }
        }
      }

      // BFS flood fill outwards from borders only
      let head = 0;
      while (head < queue.length) {
        const curr = queue[head++];
        const cx = curr % width;
        const cy = Math.floor(curr / width);

        const neighbors = [
          [cx - 1, cy], [cx + 1, cy],
          [cx, cy - 1], [cx, cy + 1]
        ];

        for (const [nx, ny] of neighbors) {
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const nidx = ny * width + nx;
            if (!visited[nidx] && !isEmpty[nidx] && colorMatchesBg(nx, ny)) {
              visited[nidx] = 1;
              isEmpty[nidx] = 1;
              queue.push(nidx);
            }
          }
        }
      }
    }

    // 2D grid storing the selected bead for each cell
    const grid = new Array(height);
    for (let y = 0; y < height; y++) {
      grid[y] = new Array(width);
    }

    // Pass 1: Quantization
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (isEmpty[idx]) {
          grid[y][x] = null;
          continue;
        }

        let currR = Math.max(0, Math.min(255, bufR[idx]));
        let currG = Math.max(0, Math.min(255, bufG[idx]));
        let currB = Math.max(0, Math.min(255, bufB[idx]));

        // Apply Bayer Ordered Dithering if enabled
        if (dither === 'bayer') {
          const matrixVal = BAYER_4X4[y % 4][x % 4] * ditherStrength * 48;
          currR = Math.max(0, Math.min(255, currR + matrixVal));
          currG = Math.max(0, Math.min(255, currG + matrixVal));
          currB = Math.max(0, Math.min(255, currB + matrixVal));
        }

        const bestBead = findClosestBead(currR, currG, currB, paletteColors, distanceMetric);
        grid[y][x] = bestBead;

        // Apply Floyd-Steinberg Error Diffusion if enabled
        if (dither === 'floyd-steinberg') {
          const errR = (currR - bestBead.r) * ditherStrength;
          const errG = (currG - bestBead.g) * ditherStrength;
          const errB = (currB - bestBead.b) * ditherStrength;

          function addError(nx, ny, factor) {
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const nidx = ny * width + nx;
              if (!isEmpty[nidx]) {
                bufR[nidx] += errR * factor;
                bufG[nidx] += errG * factor;
                bufB[nidx] += errB * factor;
              }
            }
          }

          addError(x + 1, y,     7 / 16);
          addError(x - 1, y + 1, 3 / 16);
          addError(x,     y + 1, 5 / 16);
          addError(x + 1, y + 1, 1 / 16);
        }
      }
    }

    // Optional Pass 2: Limit to Max Colors (Top-K most frequent)
    if (maxColors > 0 && maxColors < paletteColors.length) {
      const counts = {};
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const bead = grid[y][x];
          if (bead) {
            counts[bead.code] = (counts[bead.code] || 0) + 1;
          }
        }
      }

      const sortedCodes = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
      if (sortedCodes.length > maxColors) {
        const allowedCodeSet = new Set(sortedCodes.slice(0, maxColors));
        const filteredPalette = paletteColors.filter(b => allowedCodeSet.has(b.code));

        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const bead = grid[y][x];
            if (bead && !allowedCodeSet.has(bead.code)) {
              grid[y][x] = findClosestBead(bead.r, bead.g, bead.b, filteredPalette, distanceMetric);
            }
          }
        }
      }
    }

    // Compute BOM statistics
    const bomCounts = {};
    let totalBeads = 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bead = grid[y][x];
        if (bead) {
          totalBeads++;
          if (!bomCounts[bead.code]) {
            bomCounts[bead.code] = {
              bead: bead,
              count: 0
            };
          }
          bomCounts[bead.code].count++;
        }
      }
    }

    const bomList = Object.values(bomCounts).sort((a, b) => b.count - a.count);
    bomList.forEach(item => {
      item.percentage = totalBeads > 0 ? ((item.count / totalBeads) * 100).toFixed(1) : '0';
    });

    return {
      width,
      height,
      grid,
      bomList,
      totalBeads,
      uniqueColors: bomList.length
    };
  }

  // Export to global scope
  global.BeadQuantizer = {
    rgbToLab,
    deltaE76,
    deltaE00,
    findClosestBead,
    quantizeImage
  };

})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : global));
