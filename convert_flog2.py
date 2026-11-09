"""將富士 F-Log2 65Grid 3D LUT 超取樣轉換為標準 sRGB 33Grid 3D LUT 之批次處理工具。"""

import re
from pathlib import Path
import numpy as np

# 針對 Snapseed 介面 9 半形字元預覽寬度限制，將 4 個中文字情境置於檔名前綴
SHORT_NAMES = {
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
    'WDR-709': '寬動態域_Rec709-WDR',
}

_NAME_PATTERN = re.compile(r'FLog2_to_(.+?)_(?:65|33)grid')

# Rec.709 / sRGB 線性原色轉換至 Fujifilm F-Gamut (ITU-R BT.2020) 之轉置色彩矩陣，確保 D65 白點守恆
_REC709_TO_FGAMUT_T = np.array([
    [0.627404, 0.329283, 0.043313],
    [0.069097, 0.919540, 0.011362],
    [0.016391, 0.088013, 0.895595],
], dtype=np.float64).T


def get_short_name(stem: str) -> str:
    """從官方原始 LUT 檔案主檔名擷取軟片模擬名稱並映射為情境短檔名。

    Args:
        stem: 不含副檔名的原始檔案名稱。

    Returns:
        映射後的情境短檔名；若未匹配字典則回傳擷取出的原始核心名稱。
    """
    m = _NAME_PATTERN.search(stem)
    raw_name = m.group(1) if m else stem
    return SHORT_NAMES.get(raw_name, raw_name)


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    """依據 IEC 61966-2-1 標準將 sRGB 非線性訊號解碼為線性光訊號。

    Args:
        x: 正規化之 sRGB 訊號陣列，數值範圍為 [0.0, 1.0]。

    Returns:
        轉換後的線性光反射率陣列。
    """
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def linear_to_flog2(x: np.ndarray) -> np.ndarray:
    """依據 Fujifilm F-Log2 Data Sheet Ver.1.0 白皮書規範將線性光訊號編碼為 F-Log2 曲線。

    Args:
        x: 位於 F-Gamut 色域之線性光訊號陣列。

    Returns:
        正規化之 F-Log2 對數訊號陣列。
    """
    # 分段函數常數與分界點 cut1 嚴格遵循富士 F-Log2 白皮書第 2-3 節定義
    a, b, c, d, e, f, cut1 = 5.555556, 0.064829, 0.245281, 0.384316, 8.799461, 0.092864, 0.000889
    return np.where(x < cut1, e * x + f, c * np.log10(a * x + b) + d)


def build_trilinear_plan(src_size: int, target_size: int) -> tuple[np.ndarray, np.ndarray, list[np.ndarray]]:
    """預先計算目標網格映射至來源母片網格的一維基底索引、頂點步進位移與三線性插值權重。

    利用網格座標轉換僅依賴維度大小而不依賴檔案內容的特性，將時間複雜度 O(M) 的空間轉換與權重計算提取為迴圈不變數，使跨檔案重複查詢降至 O(1)。

    Args:
        src_size: 來源母片 3D LUT 的單軸網格尺寸（如 65）。
        target_size: 輸出目標 3D LUT 的單軸網格尺寸（如 33）。

    Returns:
        包含三個元素的元組：
        - base_idx: 每個目標網格點對應至來源一維展平陣列的左下角基準索引。
        - offsets: 單位立方體 8 個頂點相對於基準索引的一維步進偏移量。
        - weights: 對應 8 個頂點的三線性插值權重陣列清單。
    """
    # 善用單通道獨立性，先於 1D 軸向完成指數解碼再展開為 3D，將指數運算次數由 3 * M 降至 M^(1/3)
    out_grid_1d = np.linspace(0.0, 1.0, target_size, dtype=np.float64)
    lin_1d = srgb_to_linear(out_grid_1d)

    # 依 .cube 規範排列：Blue 軸變動最慢、Green 次之、Red 變動最快
    B, G, R = np.meshgrid(lin_1d, lin_1d, lin_1d, indexing='ij')
    pts_linear = np.column_stack((R.ravel(), G.ravel(), B.ravel()))

    pts_fgamut = np.clip(pts_linear @ _REC709_TO_FGAMUT_T, 0.0, 1.0)
    pts_flog2 = np.clip(linear_to_flog2(pts_fgamut), 0.0, 1.0)

    # 利用等距網格特性以 O(1) 算術運算直接定位下界索引，並將最大值夾限於 src_size - 2 以防座標 1.0 時上界溢位
    scaled = pts_flog2 * (src_size - 1)
    idx0 = np.floor(scaled).astype(np.intp)
    np.clip(idx0, 0, src_size - 2, out=idx0)

    d = scaled - idx0
    dr, dg, db = d[:, 0:1], d[:, 1:2], d[:, 2:3]
    omr, omg, omb = 1.0 - dr, 1.0 - dg, 1.0 - db

    # 以一維線性定址公式 ir + S * ig + S^2 * ib 直接對應 .cube 原始資料順序，免除 Fortran order 記憶體重排開銷
    s2 = src_size * src_size
    base_idx = idx0[:, 0] + src_size * idx0[:, 1] + s2 * idx0[:, 2]

    offsets = np.array([
        0,
        1,
        src_size,
        src_size + 1,
        s2,
        s2 + 1,
        s2 + src_size,
        s2 + src_size + 1,
    ], dtype=np.intp)

    weights = [
        omr * omg * omb,
        dr * omg * omb,
        omr * dg * omb,
        dr * dg * omb,
        omr * omg * db,
        dr * omg * db,
        omr * dg * db,
        dr * dg * db,
    ]
    return base_idx, offsets, weights


def parse_cube_fast(file_path: Path) -> tuple[int, np.ndarray]:
    """高效剖析 .cube 檔案，讀取網格尺寸並將色彩查找表載入為二維浮點數陣列。

    Args:
        file_path: 來源 .cube 檔案的路徑。

    Returns:
        包含單軸網格尺寸與形狀為 (N, 3) 之 RGB 資料陣列的元組。

    Raises:
        ValueError: 當檔案為空白或未包含任何有效 RGB 數值資料列時拋出。
    """
    size = 65
    first_data_line = ''
    rest_text = ''

    # 僅在檔頭區段使用 Python 逐行掃描，定位至第一筆數值後即一次性讀出剩餘區塊交由 C 底層剖析
    with file_path.open('r', encoding='utf-8') as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith(('#', 'TITLE', 'DOMAIN_MIN', 'DOMAIN_MAX', 'LUT_1D_SIZE')):
                continue
            if s.startswith('LUT_3D_SIZE'):
                size = int(s.split()[1])
                continue
            first_data_line = s
            rest_text = f.read()
            break
        else:
            raise ValueError(f'無效或空白的 .cube 檔案: {file_path}')

    # 若數值區塊內嵌非標準的註解行，先行濾除以避免 np.fromstring 提前終止解析
    if '#' in rest_text:
        clean_lines = [first_data_line]
        clean_lines.extend(
            ln for ln in rest_text.splitlines()
            if ln.strip() and not ln.lstrip().startswith('#')
        )
        full_data_str = '\n'.join(clean_lines)
    else:
        full_data_str = f'{first_data_line}\n{rest_text}'

    lut_data = np.fromstring(full_data_str, dtype=np.float64, sep=' ').reshape((-1, 3))
    return size, lut_data


def convert_flog2_supersampled(
    cube_path: Path,
    out_path: Path,
    short_title: str,
    target_size: int,
    plan_cache: dict[tuple[int, int], tuple[np.ndarray, np.ndarray, list[np.ndarray]]],
) -> None:
    """讀取單一 F-Log2 .cube 母片，執行超取樣插值並匯出為 sRGB 色彩空間之 .cube 檔案。

    Args:
        cube_path: 來源 F-Log2 .cube 母片檔案路徑。
        out_path: 轉換後輸出的 .cube 檔案路徑。
        short_title: 寫入輸出檔案 TITLE 標頭的簡短名稱。
        target_size: 輸出 3D LUT 的單軸網格尺寸。
        plan_cache: 儲存以 (src_size, target_size) 為鍵之預計算插值索引與權重的快取字典。
    """
    src_size, lut_data = parse_cube_fast(cube_path)

    cache_key = (src_size, target_size)
    if cache_key not in plan_cache:
        plan_cache[cache_key] = build_trilinear_plan(src_size, target_size)
    base_idx, offsets, weights = plan_cache[cache_key]

    # 以原地累加執行 8 頂點加權求和，避免配置形狀為 (8, M, 3) 的中介陣列以降低記憶體峰值
    new_lut_data = lut_data[base_idx + offsets[0]] * weights[0]
    for k in range(1, 8):
        new_lut_data += lut_data[base_idx + offsets[k]] * weights[k]
    np.clip(new_lut_data, 0.0, 1.0, out=new_lut_data)

    # 先將 NumPy 陣列轉為原生 Python list 再進行字串格式化，避免逐列迭代時產生大量的 NumPy 標量封裝開銷
    header = (
        f'TITLE "{short_title}"\n'
        f'LUT_3D_SIZE {target_size}\n'
        'DOMAIN_MIN 0.0 0.0 0.0\n'
        'DOMAIN_MAX 1.0 1.0 1.0\n'
    )
    body = '\n'.join(f'{r:.6f} {g:.6f} {b:.6f}' for r, g, b in new_lut_data.tolist())
    out_path.write_text(f'{header}{body}\n', encoding='utf-8')


if __name__ == '__main__':
    src_dir = Path('65Grid/F-Log2')
    out_dir_33 = Path('Fuji_LUT_Best_33Grid')
    out_dir_33.mkdir(exist_ok=True)

    trilinear_plan_cache: dict[tuple[int, int], tuple[np.ndarray, np.ndarray, list[np.ndarray]]] = {}

    for cube_file in sorted(src_dir.glob('*.cube')):
        short_name = get_short_name(cube_file.stem)
        out_file = out_dir_33 / f'{short_name}.cube'
        convert_flog2_supersampled(
            cube_path=cube_file,
            out_path=out_file,
            short_title=short_name,
            target_size=33,
            plan_cache=trilinear_plan_cache,
        )
        print(f'[65Grid 母片超取樣] {cube_file.name}  ==>  {out_file.name}')
