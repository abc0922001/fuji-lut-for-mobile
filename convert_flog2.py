import re
from pathlib import Path
import numpy as np

# 拔除編號，前 4 個中文字情境在 Snapseed 9 字元寬度限制下可 100% 完整顯示
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

# Rec.709 / sRGB 轉 Fujifilm F-Gamut (ITU-R BT.2020) 轉置矩陣常數
_REC709_TO_FGAMUT_T = np.array([
    [0.627404, 0.329283, 0.043313],
    [0.069097, 0.919540, 0.011362],
    [0.016391, 0.088013, 0.895595],
], dtype=np.float64).T


def get_short_name(stem: str) -> str:
    m = _NAME_PATTERN.search(stem)
    raw_name = m.group(1) if m else stem
    return SHORT_NAMES.get(raw_name, raw_name)


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def linear_to_flog2(x: np.ndarray) -> np.ndarray:
    # 依據 Fujifilm F-Log2 Data Sheet Ver.1.0 官方白皮書常數
    a, b, c, d, e, f, cut1 = 5.555556, 0.064829, 0.245281, 0.384316, 8.799461, 0.092864, 0.000889
    return np.where(x < cut1, e * x + f, c * np.log10(a * x + b) + d)


def build_trilinear_plan(src_size: int, target_size: int) -> tuple[np.ndarray, np.ndarray, list[np.ndarray]]:
    """
    預計算目標網格在母片中的「一維基底索引」、「8 頂點純量位移」與「8 組三線性插值權重」。
    時間複雜度: O(M)，跨檔案重複使用時為 O(1)。
    """
    # 1. 降維最佳化：僅在 1D (長度 target_size) 上執行 sRGB -> Linear 指數運算，複雜度 O(M^(1/3))
    out_grid_1d = np.linspace(0.0, 1.0, target_size, dtype=np.float64)
    lin_1d = srgb_to_linear(out_grid_1d)

    # 展開為 3D 網格 (B 變化最慢、G 次之、R 最快，符合 .cube 規範)
    B, G, R = np.meshgrid(lin_1d, lin_1d, lin_1d, indexing='ij')
    pts_linear = np.column_stack((R.ravel(), G.ravel(), B.ravel()))

    # 2. 線性光轉 F-Gamut (BT.2020) 再轉 F-Log2 對數曲線
    pts_fgamut = np.clip(pts_linear @ _REC709_TO_FGAMUT_T, 0.0, 1.0)
    pts_flog2 = np.clip(linear_to_flog2(pts_fgamut), 0.0, 1.0)

    # 3. O(1) 等距網格直接定址（取代 RegularGridInterpolator 的 O(log N) 二分搜尋）
    scaled = pts_flog2 * (src_size - 1)
    idx0 = np.floor(scaled).astype(np.intp)
    np.clip(idx0, 0, src_size - 2, out=idx0)

    # 局部差值權重 d 介於 [0.0, 1.0]
    d = scaled - idx0
    dr, dg, db = d[:, 0:1], d[:, 1:2], d[:, 2:3]
    omr, omg, omb = 1.0 - dr, 1.0 - dg, 1.0 - db

    # 4. 計算一維展平基底索引：flat_idx = ir + S * (ig + S * ib)，免除 order='F' 記憶體重排拷貝
    s2 = src_size * src_size
    base_idx = idx0[:, 0] + src_size * idx0[:, 1] + s2 * idx0[:, 2]

    # 8 個立方體頂點相對於 base_idx 的純量步進偏移量
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

    # 預先算好 8 個頂點的插值權重 (各為 shape=(M, 1))
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
    """
    只逐行讀取檔頭，數值區塊直接交由 C 底層 np.fromstring 一次解析。
    消除 274,625 行 Python 字串切分與 list 記憶體配置。
    """
    size = 65
    first_data_line = ''
    rest_text = ''

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

    # 防護邊界情況：若資料區段中夾雜 # 註解行則予以濾除
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
    src_size, lut_data = parse_cube_fast(cube_path)

    # O(1) 取得預計算之插值索引與權重
    cache_key = (src_size, target_size)
    if cache_key not in plan_cache:
        plan_cache[cache_key] = build_trilinear_plan(src_size, target_size)
    base_idx, offsets, weights = plan_cache[cache_key]

    # O(M) 向量化三線性插值（原地累加，避免配置 (8, M, 3) 巨型暫存陣列）
    new_lut_data = lut_data[base_idx + offsets[0]] * weights[0]
    for k in range(1, 8):
        new_lut_data += lut_data[base_idx + offsets[k]] * weights[k]
    np.clip(new_lut_data, 0.0, 1.0, out=new_lut_data)

    # 批次格式化寫出（先轉為原生 list 迭代，避免逐列索引 numpy.ndarray 的封裝開銷）
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

    # 快取 (src_size, target_size) 的預計算結果，跨檔案零重複運算
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
        print(f'[65Grid 母片超採樣] {cube_file.name}  ==>  {out_file.name}')
