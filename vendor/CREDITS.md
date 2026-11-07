# 同梱ライブラリ（vendor）

このフォルダのファイルは、実行時に外部 CDN へアクセスせずブラウザだけで動作させるために同梱しているサードパーティ製ライブラリです。
jsDelivr の `/+esm` ビルドを取得し、相互の import をローカル相対パスへ書き換えたものです（コードの内容は改変していません）。

| ファイル | パッケージ | バージョン | ライセンス | 入手元 |
|----------|-----------|-----------|-----------|--------|
| `gan-web-bluetooth.js` | gan-web-bluetooth | 3.0.2 | MIT | https://github.com/afedotov/gan-web-bluetooth |
| `rxjs.js` | rxjs | 7.8.1 | Apache-2.0 | https://github.com/ReactiveX/rxjs |
| `aes-js.js` | aes-js | 3.1.2 | MIT | https://github.com/ricmoo/aes-js |
| `tslib.js` | tslib | 2.5.0 | 0BSD | https://github.com/microsoft/tslib |

各ライブラリの著作権・ライセンスは、それぞれの配布元に帰属します。
