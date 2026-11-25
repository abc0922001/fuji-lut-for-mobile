/**
 * 富士 F-Log2 / F-Log 轉標準 sRGB 3D LUT 核心數學與檔案剖析模組。
 * 零 DOM 依賴，同時供瀏覽器 Web Worker 與 Node.js 自動化驗證腳本共用（Single Source of Truth）。
 */

import { sanitizeCubeTitle } from './presets.js';

/** 依據 Fujifilm F-Log2 Data Sheet Ver.1.1 第 2-3 節定義之雙向對數轉換常數與分界點 */
export const FLOG2_PARAMS = Object.freeze({
  a: 5.555556,
  b: 0.064829,
  c: 0.245281,
  d: 0.384316,
  e: 8.799461,
  f: 0.092864,
  cut1: 0.000889,
  cut2: 0.100686685370811,
});

/** 依據 Fujifilm F-Log Data Sheet 官方白皮書定義之一代雙向對數轉換常數與分界點 */
export const FLOG_PARAMS = Object.freeze({
  a: 0.555556,
  b: 0.009468,
  c: 0.344676,
  d: 0.790453,
  e: 8.735631,
  f: 0.092864,
  cut1: 0.00089,
  cut2: 0.100537775223865,
});

/**
 * 依據白皮書第 3 節 CIE 1931 色度座標推導之 ITU-R BT.709 (Rec.709) 轉 F-Gamut (ITU-R BT.2020) 列優先矩陣。
 * 與 convert_flog2.py 內 _REC709_TO_FGAMUT_T 常數完全一致，確保 float64 下 D65 白點嚴格守恆。
 */
export const REC709_TO_FGAMUT = Object.freeze([
  0.6274038959346990, 0.3292830383778837, 0.0433130656874172,
  0.0690972893582320, 0.9195403950754589, 0.0113623155663091,
  0.0163914388751502, 0.0880133078772257, 0.8955952532476241,
]);

/**
 * 將數值夾限於 [0.0, 1.0] 閉區間。
 * @param {number} x
 * @returns {number}
 */
export function clamp01(x) {
  return x <= 0.0 ? 0.0 : x >= 1.0 ? 1.0 : x;
}

/**
 * 依據 IEC 61966-2-1 標準將 sRGB 非線性訊號解碼為線性光訊號。
 * @param {number} x - 正規化之 sRGB 訊號 [0.0, 1.0]
 * @returns {number}
 */
export function srgbToLinear(x) {
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/**
 * 依據 IEC 61966-2-1 標準將線性光訊號編碼為 sRGB 非線性訊號。
 * @param {number} x - 場景線性光反射率
 * @returns {number}
 */
export function linearToSrgb(x) {
  const c = clamp01(x);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * (c ** (1.0 / 2.4)) - 0.055;
}

/**
 * 將 F-Gamut 線性光反射率依指定富士對數參數編碼為 F-Log2 或 F-Log 訊號。
 * @param {number} x - 線性光反射率（>= 0.0）
 * @param {typeof FLOG2_PARAMS} params - 對數曲線常數組
 * @returns {number}
 */
export function linearToFujilog(x, params = FLOG2_PARAMS) {
  return x < params.cut1
    ? params.e * x + params.f
    : params.c * Math.log10(params.a * x + params.b) + params.d;
}

/**
 * 將 F-Log2 或 F-Log 對數訊號逆轉換還原為線性光反射率。
 * @param {number} x - 對數訊號
 * @param {typeof FLOG2_PARAMS} params - 對數曲線常數組
 * @returns {number}
 */
export function fujilogToLinear(x, params = FLOG2_PARAMS) {
  return x < params.cut2
    ? (x - params.f) / params.e
    : (10.0 ** ((x - params.d) / params.c)) / params.a - params.b / params.a;
}

/**
 * 高容錯剖析 .cube 3D LUT 檔案文字，支援註解行、空行、UTF-8 BOM 與動態網格偵測。
 * @param {string} text - .cube 原始文字內容
 * @returns {{
 *   size: number,
 *   rawTitle: string,
 *   outputCurve: 'rec709' | 'flog2' | 'flog',
 *   domainMin: [number, number, number],
 *   domainMax: [number, number, number],
 *   data: Float64Array
 * }}
 */
export function parseCubeText(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('檔案內容為空白，請上傳有效的富士 .cube 3D LUT 檔案。');
  }

  const cleanText = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const lines = cleanText.split(/\r?\n/);

  let declaredSize = null;
  let rawTitle = '';
  /** @type {'rec709' | 'flog2' | 'flog'} */
  let outputCurve = 'rec709';
  /** @type {[number, number, number]} */
  let domainMin = [0.0, 0.0, 0.0];
  /** @type {[number, number, number]} */
  let domainMax = [1.0, 1.0, 1.0];

  /** @type {Float64Array | null} */
  let data = null;
  /** @type {number[] | null} */
  let dynamicValues = null;
  let valueOffset = 0;
  let inDataSection = false;

  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;

    if (s.charCodeAt(0) === 35 /* '#' */) {
      if (/F-Log2\s+to\s+F-Log2/i.test(s)) {
        outputCurve = 'flog2';
      } else if (/F-Log\s+to\s+F-Log(?!2)/i.test(s)) {
        outputCurve = 'flog';
      }
      continue;
    }

    if (!inDataSection) {
      if (s.startsWith('TITLE')) {
        const rest = s.slice(5).trim();
        if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) {
          rawTitle = rest.slice(1, -1);
        } else {
          rawTitle = rest;
        }
        continue;
      }

      if (s.startsWith('LUT_1D_SIZE')) {
        throw new Error('偵測到 1D LUT（LUT_1D_SIZE），本工具僅支援 3D LUT（LUT_3D_SIZE）色彩查找表。');
      }

      if (s.startsWith('LUT_3D_SIZE')) {
        const parts = s.split(/\s+/);
        const parsed = Number(parts[1]);
        if (!Number.isInteger(parsed) || parsed < 2 || parsed > 129) {
          throw new Error(`無效的 LUT_3D_SIZE 數值：「${parts[1] ?? ''}」（需為 2 至 129 之間的整數）。`);
        }
        declaredSize = parsed;
        continue;
      }

      if (s.startsWith('DOMAIN_MIN')) {
        const parts = s.split(/\s+/);
        if (parts.length >= 4) {
          const d0 = Number(parts[1]);
          const d1 = Number(parts[2]);
          const d2 = Number(parts[3]);
          if (Number.isFinite(d0) && Number.isFinite(d1) && Number.isFinite(d2)) {
            domainMin = [d0, d1, d2];
          }
        }
        continue;
      }

      if (s.startsWith('DOMAIN_MAX')) {
        const parts = s.split(/\s+/);
        if (parts.length >= 4) {
          const d0 = Number(parts[1]);
          const d1 = Number(parts[2]);
          const d2 = Number(parts[3]);
          if (Number.isFinite(d0) && Number.isFinite(d1) && Number.isFinite(d2)) {
            domainMax = [d0, d1, d2];
          }
        }
        continue;
      }

      if (/^[A-Za-z_]/.test(s)) {
        // 略過其他非數值標準檔頭關鍵字（如 LUT_3D_INPUT_RANGE），但若是亂碼文字將在最終筆數檢驗攔截
        const tokens = s.split(/\s+/);
        if (tokens.length === 2 || tokens.length === 3) {
          const secondNum = Number(tokens[1]);
          if (Number.isFinite(secondNum)) {
            continue;
          }
        }
        throw new Error(`檔案第 ${i + 1} 行出現無法辨識的標頭格式：「${s.slice(0, 48)}」。`);
      }

      inDataSection = true;
      if (declaredSize !== null) {
        data = new Float64Array(declaredSize * declaredSize * declaredSize * 3);
      } else {
        dynamicValues = [];
      }
    }

    const parts = s.split(/\s+/);
    if (parts.length !== 3) {
      throw new Error(`檔案第 ${i + 1} 行數值格式異常（預期每行 3 個 RGB 浮點數，實際為 ${parts.length} 個欄位）。`);
    }

    const r = Number(parts[0]);
    const g = Number(parts[1]);
    const b = Number(parts[2]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      throw new Error(`檔案第 ${i + 1} 行包含非有效數值：「${s.slice(0, 48)}」。`);
    }

    if (data !== null) {
      if (valueOffset + 3 > data.length) {
        throw new Error(`RGB 節點數量超過 LUT_3D_SIZE ${declaredSize} 預期的 ${declaredSize ** 3} 筆。`);
      }
      data[valueOffset++] = r;
      data[valueOffset++] = g;
      data[valueOffset++] = b;
    } else if (dynamicValues !== null) {
      dynamicValues.push(r, g, b);
    }
  }

  if (!inDataSection) {
    throw new Error('檔案中未找到任何有效的 RGB 色彩數值資料列。');
  }

  let finalSize = declaredSize ?? 65;
  if (data === null && dynamicValues !== null) {
    const tripletCount = dynamicValues.length / 3;
    const inferred = Math.round(Math.cbrt(tripletCount));
    if (inferred >= 2 && inferred <= 129 && inferred * inferred * inferred === tripletCount) {
      finalSize = inferred;
    }
    data = Float64Array.from(dynamicValues);
    valueOffset = data.length;
  }

  const expectedValues = finalSize * finalSize * finalSize * 3;
  if (!data || valueOffset !== expectedValues) {
    const actualTriplets = Math.floor(valueOffset / 3);
    throw new Error(
      `RGB 節點總數不符：預期 ${finalSize}^3 = ${finalSize ** 3} 筆，實際僅讀取到 ${actualTriplets} 筆。`
    );
  }

  return {
    size: finalSize,
    rawTitle,
    outputCurve,
    domainMin,
    domainMax,
    data,
  };
}

/**
 * 執行逆向色彩管線與 O(1) 四面體插值，將富士 F-Log2 / F-Log 母片烘焙為標準 sRGB 3D LUT。
 * 數學邏輯嚴格對齊 convert_flog2.py。
 *
 * @param {{
 *   size: number,
 *   outputCurve?: 'rec709' | 'flog2' | 'flog',
 *   domainMin?: [number, number, number],
 *   domainMax?: [number, number, number],
 *   data: Float64Array
 * }} parsedCube
 * @param {{
 *   inputCurve?: 'flog2' | 'flog',
 *   targetSize?: number,
 *   linearGain?: number,
 *   intensity?: number
 * }} [options]
 * @returns {Float64Array} 長度為 targetSize^3 * 3 之 RGB 陣列
 */
export function bakeSrgbLut(parsedCube, options = {}) {
  const srcSize = parsedCube.size;
  const srcData = parsedCube.data;
  const outputCurve = parsedCube.outputCurve ?? 'rec709';
  const domainMin = parsedCube.domainMin ?? [0.0, 0.0, 0.0];
  const domainMax = parsedCube.domainMax ?? [1.0, 1.0, 1.0];

  const inputCurve = options.inputCurve === 'flog' ? 'flog' : 'flog2';
  const targetSize = options.targetSize ?? 33;
  const linearGain = options.linearGain ?? 1.0;
  const intensity = options.intensity ?? 1.0;

  if (!Number.isInteger(targetSize) || targetSize < 2 || targetSize > 129) {
    throw new Error(`無效的輸出網格尺寸：${targetSize}`);
  }

  const curveParams = inputCurve === 'flog' ? FLOG_PARAMS : FLOG2_PARAMS;

  // 1D 軸向預計算，將 sRGB 指數解碼次數由 3 * M 降至 targetSize 次
  const srgb1d = new Float64Array(targetSize);
  const lin1d = new Float64Array(targetSize);
  const invTargetMax = 1.0 / (targetSize - 1);
  for (let i = 0; i < targetSize; i++) {
    const s = i * invTargetMax;
    srgb1d[i] = s;
    lin1d[i] = srgbToLinear(s) * linearGain;
  }

  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = REC709_TO_FGAMUT;

  const srcMaxIndex = srcSize - 1;
  const srcClampUpper = srcSize - 2;
  const strideR = 3;
  const strideG = srcSize * 3;
  const strideB = srcSize * srcSize * 3;

  const hasCustomDomain =
    domainMin[0] !== 0.0 || domainMin[1] !== 0.0 || domainMin[2] !== 0.0 ||
    domainMax[0] !== 1.0 || domainMax[1] !== 1.0 || domainMax[2] !== 1.0;
  const invDomR = hasCustomDomain ? 1.0 / (domainMax[0] - domainMin[0] || 1.0) : 1.0;
  const invDomG = hasCustomDomain ? 1.0 / (domainMax[1] - domainMin[1] || 1.0) : 1.0;
  const invDomB = hasCustomDomain ? 1.0 / (domainMax[2] - domainMin[2] || 1.0) : 1.0;

  const outData = new Float64Array(targetSize * targetSize * targetSize * 3);
  const blendIdentity = intensity < 1.0;
  const oneMinusT = 1.0 - intensity;

  let outOffset = 0;

  // 依 .cube 標準排列：Blue 軸變動最慢、Green 次之、Red 變動最快
  for (let ib = 0; ib < targetSize; ib++) {
    const bLin = lin1d[ib];
    const bSrgb = srgb1d[ib];

    for (let ig = 0; ig < targetSize; ig++) {
      const gLin = lin1d[ig];
      const gSrgb = srgb1d[ig];

      const fgR_gb = m01 * gLin + m02 * bLin;
      const fgG_gb = m11 * gLin + m12 * bLin;
      const fgB_gb = m21 * gLin + m22 * bLin;

      for (let ir = 0; ir < targetSize; ir++) {
        const rLin = lin1d[ir];

        // 線性色域轉換至 F-Gamut：夾下界 >= 0.0，使 Gain=1.0 時與 Python 完全等價，Gain>1.0 時推入對數高光滾降區
        const fgR = Math.max(0.0, m00 * rLin + fgR_gb);
        const fgG = Math.max(0.0, m10 * rLin + fgG_gb);
        const fgB = Math.max(0.0, m20 * rLin + fgB_gb);

        let logR = clamp01(linearToFujilog(fgR, curveParams));
        let logG = clamp01(linearToFujilog(fgG, curveParams));
        let logB = clamp01(linearToFujilog(fgB, curveParams));

        if (hasCustomDomain) {
          logR = clamp01((logR - domainMin[0]) * invDomR);
          logG = clamp01((logG - domainMin[1]) * invDomG);
          logB = clamp01((logB - domainMin[2]) * invDomB);
        }

        const scaledR = logR * srcMaxIndex;
        const scaledG = logG * srcMaxIndex;
        const scaledB = logB * srcMaxIndex;

        let ir0 = Math.floor(scaledR);
        let ig0 = Math.floor(scaledG);
        let ib0 = Math.floor(scaledB);
        if (ir0 > srcClampUpper) ir0 = srcClampUpper;
        if (ig0 > srcClampUpper) ig0 = srcClampUpper;
        if (ib0 > srcClampUpper) ib0 = srcClampUpper;

        const dr = scaledR - ir0;
        const dg = scaledG - ig0;
        const db = scaledB - ib0;

        const v0 = ir0 * strideR + ig0 * strideG + ib0 * strideB;

        // 沿主對角線切分 6 個四面體，消除三線性插值跨非中性色角平均造成的灰階偏色
        let dMax, dMid, dMin, sMax, sMid, sMin;
        if (dr >= dg && dg >= db) {
          dMax = dr; dMid = dg; dMin = db;
          sMax = strideR; sMid = strideG; sMin = strideB;
        } else if (dr >= db && db > dg) {
          dMax = dr; dMid = db; dMin = dg;
          sMax = strideR; sMid = strideB; sMin = strideG;
        } else if (dg > dr && dr >= db) {
          dMax = dg; dMid = dr; dMin = db;
          sMax = strideG; sMid = strideR; sMin = strideB;
        } else if (dg >= db && db > dr) {
          dMax = dg; dMid = db; dMin = dr;
          sMax = strideG; sMid = strideB; sMin = strideR;
        } else if (db > dr && dr >= dg) {
          dMax = db; dMid = dr; dMin = dg;
          sMax = strideB; sMid = strideR; sMin = strideG;
        } else {
          dMax = db; dMid = dg; dMin = dr;
          sMax = strideB; sMid = strideG; sMin = strideR;
        }

        const v1 = v0 + sMax;
        const v2 = v1 + sMid;
        const v3 = v2 + sMin;

        const w0 = 1.0 - dMax;
        const w1 = dMax - dMid;
        const w2 = dMid - dMin;
        const w3 = dMin;

        let outR = srcData[v0] * w0 + srcData[v1] * w1 + srcData[v2] * w2 + srcData[v3] * w3;
        let outG = srcData[v0 + 1] * w0 + srcData[v1 + 1] * w1 + srcData[v2 + 1] * w2 + srcData[v3 + 1] * w3;
        let outB = srcData[v0 + 2] * w0 + srcData[v1 + 2] * w1 + srcData[v2 + 2] * w2 + srcData[v3 + 2] * w3;

        // 若母片僅轉換色域而未轉換 Gamma（如 FLog2_to_FLog2-709），逆轉換回線性光再編碼為 sRGB
        if (outputCurve === 'flog2') {
          outR = linearToSrgb(fujilogToLinear(outR, FLOG2_PARAMS));
          outG = linearToSrgb(fujilogToLinear(outG, FLOG2_PARAMS));
          outB = linearToSrgb(fujilogToLinear(outB, FLOG2_PARAMS));
        } else if (outputCurve === 'flog') {
          outR = linearToSrgb(fujilogToLinear(outR, FLOG_PARAMS));
          outG = linearToSrgb(fujilogToLinear(outG, FLOG_PARAMS));
          outB = linearToSrgb(fujilogToLinear(outB, FLOG_PARAMS));
        } else {
          outR = clamp01(outR);
          outG = clamp01(outG);
          outB = clamp01(outB);
        }

        if (blendIdentity) {
          const rSrgb = srgb1d[ir];
          outR = clamp01(rSrgb * oneMinusT + outR * intensity);
          outG = clamp01(gSrgb * oneMinusT + outG * intensity);
          outB = clamp01(bSrgb * oneMinusT + outB * intensity);
        }

        outData[outOffset++] = outR;
        outData[outOffset++] = outG;
        outData[outOffset++] = outB;
      }
    }
  }

  return outData;
}

/**
 * 將烘焙完成的 RGB Float64Array 組裝為與 convert_flog2.py 完全一致的 .cube 檔案字串。
 * @param {Float64Array} lutData
 * @param {number} targetSize
 * @param {string} title
 * @returns {string}
 */
export function formatCubeFile(lutData, targetSize, title) {
  const safeTitle = sanitizeCubeTitle(title);
  const nodeCount = targetSize * targetSize * targetSize;
  const lines = new Array(nodeCount + 4);
  lines[0] = `TITLE "${safeTitle}"`;
  lines[1] = `LUT_3D_SIZE ${targetSize}`;
  lines[2] = 'DOMAIN_MIN 0.0 0.0 0.0';
  lines[3] = 'DOMAIN_MAX 1.0 1.0 1.0';

  let offset = 0;
  for (let i = 0; i < nodeCount; i++) {
    const r = lutData[offset++].toFixed(6);
    const g = lutData[offset++].toFixed(6);
    const b = lutData[offset++].toFixed(6);
    lines[i + 4] = `${r} ${g} ${b}`;
  }

  return `${lines.join('\n')}\n`;
}

/**
 * 使用預先烘焙好的標準 sRGB 3D LUT，以 O(1) 8-bit 預建表 + 四面體插值高速渲染 RGBA 影像像素。
 *
 * @param {Uint8ClampedArray} srcRgba - 原始影像 RGBA 緩衝區
 * @param {Float64Array} lutData - 已烘焙之 sRGB 3D LUT 資料
 * @param {number} lutSize - LUT 單軸尺寸（如 17、33、65）
 * @returns {Uint8ClampedArray} 套用濾鏡後的 RGBA 緩衝區
 */
export function applyBakedLutToRgba(srcRgba, lutData, lutSize) {
  const outRgba = new Uint8ClampedArray(srcRgba.length);
  const maxIdx = lutSize - 1;
  const clampUpper = lutSize - 2;
  const strideR = 3;
  const strideG = lutSize * 3;
  const strideB = lutSize * lutSize * 3;

  // 針對 8-bit 輸入 [0..255] 預計算下界偏移與局部差值，消除百萬像素迴圈內的除法與 Math.floor
  const baseR = new Int32Array(256);
  const baseG = new Int32Array(256);
  const baseB = new Int32Array(256);
  const frac = new Float64Array(256);

  for (let v = 0; v < 256; v++) {
    const scaled = (v / 255.0) * maxIdx;
    let i0 = Math.floor(scaled);
    if (i0 > clampUpper) i0 = clampUpper;
    baseR[v] = i0 * strideR;
    baseG[v] = i0 * strideG;
    baseB[v] = i0 * strideB;
    frac[v] = scaled - i0;
  }

  const len = srcRgba.length;
  for (let p = 0; p < len; p += 4) {
    const r8 = srcRgba[p];
    const g8 = srcRgba[p + 1];
    const b8 = srcRgba[p + 2];

    const v0 = baseR[r8] + baseG[g8] + baseB[b8];
    const dr = frac[r8];
    const dg = frac[g8];
    const db = frac[b8];

    let dMax, dMid, dMin, sMax, sMid, sMin;
    if (dr >= dg && dg >= db) {
      dMax = dr; dMid = dg; dMin = db;
      sMax = strideR; sMid = strideG; sMin = strideB;
    } else if (dr >= db && db > dg) {
      dMax = dr; dMid = db; dMin = dg;
      sMax = strideR; sMid = strideB; sMin = strideG;
    } else if (dg > dr && dr >= db) {
      dMax = dg; dMid = dr; dMin = db;
      sMax = strideG; sMid = strideR; sMin = strideB;
    } else if (dg >= db && db > dr) {
      dMax = dg; dMid = db; dMin = dr;
      sMax = strideG; sMid = strideB; sMin = strideR;
    } else if (db > dr && dr >= dg) {
      dMax = db; dMid = dr; dMin = dg;
      sMax = strideB; sMid = strideR; sMin = strideG;
    } else {
      dMax = db; dMid = dg; dMin = dr;
      sMax = strideB; sMid = strideG; sMin = strideR;
    }

    const v1 = v0 + sMax;
    const v2 = v1 + sMid;
    const v3 = v2 + sMin;

    const w0 = 1.0 - dMax;
    const w1 = dMax - dMid;
    const w2 = dMid - dMin;
    const w3 = dMin;

    const outR = lutData[v0] * w0 + lutData[v1] * w1 + lutData[v2] * w2 + lutData[v3] * w3;
    const outG = lutData[v0 + 1] * w0 + lutData[v1 + 1] * w1 + lutData[v2 + 1] * w2 + lutData[v3 + 1] * w3;
    const outB = lutData[v0 + 2] * w0 + lutData[v1 + 2] * w1 + lutData[v2 + 2] * w2 + lutData[v3 + 2] * w3;

    outRgba[p] = outR * 255.0 + 0.5;
    outRgba[p + 1] = outG * 255.0 + 0.5;
    outRgba[p + 2] = outB * 255.0 + 0.5;
    outRgba[p + 3] = srcRgba[p + 3];
  }

  return outRgba;
}
