# DJI Studio 360 스티칭 분석 (2026-11-03)

대상: `DJIStudio-1.2.25.31368(PublishBuild).exe` (708,576,864 bytes, SHA-256 `0fa12b34…f1db`, 서명 Shanghai Feilai Information Technology). 설치하지 않고 파일만 풀어 봤습니다 (NSIS 3, 파일별 deflate).

## 관련 파일

| 파일 | 크기 | 하는 일 |
|---|---|---|
| `stitch_with_sym.dll` | 4.6 MB | 스티칭 본체. 심볼(함수 이름)과 GLSL 셰이더 205개가 그대로 들어 있음 |
| `pano_selfcali.dll` | 1.7 MB | 두 렌즈 자체 보정 (OpenCV 4.10) |
| `dual_fisheye_video_eis_win.dll` | 8.3 MB | 두 어안 영상 흔들림 보정 (자이로) |
| `MeshResource/masks/<제품>/mask_fisheye_{master,slave}.bin` | | 렌즈별 유효 영역 마스크 (`panomask` v2, 런 길이 부호화). `530` = 3840×3840 렌즈(Osmo 360), `102`·`00.1.0` = 1920×1920. `lens_protector`·`under_water`·`above_water` 변형 있음 |
| `MeshResource/models/*.bin`, `masks/530/dymask_parsing_model.mnn` | | AI 이음새·마스크 모델 (암호화, `decrypt_mnn_file`) |

## 처리 순서 (`StitchOpenglV130Impl::process`, `AiStitchOpenglImpl530`)

1. **렌즈 모델과 보정값**: `pano_selfcali`의 값 이름은 `INTRI_CALIB_UNIT_FX/FY/CX/CY`, `RADIAL_COEFF`, `TANGENT_COEFF`, `omni_param`(xi 포함, 전방위 카메라 모델), `EXTRI_CALIB_UNIT_YAW/PITCH/ROLL`, `qwxyz_master2slave`, `TEMP`(온도). 파일에 든 공장 보정값(`PANO_CALIB_ROOT` JSON)을 읽고, 겹치는 부분의 특징점을 따라가며(`track_manager_t`, `SelfcaliFunctor`, 재투영 오차 최소화) 회전을 다시 맞춥니다.
2. **이음새 띠 펼치기**: 두 렌즈가 겹치는 띠를 가로로 펼쳐 놓고(열 = 이음새를 따라가는 위치, 행 = 이음새를 가로지르는 방향, 가로는 360° 이어짐) 모든 처리를 그 띠에서 합니다. 마스크로 열마다 각 렌즈의 유효 시작·끝(`mask_l`, `mask_r`)을 구합니다.
3. **광학 흐름 정렬**: DIS 광학 흐름(`DISPruneImplOptB2`, 양방향, 피라미드)으로 두 렌즈의 어긋남을 구하고, 칼만·EMA로 시간에 따라 부드럽게 한 뒤(`KalmanFlowFilter`, `EmaFlowFilterShader`) 양쪽을 가운데로 휘어(`WarpImgShader`, `NovelViewBlendShader`) 가까운 물체의 이중상을 없앱니다.
4. **이음새 위치 찾기**: `FastHorizontalSeamFinder` — 흐름 차이·경사로 비용 지도를 만들고 시간 연속성을 유지하는 가장 싼 경로.
5. **밝기·색 맞춤** (`Compensator`, `EdgeCompensator`): 이음새를 따라 64개 블록으로 나눠 YCrCb 평균·히스토그램을 비교해 열마다 `y_gain`, `cr_gain`, `cb_gain`을 구하고, 이상값 제거·곡선 다듬기·시간 평활 후 적용. 적용 세기는 이음새에서 가장 세고 렌즈 안쪽으로 갈수록 줄어듦(`ver_alpha`), 밝기 차가 큰 화소는 덜 바꿈(시그모이드 유사도).
6. **섞기**: 두 가지 방식.
   - 선형(`SeamLinearBlendShader`): 겹치는 띠의 가운데 50%(`len_ratio = 0.5`)에서 직선으로 섞음.
   - 두 대역(`BandBlendShader`): 5×5 가우시안으로 저주파/고주파를 나눠 저주파는 넓게(최대 110px), 고주파는 좁게(`band_step`) 섞고 고주파를 1.8배 살림.
7. 그 밖: 역광 번짐 보정(`SunGlarePass`), 10비트 처리, CUDA/TensorRT·MNN로 AI 버전 실행.

## Reelcut 2.2.0에 옮긴 것

| DJI | Reelcut (`src-tauri/src/stitch.rs`) |
|---|---|
| 자체 보정 (회전·렌즈) | 겹치는 띠(양쪽 이음새, 블록 96개)를 비교해 화각과 뒤 렌즈 yaw/pitch/roll을 찾음. 흐린 그림→선명한 그림 순서로 좁혀 감. .lrf가 있으면 .lrf로 |
| 밝기·색 맞춤 | 겹치는 띠에서 두 렌즈의 Y 비율, U·V 차이를 구해 반씩 맞춤(파일당 한 번) |
| 선형 이음새 섞기 (가운데 50%) | 같은 비율. 각 렌즈를 v360(input=fisheye)으로 따로 그린 뒤, 이음새에서의 거리로 정한 가중치(작은 띠를 v360으로 같은 시점에 펼침)로 `maskedmerge` |
| 렌즈 순서 | ffmpeg `dfisheye`와 같게: 왼쪽 반(트랙 0) = 뒤(yaw 180), 오른쪽 반 = 앞 |

옮기지 않은 것: 장면마다 도는 광학 흐름·이음새 경로·AI 모델, 열마다 다른 보정값과 시간 평활, 두 대역 섞기, 마스크 파일(암호화되지 않았지만 DJI 데이터라 쓰지 않음), 흔들림 보정.

## 검증

가상 360 구(구름 무늬)를 두 어안으로 만든 OSV(뒤 렌즈 yaw +1°, pitch −0.7°, roll +0.4°, 화각 193°, 밝기 +10%)로 확인:
- 자동 보정 결과: 화각 192.8°, yaw 1.0, pitch −0.7, roll 0.4, 밝기 ±4.5%씩 (`itest_stitch`)
- 이음새를 가로지르는 시점의 원본 대비 PSNR: 예전 방식 25.3 dB → 섞기만 25.4 dB → 보정+섞기 31.7 dB
- 기존 실제 ffmpeg 통합 테스트(미리보기·내보내기 전체) 통과

실제 Osmo 360 파일로는 아직 못 봤습니다(PC에 .osv 없음). 렌즈 순서·방향이 다르면 "앞뒤 렌즈 바꾸기"로 고칩니다.
