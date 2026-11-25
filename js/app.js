/**
 * FujiLUT-for-Mobile 主執行緒互動與無障礙控制器。
 * 遵循 modern-web-guidance：Web Worker 非阻塞運算、scheduler.yield() 長任務切分、
 * :user-invalid <-> aria-invalid 動態橋接、IME 組字防護、全程 textContent 防堵 DOM XSS。
 */

import {
  analyzeCubeFilename,
  measureSnapseedPreview,
  sanitizeCubeTitle,
  sanitizeDownloadStem,
} from './presets.js';

const MAX_PREVIEW_EDGE = 1280;

/**
 * 將主執行緒控制權讓回瀏覽器以維護良好 INP，優先使用 scheduler.yield() 並以 setTimeout 降級。
 * @returns {Promise<void>}
 */
function yieldToMain() {
  if ('scheduler' in window && typeof window.scheduler.yield === 'function') {
    return window.scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 格式化位元組大小為易讀字串。
 * @param {number} bytes
 * @returns {string}
 */
function formatByteSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// 取得 DOM 節點
const form = /** @type {HTMLFormElement} */ (document.getElementById('converter-form'));
const cubeFileInput = /** @type {HTMLInputElement} */ (document.getElementById('cube-file-input'));
const cubeDropZone = /** @type {HTMLElement} */ (document.getElementById('cube-drop-zone'));
const dropZoneTitle = /** @type {HTMLElement} */ (document.getElementById('drop-zone-title'));
const cubeFileErrorText = /** @type {HTMLElement} */ (document.getElementById('cube-file-error-text'));

const cubeMetaPanel = /** @type {HTMLElement} */ (document.getElementById('cube-meta-panel'));
const metaFilename = /** @type {HTMLElement} */ (document.getElementById('meta-filename'));
const metaGrid = /** @type {HTMLElement} */ (document.getElementById('meta-grid'));
const metaTitle = /** @type {HTMLElement} */ (document.getElementById('meta-title'));
const metaPresetDesc = /** @type {HTMLElement} */ (document.getElementById('meta-preset-desc'));

const curveFlog2Radio = /** @type {HTMLInputElement} */ (document.getElementById('curve-flog2'));
const curveFlogRadio = /** @type {HTMLInputElement} */ (document.getElementById('curve-flog'));

const linearGainSlider = /** @type {HTMLInputElement} */ (document.getElementById('linear-gain'));
const linearGainOutput = /** @type {HTMLOutputElement} */ (document.getElementById('linear-gain-output'));
const resetGainBtn = /** @type {HTMLButtonElement} */ (document.getElementById('reset-gain-btn'));

const intensitySlider = /** @type {HTMLInputElement} */ (document.getElementById('lut-intensity'));
const intensityOutput = /** @type {HTMLOutputElement} */ (document.getElementById('lut-intensity-output'));
const resetIntensityBtn = /** @type {HTMLButtonElement} */ (document.getElementById('reset-intensity-btn'));

const namingShortExample = /** @type {HTMLElement} */ (document.getElementById('naming-short-example'));
const namingEnglishExample = /** @type {HTMLElement} */ (document.getElementById('naming-english-example'));
const customNameBox = /** @type {HTMLElement} */ (document.getElementById('custom-name-box'));
const customNameInput = /** @type {HTMLInputElement} */ (document.getElementById('custom-name-input'));

const snapseedThumbLabel = /** @type {HTMLElement} */ (document.getElementById('snapseed-thumb-label'));
const snapseedPreviewText = /** @type {HTMLElement} */ (document.getElementById('snapseed-preview-text'));
const resolvedFilenameEl = /** @type {HTMLElement} */ (document.getElementById('resolved-filename'));
const resolvedCubeTitleEl = /** @type {HTMLElement} */ (document.getElementById('resolved-cube-title'));
const snapseedWidthBadge = /** @type {HTMLElement} */ (document.getElementById('snapseed-width-badge'));

const convertBtn = /** @type {HTMLButtonElement} */ (document.getElementById('convert-download-btn'));
const appStatus = /** @type {HTMLElement} */ (document.getElementById('app-status'));

const photoDetails = /** @type {HTMLDetailsElement} */ (document.getElementById('photo-preview-details'));
const photoFileInput = /** @type {HTMLInputElement} */ (document.getElementById('photo-file-input'));
const photoDropZone = /** @type {HTMLElement} */ (document.getElementById('photo-drop-zone'));
const sampleChartBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sample-chart-btn'));
const compareSlider = /** @type {HTMLInputElement} */ (document.getElementById('compare-slider'));
const compareSliderOutput = /** @type {HTMLOutputElement} */ (document.getElementById('compare-slider-output'));
const compareStage = /** @type {HTMLElement} */ (document.getElementById('compare-stage'));
const canvasBefore = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas-before'));
const canvasAfter = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas-after'));
const previewMetaNote = /** @type {HTMLElement} */ (document.getElementById('preview-meta-note'));

// 應用程式狀態
const state = {
  cubeLoaded: false,
  isBusy: false,
  shortName: '人文街拍_Classic-Neg',
  englishName: 'Classic-Neg',
  activePhotoLabel: '內建色階測試卡',
  previewImageReadyInWorker: false,
  nextRequestId: 1,
  activeLoadRequestId: 0,
  activeExportRequestId: 0,
  activePreviewRequestId: 0,
};

const worker = new Worker(new URL('./lut-worker.js', import.meta.url), { type: 'module' });

/**
 * 更新單一無障礙狀態播報區（全程使用 textContent 杜絕 DOM XSS）。
 * @param {string} text
 * @param {'neutral' | 'success' | 'error'} [tone='neutral']
 */
function setStatus(text, tone = 'neutral') {
  appStatus.dataset.tone = tone;
  appStatus.textContent = text;
}

/**
 * 設定主要轉換按鈕之 aria-disabled 狀態，不移除鍵盤焦點。
 * @param {boolean} busy
 * @param {string} [label]
 */
function setConvertBusy(busy, label) {
  state.isBusy = busy;
  convertBtn.setAttribute('aria-disabled', busy ? 'true' : 'false');
  convertBtn.textContent = label ?? (busy ? '正在背景轉換 .cube…' : '轉換並下載 .cube 濾鏡');
}

// ============================================================================
// 表單無障礙驗證橋接（:user-invalid <-> aria-invalid 與動態 aria-describedby）
// ============================================================================
const supportsUserInvalid = CSS.supports('selector(:user-invalid)');
const dirtyFallbackMap = new WeakMap();
const flaggedInvalidFields = new WeakSet();

/**
 * 僅在欄位顯示錯誤時將 data-error 指向的錯誤訊息 ID 掛入 aria-describedby。
 * @param {HTMLElement} el
 * @param {boolean} showError
 */
function syncErrorDescribedBy(el, showError) {
  const errorId = el.dataset.error;
  if (!errorId) return;
  const existing = (el.getAttribute('aria-describedby') || '')
    .split(/\s+/)
    .filter((id) => id && id !== errorId);
  if (showError) {
    existing.push(errorId);
  }
  if (existing.length > 0) {
    el.setAttribute('aria-describedby', existing.join(' '));
  } else {
    el.removeAttribute('aria-describedby');
  }
}

/**
 * 同步單一表單控制項的視覺驗證狀態與 ARIA 屬性（略過 range 滑桿）。
 * @param {EventTarget | null} target
 * @param {{ forceCommit?: boolean }} [opts]
 */
function syncFieldValidation(target, opts = {}) {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) {
    return;
  }
  if (target.type === 'range' || target.disabled) {
    target.setAttribute('aria-invalid', 'false');
    target.classList.remove('user-invalid-fallback', 'user-valid-fallback');
    syncErrorDescribedBy(target, false);
    return;
  }

  let isUserInvalid = false;
  if (supportsUserInvalid) {
    isUserInvalid = target.matches(':user-invalid') || (opts.forceCommit === true && !target.validity.valid);
    if (opts.forceCommit && !target.validity.valid) {
      target.classList.add('user-invalid-fallback');
    } else {
      target.classList.remove('user-invalid-fallback');
    }
  } else {
    const rec = dirtyFallbackMap.get(target) || { interacted: false, blurred: false };
    if (opts.forceCommit) {
      rec.interacted = true;
      rec.blurred = true;
      dirtyFallbackMap.set(target, rec);
    }
    if (rec.interacted && rec.blurred) {
      isUserInvalid = !target.validity.valid;
      target.classList.toggle('user-invalid-fallback', isUserInvalid);
      target.classList.toggle('user-valid-fallback', !isUserInvalid);
    }
  }

  if (isUserInvalid) {
    target.setAttribute('aria-invalid', 'true');
    syncErrorDescribedBy(target, true);
    flaggedInvalidFields.add(target);
  } else if (flaggedInvalidFields.has(target) || target.getAttribute('aria-invalid') !== 'true') {
    target.setAttribute('aria-invalid', 'false');
    syncErrorDescribedBy(target, false);
    flaggedInvalidFields.delete(target);
  }
}

form.querySelectorAll('input:not([type="range"]), select, textarea').forEach((el) => {
  el.setAttribute('aria-invalid', 'false');
});

form.addEventListener(
  'blur',
  (e) => {
    if (!supportsUserInvalid && e.target instanceof HTMLElement) {
      const rec = dirtyFallbackMap.get(e.target) || { interacted: false, blurred: false };
      rec.blurred = true;
      dirtyFallbackMap.set(e.target, rec);
    }
    syncFieldValidation(e.target);
  },
  true
);

form.addEventListener('input', (e) => {
  if (!supportsUserInvalid && e.target instanceof HTMLElement) {
    const rec = dirtyFallbackMap.get(e.target) || { interacted: false, blurred: false };
    rec.interacted = true;
    dirtyFallbackMap.set(e.target, rec);
  }
  syncFieldValidation(e.target);
});

form.addEventListener(
  'change',
  (e) => {
    if (!supportsUserInvalid && e.target instanceof HTMLElement) {
      const rec = dirtyFallbackMap.get(e.target) || { interacted: true, blurred: true };
      rec.interacted = true;
      dirtyFallbackMap.set(e.target, rec);
    }
    syncFieldValidation(e.target);
  },
  true
);

// ============================================================================
// 原生 Range 滑桿進度與無障礙文字同步
// ============================================================================
/**
 * 同步滑桿的 CSS 變數（相容不支援型別化 attr() 之 Safari）
 * @param {HTMLInputElement} slider
 */
function syncSliderCssVars(slider) {
  slider.style.setProperty('--attr-min', slider.min || '0');
  slider.style.setProperty('--attr-max', slider.max || '100');
  slider.style.setProperty('--control-value', slider.value);
}

function updateGainUi() {
  const val = Number(linearGainSlider.value);
  const formatted = `${val.toFixed(2)}x`;
  linearGainOutput.textContent = formatted;
  linearGainSlider.setAttribute(
    'aria-valuetext',
    Math.abs(val - 1.0) < 0.001 ? '1.00 倍（忠實白皮書）' : `${val.toFixed(2)} 倍`
  );
  syncSliderCssVars(linearGainSlider);
}

function updateIntensityUi() {
  const pct = Math.round(Number(intensitySlider.value));
  const formatted = `${pct}%`;
  intensityOutput.textContent = formatted;
  intensitySlider.setAttribute('aria-valuetext', formatted);
  syncSliderCssVars(intensitySlider);
}

function updateCompareUi() {
  const pct = Math.round(Number(compareSlider.value));
  compareSliderOutput.textContent = `${pct}%`;
  compareSlider.setAttribute('aria-valuetext', `原圖 ${pct}%，套用濾鏡 ${100 - pct}%`);
  compareStage.style.setProperty('--split-pct', `${pct}%`);
  syncSliderCssVars(compareSlider);
}

updateGainUi();
updateIntensityUi();
updateCompareUi();

// ============================================================================
// 參數讀取與輸出命名／Snapseed 9 半形字元即時預覽
// ============================================================================
/**
 * 讀取目前表單中的色彩轉換參數。
 */
function getConversionParams() {
  const formData = new FormData(form);
  const inputCurve = formData.get('inputCurve') === 'flog' ? 'flog' : 'flog2';
  const targetSize = Number(formData.get('targetSize') || 33);
  const linearGain = Number(linearGainSlider.value || 1.0);
  const intensity = Number(intensitySlider.value || 100) / 100.0;
  return { inputCurve, targetSize, linearGain, intensity };
}

/**
 * 取得目前選取之命名模式。
 * @returns {'short' | 'english' | 'custom'}
 */
function getNamingMode() {
  const checked = form.querySelector('input[name="namingMode"]:checked');
  const val = checked instanceof HTMLInputElement ? checked.value : 'short';
  if (val === 'english' || val === 'custom') return val;
  return 'short';
}

/**
 * 解析目前應使用的輸出主檔名（未清理前之顯示文字與清理後之安全檔名／TITLE）。
 */
function resolveOutputNaming() {
  const mode = getNamingMode();
  let rawCandidate = state.shortName;
  if (mode === 'english') {
    rawCandidate = state.englishName;
  } else if (mode === 'custom') {
    rawCandidate = customNameInput.value.trim();
  }

  const displayBase = rawCandidate || (mode === 'custom' ? '' : state.shortName);
  const safeStem = sanitizeDownloadStem(displayBase || state.shortName);
  const safeTitle = sanitizeCubeTitle(displayBase || state.shortName);
  const measurement = measureSnapseedPreview(displayBase ? safeStem : '');

  return {
    mode,
    displayBase,
    safeStem,
    safeTitle,
    measurement,
  };
}

function updateNamingPreviewUi() {
  const mode = getNamingMode();
  const isCustom = mode === 'custom';

  customNameBox.hidden = !isCustom;
  customNameInput.disabled = !isCustom;
  customNameInput.required = isCustom;
  if (!isCustom) {
    customNameInput.setAttribute('aria-invalid', 'false');
    customNameInput.classList.remove('user-invalid-fallback', 'user-valid-fallback');
    syncErrorDescribedBy(customNameInput, false);
  }

  namingShortExample.textContent = `例：${state.shortName}`;
  namingEnglishExample.textContent = `例：${state.englishName}`;

  const { safeStem, safeTitle, measurement } = resolveOutputNaming();
  snapseedThumbLabel.textContent = measurement.preview;
  snapseedPreviewText.textContent = measurement.preview;
  resolvedFilenameEl.textContent = `${safeStem}.cube`;
  resolvedCubeTitleEl.textContent = `TITLE "${safeTitle}"`;

  if (measurement.totalUnits === 0) {
    snapseedWidthBadge.textContent = '請輸入自訂名稱以預覽 Snapseed 9 半形字元截斷位置';
  } else if (measurement.isTruncated) {
    snapseedWidthBadge.textContent = `前 9 半形可視：「${measurement.visiblePart}」｜全長 ${measurement.totalUnits} 半形寬（超出將縮略為 …）`;
  } else {
    snapseedWidthBadge.textContent = `完整顯示不截斷｜全長 ${measurement.totalUnits} / 9 半形寬`;
  }
}

updateNamingPreviewUi();

// 自訂名稱輸入框：防止中文／注音輸入法（IME）組字按 Enter 時誤觸送出（含 Safari keyCode 229 防護）
customNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    form.requestSubmit();
  }
});

customNameInput.addEventListener('input', () => {
  updateNamingPreviewUi();
});

form.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;

  if (target.name === 'namingMode') {
    if (target.value === 'custom' && !customNameInput.value.trim()) {
      customNameInput.value = state.shortName;
    }
    updateNamingPreviewUi();
    if (target.value === 'custom') {
      customNameInput.focus();
    }
    return;
  }

  if (target.name === 'inputCurve' || target.name === 'targetSize') {
    schedulePreviewRender();
  }
});

linearGainSlider.addEventListener('input', () => {
  updateGainUi();
  schedulePreviewRender();
});

resetGainBtn.addEventListener('click', () => {
  linearGainSlider.value = '1';
  updateGainUi();
  schedulePreviewRender();
});

intensitySlider.addEventListener('input', () => {
  updateIntensityUi();
  schedulePreviewRender();
});

resetIntensityBtn.addEventListener('click', () => {
  intensitySlider.value = '100';
  updateIntensityUi();
  schedulePreviewRender();
});

compareSlider.addEventListener('input', () => {
  updateCompareUi();
});

// ============================================================================
// .cube 檔案選取與拖曳載入
// ============================================================================
/**
 * 處理使用者選取或拖放的單一 .cube 檔案。
 * @param {File | undefined | null} file
 */
async function handleCubeFile(file) {
  if (!file) return;

  state.cubeLoaded = false;
  const info = analyzeCubeFilename(file.name);
  state.shortName = info.shortName;
  state.englishName = info.englishName;

  // 依上傳檔名自動預選 F-Log2 / F-Log
  if (info.detectedCurve === 'flog') {
    curveFlogRadio.checked = true;
  } else {
    curveFlog2Radio.checked = true;
  }

  if (getNamingMode() === 'custom') {
    customNameInput.value = info.shortName;
  }
  updateNamingPreviewUi();

  dropZoneTitle.textContent = `正在解析：${file.name}`;
  metaFilename.textContent = file.name;
  setConvertBusy(true, '正在解析 .cube 母片…');
  setStatus(`正在背景解析「${file.name}」…`, 'neutral');

  try {
    const buffer = await file.arrayBuffer();
    const requestId = state.nextRequestId++;
    state.activeLoadRequestId = requestId;
    worker.postMessage({ type: 'LOAD_CUBE', requestId, buffer }, [buffer]);
  } catch {
    state.cubeLoaded = false;
    setConvertBusy(false);
    cubeFileInput.setCustomValidity('無法讀取選取的檔案。');
    cubeFileErrorText.textContent = '無法讀取此檔案，請確認檔案未毀損後重試。';
    syncFieldValidation(cubeFileInput, { forceCommit: true });
    setStatus('讀取檔案失敗，請重新選取有效的 .cube 檔案。', 'error');
  }
}

cubeFileInput.addEventListener('change', () => {
  const file = cubeFileInput.files?.[0];
  if (file) {
    cubeFileInput.setCustomValidity('');
    syncFieldValidation(cubeFileInput);
    handleCubeFile(file);
  }
});

function wireDropSurface(surface, onFileDrop) {
  surface.addEventListener('dragenter', (e) => {
    e.preventDefault();
    surface.classList.add('is-dragover');
  });
  surface.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    surface.classList.add('is-dragover');
  });
  surface.addEventListener('dragleave', (e) => {
    if (!surface.contains(/** @type {Node | null} */ (e.relatedTarget))) {
      surface.classList.remove('is-dragover');
    }
  });
  surface.addEventListener('drop', (e) => {
    e.preventDefault();
    surface.classList.remove('is-dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file) onFileDrop(file);
  });
}

wireDropSurface(cubeDropZone, (file) => {
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    cubeFileInput.files = dt.files;
  } catch {
    // 若部分行動瀏覽器不支援設定 input.files，後續由 state.cubeLoaded 驗證放行
  }
  cubeFileInput.setCustomValidity('');
  syncFieldValidation(cubeFileInput);
  handleCubeFile(file);
});

// ============================================================================
// 本地測試照片與內建色階測試卡即時預覽
// ============================================================================
const ctxBefore = canvasBefore.getContext('2d', { willReadFrequently: true });
const ctxAfter = canvasAfter.getContext('2d');

/**
 * 於本地 Canvas 繪製標準 sRGB 色彩、灰階斜坡與膚色漸層測試卡（零外部圖片請求）。
 */
async function loadProceduralTestChart() {
  const w = 960;
  const h = 540;
  canvasBefore.width = w;
  canvasBefore.height = h;
  canvasAfter.width = w;
  canvasAfter.height = h;
  if (!ctxBefore || !ctxAfter) return;

  // 上半部：天空至夕陽連續平滑漸層，檢驗高光滾降與色彩過渡
  const skyGrad = ctxBefore.createLinearGradient(0, 0, w, h * 0.55);
  skyGrad.addColorStop(0, '#1e4f8a');
  skyGrad.addColorStop(0.45, '#4b86b4');
  skyGrad.addColorStop(0.78, '#e39b6d');
  skyGrad.addColorStop(1, '#f7dfd0');
  ctxBefore.fillStyle = skyGrad;
  ctxBefore.fillRect(0, 0, w, Math.floor(h * 0.55));

  // 中段色塊列：記憶色（膚色、植栽綠、富士藍、正紅、暖黃、洋紅、青色、深影）
  const swatches = [
    '#f2ccb7', '#d89c7e', '#9f654b', '#3c6e47',
    '#1f5f8b', '#c83e37', '#e0a92e', '#6f4a8e',
  ];
  const bandY = Math.floor(h * 0.55);
  const bandH = Math.floor(h * 0.25);
  const swW = w / swatches.length;
  for (let i = 0; i < swatches.length; i++) {
    ctxBefore.fillStyle = swatches[i];
    ctxBefore.fillRect(Math.floor(i * swW), bandY, Math.ceil(swW), bandH);
  }

  await yieldToMain();

  // 底部：0 -> 255 連續中性灰階楔形條，檢驗四面體插值中性軸零偏色與暗高光階調
  const rampY = bandY + bandH;
  const rampH = h - rampY;
  const rampGrad = ctxBefore.createLinearGradient(0, 0, w, 0);
  rampGrad.addColorStop(0, '#000000');
  rampGrad.addColorStop(0.5, '#777777');
  rampGrad.addColorStop(1, '#ffffff');
  ctxBefore.fillStyle = rampGrad;
  ctxBefore.fillRect(0, rampY, w, rampH);

  // 預設將套用後畫面同步為原圖，待母片載入後即由 Worker 覆寫
  ctxAfter.drawImage(canvasBefore, 0, 0);

  state.activePhotoLabel = '內建色階測試卡 (960×540)';
  pushPreviewSourceToWorker(w, h);
}

/**
 * 將目前 canvasBefore 內的原始像素傳送至 Web Worker 快取並觸發 LUT 套用。
 * @param {number} width
 * @param {number} height
 */
function pushPreviewSourceToWorker(width, height) {
  if (!ctxBefore) return;
  const imgData = ctxBefore.getImageData(0, 0, width, height);
  const bufferCopy = imgData.data.slice().buffer;
  const requestId = state.nextRequestId++;
  state.activePreviewRequestId = requestId;
  state.previewImageReadyInWorker = true;

  worker.postMessage(
    {
      type: 'SET_PREVIEW_IMAGE',
      requestId,
      rgbaBuffer: bufferCopy,
      width,
      height,
      params: state.cubeLoaded ? getConversionParams() : null,
    },
    [bufferCopy]
  );

  if (!state.cubeLoaded) {
    previewMetaNote.textContent = `已載入「${state.activePhotoLabel}」。請於上方選取富士 .cube 母片以檢視套用效果。`;
  }
}

/**
 * 載入使用者本機照片，等比例縮放至長邊最大 1280px 後送交 Worker。
 * @param {File | undefined | null} file
 */
async function handlePhotoFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|avif|gif|bmp|heic|heif)$/i.test(file.name)) {
    setStatus('不支援的照片格式，請選擇 JPG、PNG 或 WebP 圖片檔案。', 'error');
    return;
  }

  try {
    previewMetaNote.textContent = `正在解碼照片「${file.name}」…`;
    let bitmap;
    if ('createImageBitmap' in window) {
      bitmap = await createImageBitmap(file);
    } else {
      bitmap = await loadImageFallback(file);
    }

    const srcW = bitmap.width;
    const srcH = bitmap.height;
    const scale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(srcW, srcH));
    const dstW = Math.max(1, Math.round(srcW * scale));
    const dstH = Math.max(1, Math.round(srcH * scale));

    canvasBefore.width = dstW;
    canvasBefore.height = dstH;
    canvasAfter.width = dstW;
    canvasAfter.height = dstH;

    ctxBefore?.drawImage(bitmap, 0, 0, dstW, dstH);
    ctxAfter?.drawImage(bitmap, 0, 0, dstW, dstH);
    if ('close' in bitmap && typeof bitmap.close === 'function') {
      bitmap.close();
    }

    state.activePhotoLabel = `${file.name} (${dstW}×${dstH})`;
    if (!photoDetails.open) {
      photoDetails.open = true;
    }
    pushPreviewSourceToWorker(dstW, dstH);
  } catch {
    previewMetaNote.textContent = '無法解碼此圖片檔案，請改用標準 JPG、PNG 或 WebP 照片重試。';
    setStatus('無法解碼所選照片檔案，請改試 JPG 或 PNG 格式。', 'error');
  }
}

/**
 * 舊版瀏覽器無 createImageBitmap 時之圖片解碼降級。
 * @param {File} file
 * @returns {Promise<HTMLImageElement>}
 */
function loadImageFallback(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

function schedulePreviewRender() {
  if (!state.cubeLoaded || !state.previewImageReadyInWorker) return;
  const requestId = state.nextRequestId++;
  state.activePreviewRequestId = requestId;
  worker.postMessage({
    type: 'RENDER_PREVIEW',
    requestId,
    params: getConversionParams(),
  });
}

photoDetails.addEventListener('toggle', () => {
  if (photoDetails.open && !state.previewImageReadyInWorker) {
    loadProceduralTestChart();
  }
});

photoFileInput.addEventListener('change', () => {
  const file = photoFileInput.files?.[0];
  if (file) handlePhotoFile(file);
});

wireDropSurface(photoDropZone, (file) => {
  handlePhotoFile(file);
});

sampleChartBtn.addEventListener('click', () => {
  loadProceduralTestChart();
});

// ============================================================================
// 一鍵轉換與下載（aria-disabled 攔截 + application/octet-stream 保護副檔名）
// ============================================================================
convertBtn.addEventListener('click', (event) => {
  if (convertBtn.getAttribute('aria-disabled') === 'true') {
    event.preventDefault();
  }
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.isBusy || convertBtn.getAttribute('aria-disabled') === 'true') {
    return;
  }

  // 若透過拖放載入 .cube，確保原生 required 驗證不會誤擋已成功載入之檔案
  if (state.cubeLoaded) {
    cubeFileInput.required = false;
    cubeFileInput.setCustomValidity('');
  } else {
    cubeFileInput.required = true;
    if (!cubeFileInput.files || cubeFileInput.files.length === 0) {
      cubeFileErrorText.textContent = '請先選取有效的富士 .cube 3D LUT 檔案。';
    }
  }

  const mode = getNamingMode();
  if (mode === 'custom') {
    const trimmed = customNameInput.value.trim();
    if (!trimmed) {
      customNameInput.setCustomValidity('請輸入自訂濾鏡名稱。');
    } else {
      customNameInput.setCustomValidity('');
    }
  } else {
    customNameInput.setCustomValidity('');
  }

  if (!state.cubeLoaded || !form.checkValidity()) {
    const controls = [cubeFileInput, customNameInput];
    let firstInvalid = null;
    for (const ctrl of controls) {
      syncFieldValidation(ctrl, { forceCommit: true });
      if (!firstInvalid && !ctrl.disabled && (!ctrl.validity.valid || (ctrl === cubeFileInput && !state.cubeLoaded))) {
        firstInvalid = ctrl;
      }
    }
    if (!state.cubeLoaded) {
      cubeFileInput.setAttribute('aria-invalid', 'true');
      cubeFileInput.classList.add('user-invalid-fallback');
      syncErrorDescribedBy(cubeFileInput, true);
      firstInvalid = cubeFileInput;
      setStatus('尚未載入有效的 .cube 母片，請先選取檔案後再轉換。', 'error');
    } else {
      setStatus('請修正標示錯誤的欄位後再執行轉換。', 'error');
    }
    firstInvalid?.focus();
    return;
  }

  const { safeTitle } = resolveOutputNaming();
  const params = getConversionParams();
  const requestId = state.nextRequestId++;
  state.activeExportRequestId = requestId;

  setConvertBusy(true, '正在烘焙並封裝 .cube…');
  setStatus(`正在將母片轉換為 ${params.targetSize}Grid sRGB 濾鏡…`, 'neutral');

  worker.postMessage({
    type: 'EXPORT_CUBE',
    requestId,
    params,
    title: safeTitle,
  });
});

// ============================================================================
// Web Worker 回呼處理
// ============================================================================
worker.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'CUBE_LOADED') {
    if (msg.requestId !== state.activeLoadRequestId) return;
    const { size, nodeCount, rawTitle, outputCurve, elapsedMs } = msg.meta;

    state.cubeLoaded = true;
    cubeFileInput.required = false;
    cubeFileInput.setCustomValidity('');
    cubeFileInput.setAttribute('aria-invalid', 'false');
    cubeFileInput.classList.remove('user-invalid-fallback');
    syncErrorDescribedBy(cubeFileInput, false);

    dropZoneTitle.textContent = `已載入：${metaFilename.textContent}（點擊可更換檔案）`;
    metaGrid.textContent = `${size}Grid (${nodeCount.toLocaleString('zh-TW')} 節點)`;
    metaTitle.textContent = rawTitle ? rawTitle : '（母片未宣告 TITLE）';

    const info = analyzeCubeFilename(metaFilename.textContent || '');
    if (info.description) {
      metaPresetDesc.textContent = `推薦拍攝情境：${info.description}`;
      metaPresetDesc.hidden = false;
    } else if (outputCurve !== 'rec709') {
      metaPresetDesc.textContent = '偵測到對數至對數基準檔，轉換時將自動補齊對數逆轉換與標準 sRGB 編碼。';
      metaPresetDesc.hidden = false;
    } else {
      metaPresetDesc.hidden = true;
    }

    cubeMetaPanel.hidden = false;
    setConvertBusy(false);
    setStatus(
      `母片解析完成（${size}Grid，耗時 ${elapsedMs.toFixed(1)} ms）。可調整下方參數後一鍵轉換下載。`,
      'success'
    );

    if (state.previewImageReadyInWorker) {
      schedulePreviewRender();
    }
    return;
  }

  if (msg.type === 'PREVIEW_RENDERED') {
    if (msg.requestId < state.activePreviewRequestId) return;
    const { rgbaBuffer, width, height, elapsedMs } = msg;
    if (ctxAfter && canvasAfter.width === width && canvasAfter.height === height) {
      const clamped = new Uint8ClampedArray(rgbaBuffer);
      const imageData = new ImageData(clamped, width, height);
      ctxAfter.putImageData(imageData, 0, 0);
      const params = getConversionParams();
      previewMetaNote.textContent = `即時預覽已更新：${state.activePhotoLabel} · ${params.targetSize}Grid · 增益 ${params.linearGain.toFixed(2)}x · 強度 ${Math.round(params.intensity * 100)}%（Worker 耗時 ${elapsedMs.toFixed(1)} ms）`;
    }
    return;
  }

  if (msg.type === 'CUBE_EXPORTED') {
    if (msg.requestId !== state.activeExportRequestId) return;
    const { buffer, byteLength, targetSize, nodeCount, elapsedMs } = msg;
    const { safeStem } = resolveOutputNaming();
    const filename = `${safeStem}.cube`;

    // 使用 application/octet-stream 確保 Android Chrome / iOS Safari 保留 .cube 字尾不附加 .txt
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);

    setConvertBusy(false);
    setStatus(
      `已完成轉換並開始下載「${filename}」（${targetSize}Grid · ${nodeCount.toLocaleString('zh-TW')} 點 · ${formatByteSize(byteLength)} · 耗時 ${elapsedMs.toFixed(1)} ms）。`,
      'success'
    );
    return;
  }

  if (msg.type === 'WORKER_ERROR') {
    setConvertBusy(false);
    if (msg.stage === 'LOAD_CUBE') {
      state.cubeLoaded = false;
      cubeMetaPanel.hidden = true;
      dropZoneTitle.textContent = '點擊選取或拖曳單一 .cube 檔案至此';
      cubeFileErrorText.textContent = msg.message;
      cubeFileInput.setCustomValidity(msg.message);
      syncFieldValidation(cubeFileInput, { forceCommit: true });
    }
    setStatus(`處理失敗：${msg.message}`, 'error');
  }
});
