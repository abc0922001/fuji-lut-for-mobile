# FujiLUT-for-Mobile: Fujifilm 3D LUT Converter for Smartphone Photography

將富士官方技術級 **F-Log2 3D LUT**（`.cube`）精確重取樣並烘焙（Bake）為適用於手機直出照片（sRGB / Rec.709，如 Snapseed、Lightroom Mobile、VN 等）的輕量化膠片模擬濾鏡。

## 📸 解決的核心痛點

### 為什麼富士官方 LUT 直接套在手機照片上會「壞掉」？

富士官網釋出的免費 3D LUT 檔（如 `FLog2_to_CLASSIC-Neg.`）是專為專業相機錄製的 **F-Log2 灰片** 設計的：

* **官方設計**：輸入端為 **F-Log2（極低反差灰片）** → 輸出端為 **Rec.709（正常標準對比）**。LUT 內部包含大幅度的高光下壓、暗部拉扯與高飽和度映射。

* **手機現狀**：智慧型手機拍攝（包含 JPG/HEIC 或經由 Snapseed 開發的 DNG RAW）輸出時，影像已經過演算法色彩映射（Tone Mapping）處於標準 **sRGB** 狀態。

* **直接套用的結果**：對比度與飽和度被重複放大兩次，造成**高光嚴重死白、暗部死黑、膚色蠟黃失真**。

### 本工具的解決方式

本專案在數學層面進行**逆向色彩管線烘焙**，將輸入端重新對齊為標準手機照片色彩空間：

```mermaid
flowchart LR
    A["手機照片 (sRGB)"] -->|Gamma 解碼| B["線性光 (Linear)"]
    B -->|色域轉換矩陣| C["F-Gamut (BT.2020)"]
    C -->|F-Log2 OETF 公式| D["富士 F-Log2 訊號"]
    D -->|65Grid 母片超取樣| E["富士膠片模擬輸出 (Rec.709)"]
```

藉由將 **65Grid 高精度母片** 超取樣（Supersampling）至手機端最流暢相容的 **33Grid**，消除非線性插值色階斷層，同時將冗長檔名精簡為手機 App 一眼可辨識的格式。

## ✨ 特色亮點

* **零依賴重型函式庫**：僅依賴 `numpy`，徹底移除 `scipy`，輕量快速。

* **100% 官方白皮書對齊**：

  * 嚴格遵循富士官方《F-Log2 Data Sheet Ver.1.0》的分段式對數轉換公式（`cut1 = 0.000889`）。

  * 精確套用 Rec.709 轉 F-Gamut（ITU-R BT.2020）色域矩陣，杜絕紅、綠色偏。

* **`O(1)` 常數時間插值定址**：利用均勻等距網格特性直接算術定址，淘汰 `O(log N)` 二分搜尋。

* **降維與迴圈不變數快取**：

  * 1D 軸預計算將 sRGB 指數解碼運算從 107,811 次降至 33 次。

  * 多檔案批次轉換時，跨檔案索引與權重快取複用（耗時趨近純 I/O）。

* **手機友善檔名**：自動去除 `FLog2_to_`、`_33grid_V.1.00` 等長前綴與字尾，並同步重寫內部 `TITLE` 標籤。

## 🚀 快速上手

### 1. 下載富士官方 LUT 母片

至富士官方網站下載 3D LUT 壓縮包（建議下載包含最完整軟片模擬的 **GFX ETERNA 55** 或 **X-H2S / X-T5** 韌體支援包），解壓縮後取得 `65Grid/F-Log2` 資料夾。

### 2. 環境安裝與執行

推薦使用現代極速 Python 工具 [**uv**](https://github.com/astral-sh/uv)，免手動建置虛擬環境：

```bash
# Clone 此專案
git clone https://github.com/abc0922001/fuji-lut-for-mobile.git
cd fuji-lut-for-mobile

# 將官方 65Grid/F-Log2 資料夾放置於專案根目錄下

# 使用 uv 一鍵執行轉換
uv run --with numpy convert_flog2.py
```

*如果你使用標準 Python 環境：*

```bash
pip install numpy
python convert_flog2.py
```

轉換完成後，產出的 `.cube` 檔案將存放於 `Fuji_LUT_Best_33Grid/`。

## 📱 檔名與軟片模擬對照表

轉換後的檔案已自動精簡檔名，方便在 Snapseed 或行動裝置剪輯軟體中預覽選取：

| 輸出短檔名 | 原官方檔名 | 建議適用情境 |
| ----- | ----- | ----- |
| `Classic-Neg.cube` | `FLog2_to_CLASSIC-Neg._65grid_V.1.00.cube` | **街拍神色**，高反差、冷暖對比強烈、獨特綠色調 |
| `Reala-Ace.cube` | `FLog2_to_REALA-ACE_65grid_V.1.00.cube` | 富士最新旗艦色彩，發色自然立體，通透乾淨 |
| `Classic-Chrome.cube` | `FLog2_to_CLASSIC-CHROME_65grid_V.1.00.cube` | 紀實人文、低飽和雜誌文青感 |
| `Astia.cube` | `FLog2_to_ASTIA_65grid_V.1.00.cube` | 柔和高光與細膩膚色，人像與家庭日常首選 |
| `Provia.cube` | `FLog2_to_PROVIA_65grid_V.1.00.cube` | 富士標準正片，平衡且忠實呈現現場色彩 |
| `Velvia.cube` | `FLog2_to_Velvia_65grid_V.1.00.cube` | 風景專用，藍天與綠地具備極高飽和度 |
| `Pro-Neg-Std.cube` | `FLog2_to_PRO-Neg.Std_65grid_V.1.00.cube` | 專業負片標準，階調柔和，適合棚拍控光人像 |
| `Eterna.cube` | `FLog2_to_ETERNA_65grid_V.1.00.cube` | 電影正片色調，低對比度與平順的高光滾降 |
| `Eterna-BB.cube` | `FLog2_to_ETERNA-BB_65grid_V.1.00.cube` | 漂白效果（Bleach Bypass），高對比低飽和重工業風 |
| `Acros.cube` | `FLog2_to_ACROS_65grid_V.1.00.cube` | 細膩層次與立體感兼具的高質感黑白 |

## 📲 如何在 Snapseed 中套用

1. 將產出的 `Fuji_LUT_Best_33Grid/` 內的 `.cube` 檔案經由 AirDrop、Google Drive 或傳輸線傳至手機儲存空間。

2. 打開 **Snapseed** 並載入照片（JPG / HEIC 或 DNG RAW 皆可）。

3. 點選下方 **「工具」** → **「LUT」**。

4. 點選「開啟檔案」選取剛剛匯入的 `.cube` 檔（如 `Classic-Neg.cube`）。

5. 根據當前光線環境，左右滑動調整套用強度（建議強度：`70% ~ 100%`）。

## 📄 License

本專案程式碼基於 [MIT License](LICENSE) 開放原始碼。

*免責聲明：富士軟片模擬之色彩科學與商標權屬 FUJIFILM Corporation 所有，本專案僅提供色彩空間轉換演算法實作，官方原始 `.cube` 檔請逕自富士官網下載。*
