# Speed Cube Tracker

GAN スマートキューブ（**GAN i4 / i3 系**など）の **操作（モーション）と回転（姿勢）** を、タイムスタンプ付きで記録するブラウザ専用ツールです。
出力は時系列のテキストなので、そのまま **Gemini や Claude などの LLM に貼り付けて** 解析・評価してもらう用途を想定しています（API 連携はありません）。

- **ブラウザだけで完結** — 外部サーバー・CDN・API を一切使いません。依存ライブラリは `vendor/` に同梱しています。
- **接続は Bluetooth**（Web Bluetooth API）。
- 入力操作は **接続 / 切断 / ログクリア**。出力は **ログ表示 / ダウンロード / コピー**。

## 対応環境

| OS | ブラウザ | 対応 |
|----|----------|------|
| Android | Chrome | ✅ |
| Windows | Chrome / Edge | ✅ |
| macOS | Chrome / Edge | ✅（参考） |
| iOS | Safari / Chrome | ❌（Web Bluetooth 非対応） |

> Web Bluetooth は **HTTPS（または localhost）** でのみ動作します。GitHub Pages で公開すればこの条件を満たします。`file://` で直接開くと Bluetooth は使えません。

## 使い方

1. ページを HTTPS で開く（GitHub Pages など）。
2. キューブを少し回して起こしておく。
3. **接続** を押し、デバイス選択ダイアログでキューブを選ぶ。
4. キューブを操作すると、ログに時系列で記録されていく。
5. **コピー** または **ダウンロード** してログを取得し、LLM に貼り付ける。

### MAC アドレスについて

GAN キューブの通信は MAC アドレスに基づく暗号化を使います。多くの端末では広告パケットから自動取得しますが、取得できない場合は入力ダイアログが表示されます。

- Android の **Cube Station** アプリの端末情報、または **nRF Connect** などで確認できます。
- 一度入力すると端末名ごとにブラウザへ保存され、次回以降は自動で使われます。
- 保存した値は画面下部の「保存した MAC アドレスを消去」でクリアできます。

## 出力フォーマット

各行は次の形式です（先頭に `#` のヘッダー行が付きます）。

```
<接続からの秒>  <時刻>  <種別>  <詳細>
```

| 種別 | 意味 | 詳細の例 |
|------|------|----------|
| `MOVE` | 面回転の操作 | `R   serial=12 cubeT=1800ms` |
| `ROT` | キューブ全体の姿勢 | `q=(x, y, z, w) euler=(roll, pitch, yaw)deg w=0.66rad/s` |
| `FACELETS` | キューブの面の状態（Kociemba 表記 54 文字） | `UUUUUUUUURRR...` |
| `BATTERY` | 電池残量 | `87%` |
| `HARDWARE` | 機器情報 | `name=GAN i3 sw=... gyro=yes` |
| `MISSED` | BLE レベルで取りこぼした手 | `2手を取りこぼし（serial 3 → 6）` |
| `MISMATCH` | 記録手順と実機状態の不一致 | `記録手順と実機が不一致（4ステッカー差）` |

- 時刻はローカル時刻。`ROT` のクォータニオンは `(x, y, z, w)`、オイラー角の面順は `U, R, F, D, L, B`。
- `MISSED` / `MISMATCH` は記録の信頼性を示す補助情報です。LLM に渡すと「取りこぼしの可能性がある」ことを前提に解析してもらえます。

### 記録オプション

- **回転（ジャイロ）を記録** … 姿勢ログの ON/OFF。
- **記録間隔 (ms)** … 回転ログの間引き間隔（`0` で全サンプル記録）。既定 250ms。
- **キューブ状態（FACELETS）を記録**。
- **整合チェック** … 記録した手順をシミュレートし、キューブが報告する実際の状態と照合して取りこぼし/誤記録を検出。
- **自動スクロール** / **画面を常にオンにする**（Wake Lock）。

## GitHub Pages で公開する

このリポジトリはそのまま静的サイトとして公開できます。

1. GitHub の **Settings → Pages** を開く。
2. **Build and deployment** の Source を **Deploy from a branch** にする。
3. Branch を公開したいブランチ（例: `main`）／フォルダ `/ (root)` に設定して保存。
4. 数十秒後に `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開されます。

> `.nojekyll` を含めているため、Jekyll による加工なしでそのまま配信されます。

## ディレクトリ構成

```
index.html        … 画面
style.css         … スタイル
app.js            … アプリ本体（ES Module）
vendor/           … 同梱ライブラリ（外部アクセス不要）
  gan-web-bluetooth.js   GANキューブ通信（v3.0.2）
  rxjs.js / aes-js.js / tslib.js  依存
.nojekyll
```

開発用に `index.html?debug=1` を開くと、キューブなしで擬似イベントを流せるデバッグフック（`window.__sct`）が有効になります（通常動作には影響しません）。

## クレジット・ライセンス

キューブ通信には [`gan-web-bluetooth`](https://github.com/afedotov/gan-web-bluetooth)（Andy Fedotov 作 / MIT License）を使用しています。同梱ライブラリの詳細は [`vendor/CREDITS.md`](./vendor/CREDITS.md) を参照してください。
