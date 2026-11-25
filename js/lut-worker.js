/**
 * Web Worker 背景運算管線：負責 .cube 剖析、四面體超取樣烘焙、文字組裝與測試照片像素查表。
 * 使用 Transferable ArrayBuffer 零複製傳遞資料並捨棄過時預覽請求，確保手機瀏覽器主執行緒零卡頓。
 */

import { parseCubeText, bakeSrgbLut, formatCubeFile, applyBakedLutToRgba } from './lut-core.js';

/** @type {ReturnType<typeof parseCubeText> | null} */
let cachedSourceCube = null;

/**
 * 快取最近一次烘焙的目標 sRGB LUT，避免調整照片或點擊下載時重複計算。
 * @type {{ key: string, targetSize: number, data: Float64Array } | null}
 */
let cachedBakedLut = null;

/** @type {Uint8ClampedArray | null} */
let cachedPreviewSourceRgba = null;
let cachedPreviewWidth = 0;
let cachedPreviewHeight = 0;

let latestPreviewRequestId = 0;

/**
 * 依據轉換參數組合快取鍵值。
 * @param {{ inputCurve: string, targetSize: number, linearGain: number, intensity: number }} params
 */
function makeBakeKey(params) {
  return `${params.inputCurve}|${params.targetSize}|${params.linearGain.toFixed(4)}|${params.intensity.toFixed(4)}`;
}

/**
 * 取得或重新計算當前參數對應之 sRGB 3D LUT。
 * @param {{ inputCurve: 'flog2' | 'flog', targetSize: number, linearGain: number, intensity: number }} params
 */
function ensureBakedLut(params) {
  if (!cachedSourceCube) {
    throw new Error('尚未載入有效的 .cube 母片檔案。');
  }
  const key = makeBakeKey(params);
  if (cachedBakedLut && cachedBakedLut.key === key) {
    return cachedBakedLut;
  }
  const data = bakeSrgbLut(cachedSourceCube, params);
  cachedBakedLut = {
    key,
    targetSize: params.targetSize,
    data,
  };
  return cachedBakedLut;
}

const utf8Decoder = new TextDecoder('utf-8');
const utf8Encoder = new TextEncoder();

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'LOAD_CUBE') {
    const { requestId, buffer } = msg;
    const t0 = performance.now();
    try {
      const text = utf8Decoder.decode(buffer);
      const parsed = parseCubeText(text);
      cachedSourceCube = parsed;
      cachedBakedLut = null;
      const elapsedMs = performance.now() - t0;

      self.postMessage({
        type: 'CUBE_LOADED',
        requestId,
        meta: {
          size: parsed.size,
          nodeCount: parsed.size ** 3,
          rawTitle: parsed.rawTitle,
          outputCurve: parsed.outputCurve,
          elapsedMs,
        },
      });
    } catch (err) {
      self.postMessage({
        type: 'WORKER_ERROR',
        requestId,
        stage: 'LOAD_CUBE',
        message: err instanceof Error ? err.message : '剖析 .cube 檔案時發生未知錯誤。',
      });
    }
    return;
  }

  if (msg.type === 'SET_PREVIEW_IMAGE') {
    const { requestId, rgbaBuffer, width, height, params } = msg;
    latestPreviewRequestId = requestId;
    cachedPreviewSourceRgba = new Uint8ClampedArray(rgbaBuffer);
    cachedPreviewWidth = width;
    cachedPreviewHeight = height;

    if (!cachedSourceCube || !params) {
      self.postMessage({
        type: 'PREVIEW_IMAGE_STORED',
        requestId,
        width,
        height,
      });
      return;
    }

    renderPreview(requestId, params);
    return;
  }

  if (msg.type === 'RENDER_PREVIEW') {
    const { requestId, params } = msg;
    latestPreviewRequestId = requestId;
    if (!cachedSourceCube || !cachedPreviewSourceRgba) return;
    renderPreview(requestId, params);
    return;
  }

  if (msg.type === 'EXPORT_CUBE') {
    const { requestId, params, title } = msg;
    const t0 = performance.now();
    try {
      const baked = ensureBakedLut(params);
      const cubeText = formatCubeFile(baked.data, baked.targetSize, title);
      const bytes = utf8Encoder.encode(cubeText);
      const elapsedMs = performance.now() - t0;

      self.postMessage(
        {
          type: 'CUBE_EXPORTED',
          requestId,
          buffer: bytes.buffer,
          byteLength: bytes.byteLength,
          targetSize: baked.targetSize,
          nodeCount: baked.targetSize ** 3,
          elapsedMs,
        },
        [bytes.buffer]
      );
    } catch (err) {
      self.postMessage({
        type: 'WORKER_ERROR',
        requestId,
        stage: 'EXPORT_CUBE',
        message: err instanceof Error ? err.message : '轉換並匯出 .cube 時發生錯誤。',
      });
    }
  }
});

/**
 * 渲染測試照片並透過 Transferable ArrayBuffer 回傳主執行緒。
 * @param {number} requestId
 * @param {{ inputCurve: 'flog2' | 'flog', targetSize: number, linearGain: number, intensity: number }} params
 */
function renderPreview(requestId, params) {
  if (requestId < latestPreviewRequestId) return;
  const t0 = performance.now();
  try {
    const baked = ensureBakedLut(params);
    if (requestId < latestPreviewRequestId || !cachedPreviewSourceRgba) return;

    const gradedRgba = applyBakedLutToRgba(cachedPreviewSourceRgba, baked.data, baked.targetSize);
    const elapsedMs = performance.now() - t0;

    self.postMessage(
      {
        type: 'PREVIEW_RENDERED',
        requestId,
        rgbaBuffer: gradedRgba.buffer,
        width: cachedPreviewWidth,
        height: cachedPreviewHeight,
        elapsedMs,
      },
      [gradedRgba.buffer]
    );
  } catch (err) {
    self.postMessage({
      type: 'WORKER_ERROR',
      requestId,
      stage: 'RENDER_PREVIEW',
      message: err instanceof Error ? err.message : '產生照片預覽時發生錯誤。',
    });
  }
}
