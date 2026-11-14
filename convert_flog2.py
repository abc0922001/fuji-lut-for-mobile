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

# 依據 Fujifilm F-Log2 Data Sheet Ver.1.1 第 2-3 節定義之雙向對數轉換常數與分界點
_FLOG2_A = 5.555556
_FLOG2_B = 0.064829
_FLOG2_C = 0.245281
_FLOG2_D = 0.384316
_FLOG2_E = 8.799461
_FLOG2_F = 0.092864
_FLOG2_CUT1 = 0.000889
_FLOG2_CUT2 = 0.100686685370811

# 依據白皮書第 3 節 CIE 1931 色度座標推導之 ITU-R BT.709 轉 F-Gamut 轉置矩陣，確保 float64 下 D65 白點嚴格守恆
_REC709_TO_FGAMUT_T = np.array([
    [0.6274038959346990, 0.3292830383778837, 0.0433130656874172],
    [0.0690972893582320, 0.9195403950754589, 0.0113623155663091],
    [0.0163914388751502, 0.0880133078772257, 0.8955952532476241],
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
        轉換後的場景線性光反射率陣列。
    """
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(x: np.ndarray) -> np.ndarray:
    """依據 IEC 61966-2-1 標準將線性光訊號編碼為 sRGB 非線性訊號。

    Args:
        x: 場景線性光反射率陣列。

    Returns:
        正規化之 sRGB 訊號陣列，數值範圍為 [0.0, 1.0]。
    """
    x_clipped = np.clip(x, 0.0, 1.0)
    return np.where(x_clipped <= 0.0031308, x_clipped * 12.92, 1.055 * (x_clipped ** (1.0 / 2.4)) - 0.055)


def linear_to_flog2(x: np.ndarray) -> np.ndarray:
    """依據 Fujifilm F-Log2 Data Sheet Ver.1.1 第 2-3 節規範將場景線性光反射率編碼為 F-Log2 訊號。

    Args:
        x: 位於 F-Gamut 色域之線性光反射率陣列。

    Returns:
        正規化之 F-Log2 對數訊號陣列。
    """
    return np.where(
        x < _FLOG2_CUT1,
        _FLOG2_E * x + _FLOG2_F,
        _FLOG2_C * np.log10(_FLOG2_A * x + _FLOG2_B) + _FLOG2_D,
    )


def flog2_to_linear(x: np.ndarray) -> np.ndarray:
    """依據 Fujifilm F-Log2 Data Sheet Ver.1.1 第 2-3 節規範將 F-Log2 訊號還原為場景線性光反射率。

    Args:
        x: 正規化之 F-Log2 對數訊號陣列，數值範圍為 [0.0, 1.0]。

    Returns:
        還原後的場景線性光反射率陣列。
    """
    return np.where(
        x < _FLOG2_CUT2,
        (x - _FLOG2_F) / _FLOG2_E,
        (10.0 ** ((x - _FLOG2_D) / _FLOG2_C)) / _FLOG2_A - _FLOG2_B / _FLOG2_A,
    )


def build_tetrahedral_plan(
    src_size: int,
    target_size: int,
) -> tuple[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]]:
    """預先計算目標網格映射至來源母片網格的四面體頂點一維索引與插值權重。

    將單位立方體沿主對角線 (0,0,0) 至 (1,1,1) 切分為 6 個四面體，使灰階中性軸上的點僅由主對角線兩端點線性插值，消除三線性插值跨非中性色角平均造成的色偏；同時將每點頂點查找數由 8 降至 4，使跨檔案套用時的記憶體存取與乘加運算減半。

    Args:
        src_size: 來源母片 3D LUT 的單軸網格尺寸（如 65）。
        target_size: 輸出目標 3D LUT 的單軸網格尺寸（如 33）。

    Returns:
        包含兩個四元組的元組：
        - vertices: 每個目標網格點對應之 4 個四面體頂點一維展平索引 (v0, v1, v2, v3)。
        - weights: 對應 4 個四面體頂點的插值權重陣列 (w0, w1, w2, w3)。
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

    # 以一維線性定址公式 ir + S * ig + S^2 * ib 直接對應 .cube 原始資料順序，免除 Fortran order 記憶體重排開銷
    s2 = src_size * src_size
    v0 = idx0[:, 0] + src_size * idx0[:, 1] + s2 * idx0[:, 2]

    # 依局部差值 (dr, dg, db) 由小至大排序，決定該點落入 6 個四面體中的哪一個步進路徑
    order = np.argsort(d, axis=1)
    strides = np.array([1, src_size, s2], dtype=np.intp)
    v1 = v0 + strides[order[:, 2]]
    v2 = v1 + strides[order[:, 1]]
    v3 = v2 + strides[order[:, 0]]

    d_min = np.take_along_axis(d, order[:, 0:1], axis=1)
    d_mid = np.take_along_axis(d, order[:, 1:2], axis=1)
    d_max = np.take_along_axis(d, order[:, 2:3], axis=1)

    vertices = (v0, v1, v2, v3)
    weights = (1.0 - d_max, d_max - d_mid, d_mid - d_min, d_min)
    return vertices, weights


def parse_cube_fast(file_path: Path) -> tuple[int, bool, np.ndarray]:
    """高效剖析 .cube 檔案，讀取網格尺寸、輸出曲線標記並將色彩查找表載入為二維浮點數陣列。

    Args:
        file_path: 來源 .cube 檔案的路徑。

    Returns:
        包含單軸網格尺寸、輸出是否維持 F-Log2 曲線之布林值與形狀為 (N, 3) 之 RGB 資料陣列的元組。

    Raises:
        ValueError: 當檔案為空白或未包含任何有效 RGB 數值資料列時拋出。
    """
    size = 65
    is_flog2_output = False
    first_data_line = ''
    rest_text = ''

    # 僅在檔頭區段使用 Python 逐行掃描，定位至第一筆數值後即一次性讀出剩餘區塊交由 C 底層剖析
    with file_path.open('r', encoding='utf-8') as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            if s.startswith('#'):
                if 'F-Log2 to F-Log2' in s:
                    is_flog2_output = True
                continue
            if s.startswith(('TITLE', 'DOMAIN_MIN', 'DOMAIN_MAX', 'LUT_1D_SIZE')):
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
    return size, is_flog2_output, lut_data


def convert_flog2_supersampled(
    cube_path: Path,
    out_path: Path,
    short_title: str,
    target_size: int,
    plan_cache: dict[
        tuple[int, int],
        tuple[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]],
    ],
) -> None:
    """讀取單一 F-Log2 .cube 母片，執行四面體超取樣插值並匯出為 sRGB 色彩空間之 .cube 檔案。

    Args:
        cube_path: 來源 F-Log2 .cube 母片檔案路徑。
        out_path: 轉換後輸出的 .cube 檔案路徑。
        short_title: 寫入輸出檔案 TITLE 標頭的簡短名稱。
        target_size: 輸出 3D LUT 的單軸網格尺寸。
        plan_cache: 儲存以 (src_size, target_size) 為鍵之預計算四面體頂點索引與權重的快取字典。
    """
    src_size, is_flog2_output, lut_data = parse_cube_fast(cube_path)

    cache_key = (src_size, target_size)
    if cache_key not in plan_cache:
        plan_cache[cache_key] = build_tetrahedral_plan(src_size, target_size)
    vertices, weights = plan_cache[cache_key]

    # 以原地累加執行 4 頂點四面體加權求和，降低記憶體峰值並消除灰階對角線色偏
    new_lut_data = lut_data[vertices[0]] * weights[0]
    for k in range(1, 4):
        new_lut_data += lut_data[vertices[k]] * weights[k]

    # 若母片僅轉換色域而未轉換 Gamma（如 FLog2_to_FLog2-709），需依白皮書第 2-3 節逆轉換回線性光再編碼為 sRGB
    if is_flog2_output:
        new_lut_data = linear_to_srgb(flog2_to_linear(new_lut_data))
    else:
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

    tetrahedral_plan_cache: dict[
        tuple[int, int],
        tuple[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray], tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]],
    ] = {}

    for cube_file in sorted(src_dir.glob('*.cube')):
        short_name = get_short_name(cube_file.stem)
        out_file = out_dir_33 / f'{short_name}.cube'
        convert_flog2_supersampled(
            cube_path=cube_file,
            out_path=out_file,
            short_title=short_name,
            target_size=33,
            plan_cache=tetrahedral_plan_cache,
        )
        print(f'[65Grid 母片超取樣] {cube_file.name}  ==>  {out_file.name}')
