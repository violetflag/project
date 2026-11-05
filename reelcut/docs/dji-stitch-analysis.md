# DJI Studio 360 스티칭·흔들림 보정 분석 (2026-11-03)

대상: `DJIStudio-1.2.25.31368(PublishBuild).exe` (708,576,864 bytes, SHA-256 `0fa12b34…f1db`, 서명 Shanghai Feilai Information Technology). 설치하지 않고 파일만 풀어 봤습니다 (NSIS 3, 파일별 deflate).

## 관련 파일

| 파일 | 크기 | 하는 일 |
|---|---|---|
| `stitch_with_sym.dll` | 4.6 MB | 스티칭 본체. 심볼(함수 이름)과 GLSL 셰이더 205개가 그대로 들어 있음 |
| `pano_selfcali.dll` | 1.7 MB | 두 렌즈 자체 보정 (OpenCV 4.10) |
| `dual_fisheye_video_eis_win.dll` | 8.3 MB | 두 어안 영상 흔들림 보정 (자이로) |
| `MeshResource/masks/<제품>/mask_fisheye_{master,slave}.bin` | | 렌즈별 유효 영역 마스크 (`panomask` v2, 런 길이 부호화). `530` = 3840×3840 렌즈, `102`·`00.1.0` = 1920×1920. (정정: 2.2.0 보고서는 530을 Osmo 360이라 했지만, 메타데이터 정의를 보니 Osmo 360은 제품 번호 `oqb101`(코드 101), Osmo 360 II가 OQ102, 530은 360 카메라가 달린 다른 기기(`wab530`, 내부 이름 eagle4)입니다.) `lens_protector`·`under_water`·`above_water` 변형 있음 |
| `MeshResource/models/*.bin`, `masks/530/dymask_parsing_model.mnn` | | AI 이음새·움직이는 물체 마스크 모델 (암호화, `decrypt_mnn_file`) |
| `VinceEditor.dll` | | 편집기 본체. DJI 메타데이터(protobuf) 정의 `dvtm_oqb101.proto` 등이 들어 있음 |

## 처리 순서 (`StitchOpenglV130Impl::process`, Osmo 360은 `AiStitchOpenglImpl101`)

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

2.2.0에서 옮기지 않은 것(장면마다 도는 흐름 정렬, 이음새 경로, 열마다 다른 색 보정, 흔들림 보정)은 2.4.0에서 옮겼습니다. 아래를 보세요.

## 검증

가상 360 구(구름 무늬)를 두 어안으로 만든 OSV(뒤 렌즈 yaw +1°, pitch −0.7°, roll +0.4°, 화각 193°, 밝기 +10%)로 확인:
- 자동 보정 결과: 화각 192.8°, yaw 1.0, pitch −0.7, roll 0.4, 밝기 ±4.5%씩 (`itest_stitch`)
- 이음새를 가로지르는 시점의 원본 대비 PSNR: 예전 방식 25.3 dB → 섞기만 25.4 dB → 보정+섞기 31.7 dB
- 기존 실제 ffmpeg 통합 테스트(미리보기·내보내기 전체) 통과

실제 Osmo 360 파일로는 아직 못 봤습니다(PC에 .osv 없음). 렌즈 순서·방향이 다르면 "앞뒤 렌즈 바꾸기"로 고칩니다.


## AI 이음새 (`AiStitchOpenglImpl101`, Osmo 360)

셰이더와 함수 이름으로 본 순서:
1. 겹치는 띠를 펼친 그림 두 장을 신경망(MNN 또는 TensorRT, 모델은 `MeshResource/models/*.bin`에 암호화)에 넣어 **두 렌즈 사이 어긋남(흐름)** 을 구함. 신경망을 못 쓰면 DIS 광학 흐름으로 대신함.
2. 흐름을 양쪽 대칭으로 만듦(한쪽이 +면 다른 쪽은 −).
3. 흐름이 가장 작은 곳을 따라 이음새 선을 고름(동적 계획법, 앞 프레임 이음새에서 멀리 못 가게 함, `prev_seam_y`).
4. 왼쪽 렌즈는 `pos − flow·t`, 오른쪽은 `pos + flow·(1−t)`에서 가져와 가운데로 휘어 맞춤(t = 띠 안 위치). 세로 흐름은 `flow_thre`로 제한.
5. 한 대역 선형 섞기, 이음새 두 곳 보정, 역광 번짐 보정.
6. `dymask_parsing_model.mnn`: 움직이는 물체(사람 등)를 가려 이음새가 그 위를 지나지 않게 함.

## 흔들림 보정 (`dual_fisheye_video_eis_win.dll`)

- 입력: 파일 속 DJI 메타데이터의 IMU 자세(`FrameMetaOfIMU.IMU_attitude_after_fusion` — 프레임마다 쿼터니언 여러 개)와 롤링 셔터 세기(`DeRollingLevel`).
- 모드: 방향 지정(`EisGetMatrixForDirection`), 방향 고정(`DirectionLock`), 수평 유지(`EisAndHorizontal`), 진행 방향 보기(`ForwardView`), 기울기 복원(`TiltRecovery`), 주인공 따라가기(`Protagonist`).
- 결과는 렌즈 그림을 펼치는 격자(mesh)로 적용(`EisGetCpuMeshFor…`, 롤링 셔터 보정 포함), 자기 보정용 프레임 고르기도 있음.

### DJI 메타데이터 구조 (`dvtm_oqb101.proto`, VinceEditor.dll에서 꺼냄)

`ProductMeta` = clip_meta(1) · stream_meta(2) · frame_meta(3).
- 프레임: `frame_meta.imu_frame_meta(3).IMU_attitude_after_fusion(2).current_frame(1)` = `DeviceAttitude{timestamp=1, vsync=2, attitude=3 (쿼터니언 w,x,y,z 여러 개), offset=4}`. 카메라 쪽(`camera_frame_meta=2`)에 노출 시간(4), 카메라 자세(9), 가속도(10), 센서 온도(16).
- 클립: 센서 읽기 시간(`sensor_readout_time=4`, ns로 보임), 읽는 방향(`sensor_read_direction=5`), 왜곡 계수(3), EIS 상태(9), IMU 주기(10), 센서 fps(11), 제품 이름(헤더 10).
- 스트림: 렌즈 보정 `pano_dewarp_params(6)` = 전방위 카메라 모델(fx, fy, cx, cy, k1–k4, xi, yaw, pitch, roll, 카메라–IMU 회전 26, 렌즈 간 회전 28), 렌즈 보호필름·방수 케이스용 변형 포함.
- GPS·속도(짐벌 프레임), 심박 등 운동 기록 칸도 있음.

## Reelcut 2.4.0에 옮긴 것

| DJI | Reelcut (`src-tauri/src/pano.rs`, `motion.rs`) |
|---|---|
| 신경망 흐름(대신 DIS) | 겹치는 띠를 낮은 해상도로 펼쳐 블록 비교(평균 뺀 SAD, 소수점 위치)로 두 렌즈의 어긋남을 매 프레임 구함. 신경망 모델은 암호화돼 있고 DJI 것이라 쓰지 않음 |
| 대칭 흐름 + 이음새 선 + 앞 프레임 연속성 | 같은 방식: 가운데·앞 프레임에서 멀어지면 비용을 더한 동적 계획법으로 이음새 선을 고르고, 양쪽을 반씩 휘어 맞춤. 흐름·선·색은 시간 평활(EMA) |
| 64블록 색 맞춤 | 이음새를 따라 64칸으로 나눠 Y 비율·U·V 차이를 매 프레임 구해 부드럽게 적용 |
| IMU 자세 | `.osv`의 djmd 트랙을 직접 읽음(protobuf를 손으로 해석, 새 라이브러리 없음). 자이로 축이 렌즈와 어떻게 놓였는지는 파일에 믿을 만한 값이 없어, 화면에서 본 회전과 24가지 축 배치·시간차를 비교해 자동으로 고름 |
| 자이로 없을 때 | 구 위 700곳의 작은 조각을 앞뒤 프레임에서 맞춰 보고(접평면 블록 비교), 스스로 움직이는 물체는 빼고 회전을 맞춤(Horn 방법) |
| 수평 유지·방향 고정 | 수평 유지(기본: 수평선 반듯, 방향은 천천히 따라감), 방향 고정, 흔들림만 줄이기(가우시안 평활), 끄기. 부드러움 0.2–5초 |
| 롤링 셔터 | 센서 읽기 시간과 회전 속도로 줄마다 방향을 되돌림 |
| 격자 적용 | 출력 화면을 4–8px 격자로 나눠 렌즈 좌표를 계산(프레임마다 회전이 바뀌면 다시 계산) |

미리보기 파일(2048×1024 구)과 내보내기(360 클립을 먼저 평면 화면으로 만든 뒤 나머지 편집) 둘 다 이 엔진을 씁니다. 엔진이 실패하면 2.2의 ffmpeg 방식으로 돌아갑니다.

### 검증 (가상 영상)
- 흐름 정렬: 한 렌즈를 일부러 어긋나게 한 그림에서 이음새 띠 차이가 흐름 없이의 60% 미만(`flow_pulls_a_shifted_lens_into_line`)
- 흔들림: 구 그림을 4초 동안 좌우 ±9°, 위아래 ±4°, 회전 ±5°로 흔든 두 어안 영상(`SHAKE.OSV`)에서 화면 분석 오차 프레임당 0.07°, 처음부터 누적 0.27°. 방향 고정 결과의 프레임 간 화면 변화 7.19 → 0.65 (`itest_motion`)
- 메타데이터 읽기, 자이로 축 자동 맞춤, 수평 유지 계산은 단위 시험으로 확인. **실제 Osmo 360 파일로는 아직 못 봤음** (자이로 축 맞춤과 롤링 셔터 시간 단위는 실제 파일에서 확인 필요)

## 그 밖에 DJI Studio에 있고 Reelcut에 없는 영상 기능

DJI Studio.exe의 화면 모델, VinceEditor의 소스 경로, 리소스 폴더에서 찾은 것입니다.

**360 관련**
- 피사체 따라가기(`ml_vot`, `PanoProtagonistRenderer`, 셀카 추적, `resource/tracking`): 사람을 고르면 시점이 계속 따라감
- 보기 방식: 작은 행성·구·원통·직사각 등(`PanoSphere`, `Cylinder`, `Rect`, `Mesh` 렌더러)과 시점 이동 효과
- 렌즈 보호필름·수중 모드(보정값·마스크가 따로 있음), 수중 색 보정
- 역광 번짐 제거, 움직이는 물체 마스크
- 360 그대로 내보내기(구 형태 + 360 메타데이터 `GSpherical`) — Reelcut은 지금 평면 화면으로만 내보냄
- 파일에 든 공장 렌즈 보정값 사용(Reelcut은 화면을 보고 스스로 맞춤)

**일반 영상**
- D-Log M → 일반(Rec.709) LUT (Osmo 360용), SDR→HLG, HDR 인코딩
- 색 바퀴(Log·Primary), 톤 자동 보정, 깜빡임 제거, ND 필터 효과(모션 블러), 내보낼 때 AI 노이즈 제거
- 프레임 보간(슬로모션용 `VfiModel`), 끊김 감지
- 대시보드 오버레이: GPS 경로, 속도, 고도, 심박, 케이던스 등(`DashboardManager`)
- AI 러프컷, 하이라이트 찾기(장면·미적 점수·스키·라이딩 모델), 음악 박자 맞춤, 추억 앨범 템플릿
- 글자·스티커·워터마크(받아쓰기 자막은 Reelcut에도 있음), 전환 효과 모음(Reelcut은 디졸브만), 얼굴 보정(뷰티), 스타일 필터, 틸트 시프트

## 2.18 수정

이 문서의 앞부분은 미리보기와 내보내기가 같은 엔진을 쓴다고 적었지만, 2.5.0부터는 미리보기가 ffmpeg 그래프(`live.rs`, `stitch::graph`), 내보내기가 `pano::Stitcher`를 써서 달랐습니다. 2.18부터 둘 다 같은 이음새 가중치(`stitch::front_weight`)를 씁니다. 흐름 정렬은 "정밀"로 따로 고릅니다.
