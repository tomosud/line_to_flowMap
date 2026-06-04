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

## GitHub Actions

`main` ブランチの `webapp/**` 変更時に `webapp` をビルドし、生成された `docs/` をコミットします。
