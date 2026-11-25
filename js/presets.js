/**
 * 富士官方 3D LUT 情境短檔名對照表、拍攝情境建議與 Snapseed 寬度預覽計算工具。
 * 對齊 convert_flog2.py 與 README.md 之單一事實來源。
 */

/** 針對 Snapseed 介面 9 半形字元預覽寬度限制，將 4 個中文字情境置於檔名前綴 */
export const SHORT_NAMES = Object.freeze({
  'CLASSIC-Neg.': '人文街拍_Classic-Neg',
  'CLASSIC-CHROME': '真實紀實_Classic-Chrome',
  'REALA-ACE': '自然通透_Reala-Ace',
  'ASTIA': '柔和人像_Astia',
  'PROVIA': '標準正片_Provia',
  'Velvia': '濃郁風景_Velvia',
  'PRO-Neg.Std': '棚拍人像_Pro-Neg-Std',
  'ETERNA': '低調電影_Eterna',
  'ETERNA-BB': '重工業風_Eterna-BB',
  'ACROS': '經典黑白_Acros',
  'FLog2-709': '標準還原_Rec709-Std',
  'FLog-709': '標準還原_Rec709-Std',
  'WDR-709': '寬動態域_Rec709-WDR',
});

/** 官方精簡英文名稱對照表 */
export const ENGLISH_NAMES = Object.freeze({
  'CLASSIC-Neg.': 'Classic-Neg',
  'CLASSIC-CHROME': 'Classic-Chrome',
  'REALA-ACE': 'Reala-Ace',
  'ASTIA': 'Astia',
  'PROVIA': 'Provia',
  'Velvia': 'Velvia',
  'PRO-Neg.Std': 'Pro-Neg-Std',
  'ETERNA': 'Eterna',
  'ETERNA-BB': 'Eterna-BB',
  'ACROS': 'Acros',
  'FLog2-709': 'Rec709-Std',
  'FLog-709': 'Rec709-Std',
  'WDR-709': 'Rec709-WDR',
});

/** 12 款軟片模擬之建議適用情境與色調特色說明 */
export const PRESET_DESCRIPTIONS = Object.freeze({
  'CLASSIC-Neg.': '街拍首選，高反差、冷暖對比強烈、獨特綠色調與復古底片感。',
  'CLASSIC-CHROME': '紀實攝影必備，低飽和、微冷調雜誌文青感。',
  'REALA-ACE': '富士最新旗艦色彩，色彩忠實自然、階調立體通透。',
  'ASTIA': '柔和高光與紅潤膚色表現，家庭生活與人物拍攝首選。',
  'PROVIA': '富士經典標準色，發色均衡，各類生活記錄皆適宜。',
  'Velvia': '極高色彩飽和度，適合晴天、藍天、草地與夕陽大景。',
  'PRO-Neg.Std': '極柔和的陰影階調與低對比，適合控光人像與微距特寫。',
  'ETERNA': '經典電影正片色調，低反差、低動態衝擊、平滑高光過渡。',
  'ETERNA-BB': '漂白效果（Bleach Bypass），極低飽和伴隨強烈對比的金屬冷硬質感。',
  'ACROS': '頂級黑白底片模擬，暗部細節豐富且高光立體分明。',
  'FLog2-709': '基準技術轉換檔，不帶軟片風格濾鏡之標準 Rec.709 色彩。',
  'FLog-709': '基準技術轉換檔，不帶軟片風格濾鏡之標準 Rec.709 色彩。',
  'WDR-709': '具備高光滾降保護的寬動態標準色彩還原。',
});

const NAME_PATTERN = /FLog2?_to_(.+?)_(?:65|33|17)grid/i;

const CASE_INSENSITIVE_KEY_MAP = new Map(
  Object.keys(SHORT_NAMES).map((key) => [key.toLowerCase(), key])
);

/**
 * 解析上傳之 .cube 檔案名稱，推斷來源對數曲線、軟片模擬情境短名與推薦說明。
 *
 * @param {string} filename - 含或不含 .cube 字尾的原始檔案名稱
 * @returns {{
 *   stem: string,
 *   rawKey: string,
 *   canonicalKey: string | null,
 *   shortName: string,
 *   englishName: string,
 *   description: string | null,
 *   detectedCurve: 'flog2' | 'flog'
 * }}
 */
export function analyzeCubeFilename(filename) {
  const stem = String(filename ?? '')
    .trim()
    .replace(/\.cube$/i, '');

  /** @type {'flog2' | 'flog'} */
  let detectedCurve = 'flog2';
  if (/FLog2|F-Log2/i.test(stem)) {
    detectedCurve = 'flog2';
  } else if (/FLog(?!2)|F-Log(?!2)/i.test(stem)) {
    detectedCurve = 'flog';
  }

  const match = NAME_PATTERN.exec(stem);
  const rawKey = match ? match[1] : stem;
  const canonicalKey = SHORT_NAMES[rawKey]
    ? rawKey
    : (CASE_INSENSITIVE_KEY_MAP.get(rawKey.toLowerCase()) ?? null);

  if (canonicalKey) {
    return {
      stem,
      rawKey,
      canonicalKey,
      shortName: SHORT_NAMES[canonicalKey],
      englishName: ENGLISH_NAMES[canonicalKey],
      description: PRESET_DESCRIPTIONS[canonicalKey],
      detectedCurve,
    };
  }

  const fallbackClean = rawKey.replace(/\.+$/, '') || 'Custom-LUT';
  return {
    stem,
    rawKey,
    canonicalKey: null,
    shortName: rawKey || 'Custom-LUT',
    englishName: fallbackClean,
    description: null,
    detectedCurve,
  };
}

/**
 * 計算單一 Unicode 字元在 Snapseed 介面中的半形字元等效寬度。
 * 中文字／全形符號計 2 半形寬，ASCII 英數與半形符號計 1 半形寬。
 *
 * @param {string} ch
 * @returns {number}
 */
export function getCharHalfWidth(ch) {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp <= 0x007f || (cp >= 0xff61 && cp <= 0xff9f)) {
    return 1;
  }
  return 2;
}

/**
 * 計算名稱在 Snapseed 縮圖預覽列（上限 9 半形字元寬）下的截斷預覽結果。
 *
 * @param {string} rawName - 不含 .cube 字尾的輸出名稱
 * @param {number} [maxUnits=9] - Snapseed 可視半形字元寬度上限
 * @returns {{
 *   preview: string,
 *   visiblePart: string,
 *   overflowPart: string,
 *   totalUnits: number,
 *   visibleUnits: number,
 *   isTruncated: boolean
 * }}
 */
export function measureSnapseedPreview(rawName, maxUnits = 9) {
  const text = String(rawName ?? '').trim();
  if (!text) {
    return {
      preview: '（未命名）',
      visiblePart: '',
      overflowPart: '',
      totalUnits: 0,
      visibleUnits: 0,
      isTruncated: false,
    };
  }

  const chars = Array.from(text);
  let totalUnits = 0;
  for (const ch of chars) {
    totalUnits += getCharHalfWidth(ch);
  }

  if (totalUnits <= maxUnits) {
    return {
      preview: text,
      visiblePart: text,
      overflowPart: '',
      totalUnits,
      visibleUnits: totalUnits,
      isTruncated: false,
    };
  }

  let visibleUnits = 0;
  let splitIndex = 0;
  for (let i = 0; i < chars.length; i++) {
    const w = getCharHalfWidth(chars[i]);
    if (visibleUnits + w > maxUnits) {
      break;
    }
    visibleUnits += w;
    splitIndex = i + 1;
  }

  const visiblePart = chars.slice(0, splitIndex).join('');
  const overflowPart = chars.slice(splitIndex).join('');

  return {
    preview: `${visiblePart}…`,
    visiblePart,
    overflowPart,
    totalUnits,
    visibleUnits,
    isTruncated: true,
  };
}

/**
 * 清理寫入 .cube 檔頭 TITLE "..." 的字串，移除雙引號與控制字元以防語法破損。
 * @param {string} title
 * @returns {string}
 */
export function sanitizeCubeTitle(title) {
  const cleaned = String(title ?? '')
    .replace(/["\r\n\t\x00-\x1f]+/g, ' ')
    .trim();
  return cleaned || 'FujiLUT-Mobile';
}

/**
 * 清理匯出下載之檔案主檔名，過濾作業系統保留字元並移除前後空白與句點。
 * @param {string} name
 * @returns {string}
 */
export function sanitizeDownloadStem(name) {
  const cleaned = String(name ?? '')
    .replace(/\.cube$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
    .replace(/^\.+|\.+$/g, '')
    .trim();
  return cleaned || 'FujiLUT-Mobile';
}
