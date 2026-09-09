/**
 * Web Worker for Asynchronous Bead Color Quantization
 * Ensures mobile browser UI remains 100% fluid during image processing.
 */

try {
  self.importScripts('color-quantizer.js');
} catch (loadErr) {
  console.error('Failed to importScripts color-quantizer.js in Worker', loadErr);
}

self.onmessage = function(e) {
  if (!e.data) return;
  const { requestId, imageData, paletteColors, options } = e.data;
  try {
    if (!self.BeadQuantizer || !self.BeadQuantizer.quantizeImage) {
      throw new Error('BeadQuantizer engine is not initialized in Worker');
    }
    const result = self.BeadQuantizer.quantizeImage(imageData, paletteColors, options);
    self.postMessage({ status: 'success', requestId, result });
  } catch (err) {
    self.postMessage({ status: 'error', requestId, error: err.message || String(err) });
  }
};
