# Pose estimator replacement survey — 2026-11-01

**Evaluate MediaPipe Full first, RTMPose-s + a small detector second, and MoveNet MultiPose / RTMO-s as competing whole-frame multi-person pipelines.** Keep Lite as the shipping baseline. This is a feasibility shortlist, not a decision based on trackbench accuracy: the shared `_sample-*` scenes and their READY/GT files had not appeared when the initial measurements below were made.

Full preserves the current 33-joint/depth contract and requires the fewest product changes. It may improve raised-arm landmarks, but it shares the detector family and is not a demonstrated cure for crowded-frame misses. RTMPose-s gives an economical per-person crop model; detector amortization matters. MoveNet has a small, well-established browser graph and fewer licensing ambiguities. RTMO is a useful single-stage alternative with good published AP and measured browser execution, but heavier WASM fallback and Body7 dataset questions. **None of these models supplies reliable persistent identity by itself.** Keep the existing appearance/motion tracker and evaluate calibration and score loss independently.

## Survey

AP values below are **published results**, not our measurements. COCO body AP, WholeBody AP, and Google's single-person Dance mAP are different metrics/datasets. Top-down results can include better detector boxes and flip testing; our runners do not use flip augmentation. MB means decimal file bytes where measured; parameter counts are not download size. A dash means no verified comparable result, not zero.

| Candidate | Code / pretrained weights; dataset issue | Joints / depth | People strategy | Size / published accuracy | Deployment and principal limitations |
|---|---|---|---|---|---|
| MediaPipe Pose Lite / Full / Heavy | Apache-2.0 framework and model-card terms; Google training data not redistributable | 33 incl. heels/toes/hands; relative z plus world landmarks | Detector + tracked crops, configurable maximum people | Measured task bundles 5.78 / 9.40 / 30.66 MB. Legacy Dance mAP 53.6 / 67.4 / 73.0, **not COCO val AP** | Tasks WebGL/WASM; native Tasks on iOS. Small full-frame detector misses crowds; per-person strips multiply memory/inference. Lite raised-arm failure is observed game context. [Google quality table](https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/pose.md), [current Tasks guide/model cards](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) |
| TF.js BlazePose GHUM 3D | Apache-2.0 TF.js code; Google published model assets; do not confuse the runtime model with separately licensed GHUM body-model research assets | Same 33 and z | TF.js API is single-person; extra crops needed for multiplayer | Lite/full/heavy; same family as above, not an independent accuracy upgrade | TF.js WebGL or MediaPipe runtime; TF.js WebGPU needs explicit validation. Larger JS/runtime integration without solving the detector weakness. [TF.js pose API](https://github.com/tensorflow/tfjs-models/tree/master/pose-detection) |
| MoveNet Lightning / Thunder | Apache-2.0 code and Google model release; trained using COCO plus Google's Active dataset, not a grant to redistribute training images | COCO-17, no feet/depth | One person; tracking crop optional (not implemented here) | 192² / 256² input; no directly comparable COCO AP verified in official guide | TF.js WebGL, TFLite native; WebGPU backend possible after testing. Whole-frame single-person misses small players; no z. [Google guide](https://www.tensorflow.org/hub/tutorials/movenet), [official model](https://www.kaggle.com/models/google/movenet) |
| MoveNet MultiPose Lightning | Same Google/Apache release family | COCO-17, no feet/depth | One pass, up to six people; optional external tracker | 256 maximum dimension default; this runner uses square 256 padding for Python/JS consistency. TF.js graph+shards measured below | TF.js WebGL measured; TFLite/TF native. Limited detail for small wrists, no toes; 0.2 person threshold distinct from joint .5 gate. [TF.js constants and model URL](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/constants.ts) |
| RTMPose t / s / m + RTMDet-nano | Apache-2.0 code; maintainer says RTMPose weights Apache-2.0, **exact pretrained/dataset clearance unresolved** | Body17; Halpe26 variants add heels/toes; no z | Detector then crop per person; periodic redetection | t/s/m: 3.34/5.47/13.59M parameters; published 68.5/72.2/75.8 COCO AP in model table. RTMDet-nano 0.99M, 320² | ONNX WebGPU/WASM, ncnn/TFLite/CoreML conversion options native. Crop cost scales with dancers; detector AP and box drift matter. Runner uses YOLOX, not RTMDet. [model/pipeline zoo](https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose) |
| RTMPose s/m + YOLOX-tiny | Apache-2.0 MMPose/RTMLib/YOLOX code; Body7 + HumanArt data provenance needs clearance | COCO-17 in downloaded models | Detector at 416² + crop at 256×192; previous-keypoint box propagation | Actual ONNX bytes and timings below, detector included | Python ORT CPU measured. Browser port needs affine BGR crop + SimCC decode + NMS; not measured in this probe. [RTMLib](https://github.com/Tau-J/rtmlib), [YOLOX](https://github.com/Megvii-BaseDetection/YOLOX) |
| RTMO t / s / m (CVPR 2024) | Apache-2.0 code; same Body7 weight/data caveat | COCO-17, no feet/z | One-stage whole frame + NMS | Body7 AP 57.4 / 68.6 / 72.6; t 416², s/m 640². COCO-only s/m: 67.7/70.9 | ORT WebGPU/WASM measured for t/s. Dynamic postprocessing supported by this runtime; some work may fall back to CPU, so call it WebGPU EP rather than all-GPU. Frame cost roughly independent of people; false detections still need filtering. [official RTMO zoo](https://github.com/open-mmlab/mmpose/tree/main/projects/rtmo) |
| RTMW / DWPose | Apache-2.0 code; maintainer's RTM weight statement, but **WholeBody explicitly has research/noncommercial dataset terms**; hold shipment pending clearance | 133 incl. hands, face and six foot joints; 2D models no z | Detector + expensive per-person crops | RTMW-l/x about 70 whole-body AP; DWPose family offers t/s/m/l. Supplied RTMW-x export measured locally is batch 8 | ONNX feasible; CPU too expensive in supplied form. Feet help character placement but face/hand detail mostly unused by scorer. [RTMW paper](https://arxiv.org/abs/2407.08634), [DWPose](https://github.com/IDEA-Research/DWPose), [data terms](https://github.com/jin-s13/COCO-WholeBody#terms-of-use) |
| RTMW3D (2024) | Apache-2.0 code; mixed 3D data incl. research-restricted sources: do not assume weights commercially clear | 133 with predicted depth | Detector + 3D crop model | Large/x family; no apples-to-apples COCO2D AP/phone latency verified here | ONNX conversion possible; promising depth reference, not a lightweight drop-in. Different scale/frame semantics need retarget conversion. [official project](https://github.com/open-mmlab/mmpose/tree/main/projects/rtmpose3d) |
| ViTPose / ViTPose++ small | Apache-2.0 code; exact weight terms require verification; ++ mixed COCO/AIC/MPII/animal/WholeBody training | Typically COCO17; WholeBody head 133; no z | Detector + transformer per crop | ++S COCO AP 75.8, WholeBody AP 54.4 at 256×192; larger memory than RTMPose-s, exact export not downloaded | ORT WebGPU, CoreML conversion; attention/crop scaling on mobile and mixed-data licence make it lower priority. [code licence](https://github.com/ViTAE-Transformer/ViTPose/blob/main/LICENSE), [model zoo](https://github.com/ViTAE-Transformer/ViTPose) |
| YOLO11n/s-pose (2024) | **AGPL-3.0 code and default pretrained release / Enterprise alternative; reference only**. COCO training | COCO17, no feet/z | One-stage + NMS | 2.9/9.9M; COCO AP 50.0/58.9 | ONNX WebGPU/WASM, CoreML export; runnable PyTorch CPU references here. Cannot ship under default licence in this proprietary game. [official table](https://docs.ultralytics.com/models/yolo11/), [licence](https://github.com/ultralytics/ultralytics/blob/main/LICENSE) |
| YOLO26n/s-pose (2026) | **Same AGPL/Enterprise boundary; reference only** | COCO17, no feet/z | End-to-end model, NMS-free export option | 2.9/10.4M fused; COCO AP 57.2/63.0 | ONNX/CoreML; both Python runners tested. Newer and stronger than YOLO11 at n/s; still no open permissive shipping path. [official current pose table](https://docs.ultralytics.com/tasks/pose/) |
| Apple Vision 2D | Proprietary Apple SDK/OS service; no model redistribution, normal native-app framework use; training data undisclosed | 19 named joints including neck/root; 17 match COCO-like slots, no toes/z | Multiple observations | Bundled OS model, size/AP unpublished | Native iOS/macOS only, no browser API. Requires camera/native bridge for WKWebView; can't replace paired-phone Safari path. Small/occluded bodies can be missed. Swift runner works on macOS 27.0.1. [API](https://developer.apple.com/documentation/vision/vndetecthumanbodyposerequest) |
| Apple Vision 3D | Same OS terms | 17-joint 3D skeleton, different face/head semantics; root-relative metres | Most prominent person rather than a 4-person solution | No verified COCO AP; local speed below | Available iOS17/macOS14+. Works on this Mac; no depth sensor required. 3D confidence and z differ from MediaPipe. [Apple WWDC23](https://developer.apple.com/videos/play/wwdc2023/111241/) |
| LitePose / Lite-HRNet | LitePose MIT; Lite-HRNet MMPose Apache-2.0; check exact checkpoint/data terms | COCO17, no z | LitePose bottom-up; Lite-HRNet top-down | Lightweight research architectures; no locally verified export size | Less turnkey browser deployment/grouping than RTMO/RTMPose; older baselines, no runner in this pass. [LitePose](https://github.com/mit-han-lab/litepose), [Lite-HRNet](https://github.com/HRNet/Lite-HRNet) |
| LGM-Pose (2025) | Paper available; distributable code/weights licence not verified | COCO17, 2D | Top-down + detector | 1.2M; COCO val AP 68.6 at 256×192 / 71.0 at 384×288; test-dev 70.4 at larger size | Interesting small backbone, but no verified runnable release found; don't rank paper FPS as phone/browser evidence. [paper](https://arxiv.org/html/2506.04561v1) |
| Sapiens (2024) / Sapiens2 (2026) | Original Sapiens CC-BY-NC-4.0 weights: reference only. Sapiens2 has its **own custom licence**, not automatically the original NC licence | Whole-body 2D; Sapiens2 308 joints, separate pointmap task | Detector + very large transformer | Sapiens 0.3–2B; Sapiens2 0.4–5B, high-resolution models | Not plausible A10X browser real-time candidates; useful offline ceilings only. Sapiens2 custom use/distribution terms require review. [original model card](https://huggingface.co/facebook/sapiens), [2026 release](https://github.com/facebookresearch/sapiens2), [new licence](https://github.com/facebookresearch/sapiens2/blob/main/LICENSE.md) |

OpenPose/AlphaPose/OpenPifPaf and SMPL/HMR/MeTRAbs-style reconstruction are not promoted as shipping alternatives here: they introduce noncommercial/copyleft or separate body-model/dataset licensing questions, substantial decode/lifting integration, or large computation. A 2D model plus a temporal lifter is an architectural change, not an automatic restoration of MediaPipe's z; it needs its own latency, depth, mirrored-turn and licence evaluation.

## Licence findings that affect the shortlist

- Ultralytics references are deliberately external imports, not vendored AGPL code. They are excluded from the proprietary shipping recommendation under the user's constraint; purchasing a suitable commercial licence is a separate option, not an assumed permission.
- The RTMLib author explicitly called the RTMPose models Apache-2.0 in January 2026. However, the exact Body7/Halpe checkpoint and browser-redistribution question is still open in October 2026. Treat these as **research candidates with a commercial clearance dependency**, not “definitely noncommercial” and not “cleared because the repo is Apache”. [maintainer statement](https://github.com/Tau-J/rtmlib/issues/65), [specific checkpoint question](https://github.com/open-mmlab/mmpose/issues/3275), [earlier Body7 discussion](https://github.com/open-mmlab/mmpose/issues/3062).
- COCO-WholeBody's repository explicitly restricts the dataset to research/noncommercial use while also naming CC-BY-4.0 annotations and offering a commercial-contact route. This is a concrete provenance conflict to resolve for RTMW/DWPose/ViTPose++ releases, rather than assuming a dataset restriction automatically decides every downstream weight's legal status. [dataset terms](https://github.com/jin-s13/COCO-WholeBody#terms-of-use).
- COCO image rights are distinct from annotation rights; mixed Body7/Cocktail/AIC/MPII training does not become uniformly licensed by the inference code's Apache licence. For deployment, pin exact weights, hashes, the model licence and required notices, including detector assets. This survey does not redistribute training data.

## Browser and platform feasibility

**Safari was not measured.** Playwright WebKit is reported unavailable on this Mac. WebKit announced WebGPU in Safari 26 across Apple platforms; the GPUWeb implementation matrix lists macOS26/iOS26/iPadOS26 support. WKWebView uses the system WebKit, but that is not a measurement of ORT's operator coverage, GPU limits, worker path, or memory in the game. Feature-detect `navigator.gpu`, successfully request an adapter/device, test model initialization, and retain a usable fallback. Older A10X iPads cannot be assumed to run an OS26 WebGPU path. The A10X document in this repository measures **Apple TV rendering**, not phone-camera inference or iPad WebGPU. [WebKit announcement](https://webkit.org/blog/16993/news-from-wwdc25-web-technology-coming-this-fall-in-safari-26-beta/), [implementation matrix](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status).

ORT WebGPU uses a distinct JS entry point; WASM is the portable fallback, not necessarily fast enough. WebNN support depends on browser/OS and operator coverage and was not measured; it is not a Safari deployment plan. TF.js WebGL remains useful on older Safari. Native CoreML/ANE conversion may improve iOS performance, but does not help the paired phone's mobile Safari without a native capture app. Apple TV receives poses from that phone; upgrading its render hardware does not speed up phone inference. [ORT WebGPU documentation](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html).

The model swap also needs:

- **Depth/turns:** current retargeting uses shoulder z difference for yaw, nose versus ears for facing, and wrist/ankle z for limb depth. Zero z is acceptable to 2D scoring but visibly reduces the avatar. Missing ears/face points need explicit handling; null is not a complete live `Landmark` object.
- **Feet:** COCO17 lacks heel/toe direction. Halpe26 or WholeBody can add this; do not synthesize toes and claim measured accuracy.
- **Confidence:** min(visibility,presence), sigmoid pose visibility, Vision confidence and raw SimCC peaks have different semantics. Separate calibration data is necessary before sharing the game's .5 gate. Current fixed RTM transforms are documented in README and remain provisional.
- **Multiplayer:** evaluate whole-frame detection, per-person crop propagation and the existing strips separately. Match detector cadence, misses and person thresholds; don't compare a fast frame with zero detections to four completed pose crops.
- **Setup/identity:** calibration success and look-alike swaps depend on detection continuity and the existing tracker. A better COCO AP alone does not establish improvement.

## Measurements

The checked-in [MEASUREMENTS.json](MEASUREMENTS.json) is a compact summary, without images or raw detections. Full results remain under `$TRACKBENCH_DATA/runs/` and `browser-results/latest.json`. These are short feasibility runs on the supplied M5 Pro, potentially sharing compute with the render/harness agents. They are not low-end-device or sustained real-time claims.

### Python / native: six sparse synthetic prototype frames

| Runner | Runtime | Mean ms (cold frame included) | Median ms | Mean detections |
|---|---|---:|---:|---:|
| apple-vision | Apple Vision automatic compute selection | 29.52 | 8.93 | 1.00 |
| apple-vision-3d | Apple Vision automatic compute selection | 1109.50 | 98.19 | 0.83 |
| movenet-lightning | TensorFlow 2.21.0 CPU | 22.90 | 8.27 | 1.00 |
| movenet-multipose | TensorFlow 2.21.0 CPU | 29.39 | 12.41 | 1.00 |
| movenet-thunder | TensorFlow 2.21.0 CPU | 29.88 | 14.49 | 1.00 |
| mp-full | mediapipe 1.2.0 Python Tasks CPU | 7.48 | 5.26 | 0.67 |
| mp-heavy | mediapipe 1.2.0 Python Tasks CPU | 13.82 | 11.73 | 0.67 |
| mp-lite | mediapipe 1.2.0 Python Tasks CPU | 6.94 | 4.79 | 0.83 |
| rtmo-m | onnxruntime 1.31.1 CPUExecutionProvider / rtmlib 0.0.16 | 56.11 | 55.25 | 1.00 |
| rtmo-s | onnxruntime 1.31.1 CPUExecutionProvider / rtmlib 0.0.16 | 28.95 | 28.94 | 1.00 |
| rtmo-t | onnxruntime 1.31.1 CPUExecutionProvider / rtmlib 0.0.16 | 12.01 | 11.51 | 1.00 |
| rtmpose-m | onnxruntime 1.31.1 CPUExecutionProvider / rtmlib 0.0.16 | 15.11 | 9.49 | 1.00 |
| rtmpose-m-det1 | onnxruntime 1.31.1 CPUExecutionProvider / rtmlib 0.0.16 | 25.48 | 24.32 | 1.00 |
| rtmpose-s | onnxruntime 1.31.1 CPUExecutionProvider / rtmlib 0.0.16 | 10.18 | 5.07 | 1.00 |
| rtmpose-s-det1 | onnxruntime 1.31.1 CPUExecutionProvider / rtmlib 0.0.16 | 18.53 | 16.07 | 1.00 |
| rtmw-x | onnxruntime 1.31.1 CPUExecutionProvider / rtmlib 0.0.16 | 454.39 | 451.10 | 1.00 |
| yolo11n-pose | ultralytics 8.4.194 PyTorch CPU | 133.58 | 19.65 | 1.00 |
| yolo11s-pose | ultralytics 8.4.194 PyTorch CPU | 138.37 | 71.79 | 1.00 |
| yolo26n-pose | ultralytics 8.4.194 PyTorch CPU | 88.66 | 21.32 | 1.00 |
| yolo26s-pose | ultralytics 8.4.194 PyTorch CPU | 102.16 | 36.47 | 1.00 |

These are `proto/rt/f0001.png … f0151.png`, six sparse poses, not a continuous-motion sequence. Detector propagation and VIDEO tracking can therefore be disadvantaged by artificial jumps. Vision3D returned a pose on 5/6 frames; its first request dominates the mean. YOLO cold-start overhead similarly dominates. RTMW runs a repeated fixed batch of eight for each crop.

### Chromium Metal: 640×480 repeated-still feasibility

Browser: `153.0.8010.12`. Three warmups, ten timed frames. One-person fixture is synthetic; four-person fixture is stylized dance footage at `v4/02000.jpg`, not camera footage or GT. The renderer is `ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Pro, Unspecified Version)`.

| Model | Backend | People in fixture → detected | Model MB | Init ms | Mean frame ms | Browser-tree RSS MiB | Python decoded mean / max px |
|---|---|---|---:|---:|---:|---:|---|
| rtmo-t | webgpu | 1 → 1 | 27.34 | 307.2 | 21.38 | 1594 | 0.2451 / 0.6438 |
| rtmo-t | wasm | 1 → 1 | 27.34 | 261.6 | 129.72 | 1519 | 0.2451 / 0.6438 |
| rtmo-t | webgpu | 4 → 4 | 27.34 | 313.8 | 21.22 | 1579 | 0.1315 / 0.9258 |
| rtmo-t | wasm | 4 → 4 | 27.34 | 267.4 | 136.53 | 1501 | 0.1315 / 0.9258 |
| rtmo-s | webgpu | 1 → 1 | 39.62 | 318.6 | 20.89 | 1686 | 0.0000 / 0.0002 |
| rtmo-s | wasm | 1 → 1 | 39.62 | 277.6 | 439.28 | 1675 | 0.0000 / 0.0002 |
| rtmo-s | webgpu | 4 → 6 | 39.62 | 315.2 | 25.35 | 1646 | 0.0000 / 0.0001 |
| rtmo-s | wasm | 4 → 6 | 39.62 | 286.5 | 447.58 | 1618 | 0.0000 / 0.0001 |
| movenet-multipose | webgl | 1 → 1 | 9.68 | 22.3 | 20.86 | 1245 | 0.0426 / 0.0872 |
| movenet-multipose | webgl | 4 → 4 | 9.68 | 22.2 | 18.88 | 1244 | 0.0740 / 0.2110 |
| mp-lite | webgl | 1 → 1 | 5.78 | 80.0 | 6.05 | 1322 | 0.2340 / 0.7469 |
| mp-lite | webgl | 4 → 0 | 5.78 | 80.1 | 7.50 | 1323 | — |
| mp-full | webgl | 1 → 1 | 9.40 | 85.7 | 9.03 | 1369 | 0.2196 / 0.4083 |
| mp-full | webgl | 4 → 0 | 9.40 | 87.2 | 8.43 | 1358 | — |
| mp-heavy | webgl | 1 → 1 | 30.66 | 125.7 | 19.55 | 1632 | 0.1908 / 0.2971 |
| mp-heavy | webgl | 4 → 0 | 30.66 | 124.2 | 6.37 | 1634 | — |

**Do not read MediaPipe’s four-person timings as successful four-person pose inference: all returned zero on this fixture.** RTMO-s found six, including extra detections; t and MoveNet found four. These are diagnostic examples, not precision/recall estimates. RSS covers the isolated launcher browser tree sampled after inference and may retain allocator memory between cases; it is not per-model peak memory or an iOS memory-budget estimate.

RTMO identical-tensor CPU/JS outputs agree within 0.0004 model pixels in these cases. End-to-end t differences arise from canvas/OpenCV resize; s uses scale 1 and agrees much more closely. MoveNet TF.js/Python confidence and coordinate deltas are nonzero, as the table shows. MP CPU/GPU parity is only meaningful where both detected someone. No Safari/iOS/A10X measurements were made.



### Downloaded asset sizes

Uncompressed individual files (SavedModels shown as downloaded archives). RTMPose/RTMW also require the 20 MB-class YOLOX detector; exact values below.

| Asset | MB |
|---|---:|
| movenet-lightning.tar.gz | 9.71 |
| movenet-multipose.tar.gz | 18.61 |
| movenet-thunder.tar.gz | 24.40 |
| pose_landmarker_full.task | 9.40 |
| pose_landmarker_heavy.task | 30.66 |
| pose_landmarker_lite.task | 5.78 |
| rtmo-m.onnx | 89.27 |
| rtmo-s.onnx | 39.62 |
| rtmo-t.onnx | 27.34 |
| rtmpose-m.onnx | 54.33 |
| rtmpose-s.onnx | 21.89 |
| rtmw-x.onnx | 229.35 |
| yolo11n-pose.pt | 6.26 |
| yolo11s-pose.pt | 20.37 |
| yolo26n-pose.pt | 7.88 |
| yolo26s-pose.pt | 24.15 |
| yolox-tiny.onnx | 20.28 |

## Ground-truth status

At the last check, no `scenes/*/READY` or `gt.jsonl` existed under the shared data root. Consequently there are **no defensible per-joint GT sanity numbers yet**. The six synthetic prototype frames exercise every runner; `sanity.py` and `run_ready.py` are ready to produce per-joint mean/p95 and swapped-side diagnostics as soon as samples arrive. This missing measurement must remain explicit when handing results to the full harness.

## Ranked follow-up

1. **MediaPipe Full vs Lite through the actual game worker**, including strips, overhead arms and per-device memory. Heavy is a useful quality ceiling but much more costly; it is not the default recommendation.
2. **RTMPose-s + RTMDet-nano (commercially cleared exact checkpoint) and YOLOX-tiny research baseline**, detector every frame vs every fifth frame. Small-crop economics are attractive; measure 4-person coverage and box drift before porting into the game. RTMPose-m is an accuracy/cost comparison.
3. **MoveNet MultiPose**, especially if a 2D scoring pipeline with a separate avatar policy is acceptable. Browser-native execution works, but pixel parity/score calibration and small-arm accuracy need the full corpus.
4. **RTMO-s/t**, subject to exact weight clearance. Measured WebGPU feasibility is encouraging; WASM fallback is slow and stylized-background false positives require testing. RTMO-m is an offline accuracy ceiling first.
5. **Apple Vision 2D** for a native iOS-only branch; retain a web model for browser and paired Safari. Vision3D, RTMW-x, ViTPose++ and YOLO26 remain references until platform, depth/licence or speed constraints are resolved.
