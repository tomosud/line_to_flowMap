"""
line_to_flowmap.py

線画画像からフローマップ（16bit RGB PNG）を生成する。

Usage:
    python line_to_flowmap.py <input_image> [<input_image2> ...]

Output:
    入力ファイルと同じフォルダに {name}_flow.png を出力する。
"""

import sys
import os
import numpy as np
import cv2
from skimage.morphology import skeletonize
from scipy.ndimage import distance_transform_edt, gaussian_filter

# ── チューニング定数 ───────────────────────────────────────────────────────
MORPH_CLOSE_KERNEL_SIZE = 3   # 線途切れ補修カーネルサイズ（px）
SIGMA = 20.0                   # スケルトン影響の距離減衰（px）。大きいほど広い範囲に影響
SMOOTH_SIGMA = 1.0             # ブレンド後のガウシアンスムージング（0=無効）
BLUE_VALUE = 0.5               # Bチャンネル固定値（フローマップ慣例: 0.5=中立）
BASE_VECTOR_X = 1.0            # ベースベクトルX（正規化前）→ 右方向
BASE_VECTOR_Y = 1.0            # ベースベクトルY（正規化前、正=画像下向き）→ 右下（左上起点）
# ─────────────────────────────────────────────────────────────────────────


def _normalize_vec(x, y):
    """2Dベクトルを正規化して返す。ゼロベクトルの場合は (1, 0) を返す。"""
    length = (x * x + y * y) ** 0.5
    if length < 1e-8:
        return (1.0, 0.0)
    return (x / length, y / length)


def load_and_binarize(path):
    """
    画像を読込みグレースケール二値化する。
    Returns:
        binary_img (np.ndarray uint8): 線=255, 背景=0
    """
    # cv2.imread は非ASCII パスで失敗する場合があるため PIL をフォールバックに使う
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        try:
            from PIL import Image
            pil_img = Image.open(path).convert('L')
            img = np.array(pil_img)
        except Exception as e:
            raise RuntimeError(f"画像を読み込めません: {path}\n{e}")

    # Otsu 二値化（THRESH_BINARY_INV で線=255）
    _, binary = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # モルフォロジーclose で小さな途切れを補修
    if MORPH_CLOSE_KERNEL_SIZE > 1:
        kernel = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE,
            (MORPH_CLOSE_KERNEL_SIZE, MORPH_CLOSE_KERNEL_SIZE)
        )
        binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)

    return binary


def skeletonize_image(binary_img):
    """
    1px幅スケルトンを生成する（Zhang-Suen法）。
    Returns:
        skeleton (np.ndarray bool): True=スケルトン画素
    """
    bool_img = binary_img > 0
    return skeletonize(bool_img)


def build_skeleton_graph(skeleton):
    """
    スケルトン画素の8近傍グラフを構築し、端点・分岐点を分類する。
    Returns:
        adjacency (dict): {(y,x): [(y,x), ...]}
        endpoints (set): 次数=1の画素
        junctions (set): 次数>=3の画素
    """
    ys, xs = np.where(skeleton)
    skel_set = set(zip(ys.tolist(), xs.tolist()))

    adjacency = {}
    for y, x in skel_set:
        neighbors = []
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                nb = (y + dy, x + dx)
                if nb in skel_set:
                    neighbors.append(nb)
        adjacency[(y, x)] = neighbors

    endpoints = {p for p, nb in adjacency.items() if len(nb) == 1}
    junctions = {p for p, nb in adjacency.items() if len(nb) >= 3}

    return adjacency, endpoints, junctions


def _edge_key(a, b):
    return (a, b) if a < b else (b, a)


def _trace_path(start, adjacency, visited_edges, visited_pixels, junctions):
    """
    start から辿れる限りポリラインをトレースする。
    エッジベース管理により分岐点も複数ポリラインで共有可能。
    """
    polyline = [start]
    visited_pixels.add(start)
    current = start
    prev = None

    while True:
        neighbors = adjacency[current]
        candidates = [
            n for n in neighbors
            if n != prev and _edge_key(current, n) not in visited_edges
        ]

        if not candidates:
            break

        # 分岐点以外を優先してメインラインを延長する
        non_junc = [n for n in candidates if n not in junctions]
        next_px = non_junc[0] if non_junc else candidates[0]

        visited_edges.add(_edge_key(current, next_px))
        polyline.append(next_px)
        visited_pixels.add(next_px)
        prev = current
        current = next_px

        # 閉ループ検出（開始点に戻ったら終了）
        if current == start:
            break

    return polyline


def trace_all_polylines(adjacency, endpoints, junctions, shape):
    """
    全ポリラインをトレースする。
    開いた線分は端点(score=y*W+x 最小)から開始し、左上優先で方向を統一する。
    閉曲線は未訪問の任意点から開始する。

    Returns:
        polylines (list of list): [(y,x), ...] のリスト
    """
    width = shape[1]
    visited_edges = set()
    visited_pixels = set()
    polylines = []

    # 開いた線分：端点からスコア順で開始（左上ほどスコアが小さい）
    sorted_endpoints = sorted(endpoints, key=lambda p: p[0] * width + p[1])
    for start in sorted_endpoints:
        if start in visited_pixels:
            # 既に別ポリラインで通過済みでも残存エッジがある可能性を確認
            remaining = [
                n for n in adjacency[start]
                if _edge_key(start, n) not in visited_edges
            ]
            if not remaining:
                continue
        pl = _trace_path(start, adjacency, visited_edges, visited_pixels, junctions)
        if len(pl) >= 2:
            polylines.append(pl)

    # 閉曲線・未到達成分：残った未訪問エッジから開始
    all_pixels = set(adjacency.keys())
    while True:
        # エッジが未訪問の画素を探す
        unvisited_edge_pixels = [
            p for p in all_pixels
            if any(_edge_key(p, n) not in visited_edges for n in adjacency[p])
        ]
        if not unvisited_edge_pixels:
            break
        start = unvisited_edge_pixels[0]
        pl = _trace_path(start, adjacency, visited_edges, visited_pixels, junctions)
        if len(pl) >= 2:
            polylines.append(pl)

    return polylines


def compute_tangents(polylines, shape):
    """
    各ポリライン点のタンジェントベクトルを計算して tangent_map に書き込む。

    Returns:
        tangent_map (np.ndarray float32, H×W×2): スケルトン画素のタンジェント
        mask (np.ndarray bool, H×W): スケルトン画素フラグ
    """
    H, W = shape
    tangent_map = np.zeros((H, W, 2), dtype=np.float32)
    mask = np.zeros((H, W), dtype=bool)

    for polyline in polylines:
        n = len(polyline)
        for i, (y, x) in enumerate(polyline):
            if n == 1:
                tx, ty = 1.0, 0.0  # 単一画素: ベース方向
            elif i == 0:
                dy = polyline[1][0] - polyline[0][0]
                dx = polyline[1][1] - polyline[0][1]
                tx, ty = _normalize_vec(dx, dy)
            elif i == n - 1:
                dy = polyline[-1][0] - polyline[-2][0]
                dx = polyline[-1][1] - polyline[-2][1]
                tx, ty = _normalize_vec(dx, dy)
            else:
                dy = polyline[i + 1][0] - polyline[i - 1][0]
                dx = polyline[i + 1][1] - polyline[i - 1][1]
                tx, ty = _normalize_vec(dx, dy)

            tangent_map[y, x, 0] = tx
            tangent_map[y, x, 1] = ty
            mask[y, x] = True

    return tangent_map, mask


def build_vector_field(tangent_map, mask, shape):
    """
    ベースベクトル場とスケルトン方向をブレンドしてフローベクトル場を構築する。

    処理:
    1. 全画素に V0 = normalize(BASE_VECTOR_X, BASE_VECTOR_Y) を設定
    2. スケルトン点のタンジェントを V0 と dot 積で符号統一
    3. 距離変換で最近傍スケルトン点を取得
    4. ガウス重みでブレンドし正規化
    5. 軽いスムージング後に再正規化

    Returns:
        vector_field (np.ndarray float32, H×W×2): 正規化済みベクトル場
    """
    H, W = shape[:2]

    # ベースベクトル（左上起点・右下方向）
    v0x, v0y = _normalize_vec(BASE_VECTOR_X, BASE_VECTOR_Y)

    # ---- Step 1: スケルトン点の向きを V0 と統一 ----
    ys, xs = np.where(mask)
    if len(ys) > 0:
        tx = tangent_map[ys, xs, 0]
        ty = tangent_map[ys, xs, 1]
        dot = tx * v0x + ty * v0y
        flip = dot < 0
        tangent_map[ys[flip], xs[flip], 0] *= -1
        tangent_map[ys[flip], xs[flip], 1] *= -1

    # ---- Step 2: 距離変換で最近傍スケルトン点を取得 ----
    # distance_transform_edt: ~mask=True の画素（背景）から最近傍 False 画素（スケルトン）までの距離
    if mask.any():
        distances, nearest_indices = distance_transform_edt(~mask, return_indices=True)
        ny = nearest_indices[0]  # (H, W) 最近傍スケルトン点の y 座標
        nx = nearest_indices[1]  # (H, W) 最近傍スケルトン点の x 座標

        # ---- Step 3: ガウス重みでブレンド ----
        weights = np.exp(-(distances ** 2) / (2.0 * SIGMA ** 2))  # (H, W)

        vs_x = tangent_map[ny, nx, 0]  # (H, W)
        vs_y = tangent_map[ny, nx, 1]  # (H, W)

        w = weights[:, :, np.newaxis]                     # (H, W, 1) broadcast 用
        vs = np.stack([vs_x, vs_y], axis=-1)              # (H, W, 2)
        v0_arr = np.array([v0x, v0y], dtype=np.float32)   # (2,)

        blended = (1.0 - w) * v0_arr + w * vs            # (H, W, 2)
    else:
        # スケルトンなし: 全画素にベースベクトルのみ
        blended = np.full((H, W, 2), [v0x, v0y], dtype=np.float32)

    # ---- Step 4: 正規化 ----
    norms = np.linalg.norm(blended, axis=-1, keepdims=True)
    norms = np.where(norms < 1e-8, 1.0, norms)
    vector_field = blended / norms

    # ---- Step 5: 軽いスムージング（方向の急変を緩和）----
    if SMOOTH_SIGMA > 0:
        vector_field[:, :, 0] = gaussian_filter(vector_field[:, :, 0], sigma=SMOOTH_SIGMA)
        vector_field[:, :, 1] = gaussian_filter(vector_field[:, :, 1], sigma=SMOOTH_SIGMA)
        norms = np.linalg.norm(vector_field, axis=-1, keepdims=True)
        norms = np.where(norms < 1e-8, 1.0, norms)
        vector_field /= norms

    return vector_field


def encode_flowmap(vector_field):
    """
    ベクトル場をフローマップ（16bit BGR）にエンコードする。

    R = 0.5 + 0.5 * Tx   (水平方向)
    G = 0.5 + 0.5 * Ty   (垂直方向)
    B = BLUE_VALUE        (固定)

    Returns:
        bgr_16bit (np.ndarray uint16, H×W×3): cv2 保存用 BGR 順
    """
    Tx = vector_field[:, :, 0]
    Ty = vector_field[:, :, 1]

    R = np.clip(0.5 + 0.5 * Tx, 0.0, 1.0)
    G = np.clip(0.5 + 0.5 * Ty, 0.0, 1.0)
    B = np.full_like(R, BLUE_VALUE)

    R_16 = (R * 65535).astype(np.uint16)
    G_16 = (G * 65535).astype(np.uint16)
    B_16 = (B * 65535).astype(np.uint16)

    # cv2 は BGR 順で保存するので、ファイル上の R/G/B が正しくなるよう逆順に積む
    bgr_16 = np.stack([B_16, G_16, R_16], axis=-1)
    return bgr_16


def save_output(bgr_16bit, input_path):
    """
    16bit PNG を入力と同フォルダの {stem}_flow.png に保存する。
    非ASCII パス対策として cv2.imencode + バイナリ書込を使う。
    """
    input_dir = os.path.dirname(os.path.abspath(input_path))
    stem = os.path.splitext(os.path.basename(input_path))[0]
    output_path = os.path.join(input_dir, stem + "_flow.png")

    success, buf = cv2.imencode(".png", bgr_16bit)
    if not success:
        raise RuntimeError(f"cv2.imencode に失敗しました: {output_path}")

    with open(output_path, 'wb') as f:
        f.write(buf.tobytes())

    print(f"[INFO] 保存完了: {output_path}")
    return output_path


def main(input_path):
    print(f"[INFO] 入力: {input_path}")

    binary = load_and_binarize(input_path)
    print(f"[INFO] 画像サイズ: {binary.shape[1]}x{binary.shape[0]}")

    skeleton = skeletonize_image(binary)
    skel_count = int(np.sum(skeleton))
    print(f"[INFO] スケルトン画素数: {skel_count}")

    if skel_count == 0:
        print("[WARN] スケルトンが見つかりませんでした。ベースベクトル場のみ出力します。")
        H, W = binary.shape
        vector_field = np.full((H, W, 2), [
            BASE_VECTOR_X / ((BASE_VECTOR_X**2 + BASE_VECTOR_Y**2) ** 0.5),
            BASE_VECTOR_Y / ((BASE_VECTOR_X**2 + BASE_VECTOR_Y**2) ** 0.5)
        ], dtype=np.float32)
        bgr_16bit = encode_flowmap(vector_field)
        save_output(bgr_16bit, input_path)
        return

    adjacency, endpoints, junctions = build_skeleton_graph(skeleton)
    print(f"[INFO] 端点: {len(endpoints)}, 分岐点: {len(junctions)}")

    polylines = trace_all_polylines(adjacency, endpoints, junctions, binary.shape)
    print(f"[INFO] ポリライン数: {len(polylines)}")

    tangent_map, mask = compute_tangents(polylines, binary.shape)

    vector_field = build_vector_field(tangent_map, mask, binary.shape)

    bgr_16bit = encode_flowmap(vector_field)

    save_output(bgr_16bit, input_path)
    print("[INFO] 完了")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python line_to_flowmap.py <input_image> [<input_image2> ...]")
        sys.exit(1)

    for path in sys.argv[1:]:
        try:
            main(path)
        except Exception as e:
            print(f"[ERROR] {path}: {e}")
            import traceback
            traceback.print_exc()
