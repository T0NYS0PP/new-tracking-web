# HEROセクション 技術要件書 — 頭部トラッキング × Gaussian Splatting

参考: Instagram リール (_fojciko) 「POV: when a website starts feeling a little too real」
作成日: 2026-10-10 / 対象: HEROセクションのみ(第1フェーズ)

---

## 1. 再現する体験(ゴール)

リールで起きていることを分解すると、次の4要素で構成されています。

| # | 要素 | 内容 |
|---|------|------|
| 1 | 背景 | 全画面の 3D Gaussian Splat シーン(廃墟の廊下。手前〜奥に強い奥行きがある) |
| 2 | 頭部トラッキング | Webカメラで顔位置を検出し、頭の移動に合わせて視点が動く。画面が「窓」になる効果(head-coupled perspective / off-axis projection) |
| 3 | タイポグラフィ | 画面下部に巨大な見出し(例: "BORING")、右下に短い説明文と CTA リンク |
| 4 | 演出 | ロード後に文字がフェードイン、視点はわずかに遅延して滑らかに追従 |

「本物っぽく感じる」のは、単なるマウスパララックスではなく、頭の位置に応じて **カメラ位置と投影行列(非対称フラスタム)** の両方を更新しているためです。これを正しく実装することが最重要要件です。

## 1b. 参考動画(画面録画 9.5 秒)からの観察

| 観察 | 要件への反映 |
|------|------|
| 撮影者が左右に動くと、廊下の見え方が **左の壁寄り → 正面 → 右の窓寄り** まで大きく変わる(体感で ±20〜30° 相当)。物理的に正確な「窓」よりも振れ幅が誇張されている | 視点は「非対称フラスタム(off-axis)」+「シーン内の注視点を中心としたオービット回転」の **合成** にし、振幅係数を設定値で調整できるようにする(§6) |
| 追従は滑らかで、小刻みなブレがない。頭が止まると視点もすぐ静止する | One Euro Filter の採用、デッドゾーン(§5) |
| 見出し "BORING"(左下)、本文 + CTA "Book Your Charter →"(右下)、ロゴ "BORING"(左上)、ナビ(右上)は **視点が動いても画面に固定** | テキストは Canvas に描かず DOM オーバーレイ(§9) |
| 本文は「Literally the most boring website you gonna see. Nothing to buy, nothing to book... Move your head and the screen pretends to be a window...」というセルフパロディ | コピーは別途決定(§14) |
| ブラウザのタブに緑のカメラ使用中ドットが点灯しており、ページ表示中は常時トラッキング | 常時 ON を想定しつつ、権限要求のタイミングは要確認(§14) |
| シーンは廃墟の地下通路。手前に太いパイプ・右に窓、奥に消失点。緑の塗装と汚れが視差を強調 | 素材の構図要件(§7) |

## 2. スコープ

**今回やること**
- HEROセクション 1 画面(100svh、フルブリード)
- Webカメラ頭部トラッキング + 視点連動
- カメラ非許可・非対応時のフォールバック(マウス追従 / スマホのジャイロ)
- ローディング表示、ポスター画像フォールバック
- デスクトップ Chrome / Edge / Safari を主要ターゲット、スマホは縮小版で動作

**今回やらないこと**
- HERO 以外のセクション、ナビゲーション以外の UI
- Splat の撮影・学習パイプライン自体(素材は別途用意 → 変換のみ本要件で扱う)
- CMS、多言語、解析タグ

## 3. 技術スタック(推奨)

| 領域 | 採用 | バージョン(2026-10 時点の最新) | 理由 |
|------|------|------|------|
| ビルド | Vite + TypeScript (vanilla) | Vite 8.3 | HERO 単体の検証に最速。後から Next.js / React にそのまま移植可能 |
| 3D | three.js | 0.186 | Spark の peerDependency が `three >= 0.180` |
| Splat 描画 | `@sparkjsdev/spark` (World Labs, MIT) | 2.3.1 | WebGL2 ベースで対応端末 98%+、.spz / .sog / .ply / .ksplat / .splat 対応、three.js のメッシュと混在可能、LoD ストリーミング対応 |
| 顔検出 | `@mediapipe/tasks-vision` FaceLandmarker | 1.1.0 | ブラウザ内 WASM/GPU 推論。468 点ランドマーク + 4x4 頭部姿勢行列を出力。全てオンデバイス |
| 平滑化 | One Euro Filter(自前実装、約 40 行) | — | 低遅延かつジッター抑制。head-tracking の定番 |
| テキスト演出 | CSS transition / GSAP(任意) | — | 文字のフェード・スライドのみなので CSS で十分 |
| ホスティング | Vercel / Cloudflare Pages / Netlify(静的) | — | HTTPS 必須(getUserMedia は secure context のみ) |

代替案と不採用理由:
- **three.js 標準の Splat レンダラ(WebGPU)**: WebGPU 必須で Safari / 古い端末が落ちる。HERO には WebGL2 の Spark が安全。
- **gsplat.js / GaussianSplats3D(mkkellogg)**: 動作するが、Spark の方が圧縮フォーマット・LoD・保守状況で優位。
- **PlayCanvas Engine**: 単体では良いが three.js 資産・将来のサイト全体との親和性で three.js を選択。

## 4. アーキテクチャ

```
src/
  main.ts                 … エントリ。状態機械を起動
  hero/HeroScene.ts       … three.js Scene / SparkRenderer / SplatMesh / resize / DPR 管理
  camera/ViewerCamera.ts  … 頭位置 {x,y,z} → カメラ位置 + 非対称フラスタム(off-axis)を毎フレーム更新
  tracking/HeadTracker.ts … getUserMedia + FaceLandmarker(VIDEO mode)→ 正規化した頭位置を発行
  tracking/OneEuroFilter.ts
  input/PointerInput.ts   … マウス / タッチのフォールバック入力(同じ {x,y,z} インターフェース)
  input/OrientationInput.ts … DeviceOrientation フォールバック(iOS は許可 API が必要)
  ui/HeroOverlay.ts       … 見出し・説明文・CTA・権限ボタン・ローディング・プライバシー表示
  styles/hero.css
public/
  splats/hero.spz         … 本番 Splat(デスクトップ用)
  splats/hero-mobile.spz  … 縮小版(スマホ用)
  mediapipe/wasm/*        … tasks-vision の WASM 一式(セルフホスト)
  mediapipe/face_landmarker.task … モデル(float16, 約 3.6MB、セルフホスト)
  poster.jpg              … ロード中 / 非対応時のポスター画像
```

**入力ソースの抽象化**: `HeadTracker` / `PointerInput` / `OrientationInput` は全て `{ x, y, z, confidence }`(x,y ∈ [-1,1]、z は相対距離)を返す同一インターフェースにし、`ViewerCamera` は入力元を意識しない。

**状態遷移**
```
boot → loading-splat → ready(pointer入力で動作中)
     → requesting-camera → tracking            (許可)
                         → ready(pointer のまま) (拒否 / 非対応)
tracking → lost-face(0.5s 以上検出なし)→ 1s かけて中央へ復帰
```

## 5. 頭部トラッキング仕様

| 項目 | 仕様 |
|------|------|
| カメラ取得 | デスクトップは 1280×720、スマホは 640×480 を要求(`getUserMedia`、facingMode user、30fps)。`<video>` は非表示(`display:none` ではなく画面外配置、iOS は `playsinline` 必須) |
| 推論設定 | `FaceLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath, delegate: 'GPU' }, runningMode: 'VIDEO', numFaces: 1, outputFacialTransformationMatrixes: true })`。GPU 不可時は CPU delegate に自動フォールバック |
| 推論ループ | render loop とは分離し 30fps 上限。`requestVideoFrameCallback` があれば使用。`detectForVideo(video, timestamp)` |
| 位置推定(v2) | 既定は `facialTransformationMatrixes` の平行移動成分(顔全体のフィット、cm 単位)で頭の位置をメートル系で推定。代替として眼角 4 点の中点 + 虹彩径(約 11.7mm、個人差が小さい)によるピンホール推定(`method: 'landmarks'`、水平画角を仮定)。視線移動の影響を受けず、距離が変わっても横移動の感度が一定になる |
| ニュートラル較正 | 追跡開始時の 20 フレームの中央値をニュートラル姿勢とし、以降は相対位置を `lateralRangeCm` / `verticalRangeCm`(±22 / ±14cm)で [-1,1] に正規化。R キー / Recenter ボタンで再較正。5 秒以上ロスト後の再検出時は自動再較正 |
| 外れ値除去 | 連続フレーム間で 40cm を超える推定の飛びは棄却 |
| 遅延補償 | 描画側でフィルタ済み姿勢を速度外挿(既定 70ms)し、カメラ + 推論の遅延を隠す。頭部入力時は描画側の平滑化を弱める(二重平滑化の回避) |
| 平滑化 | One Euro Filter(正規化単位で minCutoff ≈ 1.0, beta ≈ 0.4, dCutoff ≈ 1.0、奥行きはやや強め)。デッドゾーン ±0.01 |
| クランプ | x,y を ±1、z を [0.6, 1.6] に制限。振幅が大きすぎると酔うため、カメラ移動量は最大 ±0.35 ワールド単位程度に抑える |
| ロスト処理 | 顔未検出が 500ms 続いたら中央へイージング復帰。再検出時はジャンプせずフィルタで追従 |
| 省電力 | `visibilitychange` で非表示時は停止、HERO が `IntersectionObserver` で画面外になったら推論を停止 |

## 6. 視点(カメラ)仕様 — 「窓」効果の核心

1. 画面を仮想世界の「窓」とみなし、窓の物理サイズ(幅 W、高さ H、ワールド単位)を定義する。
2. 頭位置 `(hx, hy, hz)` をワールド座標のカメラ位置 `eye = (hx * kx, hy * ky, d0 * hz)` に変換(`kx`, `ky` は振幅係数、`d0` は基準距離)。
3. 投影は **非対称フラスタム** を毎フレーム作る:
   ```
   left   = (-W/2 - eye.x) * near / eye.z
   right  = ( W/2 - eye.x) * near / eye.z
   bottom = (-H/2 - eye.y) * near / eye.z
   top    = ( H/2 - eye.y) * near / eye.z
   camera.projectionMatrix.makePerspective(left, right, top, bottom, near, far)
   ```
   `camera.position` を `eye` に置き、向きは窓面に対して常に正対(回転させない)。これが「見下ろす/覗き込む」感を生む。
4. 参考動画は物理的な窓効果より振れ幅が大きいため、off-axis に加えて **注視点オービット** を合成する: 注視点 `pivot`(廊下の奥、カメラ前方 3〜5 単位)を中心に、頭位置に応じて `yaw = hx * maxYaw`(maxYaw ≈ 20°)、`pitch = hy * maxPitch`(≈ 10°)だけカメラを回転させ、その後 off-axis 補正をかける。`maxYaw` / `maxPitch` / `kx` / `ky` は設定ファイルで調整可能にし、動画と同等の体感に合わせ込む。
5. 簡易版(`camera.lookAt(target)` のみ)は最初の検証には使えるが、最終的には上記の合成方式を採用する。
6. `prefers-reduced-motion: reduce` の場合は視点固定。

## 7. Gaussian Splat アセット要件

| 項目 | 要件 |
|------|------|
| シーン | リール同様、手前の物体と奥の消失点がある屋内(廊下・部屋・トンネル)。視差が出やすい構図 |
| 取得方法 | (a) 自前撮影: iPhone 動画 → Luma AI / Polycam / Scaniverse / PostShot / Nerfstudio で学習 → .ply 出力。(b) 既製: 購入 or CC ライセンスの .ply / .spz |
| 編集・変換 | PlayCanvas **SuperSplat**(ブラウザ)でフローター除去、原点・向き・スケール調整、不要領域のクロップ → `.sog` または `.spz` で書き出し |
| 容量目標 | デスクトップ版 ≤ 20MB / ≤ 150 万 splat。スマホ版 ≤ 8MB / ≤ 50 万 splat |
| 配置 | 同一オリジン(`public/splats/`)か CORS 許可済み CDN。長期キャッシュ + `<link rel="preload">` |
| ロード演出 | Spark のロード進捗を取得してプログレス表示。完了までポスター画像(ぼかし)を表示し、完了時にクロスフェード |
| 開発用 | 本番素材が届くまでは Spark の手続き的 Splat 生成(`constructSplats`)またはサンプル .spz で代用可 |

## 8. パフォーマンス要件

| 指標 | 目標 |
|------|------|
| フレームレート | デスクトップ 60fps、スマホ 30fps 以上 |
| devicePixelRatio | 上限 1.5(高性能デスクトップのみ 2.0) |
| 初期 JS | gzip 後 ≤ 600KB(three ≈ 170KB + Spark + アプリ)。MediaPipe の WASM とモデル(約 4〜5MB)はカメラ許可後に遅延ロード |
| LCP | ポスター画像で 2.5s 以内。Splat は LCP 対象外にする |
| 推論負荷 | 顔検出は 30fps 上限、描画と分離。GPU delegate 不可時は CPU で 15fps に落とす |
| メモリ(iOS) | Splat 数を抑えた mobile アセットを `matchMedia` / UA で出し分け |

## 9. UI / UX 要件

- レイアウト: 100svh のフルブリード。見出しは左下に viewport 幅連動の巨大文字(`clamp(4rem, 14vw, 18rem)`)、説明文 + CTA は右下。上部に最小限のナビ。
- 可読性: Splat 上に下方向グラデーション(黒 0→60%)を敷き、テキストのコントラスト比 4.5:1 以上を確保。
- カメラ権限: ページロード直後に勝手にダイアログを出さない。右下に「頭の動きで覗く(カメラを使用)」のトグルボタンを置き、クリックで要求。許可前はマウス追従で動作。許可済みは `localStorage` で記憶し次回は自動開始。
- プライバシー表示: 「映像は端末内で処理され送信・保存されません」を常時小さく表示。トラッキング中はインジケータ点灯。いつでも OFF 可能。
- 文字演出: Splat ロード完了後に見出し → 説明文 → CTA の順に 80ms ずつ遅延してフェード + 上方向スライド。
- アクセシビリティ: テキストは DOM に置く(Canvas に描かない)。CTA はフォーカス可能、状態変化は `aria-live="polite"` で通知。`prefers-reduced-motion` で全てのモーション停止。

## 10. 対応環境とフォールバック

| 環境 | 挙動 |
|------|------|
| Chrome / Edge 120+、Safari 17+(macOS) | フル機能 |
| Firefox 最新 | MediaPipe GPU delegate が不安定な報告あり → CPU delegate にフォールバック、要実機確認 |
| iOS Safari 17+ | 動作可(HTTPS 必須、`playsinline`)。メモリ制約のため mobile 版 Splat。ジャイロは `DeviceOrientationEvent.requestPermission()` が必要 |
| Android Chrome | 動作可。mobile 版 Splat |
| WebGL2 なし | ポスター画像 + テキストのみ |
| カメラ拒否 / 非搭載 | マウス(PC)・ジャイロ(スマホ)によるパララックス |

## 11. セキュリティ / プライバシー

- HTTPS 必須。`Permissions-Policy: camera=(self)`。
- MediaPipe の WASM とモデルは **セルフホスト**(`public/mediapipe/`)し、CSP で外部ドメインを増やさない。`npm postinstall` または手動で `node_modules/@mediapipe/tasks-vision/wasm` をコピー。
- 映像フレームは一切送信・保存しない。推論は Web Worker 化を検討(メインスレッド負荷軽減)。
- 依存ライセンス: three.js / Spark / MediaPipe いずれも MIT または Apache-2.0。Splat 素材のライセンスは別途確認。

## 12. 実装マイルストーン

| 段階 | 内容 | 完了条件 |
|------|------|------|
| M1 | Vite + TS 雛形、three + Spark 導入、開発用 Splat 表示、HERO のタイポグラフィ・レイアウト | 全画面で Splat とテキストが表示される |
| M2 | `ViewerCamera`(off-axis 投影)+ マウス追従 + One Euro 平滑化 | マウスで覗き込み効果が成立 |
| M3 | `HeadTracker`(MediaPipe)+ 権限 UI + 入力ソース切替 + ロスト処理 | 頭の動きで視点が追従、拒否時はマウスへ |
| M4 | フォールバック(ジャイロ / reduced-motion / WebGL2 なし)、ローディング・ポスター、可視性制御、DPR 制御 | 各環境で破綻しない |
| M5 | 本番 Splat の変換・最適化、スマホ版出し分け、デプロイ、実機テスト | 性能目標を満たす |

## 13. 受け入れ基準

1. 頭を左右に 20cm 動かすと、手前の物体と奥の壁の視差が逆方向に動く(窓効果)。
2. 顔が画面から外れても視点がジャンプせず、1 秒以内に中央へ戻る。
3. カメラ拒否時もマウスで同等の操作感が得られる。
4. MacBook(内蔵 GPU)で 60fps、iPhone 15 相当で 30fps を維持する。
5. 外部へのネットワーク送信が静的アセット取得以外に存在しない(DevTools で確認)。
6. `prefers-reduced-motion` 有効時に視点が固定される。

## 14. 未確定事項(ご確認ください)

1. **Splat 素材**: お手元に .ply / .spz はありますか?なければ (a) 自前撮影、(b) 開発中はサンプル素材で進める、のどちらにしますか。
2. **カメラ権限のタイミング**: 推奨は「ボタンで開始」ですが、リール同様に初回から自動起動を希望しますか。
3. **フレームワーク**: HERO 単体は Vite(vanilla TS)で進め、サイト全体が決まった段階で Next.js 等へ移植する想定で問題ないですか。
4. **コピー**: 見出し("BORING" 相当)、説明文、CTA の文言とリンク先。
5. **スマホ対応レベル**: 縮小版で動かす(推奨)/ ポスターのみ、のどちらにしますか。

## 15. 開発環境メモ

- このクラウド環境では npm レジストリと `storage.googleapis.com`(MediaPipe モデル)へは到達できますが、`sparkjs.dev` と `cdn.jsdelivr.net` はブロックされています。そのため CDN import map ではなく **npm インストール + セルフホスト**で構成します。
- 開発用 Splat をリモートから取得できないため、M1 では手続き的生成またはリポジトリに同梱した小さな .spz を使います。

## 16. 決定事項と実装状況(2026-10-10)

| 項目 | 決定 |
|------|------|
| カメラ権限 | ボタン開始(自動プロンプトなし)。一度許可した訪問者は次回、最初のクリック/キー操作で自動再開 |
| フレームワーク | Vite 8 + vanilla TypeScript |
| コピー | 仮置き: 見出し "BORING"、本文はセルフパロディ調、CTA "Book a tour anyway →" |
| 開発用 Splat | Niantic の `spz` リポジトリのサンプル(hornedlizard.spz, 18MB)を `npm run assets` で取得。コミットはしない |
| MediaPipe | WASM は `postinstall` で `public/mediapipe/wasm` にセルフホスト。モデルは `npm run assets` で取得(未取得時は Google の配信 URL にフォールバック) |

実装済み(M1〜M4 相当): Spark 描画、off-axis + オービット合成カメラ、One Euro 平滑化、MediaPipe 頭部トラッキング(遅延読み込み)、マウス / ジャイロ / reduced-motion / WebGL2 なしのフォールバック、ローディングとポスター、可視性による停止、DPR 上限。

**要件からの乖離(既知)**: 初期 JS は gzip 後およそ 1.0MB。内訳の大半は Spark 本体(Rust 製 WASM とワーカーを同梱)で、three.js とアプリ本体は 200KB 程度。§8 の 600KB 目標は Spark 採用時点で達成不能のため、実測値を基準に見直す。

未着手(M5): 本番 Splat の差し替えと配置調整、スマホ用縮小アセットの出し分け、実機での性能計測、デプロイ。

## 17. 第2デモ: 絵画の中へ(2026-10-11)

参考リール「What if you could step inside a painting?」の再現。1 枚の絵画を Gaussian Splat 化し、頭部トラッキングの窓効果に「歩き込み」を加えた `painting.html`。

| 工程 | 実装 |
|------|------|
| 深度推定 | Depth Anything V2 Small(ONNX、CPU で約 0.3 秒/枚)。`scripts/painting-to-splat.mjs` |
| 3D 化 | 画素ごとに深度へ逆投影し、画素フットプリント比例の薄い Gaussian を配置(約 65 万 splat)。輪郭のランプ画素は勾配閾値で除去し、後方にぼかした背景層を鏡像拡張して配置(欠損と黒縁を隠す) |
| 出力 | 自前の SPZ v2 エンコーダ(24bit 固定小数点位置、log スケール、SH0 色)。1 枚あたり 3〜6MB |
| 視点 | 窓効果(off-axis)はそのまま。シーン全体を視聴者側へスライドする「dolly」で歩き込みを表現(カメラは窓の前に留めるので投影が破綻しない)。ホイール / ↑↓ で深さを操作、Space で一時停止 |
| UI | 見出しと作家名、元絵のピクチャ・イン・ピクチャ、作品切替チップ(星月夜 / ターナー「難破船」/ 北斎「神奈川沖浪裏」/ ムンク「叫び」。いずれもパブリックドメイン) |

参考リール(World Labs Marble 等の生成系ワールドモデルによるもの)との差: 本実装は単眼深度による 2.5D レリーフなので、物体の背後に回り込む視点には対応しない。歩き込み量と視差を抑えて破綻を見せない設計にしている。本物の歩行体験が必要なら、生成系サービスで `.spz` を作って同じページに差し替える。

### 17b. 光の表現(2026-10-11)

参考リールの「日差し」の質感を、次の 5 要素で再現した。

| 要素 | 実装 |
|------|------|
| 光の筋(ゴッドレイ) | スクリーン空間の放射状ブラー。絵ごとに光源位置を画像座標で指定し、毎フレーム遠景面上の光源をカメラへ投影して UV を更新。暗い前景(糸杉など)が自然に筋を遮る。わずかに揺らめく |
| にじみ(ブルーム) | three.js UnrealBloomPass(強さ 0.22、閾値 0.82)。星や月だけがにじむ程度に抑制 |
| 空気感 | 変換時に遠景の splat を絵自身の遠景平均色(白寄り)へ 12〜22% 混ぜて焼き込み(aerial perspective)。描画側でも影を僅かに持ち上げる |
| 光の粒子 | 加算合成のポイントスプライト 320 個を視聴者と絵の間の空間に配置し、ゆっくり漂って明滅 |
| グレーディング | 露出・コントラスト・暖色/寒色・ビネット・微粒子。絵ごとに暖色度とかすみ色を指定(星月夜は寒色、ターナーと叫びは暖色) |

全体は EffectComposer 経由で描画し、Spark の splat 描画をレンダーターゲットに受けてから合成する。UI の「Light」ボタンで ON/OFF でき、設定は端末ごとに記憶。`prefers-reduced-motion` 時は粒子を止める。
