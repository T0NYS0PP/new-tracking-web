# Unreal Engine → Gaussian Splat → HERO 差し替え手順

UE で作ったシーンを、今のサイトがそのまま読める `.spz` にするまでの流れです。
UE 側のスクリプトは `tools/unreal/ue_export_splat_dataset.py`、検証は `scripts/check-dataset.mjs`。

> 注意: UE スクリプトは Unreal が無い環境で書いたもので、実機では未検証です。
> まず `DRY_RUN = True` でカメラ配置をログで確認し、次に少数(`YAW_STEPS = 3`, `PITCH_STEPS = 2`)で
> 画像を出して問題なければ本番枚数にしてください。

## 1. UE 側の準備(5 分)

1. Edit → Plugins で **Python Editor Script Plugin** を有効化して再起動。
2. `tools/unreal/ue_export_splat_dataset.py` を任意の場所にコピーし、先頭の `CONFIG` を編集:
   - `PIVOT`: 訪問者が「窓越しに見つめる点」(廊下の奥など)。UE のワールド座標、cm。
   - `BASE_CAMERA`: ニュートラルのカメラ位置。ここから PIVOT までの距離と向きが基準になります。
   - `YAW_RANGE_DEG` / `PITCH_RANGE_DEG`: サイトは左右 ±20°、上下 ±10° まで振るので、少し広めの既定値(32 / 16)のままで可。
   - `WIDTH` / `HEIGHT` / `FOV_DEG`: 1920×1080、水平 60° が既定。
   - `OUTPUT_DIR`: 既定はプロジェクトの `Saved/SplatDataset`。
3. Output Log の Python コンソールで実行:
   ```
   py "C:/path/to/ue_export_splat_dataset.py"
   ```
   引数で上書きもできます(例: `py "...py" DRY_RUN=1 YAW_STEPS=3`)。

出力は `OUTPUT_DIR/images/0000.png …` と `OUTPUT_DIR/transforms.json`(Nerfstudio 形式のカメラ姿勢)。
既定では 13 × 7 × 3 = 273 枚です。

### レンダリング品質の注意
- スクリプトは SceneCapture2D を使い、露出固定・モーションブラー 0・ビネット 0・レンズフレア 0・ブルーム 0・被写界深度なしに設定します。
- Lumen を使っている場合、SceneCapture では品質が落ちることがあります。気になる場合は、同じカメラ配置を Movie Render Queue で描画してください(`transforms.json` は流用できます。画像のファイル名だけ `images/NNNN.png` に揃えます)。
- 動くもの(揺れる植生、パーティクル、Sequencer のアニメ)は止めてから書き出してください。視点ごとに形が違うと学習が破綻します。

## 2. データセットの確認(1 分)

```bash
node scripts/check-dataset.mjs "C:/UEProject/Saved/SplatDataset"
```
画像枚数、`transforms.json` のフレーム数と画角、カメラ位置の広がりを表示し、参照先の画像が無ければ警告します。

## 3. Splat の学習

### A. PostShot(Windows、GUI、推奨)
1. New Project → Import に `images` フォルダをドラッグ(`transforms.json` は不要。PostShot 内でカメラを解きます)。
2. Profile は **Splat MCMC** か **Splat ADC**。Max Splat Count は 100 万〜150 万。
3. 学習は 30k ステップ前後。終わったら Export → **PLY (3DGS)**。

### B. Nerfstudio(コマンドライン、カメラ姿勢をそのまま使える)
```bash
ns-train splatfacto --data "C:/UEProject/Saved/SplatDataset" \
  --pipeline.model.cull-alpha-thresh 0.005 \
  nerfstudio-data --orientation-method none --center-method none --auto-scale-poses False
ns-export gaussian-splat --load-config outputs/.../config.yml --output-dir exports/splat
```
`transforms.json` を読むので COLMAP は不要です。姿勢を正規化しない指定にしておくと、UE の座標系(m 単位、Z 上)のまま出力されます。

## 4. 仕上げと変換(SuperSplat)

1. https://superspl.at/editor で `.ply` を開く。
2. 学習の残りカス(フローター)を選択して削除し、窓から見えない領域はトリミング。
3. シーンの向きを合わせる: 窓の正面方向が **−Z**、上が **+Y** になるよう回転(PlayCanvas 系は Y 上)。
4. Export → **SPZ**(または SOG)。目安は 150 万 splat 以下、20MB 以下。

## 5. サイトへ差し替え

1. `public/splats/hero.spz` を書き出したファイルで上書き(スマホ・Artifact 用の軽量版は `node scripts/spz-lite.mjs public/splats/hero.spz public/splats/hero-lite.spz --sh 1`)。
2. `src/config.ts` の `splat.position / rotation / scale` を調整。UE の 1m = Nerfstudio 出力の 1 単位なので、`BASE_CAMERA`→`PIVOT` の距離(例 3.5m)がサイトの `camera.baseDistance`(2.6)に近づくよう `scale` を決めます(例: 2.6 / 3.5 ≈ 0.75)。
3. `npm run dev` で確認。`?debug` を付けると視点の数値が見えます。
4. プッシュすると GitHub Pages に自動デプロイされます。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| 画像が真っ黒 / 真っ白 | `EXPOSURE_BIAS` を ±2 の範囲で調整。Lumen の場合は MRQ で描画 |
| 学習結果が霧のように濁る | 視点の重なりが少ない。`YAW_STEPS` / `PITCH_STEPS` を増やすか `JITTER_CM` を上げる |
| 端で破綻する | `YAW_RANGE_DEG` / `PITCH_RANGE_DEG` を広げる、または `camera.maxYaw / maxPitch` を下げる |
| 上下が逆 | `config.splat.rotation` に `[Math.PI, 0, 0]` |
| 左右の視差が逆 | SuperSplat で Y 軸回転 180°、または `tracking.mirror` を反転 |
