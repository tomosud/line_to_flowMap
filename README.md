# line_to_flowMap

線画画像からフローマップ（16bit RGB PNG）を生成する Web アプリです。

## Web アプリ

### GitHub Pages

https://tomosud.github.io/line_to_flowMap/docs/index.html

### ローカルで起動

```bash
cd webapp
npm install
npm run dev
```

表示された Vite のローカル URL をブラウザで開きます。

### ビルド

```bash
cd webapp
npm install
npm run build
```

ビルド結果は `docs/` に出力されます。GitHub Pages の公開 path は次のままです。

```text
https://tomosud.github.io/line_to_flowMap/docs/index.html
```

## URL で設定共有

パラメータ変更は URL に反映されます。URL を共有すると同じ設定で開けます。

```text
docs/index.html?sigma=60&smooth=2.5&blue=0.25&baseDir=0%2C1&morph=7
```

## パラメータ

| URLキー | UI表示 | 範囲 / 値 | 既定値 | 説明 |
|---|---|---|---|---|
| `sigma` | 影響半径 σ (Sigma) | `1` - `100` | `20` | 線の向きが周囲へ影響する距離です。大きいほど線から離れた場所まで方向が広く伝わります。 |
| `smooth` | 平滑化 σ (Smooth) | `0.0` - `5.0` | `1.0` | 生成したベクトル場をならす強さです。大きいほど急な向きの変化が減り、滑らかな結果になります。 |
| `blue` | Bチャンネル値 | `0.0` - `1.0` | `0.5` | 出力 PNG の B チャンネルに入れる固定値です。ツール側の仕様に合わせて調整します。 |
| `baseDir` | ベース方向 | `1,0`, `1,1`, `0,1`, `-1,1`, `-1,0`, `0,-1` | `1,1` | 向きが曖昧な線で基準にする全体方向です。線の始点・終点の向きが逆転する場合に調整します。 |
| `morph` | モルフォロジー Close | `1`, `3`, `5`, `7` | `3` | 線の小さな切れ目を埋める前処理です。値を大きくすると切れた線をつなぎやすくなりますが、細部もつながりやすくなります。 |

## GitHub Actions

`main` ブランチの `webapp/**` 変更時に `webapp` をビルドし、生成された `docs/` をコミットして GitHub Pages にデプロイします。
