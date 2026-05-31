# Workbench 파라미터 패널 계획

## 목적

lasso seed 선택이 완료된 뒤 사용자가 같은 선택 영역을 다시 그리지 않고 rough mask 결과를 조정할 수 있게 한다.
패널은 workbench 화면 우측 상단에 배치하고, 조정값을 바꿀 때 기존 `lastSelection`으로 mask preview와 PNG blob을 다시 생성한다.

이 기능은 정교한 mask 편집기가 아니다.
현재 알고리즘의 threshold, seed prior, sampling area, output padding 같은 수치를 사용자가 이해 가능한 한국어 컨트롤로 노출하는 것이다.

## 현재 알고리즘 기준점

현재 `createRoughMask()`는 다음 흐름으로 동작한다.

```text
lasso polygon 내부를 foreground seed mask로 만든다.
seed bounds를 기준으로 workArea를 약간 확장한다.
seed mask 내부 RGB 평균을 foreground 후보로 샘플링한다.
nearSeedMask 바깥과 workArea border를 background 후보로 샘플링한다.
각 픽셀마다 foreground/background 색상 거리와 prior를 합산해 score를 만든다.
score > 8이면 foreground alpha 255, 아니면 alpha 0으로 둔다.
```

현재 하드코딩 값:

```text
판정 기준값: 8
seed 내부 가산점: +30
seed 주변 가산점: +10
seed 밖 감점: -12
workArea border 감점: -18
거칠기 noise 폭: 24, 실제 영향은 +/-12
workArea 확장 비율: 0.08
near seed dilation: min(workArea) * 0.03, 최소 4px, 최대 32px
background border 샘플 비율: min(workArea) * 0.08, 최소 2px
output padding: 최소 4px, foregroundBounds 큰 변의 0.02
foreground ratio guard: 0.01 ~ 0.95
sample target: 약 12,000 sample
```

## 배치

### 위치

패널은 `workbench.html`의 `.workspace` 내부, 캔버스 위 absolute overlay로 배치한다.

```html
<aside id="parameter-panel" class="parameter-panel" aria-label="Mask parameters">
  ...
</aside>
```

권장 위치:

```css
.parameter-panel {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 280px;
}
```

이유:

```text
기존 toolbar의 Reset/Copy/Back 버튼과 충돌하지 않는다.
canvas 위 preview를 보면서 즉시 조정하기 좋다.
workbench의 기존 구조를 크게 바꾸지 않는다.
```

### 반응형

```text
desktop/tablet:
  우측 상단 고정 패널, 폭 280px.

mobile 또는 width <= 640px:
  우측 상단 패널을 접힌 상태로 시작하거나,
  하단 statusbar 위에 가로 스크롤 없는 compact panel로 배치한다.
```

MVP에서는 desktop 우선으로 구현하고, mobile에서는 패널 폭을 `min(280px, calc(100% - 24px))`로 제한한다.

### 표시 상태

```text
loading-source:
  패널 숨김 또는 disabled.

ready:
  패널 표시, 컨트롤 disabled.
  사용자가 아직 lasso seed를 만들지 않았으므로 조정할 결과가 없다.

selecting-object:
  패널 표시, 컨트롤 disabled.

processing-mask:
  패널 표시, 컨트롤 disabled.

preview-ready / copied:
  패널 표시, 컨트롤 enabled.

failed:
  패널 숨김 또는 disabled.
```

권장: 패널은 항상 보이되, preview 전에는 컨트롤을 disabled하고 값만 보여준다.
이렇게 하면 사용자는 선택 후 무엇을 조정할 수 있는지 미리 인지할 수 있다.

## 사용자-facing 요소명

모든 컨트롤 label은 한국어로 제공한다.
상태/오류 메시지는 기존 MVP 원칙에 따라 영어를 유지해도 되지만, 패널 내부 label은 한국어로 둔다.

## MVP 패널 구성

### 1. 민감도

UI label:

```text
민감도
```

설명:

```text
foreground로 판정되는 문턱값을 조절한다.
값을 올리면 더 많이 포함하고, 낮추면 더 많이 제거하는 방향을 추천한다.
```

내부 매핑:

```text
현재 threshold = 8
UI 범위: -50 ~ +50
기본값: 0
계산:
  threshold = 8 - uiValue * 0.4
```

주의:

```text
사용자 관점의 "민감도 증가"는 더 많은 픽셀을 잡는 것이 자연스럽다.
알고리즘 관점에서는 threshold를 낮춰야 더 많이 잡힌다.
따라서 UI 값과 threshold는 반대로 매핑한다.
```

권장 control:

```text
range slider + numeric value
```

### 2. 확장

UI label:

```text
확장
```

설명:

```text
lasso seed 주변을 얼마나 넓게 분석할지 조절한다.
값이 클수록 lasso 밖 물체 영역까지 더 시도한다.
```

내부 매핑:

```text
현재 workArea expand ratio = 0.08
현재 near seed dilation ratio = 0.03
UI 범위: -50 ~ +50
기본값: 0
계산:
  selectionPaddingRatio = clamp(0.08 + uiValue * 0.0016, 0.02, 0.18)
  nearSeedDilationRatio = clamp(0.03 + uiValue * 0.0006, 0.01, 0.07)
```

권장 control:

```text
range slider
```

### 3. 가장자리 정리

UI label:

```text
가장자리 정리
```

설명:

```text
workArea 가장자리로 mask가 번지는 것을 억제하고, 결과 edge를 더 엄격하게 만든다.
값을 올리면 배경이 덜 딸려오지만 물체 끝이 깎일 수 있다.
```

내부 매핑:

```text
현재 border prior = -18
현재 background border sample ratio = 0.08
UI 범위: -50 ~ +50
기본값: 0
계산:
  borderPenalty = -18 - uiValue * 0.3
  backgroundBorderRatio = clamp(0.08 + uiValue * 0.0008, 0.03, 0.14)
```

권장 control:

```text
range slider
```

### 4. 출력 여백

UI label:

```text
출력 여백
```

설명:

```text
복사되는 PNG의 bounding box 바깥 여백을 조절한다.
mask 자체를 바꾸지 않고 outputBounds만 다시 계산한다.
```

내부 매핑:

```text
현재 min padding = 4px
현재 ratio = 0.02
UI 범위: 0 ~ 50
기본값: 0
계산:
  outputPaddingMinPx = 4 + uiValue
  outputPaddingRatio = 0.02 + uiValue * 0.001
```

권장 control:

```text
range slider
```

특이점:

```text
출력 여백만 변경할 때는 full segmentation을 다시 돌릴 필요가 없다.
기존 maskResult의 foregroundBounds를 이용해 outputBounds와 pngBlob만 다시 만들 수 있다.
하지만 구현 단순성을 위해 MVP에서는 전체 processSelection을 재실행해도 된다.
```

## Advanced 패널 구성

MVP에서는 접힌 `고급` 섹션으로 제공한다.
처음부터 너무 많은 슬라이더가 보이면 사용자가 부담을 느낄 수 있다.

### 5. 시드 영향

UI label:

```text
시드 영향
```

설명:

```text
seed 주변을 foreground/background 샘플링에서 얼마나 강하게 보호할지 조절한다.
```

내부 매핑:

```text
UI 범위: -50 ~ +50
기본값: 0
계산:
  nearSeedDilationRatio = clamp(0.03 + expansion * 0.0006 + uiValue * 0.00025, 0.01, 0.08)
```

값을 올리면:

```text
seed 가까이 있는 픽셀이 background 평균에 덜 섞인다.
lasso 내부 픽셀을 최종 mask에 100% 포함시키지는 않는다.
foreground/background 분리가 불안정한 경우 샘플링이 조금 더 보수적으로 변한다.
```

### 6. 배경 범위

UI label:

```text
배경 범위
```

설명:

```text
배경 후보를 seed에서 얼마나 멀리 떨어진 영역으로 볼지 조절한다.
```

내부 매핑:

```text
현재 nearSeedDilationMin = 4px
현재 nearSeedDilationMax = 32px
현재 dilation ratio = 0.03
UI 범위: -50 ~ +50
기본값: 0
계산:
  nearSeedDilationRatio = clamp(0.03 + uiValue * 0.0008, 0.008, 0.08)
  nearSeedDilationMinPx = clamp(round(4 + uiValue * 0.06), 1, 10)
  nearSeedDilationMaxPx = clamp(round(32 + uiValue * 0.4), 12, 64)
```

값을 올리면:

```text
seed 가까이 있는 픽셀은 background 샘플에서 더 많이 제외된다.
배경 평균이 seed 색상에 덜 오염된다.
workArea가 좁으면 background sample이 부족해질 수 있다.
```

### 7. 거칠기

UI label:

```text
거칠기
```

설명:

```text
결과 edge에 들어가는 pseudo-random noise의 강도를 조절한다.
```

내부 매핑:

```text
현재 roughNoiseAmount = 24, 실제 영향 +/-12
UI 범위: 0 ~ 50
기본값: 24 또는 UI 24
계산:
  roughNoiseAmount = uiValue
```

값을 올리면:

```text
윤곽이 더 거칠고 불규칙해진다.
복잡한 배경에서 작은 구멍이나 섬이 늘 수 있다.
```

값을 낮추면:

```text
결과가 더 안정적이다.
MVP의 rough aesthetic은 약해질 수 있다.
```

### 8. 마스크 보정

UI label:

```text
마스크 보정
```

설명:

```text
최종 binary mask를 1~5px 정도 팽창하거나 수축한다.
```

내부 매핑:

```text
현재 없음.
UI 범위: -5 ~ +5
기본값: 0
계산:
  negative value -> erode mask
  positive value -> dilate mask
```

이 파라미터는 현재 알고리즘에는 없지만 가장 체감이 크다.
선택 후 "조금 더 넣기/조금 깎기"를 직접 해결한다.

구현 방식:

```text
score threshold 결과 mask를 만든 뒤,
maskAdjustmentPx > 0이면 binary dilation,
maskAdjustmentPx < 0이면 binary erosion.
```

### 9. 구멍 채우기

UI label:

```text
구멍 채우기
```

설명:

```text
물체 내부의 작은 투명 구멍을 채운다.
```

내부 매핑:

```text
현재 없음.
UI type: checkbox
기본값: off
```

MVP 구현에서는 optional로 둔다.
binary flood fill로 workArea 외부와 연결되지 않은 transparent island를 채울 수 있다.

### 10. 작은 조각 제거

UI label:

```text
작은 조각 제거
```

설명:

```text
배경 쪽에 생긴 작은 foreground 섬을 제거한다.
```

내부 매핑:

```text
현재 없음.
UI type: checkbox 또는 0~100 slider
기본값: off
```

MVP 구현에서는 optional로 둔다.
connected component labeling이 필요해 구현량이 늘어난다.

## 최종 추천 노출안

### 기본 노출

첫 버전에서는 네 개만 상시 노출한다.

```text
민감도
확장
가장자리 정리
출력 여백
```

이 네 개는 현재 알고리즘에 바로 연결되고, 사용자가 결과 변화를 이해하기 쉽다.

### 고급 노출

접힌 `고급` 섹션에 다음을 둔다.

```text
시드 영향
배경 범위
거칠기
마스크 보정
구멍 채우기
작은 조각 제거
```

단, `마스크 보정`, `구멍 채우기`, `작은 조각 제거`는 현재 알고리즘에 없는 후처리이므로 구현 난이도가 한 단계 높다.
MVP 파라미터 패널 1차 구현에서는 `마스크 보정`까지만 포함하는 것을 추천한다.

## 기본값 객체

코드에는 다음 형태의 옵션 객체를 추가한다.

```ts
export type MaskTuningOptions = {
  sensitivity: number;
  expansion: number;
  edgeCleanup: number;
  outputPadding: number;
  seedInfluence: number;
  backgroundRange: number;
  roughness: number;
  maskAdjustment: number;
  fillHoles: boolean;
  removeSpeckles: boolean;
};

export const DEFAULT_MASK_TUNING_OPTIONS: MaskTuningOptions = {
  sensitivity: 0,
  expansion: 0,
  edgeCleanup: 0,
  outputPadding: 0,
  seedInfluence: 0,
  backgroundRange: 0,
  roughness: 24,
  maskAdjustment: 0,
  fillHoles: false,
  removeSpeckles: false
};
```

## 알고리즘 옵션 변환

UI 값은 그대로 알고리즘에 흘려보내지 않고, `resolveMaskTuning()`에서 내부 수치로 변환한다.

```ts
type ResolvedMaskTuning = {
  scoreThreshold: number;
  selectionPaddingRatio: number;
  nearSeedDilationRatio: number;
  nearSeedDilationMinPx: number;
  nearSeedDilationMaxPx: number;
  inSeedPrior: number;
  nearSeedPrior: number;
  outsideSeedPrior: number;
  borderPenalty: number;
  backgroundBorderRatio: number;
  roughNoiseAmount: number;
  outputPaddingMinPx: number;
  outputPaddingRatio: number;
  maskAdjustmentPx: number;
  fillHoles: boolean;
  removeSpeckles: boolean;
};
```

`createRoughMask()`는 다음처럼 변경한다.

```ts
createRoughMask(sourceCanvas, selection, tuningOptions)
```

`createEmergencyMask()`도 output padding을 tuning에서 받아야 한다.

## 상호작용

### 재계산 시점

추천:

```text
input 이벤트 중에는 120ms debounce로 preview 재계산
change 이벤트나 pointerup 후에는 즉시 최종 pngBlob 재계산
```

간단한 MVP:

```text
slider input 때마다 150ms debounce로 processSelection(lastSelection) 재실행
```

### 상태 처리

```text
사용자가 값을 바꿈
-> lastSelection이 없으면 값만 저장
-> lastSelection이 있으면 state = processing-mask
-> createRoughMask(..., tuning)
-> createPreviewCanvas()
-> createPngBlob()
-> state = preview-ready
```

복사 완료 후 값을 바꾸면:

```text
state = processing-mask
새 PNG 생성
state = preview-ready
Copy PNG 버튼 활성
```

즉 `copied` 상태는 파라미터 변경 시 해제된다.

### Reset Selection

추천:

```text
Reset Selection은 lasso/preview/pngBlob만 초기화한다.
파라미터 값은 유지한다.
```

이유:

```text
사용자가 같은 이미지에서 다시 선택할 때 방금 찾은 튜닝값을 유지하는 편이 자연스럽다.
```

별도 버튼:

```text
파라미터 초기화
```

## HTML 구조 제안

```html
<aside id="parameter-panel" class="parameter-panel" aria-label="Mask parameters">
  <div class="parameter-panel-header">
    <strong>조정</strong>
    <button id="reset-parameters-button" type="button">초기화</button>
  </div>

  <label class="parameter-control">
    <span>민감도</span>
    <input id="sensitivity-input" type="range" min="-50" max="50" value="0" />
  </label>

  <label class="parameter-control">
    <span>확장</span>
    <input id="expansion-input" type="range" min="-50" max="50" value="0" />
  </label>

  <label class="parameter-control">
    <span>가장자리 정리</span>
    <input id="edge-cleanup-input" type="range" min="-50" max="50" value="0" />
  </label>

  <label class="parameter-control">
    <span>출력 여백</span>
    <input id="output-padding-input" type="range" min="0" max="50" value="0" />
  </label>

  <details class="advanced-parameters">
    <summary>고급</summary>
    ...
  </details>
</aside>
```

## CSS 방향

```text
패널은 작업 도구이므로 화려한 card 느낌보다 작고 조밀한 tool panel로 만든다.
기존 toolbar/statusbar와 같은 #f8f6f0 계열 배경을 사용한다.
border radius는 6px 이하로 유지한다.
버튼과 range input 높이를 안정적으로 고정한다.
캔버스 위 내용과 겹치므로 약한 shadow를 사용한다.
```

권장:

```css
.parameter-panel {
  position: absolute;
  top: 12px;
  right: 12px;
  width: min(280px, calc(100% - 24px));
  padding: 10px;
  border: 1px solid #d8d2c8;
  border-radius: 6px;
  background: rgba(248, 246, 240, 0.96);
  box-shadow: 0 10px 30px rgba(36, 36, 36, 0.14);
}
```

## 구현 단계

1. `MaskTuningOptions` 타입과 기본값을 추가한다.
2. `createRoughMask(sourceCanvas, selection, options)`로 signature를 변경한다.
3. 하드코딩된 threshold/prior/padding/noise 값을 `resolveMaskTuning()` 결과로 대체한다.
4. workbench HTML에 parameter panel을 추가한다.
5. workbench state에 `maskTuningOptions`를 추가한다.
6. input event를 읽어 옵션을 업데이트한다.
7. `lastSelection`이 있으면 debounce 후 preview/pngBlob을 재생성한다.
8. `Reset Selection`은 tuning 값을 유지한다.
9. `파라미터 초기화` 버튼은 tuning만 기본값으로 되돌리고 preview를 재생성한다.
10. README/manual test checklist에 파라미터 조정 항목을 추가한다.

## 테스트 체크리스트

```text
선택 전 패널이 보이지만 disabled 상태다.
선택 후 민감도 변경 시 preview가 다시 생성된다.
민감도를 올리면 일반적으로 foreground가 더 많이 잡힌다.
확장을 올리면 lasso 주변까지 더 넓게 분석한다.
가장자리 정리를 올리면 workArea border 쪽 번짐이 줄어든다.
출력 여백 변경 후 Copy PNG 결과 bounding box 여백이 달라진다.
고급 패널을 열고 닫아도 preview 상태가 유지된다.
Reset Selection 후 파라미터 값은 유지된다.
파라미터 초기화 버튼은 기본값으로 되돌리고 preview를 재계산한다.
Copy PNG 후 파라미터 변경 시 copied 상태가 preview-ready로 돌아온다.
작은 화면에서 패널이 버튼/상태바와 겹치지 않는다.
```

## 권장 1차 구현 범위

1차 구현은 다음 여섯 개로 제한하는 것을 추천한다.

```text
민감도
확장
가장자리 정리
출력 여백
시드 영향
거칠기
```

이 여섯 개는 후처리 알고리즘 추가 없이 현재 code path의 하드코딩 값을 옵션화하면 구현할 수 있다.

`마스크 보정`, `구멍 채우기`, `작은 조각 제거`는 사용성이 크지만 후처리 구현이 필요하므로 2차 구현으로 둔다.
