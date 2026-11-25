/**
 * FujiLUT-for-Mobile 自動化驗收測試腳本
 * 1. 數值一致性驗證：產生 65Grid F-Log2 .cube 測試母片，同時以 Python @convert_flog2.py 與
 *    網頁核心 js/lut-core.js 執行預設轉換（F-Log2、33Grid、Gain 1.0、Intensity 100%），
 *    驗證全部 33^3 = 35,937 點 RGB 最大絕對誤差 < 1e-5，且標頭與行數完全一致。
 * 2. 邊界容錯驗證：33Grid 母片、資料區夾雜 # 註解與空行、UTF-8 BOM、CRLF、1D LUT 攔截、損毀檔案錯誤訊息。
 * 3. 資安與 XSS 防護驗證：惡意 TITLE "<img src=x onerror=alert(1)>" 處理，以及靜態掃描零 innerHTML 與零外部請求。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  FLOG_PARAMS,
  FLOG2_PARAMS,
  applyBakedLutToRgba,
  bakeSrgbLut,
  clamp01,
  formatCubeFile,
  fujilogToLinear,
  linearToFujilog,
  parseCubeText,
} from '../js/lut-core.js';
import {
  SHORT_NAMES,
  analyzeCubeFilename,
  measureSnapseedPreview,
  sanitizeCubeTitle,
  sanitizeDownloadStem,
} from '../js/presets.js';

const repoRoot = resolve(import.meta.dirname, '..');

/**
 * 建立具真實非線性 S 曲線、跨通道耦合與肩部滾降的合成 65Grid .cube 母片文字。
 * @param {number} size
 * @param {{ flog2ToFlog2?: boolean, withCommentsAndBlanks?: boolean, title?: string }} [opts]
 */
function generateSyntheticCube(size, opts = {}) {
  const headerLines = [
    `# Fujifilm Synthetic Test LUT (${size}Grid)`,
    opts.flog2ToFlog2 ? '#Gamma:F-Log2 to F-Log2' : '#Gamma:F-Log2 to ITU-R BT.709',
    `TITLE "${opts.title ?? 'FLog2_Synthetic_Test'}"`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    '',
  ];

  const rows = [];
  const inv = 1.0 / (size - 1);
  let idx = 0;

  for (let ib = 0; ib < size; ib++) {
    const b = ib * inv;
    for (let ig = 0; ig < size; ig++) {
      const g = ig * inv;
      for (let ir = 0; ir < size; ir++) {
        const r = ir * inv;

        // 模擬軟片模擬母片之非線性對比與跨通道色彩耦合（刻意讓非中性軸具明顯曲率以嚴格檢驗四面體插值）
        const sr = clamp01(0.5 + 0.48 * Math.tanh(2.4 * (r - 0.42)) + 0.035 * (g - b));
        const sg = clamp01(0.5 + 0.47 * Math.tanh(2.25 * (g - 0.43)) - 0.02 * (r - b));
        const sb = clamp01(0.5 + 0.46 * Math.tanh(2.1 * (b - 0.44)) + 0.03 * (g - r));

        if (opts.withCommentsAndBlanks && idx === 128) {
          rows.push('# Interleaved comment inside numeric section');
          rows.push('   ');
        }
        rows.push(`${sr.toFixed(6)} ${sg.toFixed(6)} ${sb.toFixed(6)}`);
        idx++;
      }
    }
  }

  return `${headerLines.join('\n')}\n${rows.join('\n')}\n`;
}

/**
 * 比較兩份 .cube 輸出文字的標頭、總行數與全部節點最大絕對誤差。
 * @param {string} pyText
 * @param {string} jsText
 * @param {number} expectedNodes
 */
function compareCubeOutputs(pyText, jsText, expectedNodes) {
  const pyLines = pyText.replace(/\r\n/g, '\n').split('\n');
  const jsLines = jsText.replace(/\r\n/g, '\n').split('\n');

  assert.equal(
    jsLines.length,
    pyLines.length,
    `總行數必須完全一致（Python=${pyLines.length}, JS=${jsLines.length}）`
  );
  // 4 行標頭 + expectedNodes 行數值 + 結尾換行空字串 = expectedNodes + 5
  assert.equal(jsLines.length, expectedNodes + 5, '輸出總行數應為 4 行標頭 + 節點數 + 結尾換行');

  for (let h = 0; h < 4; h++) {
    assert.equal(jsLines[h], pyLines[h], `第 ${h + 1} 行檔頭不一致：JS="${jsLines[h]}" vs Py="${pyLines[h]}"`);
  }
  assert.equal(jsLines[jsLines.length - 1], '', '檔案結尾必須保留換行符號');

  let maxAbsDiff = 0.0;
  let sumAbsDiff = 0.0;

  for (let i = 0; i < expectedNodes; i++) {
    const pyParts = pyLines[i + 4].split(' ').map(Number);
    const jsParts = jsLines[i + 4].split(' ').map(Number);
    assert.equal(pyParts.length, 3);
    assert.equal(jsParts.length, 3);

    for (let c = 0; c < 3; c++) {
      const diff = Math.abs(pyParts[c] - jsParts[c]);
      if (diff > maxAbsDiff) maxAbsDiff = diff;
      sumAbsDiff += diff;
    }
  }

  return {
    maxAbsDiff,
    meanAbsDiff: sumAbsDiff / (expectedNodes * 3),
  };
}

console.log('=== [1/4] 驗證與 @convert_flog2.py 之 65Grid -> 33Grid 數值一致性 ===');
const tempDir = mkdtempSync(join(tmpdir(), 'fujilut-verify-'));

try {
  // Case A：標準軟片模擬母片（F-Log2 -> BT.709）
  const srcNameA = 'FLog2_to_CLASSIC-Neg._65grid_V.1.00.cube';
  const srcPathA = join(tempDir, srcNameA);
  const pyOutPathA = join(tempDir, 'py_out_classic_neg.cube');
  const cubeContentA = generateSyntheticCube(65, { flog2ToFlog2: false, withCommentsAndBlanks: true });
  writeFileSync(srcPathA, cubeContentA, 'utf8');

  // Case B：基準對數輸出母片（#Gamma:F-Log2 to F-Log2）
  const srcNameB = 'FLog2_to_FLog2-709_65grid_V.1.00.cube';
  const srcPathB = join(tempDir, srcNameB);
  const pyOutPathB = join(tempDir, 'py_out_flog2_709.cube');
  const cubeContentB = generateSyntheticCube(65, { flog2ToFlog2: true });
  writeFileSync(srcPathB, cubeContentB, 'utf8');

  const pyRunner = `
import sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(repoRoot)})
import convert_flog2 as cf

cache = {}
src_a = Path(${JSON.stringify(srcPathA)})
out_a = Path(${JSON.stringify(pyOutPathA)})
short_a = cf.get_short_name(src_a.stem)
cf.convert_flog2_supersampled(src_a, out_a, short_a, 33, cache)

src_b = Path(${JSON.stringify(srcPathB)})
out_b = Path(${JSON.stringify(pyOutPathB)})
short_b = cf.get_short_name(src_b.stem)
cf.convert_flog2_supersampled(src_b, out_b, short_b, 33, cache)
`;

  execFileSync('uv', ['run', '--with', 'numpy', 'python', '-c', pyRunner], {
    cwd: repoRoot,
    stdio: 'pipe',
  });

  // 網頁版預設參數轉換 Case A
  const infoA = analyzeCubeFilename(srcNameA);
  assert.equal(infoA.shortName, '人文街拍_Classic-Neg');
  assert.equal(infoA.detectedCurve, 'flog2');

  const parsedA = parseCubeText(readFileSync(srcPathA, 'utf8'));
  assert.equal(parsedA.size, 65);
  assert.equal(parsedA.outputCurve, 'rec709');

  const bakedA = bakeSrgbLut(parsedA, {
    inputCurve: 'flog2',
    targetSize: 33,
    linearGain: 1.0,
    intensity: 1.0,
  });
  const jsOutTextA = formatCubeFile(bakedA, 33, infoA.shortName);
  const pyOutTextA = readFileSync(pyOutPathA, 'utf8');

  const statsA = compareCubeOutputs(pyOutTextA, jsOutTextA, 33 ** 3);
  console.log(
    `  ✔ 標準母片 (35,937 點)：maxAbsError = ${statsA.maxAbsDiff.toExponential(3)} (< 1e-5)，meanAbsError = ${statsA.meanAbsDiff.toExponential(3)}`
  );
  assert.ok(statsA.maxAbsDiff < 1e-5, `最大誤差 ${statsA.maxAbsDiff} 超過 1e-5 上限`);

  // 網頁版預設參數轉換 Case B (#Gamma:F-Log2 to F-Log2 逆轉換分支)
  const infoB = analyzeCubeFilename(srcNameB);
  assert.equal(infoB.shortName, '標準還原_Rec709-Std');
  const parsedB = parseCubeText(readFileSync(srcPathB, 'utf8'));
  assert.equal(parsedB.outputCurve, 'flog2');

  const bakedB = bakeSrgbLut(parsedB, {
    inputCurve: 'flog2',
    targetSize: 33,
    linearGain: 1.0,
    intensity: 1.0,
  });
  const jsOutTextB = formatCubeFile(bakedB, 33, infoB.shortName);
  const pyOutTextB = readFileSync(pyOutPathB, 'utf8');

  const statsB = compareCubeOutputs(pyOutTextB, jsOutTextB, 33 ** 3);
  console.log(
    `  ✔ F-Log2 to F-Log2 逆轉換母片 (35,937 點)：maxAbsError = ${statsB.maxAbsDiff.toExponential(3)} (< 1e-5)`
  );
  assert.ok(statsB.maxAbsDiff < 1e-5, `F-Log2 逆轉換最大誤差 ${statsB.maxAbsDiff} 超過 1e-5`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('=== [2/4] 驗證邊界條件、33Grid 母片、一代 F-Log 曲線與自訂參數 ===');
{
  // 1. 33Grid 母片夾雜 BOM、CRLF、註解行與空行
  const raw33 = `\uFEFF${generateSyntheticCube(33, {
    withCommentsAndBlanks: true,
    title: 'Fuji 33Grid Master',
  }).replace(/\n/g, '\r\n')}`;

  const parsed33 = parseCubeText(raw33);
  assert.equal(parsed33.size, 33);
  assert.equal(parsed33.rawTitle, 'Fuji 33Grid Master');
  assert.equal(parsed33.data.length, 33 * 33 * 33 * 3);

  // 支援輸出 17Grid / 33Grid / 65Grid
  for (const outGrid of [17, 33, 65]) {
    const outArr = bakeSrgbLut(parsed33, { targetSize: outGrid });
    assert.equal(outArr.length, outGrid ** 3 * 3);
  }

  // 2. 一代 F-Log 白皮書公式連續性與檔名偵測驗證
  const flog1Info = analyzeCubeFilename('FLog_to_ETERNA_33grid_V.1.01.cube');
  assert.equal(flog1Info.detectedCurve, 'flog');
  assert.equal(flog1Info.shortName, '低調電影_Eterna');
  assert.equal(flog1Info.englishName, 'Eterna');

  const belowCut = linearToFujilog(FLOG_PARAMS.cut1 - 1e-7, FLOG_PARAMS);
  const aboveCut = linearToFujilog(FLOG_PARAMS.cut1 + 1e-7, FLOG_PARAMS);
  assert.ok(Math.abs(belowCut - aboveCut) < 2e-4, 'F-Log 一代分段點 cut1 應平滑銜接');
  const roundTrip = fujilogToLinear(linearToFujilog(0.18, FLOG2_PARAMS), FLOG2_PARAMS);
  assert.ok(Math.abs(roundTrip - 0.18) < 1e-12, 'F-Log2 正逆轉換 18% 灰階應精確可逆');

  // 3. Intensity 混合強度與 Gain 曝光增益驗證
  const fullBake = bakeSrgbLut(parsed33, { targetSize: 17, intensity: 1.0 });
  const halfBake = bakeSrgbLut(parsed33, { targetSize: 17, intensity: 0.5 });
  // 檢查中點節點 (8, 8, 8) -> sRGB = (0.5, 0.5, 0.5)
  const centerIdx = (8 + 17 * 8 + 17 * 17 * 8) * 3;
  const expectedHalfR = 0.5 * 0.5 + fullBake[centerIdx] * 0.5;
  assert.ok(Math.abs(halfBake[centerIdx] - expectedHalfR) < 1e-12, '50% 強度必須為原始 sRGB 與 LUT 之精確線性內插');

  // 4. 預覽影像 RGBA 四面體查表驗證
  const sampleRgba = new Uint8ClampedArray([0, 0, 0, 255, 128, 128, 128, 200, 255, 255, 255, 255]);
  const gradedRgba = applyBakedLutToRgba(sampleRgba, fullBake, 17);
  assert.equal(gradedRgba.length, 12);
  assert.equal(gradedRgba[3], 255);
  assert.equal(gradedRgba[7], 200, 'Alpha 通道必須原封不動保留');

  // 5. Snapseed 9 半形字元寬度截斷預覽與全部 SHORT_NAMES 檢核
  assert.equal(Object.keys(SHORT_NAMES).length >= 12, true);
  const snap1 = measureSnapseedPreview('人文街拍_Classic-Neg');
  assert.equal(snap1.preview, '人文街拍_…');
  assert.equal(snap1.visiblePart, '人文街拍_');
  assert.equal(snap1.totalUnits, 20);
  assert.equal(snap1.isTruncated, true);

  const snap2 = measureSnapseedPreview('Astia');
  assert.equal(snap2.preview, 'Astia');
  assert.equal(snap2.totalUnits, 5);
  assert.equal(snap2.isTruncated, false);

  console.log('  ✔ 33Grid 母片、BOM/CRLF/註解容錯、17/33/65 網格輸出、F-Log 一代公式與 Snapseed 截斷測試全數通過');
}

console.log('=== [3/4] 驗證非法檔案攔截與惡意 XSS TITLE 防護 ===');
{
  // 非法檔案錯誤提示驗證
  assert.throws(() => parseCubeText('   \n  '), /空白/);
  assert.throws(
    () => parseCubeText('TITLE "1D"\nLUT_1D_SIZE 1024\n0.0 0.0 0.0\n'),
    /1D LUT/
  );
  assert.throws(
    () => parseCubeText('LUT_3D_SIZE 17\n0.0 0.0 0.0\n1.0 1.0 1.0\n'),
    /節點總數不符/
  );
  assert.throws(
    () => parseCubeText('LUT_3D_SIZE 2\n0.0 NaN 0.0\n'),
    /非有效數值/
  );

  // 惡意 XSS TITLE 驗證
  const xssPayload = '<img src=x onerror=alert(1)><script>evil()</script>';
  const xssCube = generateSyntheticCube(17, { title: xssPayload });
  const parsedXss = parseCubeText(xssCube);
  assert.equal(parsedXss.rawTitle, xssPayload, '原始 TITLE 應以純文字保存而不被解析為 HTML');

  const safeHeaderTitle = sanitizeCubeTitle('Bad"\nTitle<img src=x onerror=alert(1)>');
  assert.ok(!safeHeaderTitle.includes('"') && !safeHeaderTitle.includes('\n'), '匯出 TITLE 不得含雙引號或換行');

  const safeDownload = sanitizeDownloadStem('../<img src=x onerror=alert(1)>.cube');
  assert.ok(!/[<>:"/\\|?*]/.test(safeDownload), '匯出檔名不得含危險路徑或保留字元');

  console.log('  ✔ 空白檔、1D LUT、截斷檔、NaN 資料列攔截與惡意 TITLE 清理測試全數通過');
}

console.log('=== [4/4] 靜態掃描前端程式碼之資安、無障礙與離線規範 ===');
{
  const filesToAudit = [
    'index.html',
    'css/styles.css',
    'js/app.js',
    'js/lut-core.js',
    'js/lut-worker.js',
    'js/presets.js',
  ];

  for (const relPath of filesToAudit) {
    const content = readFileSync(join(repoRoot, relPath), 'utf8');

    // 嚴禁危險 DOM XSS Sink
    assert.ok(!/\binnerHTML\b/.test(content), `${relPath} 不得使用 innerHTML`);
    assert.ok(!/\bouterHTML\b/.test(content), `${relPath} 不得使用 outerHTML`);
    assert.ok(!/\binsertAdjacentHTML\b/.test(content), `${relPath} 不得使用 insertAdjacentHTML`);
    assert.ok(!/\bdocument\.write\b/.test(content), `${relPath} 不得使用 document.write`);
    assert.ok(!/\beval\s*\(/.test(content), `${relPath} 不得使用 eval()`);

    // 嚴禁任何外部網路請求 URL（排除 SVG namespace http://www.w3.org/2000/svg 若有）
    const externalUrls = (content.match(/https?:\/\/[^\s"'`%)]+/g) ?? []).filter((u) => u !== 'http://www.w3.org/2000/svg');
    assert.equal(
      externalUrls.length,
      0,
      `${relPath} 不得包含外部網路請求 URL：${externalUrls.join(', ')}`
    );
  }

  const html = readFileSync(join(repoRoot, 'index.html'), 'utf8');
  const css = readFileSync(join(repoRoot, 'css/styles.css'), 'utf8');
  const appJs = readFileSync(join(repoRoot, 'js/app.js'), 'utf8');

  assert.ok(html.includes('<meta name="text-scale" content="scale">'), '必須包含 text-scale meta');
  assert.ok(html.includes('<meta name="color-scheme" content="light dark">'), '必須包含 color-scheme meta');
  assert.ok(html.includes("connect-src 'none'"), 'CSP 必須強制鎖死 connect-src none');
  assert.ok(css.includes('@layer'), 'CSS 必須使用 @layer');
  assert.ok(css.includes('light-dark('), 'CSS 必須使用 light-dark()');
  assert.ok(css.includes('oklch('), 'CSS 必須使用 oklch()');
  assert.ok(css.includes('interpolate-size: allow-keywords'), 'CSS 必須使用 interpolate-size: allow-keywords');
  assert.ok(css.includes('transition-behavior: allow-discrete'), 'CSS 必須獨立宣告 transition-behavior: allow-discrete');
  assert.ok(css.includes('prefers-reduced-motion: reduce'), 'CSS 必須包含 prefers-reduced-motion: reduce 防護');
  assert.ok(appJs.includes('event.isComposing || event.keyCode === 229'), '必須包含 IME 組字防護');
  assert.ok(appJs.includes('application/octet-stream'), '下載必須使用 application/octet-stream');

  console.log('  ✔ 靜態資安（零 innerHTML / 零外部 URL / CSP connect-src none）與無障礙／CSS 規範檢核全數通過');
}

console.log('\n🎉 全部自動化測試通過！');
