# AGENTS.md — FujiLUT-for-Mobile 專案技術交接與防坑指南

本文件專供後續接手維護、擴充或除錯的 AI Agent 閱讀。進入程式碼修改前，請先完整讀完本文件的**單一事實來源（SSOT）不變量**與**實戰踩坑紀錄**，避免破壞雙端數值一致性、無障礙合規或跨瀏覽器相容性。

---

## 1. 專案定位與文件分工

本專案將富士官方釋出的專業攝影機對數色彩查找表（`F-Log2` / `F-Log` `.cube` 3D LUT 母片），透過逆向色彩管線重取樣並烘焙為**手機直出 sRGB / Rec.709 照片**（Snapseed、Lightroom Mobile、VN 等）可直接套用的 `.cube` 濾鏡。

### 雙軌執行架構
1. **純前端靜態網頁版（主力產品，零建置工具）**：位於根目錄 `index.html`、`css/`、`js/` 與 `.nojekyll`。100% 於使用者瀏覽器本地端（Web Worker）執行，無任何後端、無 npm 打包步驟、無外部網路請求，推送至 GitHub Pages 即可直接上線。
2. **Python 批次轉換腳本（基準參考實作）**：`convert_flog2.py`，僅依賴 `numpy`，用於本機一次轉換整個 `65Grid/F-Log2` 資料夾，同時作為自動化測試的**數學黃金基準（Golden Reference）**。

### 文件受眾與文風分工（修改文件時請嚴守）
- **`README.md`（面向廣大攝影玩家與一般使用者）**：保持親切、有畫面感、聚焦「為什麼手機套官方 LUT 會壞掉」、「免安裝 30 秒搞定」、「12 款軟片情境怎麼挑」等痛點與價值，**避免在前半段堆砌艱澀演算法術語嚇跑一般讀者**。
- **`AGENTS.md`（本文件，面向工程師與 AI Agent）**：集中記載色彩數學規格、架構邊界、瀏覽器底層陷阱與自動化測試指令。
- **全專案語言規範**：一律使用**台灣正體中文習慣用語**（如「取樣」、「變數」、「字尾」、「軟片／底片」、「開放原始碼」、「經由／藉由」、「執行緒」），禁止出現中國大陸用語（如「採樣」、「變量」、「後綴」、「膠片」、「開源」、「通過…實現」）。

---

## 2. 檔案拓樸與模組職責

```text
.
├── .nojekyll                  # 停用 GitHub Pages 預設 Jekyll 建置，確保靜態檔案原樣秒速部署
├── index.html                 # 語意化 HTML5 主頁、CSP 安全標頭、表單與 <details> 照片對比區
├── css/
│   └── styles.css             # @layer 級聯架構、oklch + light-dark() 雙主題、響應式與無障礙樣式
├── js/
│   ├── presets.js             # 12 款軟片 SHORT_NAMES、英文精簡名、情境文案、Snapseed 9 半形寬度計算
│   ├── lut-core.js            # 【核心 SSOT】零 DOM 依賴之純數學轉換、四面體插值、.cube 剖析與像素查表
│   ├── lut-worker.js          # Web Worker 背景執行緒：快取母片/烘焙結果、捨棄過時預覽請求、Transferable 傳輸
│   └── app.js                 # 主執行緒 UI 控制器、拖放載入、ARIA 驗證同步、IME 防護、雙 Canvas 分割預覽
├── convert_flog2.py           # Python + NumPy 批次轉換基準腳本
├── tests/
│   ├── verify-converter.mjs   # Node.js 測試：與 convert_flog2.py 比對 35,937 點誤差 (< 1e-5) + 邊界/資安掃描
│   └── verify-browser.py      # Playwright 真實瀏覽器 E2E 測試：390px、200% 縮放、CSP、XSS、IME、下載驗證
└── README.md                  # 面向一般攝影讀者的產品介紹、情境挑選指南與使用教學
```

---

## 3. 色彩科學與數學單一事實來源（不可破壞的不變量）

`js/lut-core.js` 與 `convert_flog2.py` 必須維持嚴格數學對齊（在預設參數 `F-Log2`、`33Grid`、`Gain = 1.0`、`Intensity = 100%` 下，全部 `33^3 = 35,937` 個節點輸出目前為 **`0.000e+0` 零誤差完全一致**）：

1. **逆向烘焙管線順序**：
   - 於 1D 軸預計算 `targetSize` 個點的 `srgbToLinear(s) * linearGain`（IEC 61966-2-1，分界點 `0.04045`），將指數運算由 `3 * N^3` 降至 `N` 次。
   - 依 `.cube` 規範展開 3D 迴圈：**Blue 軸最外層（變動最慢）→ Green 中層 → Red 最內層（變動最快）**，一維索引為 `ir + size * ig + size^2 * ib`。
   - 乘以雙精度 `REC709_TO_FGAMUT` 矩陣轉入 `F-Gamut (ITU-R BT.2020)`。此矩陣由白皮書 CIE 1931 色度座標推導，每一列總和在 `float64` 下嚴格等於 `1.0`（確保 D65 白點 `[1, 1, 1]` 嚴格守恆不偏色，**切勿將常數截斷為小數點後 4~6 位**）。
   - 套用富士官方分段對數公式編碼為 `F-Log2`（`cut1 = 0.000889`）或一代 `F-Log`（`cut1 = 0.00089`），再夾限至 `[0.0, 1.0]`。

2. **為什麼必須是 `O(1)` 四面體插值（Tetrahedral Interpolation）而非三線性插值**：
   - 三線性插值會將立方體 8 個頂點跨非中性色角平均，導致灰階中性軸產生肉眼可見的微綠偏色，且與 `convert_flog2.py` 產生 `1e-3 ~ 1e-2` 的數值落差。
   - 本專案沿主對角線 `(0,0,0) -> (1,1,1)` 切分 6 個四面體（比較局部差值 `dr, dg, db` 大小決定步進軸順序），使灰階中性軸 `100%` 僅由主對角線兩端點插值，且每點僅需查找 4 個頂點。
   - 下界索引 `Math.floor(scaled)` 必須夾限於 `[0, srcSize - 2]`，防止座標 `1.0` 時 `v0 + stride` 發生陣列越界。

3. **`Linear Gain > 1.0x` 的高光延展夾限位置（重要陷阱）**：
   - 在 `Gain = 1.0` 時，標準 sRGB 白點 `1.0` 編碼至 `F-Log2` 約僅落在 `0.568`，母片 `[0.568, 1.0]` 的軟片高光肩部滾降區（支援至約 `1390%` 反射率）完全未被使用。
   - 矩陣相乘後的 `fgR, fgG, fgB` **只能夾下界 `Math.max(0.0, ...)`，絕對不可夾上界 `1.0`**：
     - 當 `Gain = 1.0` 時，因矩陣非負且列和為 `1.0`，結果天然落在 `[0.0, 1.0]`，與 `convert_flog2.py` 的 `np.clip(..., 0.0, 1.0)` 100% 等價。
     - 當使用者調高 `Gain (1.05x ~ 2.5x)` 時，允許 `> 1.0` 的超白線性光進入 `linearToFujilog` 推入母片高光滾降區，對數編碼完後才執行 `clamp01(...)`。若提早在線性階段夾死 `1.0`，調高增益只會造成亮部硬截斷死白。

4. **對數至對數基準母片（`#Gamma:F-Log2 to F-Log2`）自動逆轉換**：
   - 富士官方包內的 `FLog2_to_FLog2-709`（僅轉色域未轉 Gamma）在註解行標有 `#Gamma:F-Log2 to F-Log2`。
   - `parseCubeText` 會偵測此註解並標記 `outputCurve = 'flog2'`（一代則為 `'flog'`），`bakeSrgbLut` 插值後必須自動執行 `linearToSrgb(fujilogToLinear(val))` 還原為標準 sRGB，否則匯出的基準檔套在照片上仍會是一片灰霧。

5. **Snapseed 9 半形字元寬度截斷邏輯（`js/presets.js`）**：
   - Snapseed 底部濾鏡預覽磚塊僅能顯示約 `9` 個半形字元寬度（ASCII 與半形符號計 `1`，中文字與全形符號計 `2`）。
   - 例如 `人文街拍_Classic-Neg`：`人文街拍`（8 半形寬）+ `_`（1 半形寬）= 剛好佔滿前 `9` 半形寬，後續英文縮略為 `…`，在介面上呈現 `人文街拍_…`。修改預設命名規則時切勿破壞「4 中文字 + 底線」的前綴結構。

---

## 4. 曾經踩過與極易誤踩的實作陷阱（Hard-Won Gotchas）

### 陷阱 1：HTML5 `<input pattern>` 的 `/v`（`unicodeSets`）正規表示式崩潰（實戰踩坑！）
- **現象**：在 `<input id="custom-name-input" pattern="...">` 若寫成傳統 JS 習慣的 `pattern="[^<>:&quot;/\\|?*]+"`，現代 Chromium / Edge 會以 ES2024 **`/v` 旗標（`unicodeSets`）** 編譯該屬性，並在呼叫 `input.focus()` 或驗證時直接於 Console 拋出：
  `Pattern attribute value ... is not a valid regular expression: Uncaught SyntaxError: Invalid regular expression: /.../v: Invalid character in character class`。
- **同時存在的反向陷阱**：在 `/v` 模式下，字元類別 `[...]` 內的 `/`、`\`、`|` 屬於語法保留字元，**必須**跳脫為 `\/`、`\\`、`\|`；但 `<`、`>`、`:`、`"`、`?`、`*` 並非 `/v` 類別保留字元，若對它們加上反斜線（如 `\<` 或 `\:`），`/v` 模式又會拋出 `Invalid escape sequence in regular expression`！
- **正確寫法**：`pattern="[^&lt;&gt;:&quot;\/\\\|?*]+"`（僅跳脫 `\/`、`\\`、`\|`）。任何修改 `pattern` 屬性後，務必在 Node 20+ 以 `new RegExp('^(?:' + pattern + ')$', 'v')` 或跑 `verify-browser.py` 驗證 Console 零錯誤。

### 陷阱 2：`<meta name="text-scale" content="scale">` 與根字級覆寫衝突
- **規則**：為了讓行動瀏覽器響應 iOS「動態字級」與 Android 系統字體大小無障礙設定，`index.html` 啟用了 `<meta name="text-scale" content="scale">`。
- **禁忌**：在 `css/styles.css` 中**絕對不可對 `:root` 或 `html` 設定任何 `font-size`**（無論 `16px`、`100%` 或 `calc(1rem * env(preferred-text-scale))`），否則會直接覆蓋瀏覽器的系統字級縮放或引發雙倍縮放。此外，流體字級 `clamp(min, val, max)` 的最大值不得超過最小值的 `2.5` 倍，且含文字元素不可設固定 `height` / `block-size`（一律用 `min-block-size`），確保 `390px` 視窗在 `200%` 字級放大時仍零橫向捲軸。

### 陷阱 3：`<details>` / `<summary>` 折疊動畫與螢幕閱讀器標題吞噬
- **禁忌 A**：**絕對不可將 `<h2>` / `<h3>` 放進 `<summary>` 標籤內**。JAWS 與 Android TalkBack 會將 `<summary>` 視為按鈕角色並抹除內部標題語意，導致視障使用者無法透過標題快速跳轉。標題必須置於 `<details>` 外部（如 `<section aria-labelledby="preview-heading">`）。
- **禁忌 B**：`details::details-content` 收合至 `block-size: 0` 時須搭配 `visibility: hidden` 與 `contain: layout`（避免內部子元素外邊距收合抖動），且 **`transition-behavior: allow-discrete` 必須獨立宣告在 `transition-*` 屬性之後**，不可寫入 `transition` 縮寫以免舊版瀏覽器整行捨棄或被縮寫重設。

### 陷阱 4：原生 `<input type="range">` 跨瀏覽器樣式與 `:user-invalid` 誤傷
- **偽元素分離鐵律**：`::-webkit-slider-thumb` 與 `::-moz-range-thumb`（以及軌道偽元素）**絕對不可用逗號寫在同一個 CSS 規則區塊**，因為瀏覽器遇到不認識的引擎前綴偽元素時會直接丟棄整組選擇器規則。
- **Safari `attr()` 降級**：CSS `attr(min type(<number>))` 與 `progress()` 在舊版或 Safari 支援度不一，必須保留 `@supports not (opacity: progress(1, 0, 100))` 的 `calc()` 降級，並由 `js/app.js` 的 `syncSliderCssVars()` 同步寫入 `--attr-min`、`--attr-max`、`--control-value`。
- **排除驗證偽類**：全域 `:user-invalid` / `:user-valid` 規則必須加上 `:not([type="range"])`，避免滑桿被套用紅綠邊框。

### 陷阱 5：`aria-invalid` 初始值與 `aria-describedby` 隱藏錯誤提早朗讀
- Firefox 與 Safari 在頁面載入時就會將空白的 `required` 欄位視為無效；若未明確設定初始 `aria-invalid="false"`，螢幕閱讀器在焦點剛進入欄位時就會誤報「輸入無效」。
- 此外，被 `aria-describedby` 指向的元素**即使設為 `display: none` 仍會被螢幕閱讀器唸出**。因此 HTML 標記中只能將錯誤訊息 ID 放在 `data-error="..."`，由 `js/app.js` 在欄位實際進入無效態時才動態把該 ID 掛入 `aria-describedby`。

### 陷阱 6：中文／注音輸入法（IME）按 `Enter` 選字誤觸與 Safari 事件倒置
- 自訂檔名輸入框監聽 `keydown` 的 `Enter` 快捷鍵時，不能只檢查 `event.isComposing`！因 Safari 存在 WebKit Bug 165004（`compositionend` 可能比確認選字的那一下 `Enter` `keydown` 更早觸發，導致 `isComposing` 已變回 `false`），**必須同時檢查 `if (event.isComposing || event.keyCode === 229) return;`**。

### 陷阱 7：嚴格 CSP、DOM XSS 與 `color-mix()` 色相偏移
- **CSP 邊界**：`index.html` 透過 `<meta http-equiv="Content-Security-Policy">` 設定了 `connect-src 'none'` 與 `script-src 'self'` 以強制保證零外部網路連線與零內嵌腳本執行；但因 `js/app.js` 需呼叫 `element.style.setProperty('--split-pct', ...)` 更新滑桿與分割線 CSS 變數，**`style-src` 必須保留 `'self' 'unsafe-inline'`**，不可拔除 `'unsafe-inline'`，否則 CSSOM 行內變數寫入會被 CSP 攔截失效。
- **零 `innerHTML` 鐵律**：`tests/verify-converter.mjs` 會對前端所有檔案進行靜態掃描，出現任何 `innerHTML`、`outerHTML`、`insertAdjacentHTML`、`document.write`、`eval(` 或外部 `http(s)://` URL（SVG XML namespace 除外）皆會直接判定測試失敗。連註解中也請避免寫出裸字 `innerHTML`。
- **`color-mix` 色空間**：混入中性色／背景色時一律使用 `color-mix(in oklab, ...)`，**禁止使用 `in oklch`**（Chromium 對低彩度中性色在 `oklch` 插值時會將無效色相歸零為 `0deg` 洋紅色，產生詭異粉紅偏色）。

### 陷阱 8：行動端 `.cube` 下載副檔名保護與本機預覽快取
- Android Chrome 與 iOS Safari 若見到 `text/plain` Blob 下載不認識的 `.cube` 字尾，常會自動竄改為 `.cube.txt` 導致修圖軟體無法匯入。匯出時必須維持 `new Blob([buffer], { type: 'application/octet-stream' })`，且 `URL.revokeObjectURL` 需延遲（目前為 60 秒）以防手機下載管理員尚未讀取完畢即失效。
- 照片預覽採用「8-bit 256 階預建表 + 四面體查表」（`applyBakedLutToRgba`），將百萬像素的除法與 `Math.floor` 降為 256 次查表，Worker 渲染一張 `1280px` 照片僅需約 `4~10ms`；調整滑桿時透過遞增 `requestId` 自動丟棄過時請求，切勿改回主執行緒同步計算。

---

## 5. 開發與強制驗證指令（Verification Checklist）

在此環境中請優先透過 **`uv`** 呼叫 Python 工具鏈；在 Windows 下執行含非 ASCII 輸出的 Python 腳本時請加上 `PYTHONUTF8=1` 以避免 `cp950` 主控台編碼例外。

每次修改核心邏輯、HTML、CSS 或說明文件後，**必須執行以下兩道自動化測試並確認 100% 通過**：

```bash
# 1. 雙端數值一致性（35,937 點對比 convert_flog2.py 誤差 < 1e-5）+ 邊界容錯 + 靜態資安掃描
node tests/verify-converter.mjs

# 2. 真實無頭瀏覽器（Edge/Chrome）端對端測試：
#    驗證 390px 無橫向捲軸、控制項 >= 24x24px、200% 系統字級縮放、CSP 零外部請求、XSS 攔截、IME 防護與 .cube 下載
PYTHONUTF8=1 uv run --with playwright python tests/verify-browser.py
```

若需於本機手動開啟網頁測試（切勿直接用 `file://` 點開 `index.html`，瀏覽器會因 CORS 阻擋 ES Modules 與 Web Worker）：

```bash
uv run python -m http.server 8000
# 造訪 http://localhost:8000
```
