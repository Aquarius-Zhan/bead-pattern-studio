/**
 * Web Worker for Asynchronous Bead Color Quantization
 * Ensures mobile browser UI remains 100% fluid during image processing.
 */

self.importScripts('color-quantizer.js');

self.onmessage = function(e) {
  const { imageData, paletteColors, options } = e.data;
  try {
    const result = self.BeadQuantizer.quantizeImage(imageData, paletteColors, options);
    self.postMessage({ status: 'success', result });
  } catch (err) {
    self.postMessage({ status: 'error', error: err.message });
  }
};
