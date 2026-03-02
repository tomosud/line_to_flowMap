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
from scipy.ndimage import gaussian_filter

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
    各ポリラインはV0方向に合わせて必要なら反転する（ポリライン単位の方向一貫性）。
    閉曲線は未訪問の任意点から開始する。

    Returns:
        polylines (list of list): [(y,x), ...] のリスト
    """
    v0x, v0y = _normalize_vec(BASE_VECTOR_X, BASE_VECTOR_Y)
    width = shape[1]
    visited_edges = set()
    visited_pixels = set()
    polylines = []

    def align_polyline(pl):
        """ポリラインの最初のステップ方向がV0に対して逆なら反転する。
        ポリライン全体を反転することで内部タンジェントの一貫性を保つ。"""
        if len(pl) < 2:
            return pl
        dy = pl[1][0] - pl[0][0]
        dx = pl[1][1] - pl[0][1]
        if v0x * dx + v0y * dy < 0:
            return list(reversed(pl))
        return pl

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
            pl = align_polyline(pl)
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
            pl = align_polyline(pl)
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
    1. ガウス拡散でスケルトンタンジェントを全画素に広げる
       （加重平均: 周囲の全スケルトン点の影響を距離に応じて合成）
    2. スケルトン密度に応じてV0とブレンド（空白域ほどV0寄り）
    3. 正規化 → 軽いスムージング → 再正規化

    最近傍1点のVoronoi境界を避けるため、全スケルトン点の
    ガウス加重平均を使用する。これにより方向場が滑らかになる。

    Returns:
        vector_field (np.ndarray float32, H×W×2): 正規化済みベクトル場
    """
    H, W = shape[:2]
    eps = 1e-8
    v0x, v0y = _normalize_vec(BASE_VECTOR_X, BASE_VECTOR_Y)

    if mask.any():
        # ---- ガウス拡散: 全スケルトン点のタンジェントをGaussianで広げて合成 ----
        # tx_spread[y,x] = Σ_{s∈skeleton} G_σ(|(y,x)-(sy,sx)|) * tx[sy,sx]
        # w_spread[y,x]  = Σ_{s∈skeleton} G_σ(|(y,x)-(sy,sx)|)
        # → 加重平均タンジェント = tx_spread / w_spread
        mask_f = mask.astype(np.float32)
        tx_spread = gaussian_filter(tangent_map[:, :, 0] * mask_f, sigma=SIGMA)
        ty_spread = gaussian_filter(tangent_map[:, :, 1] * mask_f, sigma=SIGMA)
        w_spread  = gaussian_filter(mask_f, sigma=SIGMA)

        # 加重平均タンジェント（スケルトンが遠い画素では小さな値になる）
        vs_x = tx_spread / (w_spread + eps)
        vs_y = ty_spread / (w_spread + eps)

        # ブレンド重み: スケルトン画素でw≈1、空白域でw≈0
        # 孤立スケルトン1画素のw_spreadピーク値 ≈ 1/(2π σ²) で正規化
        peak = 1.0 / (2.0 * np.pi * SIGMA ** 2)
        w_blend = np.clip(w_spread / (peak + eps), 0.0, 1.0)

        # V0とスケルトンタンジェントをブレンド
        blend_x = (1.0 - w_blend) * v0x + w_blend * vs_x
        blend_y = (1.0 - w_blend) * v0y + w_blend * vs_y
    else:
        blend_x = np.full((H, W), v0x, dtype=np.float32)
        blend_y = np.full((H, W), v0y, dtype=np.float32)

    # ---- 正規化 ----
    norm = np.sqrt(blend_x ** 2 + blend_y ** 2)
    norm = np.where(norm < eps, 1.0, norm)
    vector_field = np.stack([blend_x / norm, blend_y / norm], axis=-1)

    # ---- 軽いスムージング（方向の急変を緩和）----
    if SMOOTH_SIGMA > 0:
        vector_field[:, :, 0] = gaussian_filter(vector_field[:, :, 0], sigma=SMOOTH_SIGMA)
        vector_field[:, :, 1] = gaussian_filter(vector_field[:, :, 1], sigma=SMOOTH_SIGMA)
        norm = np.linalg.norm(vector_field, axis=-1, keepdims=True)
        norm = np.where(norm < eps, 1.0, norm)
        vector_field /= norm

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


def save_debug_polylines(polylines, skeleton, input_path):
    """
    ポリラインごとにランダムな色を付けたデバッグ画像を保存する。
    - 背景: 白
    - 各ポリライン: ランダム色の太さ1pxライン
    - 端点: 小さな円でマーク
    - 孤立点（長さ1）: 黒点

    Output: {stem}_debug_polylines.png (8bit RGB PNG)
    """
    H, W = skeleton.shape
    # 白背景
    canvas = np.full((H, W, 3), 255, dtype=np.uint8)

    rng = np.random.default_rng(42)  # 再現性のある乱数
    total_pixels = 0

    for pl in polylines:
        # ランダム色（明るすぎ・暗すぎを避ける）
        color = tuple(int(c) for c in rng.integers(40, 220, size=3).tolist())

        if len(pl) == 1:
            y, x = pl[0]
            cv2.circle(canvas, (x, y), 2, (0, 0, 0), -1)
            total_pixels += 1
            continue

        # ポリラインを線で描画
        pts = np.array([[x, y] for y, x in pl], dtype=np.int32)
        cv2.polylines(canvas, [pts], isClosed=False, color=color, thickness=1)

        # 端点に小さな円
        sy, sx = pl[0]
        ey, ex = pl[-1]
        cv2.circle(canvas, (sx, sy), 3, color, -1)
        cv2.circle(canvas, (ex, ey), 3, color, -1)
        total_pixels += len(pl)

    input_dir = os.path.dirname(os.path.abspath(input_path))
    stem = os.path.splitext(os.path.basename(input_path))[0]
    out_path = os.path.join(input_dir, stem + "_debug_polylines.png")

    success, buf = cv2.imencode(".png", canvas)
    if success:
        with open(out_path, 'wb') as f:
            f.write(buf.tobytes())
        print(f"[DEBUG] ポリライン可視化: {out_path}  ({len(polylines)} 本, {total_pixels} px)")
    else:
        print("[WARN] デバッグ画像の保存に失敗しました")


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

    save_debug_polylines(polylines, skeleton, input_path)

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
