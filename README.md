# line_to_flowMap

線画画像からフローマップ（16bit RGB PNG）を生成するツール。

---

## Web 版（ブラウザで動作・インストール不要）

### GitHub Pages で使う

https://tomosud.github.io/line_to_flowMap/docs/index.html

### ローカルで使う

```
local_server.bat
```

ダブルクリックで `http://localhost:8099` が開く（Python が必要）。

### 再ビルド

ソース (`webapp/`) を変更した場合:

```
cd webapp
npm install
npm run build
```

`docs/` フォルダが更新される。

---
# Python版
## 概要

白背景に黒線の線画を入力として、線の方向に沿ったフローマップを出力する。

- スケルトン化した線分の接線方向をベクトル場として算出
- 画像全体にベースベクトル場（左上起点・右下方向）を設定し、線分方向がその上に重畳する
- 出力は 16bit RGB PNG（R=水平方向、G=垂直方向、B=固定値 0.5）

## セットアップ

`setup.bat` を実行して Python 仮想環境を構築する。

```
setup.bat
```

## 使い方

線画ファイルを `run.bat` にドラッグ&ドロップする。

```
run.bat  ← ここに画像をドロップ
```

- 複数ファイルの同時ドロップに対応
- 入力と同じフォルダに `{元のファイル名}_flow.png` を出力

## 出力仕様

| チャンネル | 内容 | 値域 |
|---|---|---|
| R | 水平方向ベクトル (Tx) | `0.5 + 0.5 * Tx` |
| G | 垂直方向ベクトル (Ty) | `0.5 + 0.5 * Ty` |
| B | 固定値 | 0.5 |

ビット深度: 16bit / チャンネル

## チューニング

`line_to_flowmap.py` 冒頭の定数で調整できる。

| 定数 | デフォルト | 説明 |
|---|---|---|
| `MORPH_CLOSE_KERNEL_SIZE` | 3 | 線の途切れ補修カーネルサイズ（px）。大きいほど太い隙間を補修 |
| `SIGMA` | 20.0 | スケルトン方向の影響半径（px）。大きいほど広い範囲に伝播 |
| `SMOOTH_SIGMA` | 1.0 | 最終ベクトル場のスムージング強度（0=無効） |
| `BLUE_VALUE` | 0.5 | Bチャンネルの固定値 |
| `BASE_VECTOR_X` | 1.0 | ベースベクトルの水平成分 |
| `BASE_VECTOR_Y` | 1.0 | ベースベクトルの垂直成分（正=下方向） |

## 必要環境

- Python 3.x
- opencv-python
- scikit-image
- numpy
- scipy
- Pillow
