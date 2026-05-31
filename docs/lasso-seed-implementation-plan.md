# Lasso Seed 구현 계획

## 목적

현재 workbench의 물체 선택 방식은 foreground seed brush다.
사용자는 물체 안쪽을 브러쉬로 칠하고, 알고리즘은 칠한 픽셀을 foreground seed로 사용해 rough hard-alpha mask를 만든다.

이 방식은 빠르지만 다음 문제가 있다.

```text
사용자가 어떤 영역을 seed로 제공했는지 한눈에 보기 어렵다.
큰 물체에서는 brush stroke가 foreground 샘플을 충분히 대표하지 못할 수 있다.
너무 짧은 stroke는 실패하고, 긴 stroke는 사용자가 여러 번 문질러야 한다.
emergency fallback이 물체 전체가 아니라 칠한 blob에 가까워진다.
```

lasso seed 방식은 사용자가 원본 이미지 위에 닫힌 선을 그리고, 그 내부 픽셀을 foreground seed로 사용하는 방식이다.
목표는 정교한 올가미 누끼가 아니라, "닫힌 내부 영역을 foreground 힌트로 전달하는 더 명확한 seed 입력"이다.

## 제품 정의

### 핵심 개념

```text
사용자는 물체 안쪽을 둘러싸는 닫힌 lasso path를 그린다.
pointer up 시 path는 자동으로 닫힌 polygon이 된다.
polygon 내부 픽셀은 foreground seed로 간주한다.
segmentation은 기존과 동일하게 foreground/background 색상 거리와 rough prior를 이용해 mask를 만든다.
```

### 중요한 비목표

```text
lasso path 자체를 최종 PNG 경계선으로 사용하지 않는다.
사용자가 path를 물체 외곽에 정확히 맞춰야 하는 도구로 만들지 않는다.
polygon 편집, vertex 이동, feather, soft edge는 MVP 범위가 아니다.
background lasso, exclude lasso, erase brush는 MVP 범위가 아니다.
```

### 권장 사용자 문구

오해를 줄이기 위해 "Draw around the object"보다 "Trace inside the object" 계열 문구를 권장한다.

```text
Ready: Trace inside the object.
Selecting: Drawing lasso seed...
Too small: Selection is too small
Processing: Creating rough outline...
Preview success: Preview ready
Emergency fallback: Preview ready (rough fallback)
```

## 현재 구조 검토

### 영향받는 파일

```text
src/shared/types.ts
src/shared/constants.ts
src/workbench/index.ts
src/workbench/segmentation.ts
src/workbench/style.css
README.md
PRD.md
docs/seed-brush-change-plan.md 또는 신규 문서
test-pages/manual.html
```

### 현재 코드의 전제

`src/shared/types.ts`:

```ts
export type BrushSeedPoint = {
  x: number;
  y: number;
  radius: number;
};

export type ObjectSeedSelection = {
  kind: "brush" | "rect" | "lasso";
  bounds: ImagePixelRect;
  points: BrushSeedPoint[];
};
```

타입 이름은 lasso를 예약하고 있지만 실제 payload는 brush 전용 `points: BrushSeedPoint[]`다.
lasso를 제대로 구현하려면 `ObjectSeedSelection`을 discriminated union으로 바꾸는 편이 안전하다.

`src/workbench/index.ts`:

```text
pointer down -> BrushStrokeState 시작
pointer move -> brush dab point 누적
pointer up -> selectionFromBrushPoints()
selection이 충분하면 createRoughMask()
```

lasso에서는 brush radius가 없고, point path 자체를 누적해야 한다.
따라서 stroke state, cursor drawing, selection 생성, validation이 모두 바뀐다.

`src/workbench/segmentation.ts`:

```text
createRoughMask()
  seedBounds 계산
  createBrushMask(workArea, selection.points, 1)
  createBrushMask(workArea, selection.points, 3)
  foreground/background sampling
  score threshold
```

현재 segmentation은 brush mask 생성 함수와 강하게 결합되어 있다.
lasso 도입 시 `createSeedMask()`와 `createNearSeedMask()`를 분리해야 한다.

## 추천 결정

MVP 방향은 다음을 추천한다.

```text
기본 선택 방식은 lasso seed 하나로 교체한다.
brush seed 코드는 당장 UI에서 제거하되, 타입/함수는 필요하면 후속 복구가 가능하게 분리한다.
lasso path는 pointer up 시 자동으로 닫는다.
lasso 내부는 foreground seed이고, 최종 경계선은 rough segmentation 결과다.
emergency fallback은 lasso 내부 polygon을 opaque로 출력한다.
```

이유:

```text
현재 제품은 단일 선택 도구 MVP다.
brush와 lasso를 동시에 제공하면 UI, 상태, 문서, 테스트가 늘어난다.
사용자가 겪는 가장 큰 혼란은 "어디를 seed로 잡았는지"이므로 lasso 단일화가 문제를 직접 줄인다.
fallback 품질도 brush blob보다 lasso 내부 polygon이 더 예측 가능하다.
```

## 확정 결정

다음 결정으로 구현한다.

```text
Q1: A - brush UI 제거, lasso seed만 제공
Q2: A - lasso 내부는 final boundary가 아니라 foreground seed
Q3: A - pointer up 시 자동 close
Q4: A - 이미지 밖 point는 저장하지 않고 pointer capture 유지
Q5: B - 너무 큰 rough segmentation은 emergency fallback
Q6: A - self-intersecting lasso는 canvas fill rule에 맡김
Q7: B - brush helper는 seed abstraction 내부에 보존 가능
Q8: B - preview 후 lasso seed는 약하게, rough mask edge 강조
```

구현 원칙:

```text
workbench 사용자는 lasso 하나만 본다.
lasso polygon은 final cut boundary가 아니라 foreground seed mask다.
rough segmentation 실패나 작업 영역 초과 시 lasso 내부 polygon을 emergency PNG로 만든다.
brush 관련 helper는 seed mask abstraction 내부에 남겨 후속 toggle 복구 가능성을 유지한다.
```

## 데이터 모델 변경

### 추천 타입

```ts
export type BrushSeedPoint = {
  x: number;
  y: number;
  radius: number;
};

export type BrushSeedSelection = {
  kind: "brush";
  bounds: ImagePixelRect;
  points: BrushSeedPoint[];
};

export type LassoSeedSelection = {
  kind: "lasso";
  bounds: ImagePixelRect;
  polygon: ImagePixelPoint[];
};

export type RectSeedSelection = {
  kind: "rect";
  bounds: ImagePixelRect;
};

export type ObjectSeedSelection =
  | BrushSeedSelection
  | LassoSeedSelection
  | RectSeedSelection;
```

### MVP 생성값

```text
MVP UI에서 생성하는 값은 kind: "lasso"만 사용한다.
brush와 rect는 후속 확장 또는 이전 코드 비교를 위해 타입에 남길 수 있다.
```

### bounds 규칙

```text
polygon의 모든 점을 포함하는 원본 이미지 픽셀 좌표 bounding box다.
workArea는 bounds에 SELECTION_PADDING_RATIO를 적용해 만든다.
outputBounds는 segmentation 결과 foregroundBounds에 output padding을 적용한다.
emergency fallback에서는 lasso bounds에 output padding을 적용한다.
```

### polygon point 규칙

```text
좌표는 원본 이미지 픽셀 좌표다.
첫 점을 마지막에 중복 저장하지 않는다.
렌더링과 mask fill 단계에서만 자동으로 close한다.
point 수는 화면 이동 거리 기준으로 샘플링해 제한한다.
```

## 상수 변경

기존 brush 상수는 lasso 전환 후 일부 삭제하거나 보존한다.

### 신규 상수 제안

```ts
export const LASSO_POINT_SPACING_CSS_PX = 4;
export const MIN_LASSO_POINTS = 6;
export const MIN_LASSO_AREA_PX = 64;
export const MIN_LASSO_BOUNDS_SIZE = 8;
export const NEAR_SEED_EXPANSION_PX = 12;
```

### 각 상수의 의미

```text
LASSO_POINT_SPACING_CSS_PX:
  포인터 이동 중 point를 저장할 최소 화면 거리.
  너무 작으면 point가 많아지고, 너무 크면 path가 각져 보인다.
  권장값은 4px.

MIN_LASSO_POINTS:
  닫힌 polygon으로 인정할 최소 point 수.
  권장값은 6.

MIN_LASSO_AREA_PX:
  polygon 내부 면적 최소값.
  너무 작은 실수 클릭이나 짧은 선을 거른다.
  권장값은 원본 이미지 픽셀 기준 64.

MIN_LASSO_BOUNDS_SIZE:
  bounds width/height 최소값.
  기존 MIN_OBJECT_SELECTION_SIZE 8을 재사용해도 된다.

NEAR_SEED_EXPANSION_PX:
  background sample에서 seed 주변을 제외하기 위한 local dilation 값.
  화면 기준이 아니라 workArea mask 픽셀 기준으로 쓰는 것을 권장한다.
```

### 유지할 상수

```text
MAX_DECODED_PIXELS
MAX_MASK_WORK_AREA_PIXELS
SELECTION_PADDING_RATIO
OUTPUT_PADDING_MIN_PX
OUTPUT_PADDING_RATIO
MIN_FOREGROUND_RATIO
MAX_FOREGROUND_RATIO
```

## Workbench UI 변경

### 상태 이름

현재 `WorkbenchState`의 `"selecting-object"`는 그대로 사용해도 된다.
브러쉬 전용 문구만 lasso 문구로 바꾼다.

```text
ready: Trace inside the object.
selecting-object: Drawing lasso seed...
processing-mask: Creating rough outline...
preview-ready: Preview ready
copied: Copied PNG
failed: 기존 에러 문구 유지
```

### pointer 이벤트 흐름

```text
pointerdown:
  sourceCanvas와 현재 state 확인
  displayPointToImagePoint(clientX, clientY)
  이미지 내부가 아니면 무시
  pointer capture 설정
  lassoState = { pointerId, polygon: [point] }
  기존 preview/png/mask 초기화
  state = selecting-object

pointermove:
  현재 pointerId와 lassoState 확인
  displayPointToImagePoint()
  이미지 바깥이면 마지막 유효 점을 유지하거나 edge clamp 정책 적용
  마지막 point와 거리 비교
  충분히 이동했으면 polygon에 point 추가
  draw()

pointerup:
  pointerId 확인
  selectionFromLassoPoints(lassoState.polygon)
  pointer capture 해제
  lassoState = null
  validation 실패 시 ready + Selection is too small
  성공 시 lastSelection = selection
  processSelection(selection)

pointercancel:
  lassoState = null
  ready 상태로 복귀

Escape:
  drawing 중이면 현재 lasso 취소
  preview가 있으면 resetSelection()
```

### 이미지 바깥으로 포인터가 나갈 때

추천은 "이미지 밖 point는 저장하지 않되 pointer capture는 유지"다.

```text
장점:
  실수로 이미지 밖으로 조금 나가도 드래그가 끊기지 않는다.
  polygon은 이미지 내부 점들만으로 구성되어 mask fill이 단순하다.

단점:
  사용자가 이미지 밖을 크게 돌아 다시 들어오면 path가 직선으로 이어질 수 있다.
```

대안은 이미지 가장자리로 clamp하는 방식이다.
이 경우 큰 물체가 이미지 경계에 붙어 있을 때 자연스럽지만, 사용자가 밖으로 나간 구간이 경계선을 따라 생기는 부작용이 있다.

### 렌더링

`draw()` 안에서 다음 순서로 그린다.

```text
canvas background
checker backdrop
source image
lastSelection lasso seed fill/stroke
preview mask overlay
lassoState live path fill/stroke
selection bounds
```

preview가 생긴 뒤에도 lasso seed outline을 희미하게 남길지 여부는 UX 결정이 필요하다.
권장은 preview와 bounds만 남기고 seed fill은 약하게 보여주는 것이다.

### lasso 시각 표현

```text
live path stroke: rgba(249,115,22,0.95)
live path fill: rgba(249,115,22,0.14)
closing segment: 같은 stroke 또는 dashed stroke
confirmed seed fill: rgba(249,115,22,0.10)
confirmed seed stroke: rgba(249,115,22,0.45)
```

현재 UI palette의 orange/teal과 일관된다.

## Lasso Selection 생성

### `selectionFromLassoPoints(points)` 알고리즘

```text
입력 points가 비어 있으면 empty lasso selection 반환
모든 point의 minX/minY/maxX/maxY 계산
bounds를 sourceCanvas 안쪽으로 clamp
polygonArea(points) 계산
kind: "lasso", bounds, polygon 반환
```

### polygon area

shoelace formula를 사용한다.

```ts
function polygonArea(points: ImagePixelPoint[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
}
```

### validation

```text
polygon point 수 < MIN_LASSO_POINTS 이면 실패
bounds width 또는 height < MIN_LASSO_BOUNDS_SIZE 이면 실패
polygonArea < MIN_LASSO_AREA_PX 이면 실패
workArea pixel count > MAX_MASK_WORK_AREA_PIXELS 이면 segmentation에서 emergency fallback
```

주의: 너무 큰 lasso 자체를 UI validation에서 막을지, segmentation fallback에 맡길지는 결정이 필요하다.

## Segmentation 변경

### 목표 구조

`createRoughMask()`가 brush에 직접 의존하지 않도록 seed mask 생성 계층을 분리한다.

```ts
type SeedMask = {
  mask: Uint8ClampedArray;
  foregroundCount: number;
  bounds: ImagePixelRect | null;
};

function createSeedMask(
  workArea: ImagePixelRect,
  selection: ObjectSeedSelection
): SeedMask;

function createNearSeedMask(
  workArea: ImagePixelRect,
  selection: ObjectSeedSelection
): Uint8ClampedArray;
```

### createRoughMask 흐름

```text
seedBounds = normalizeRect(selection.bounds)
if seedBounds invalid -> emergency

workArea = expandRectByRatio(seedBounds)
if workArea too large -> emergency

imageData = sourceCanvas.getImageData(workArea)
seedMask = createSeedMask(workArea, selection)
nearSeedMask = createNearSeedMask(workArea, selection)

foreground = sampleMean(seedMask 내부)
background = sampleBackground(nearSeedMask 바깥 또는 workArea border)

if foreground/background sample 없음 -> emergency

for each pixel:
  foregroundDistance = color distance to foreground mean
  backgroundDistance = color distance to background mean
  inSeed = seedMask[maskIndex] > 0
  nearSeed = nearSeedMask[maskIndex] > 0
  onBorder = workArea border
  score = backgroundDistance - foregroundDistance + seedPrior + borderPrior + roughNoise
  score > threshold => opaque

foregroundRatio validation
foregroundBounds/outputBounds 계산
```

### lasso seed mask 생성

두 가지 구현 방식이 있다.

#### 방식 A: offscreen canvas fill

```text
workArea 크기의 임시 canvas 생성
context.beginPath()
polygon point를 workArea local coordinate로 변환
moveTo 첫 점
lineTo 나머지 점
closePath()
fill()
getImageData alpha를 읽어 Uint8ClampedArray mask 생성
```

장점:

```text
구현이 짧고 브라우저 canvas polygon fill 규칙을 신뢰할 수 있다.
self-intersecting path도 canvas fill rule대로 처리된다.
현재 앱이 이미 canvas 중심이라 의존성이 늘지 않는다.
```

단점:

```text
임시 canvas와 getImageData 비용이 있다.
fill rule 세부 동작이 사용자 기대와 다를 수 있다.
```

#### 방식 B: scanline point-in-polygon

```text
workArea 각 픽셀 중심점에 대해 ray casting으로 polygon 내부 여부를 계산한다.
내부면 mask=255.
```

장점:

```text
DOM canvas 없이 순수 함수로 테스트하기 쉽다.
fill rule을 명시적으로 제어할 수 있다.
```

단점:

```text
O(workAreaPixels * polygonPoints)라 point가 많으면 느리다.
최적화가 필요해 MVP 구현량이 늘어난다.
```

권장: 방식 A.
MVP에서 단순하고, workArea pixel cap도 이미 존재한다.

### near seed mask 생성

foreground seed 주변을 background sample에서 제외하기 위한 mask다.
brush에서는 radiusMultiplier 3을 썼지만 lasso에서는 polygon 내부를 팽창시켜야 한다.

권장 방식:

```text
seed mask를 먼저 만든다.
nearSeedMask는 seed mask에 간단한 square dilation을 적용한다.
dilation radius = max(4, round(min(workArea.width, workArea.height) * 0.03))
상한은 32px 정도로 제한한다.
```

간단 구현:

```text
for each seed pixel:
  주변 [-radius, radius] 범위를 nearSeedMask=255
```

성능 개선:

```text
naive dilation은 seed pixel이 많으면 느릴 수 있다.
MVP에서는 workArea cap 4,000,000이 있으나, 큰 polygon에서는 부담이 된다.
초기 구현은 radius를 작게 제한하고, 문제 발생 시 2-pass distance transform 또는 separable dilation으로 바꾼다.
```

더 나은 MVP 구현:

```text
horizontal pass:
  seed pixel 주변 x 범위를 임시 mask에 칠함
vertical pass:
  임시 mask 주변 y 범위를 nearSeedMask에 칠함
```

하지만 코드 복잡도가 늘어난다.
처음 구현은 square dilation helper를 만들고, 테스트 후 필요하면 최적화한다.

### foreground/background sampling

foreground:

```text
seedMask 내부 픽셀을 sampling한다.
polygon이 넓을 수 있으므로 sampleMean의 stride는 기존처럼 유지한다.
```

background:

```text
workArea border 픽셀은 background 후보다.
nearSeedMask 바깥 픽셀도 background 후보다.
```

주의:

```text
lasso polygon이 물체 바깥까지 크게 잡히면 foreground sample이 오염된다.
workArea padding이 너무 작으면 background sample이 부족해질 수 있다.
```

### score prior 조정

기존 brush 값:

```text
inSeed: +38
nearSeed: +16
else: -12
border: -18
roughNoise: +/-15
threshold: 8
```

lasso에서는 seedMask가 brush보다 넓다.
inSeed prior가 너무 강하면 lasso 내부가 대부분 그대로 opaque가 될 수 있다.

권장 초기값:

```text
inSeed: +30
nearSeed: +10
else: -12
border: -18
roughNoise: +/-12
threshold: 8
```

보수적 대안:

```text
inSeed: +24
nearSeed: +8
else: -14
border: -18
roughNoise: +/-10
threshold: 8
```

튜닝은 manual test SVG와 실제 사진 몇 장으로 비교해야 한다.

## Emergency Mask 변경

### 추천 동작

lasso segmentation이 실패하면 lasso polygon 내부를 그대로 opaque로 출력한다.
이때 outputBounds는 lasso bounds + output padding이다.

```text
workArea = outputBounds
mask = createLassoMask(outputBounds, selection.polygon)
foregroundBounds = lasso bounds
foregroundRatio = seedMask.foregroundCount / mask.length
usedEmergency = true
```

### 장점

```text
사용자가 최소한 "선택한 내부 영역"을 받을 수 있다.
brush emergency의 blob 문제보다 예측 가능하다.
```

### 단점

```text
사용자가 path를 물체 안쪽에 그렸다면 fallback PNG는 물체 일부만 포함한다.
사용자가 path를 물체 외곽에 가깝게 그렸다면 fallback은 lasso cut처럼 보인다.
```

이 단점은 제품 문구와 온보딩으로 조절해야 한다.

## Preview/PNG 파이프라인

현재 preview와 PNG 생성은 `MaskResult`만 받으므로 유지 가능하다.

```text
createPreviewCanvas(result)
createPngBlob(sourceCanvas, result)
alphaAt(result, imageX, imageY)
isMaskEdge(...)
```

수정 필요성이 낮다.
다만 preview 위에 lasso seed outline을 그리는 위치는 `draw()`에서 결정한다.

## 코드 변경 계획

### 1단계: 타입과 상수

```text
src/shared/types.ts
  BrushSeedSelection, LassoSeedSelection, RectSeedSelection 추가
  ObjectSeedSelection을 union으로 변경

src/shared/constants.ts
  LASSO_POINT_SPACING_CSS_PX 추가
  MIN_LASSO_POINTS 추가
  MIN_LASSO_AREA_PX 추가
  MIN_LASSO_BOUNDS_SIZE 추가 또는 MIN_OBJECT_SELECTION_SIZE 재사용
  lasso로 완전 전환하면 brush-only 상수 제거 검토
```

### 2단계: workbench input state 전환

```text
BrushStrokeState -> LassoStrokeState
brushCursorPoint 제거 또는 lasso hover point로 대체
displayPointToBrushPoint 제거
brushRadiusImagePx 제거
brushPointSpacingImagePx -> lassoPointSpacingImagePx
selectionFromBrushPoints -> selectionFromLassoPoints
isBrushSelectionTooSmall -> isLassoSelectionTooSmall
drawBrushSeed -> drawLassoSeed
drawBrushCursor 제거
```

### 3단계: lasso drawing 구현

```text
drawLassoSeed(selection, style)
drawLassoPath(points, options)
drawSelectionBounds는 유지
```

렌더링 coordinate 변환은 현재와 동일하다.

```text
screenX = displayTransform.offsetX + imageX * displayTransform.scale
screenY = displayTransform.offsetY + imageY * displayTransform.scale
```

### 4단계: segmentation seed mask 추상화

```text
BrushMask 타입을 SeedMask로 rename
createBrushMask는 brush selection 처리 helper로 남김
createLassoMask(workArea, polygon) 추가
createSeedMask(workArea, selection) 추가
createNearSeedMask(workArea, selection) 추가
createEmergencyMask에서 selection.kind 분기
```

### 5단계: 문서 갱신

```text
README.md
  "Brush the object interior" -> "Trace inside the object" 흐름으로 변경
  seed lasso가 최종 경계선이 아니라 foreground hint임을 명시

PRD.md
  MVP 선택 방식 변경
  brush seed 항목을 lasso seed로 갱신
  알려진 한계와 테스트 항목 갱신

docs/seed-brush-change-plan.md
  과거 변경 계획으로 유지하거나 deprecated 표기

test-pages/manual.html
  안내 문구 변경
```

### 6단계: 검증

```text
npm run typecheck
npm run build
Chrome Load unpacked dist
manual.html로 일반 img, srcset, CSS background 선택
workbench에서 작은 lasso, 큰 lasso, 이미지 경계 lasso, self-intersect lasso 확인
Copy PNG 확인
```

현재 Codex 환경에는 npm이 없으므로 검증은 사용자의 로컬 Node/npm 설치 상태에 의존한다.

## 테스트 체크리스트

### 기본 동작

```text
원본 이미지 선택 후 workbench가 열린다.
이미지 내부 pointer down으로 lasso drawing이 시작된다.
drag 중 path와 내부 fill preview가 보인다.
pointer up 시 path가 자동으로 닫히고 rough preview가 생성된다.
Copy PNG가 enabled 된다.
Reset Selection이 lasso, preview, pngBlob을 모두 초기화한다.
Esc가 drawing 중에는 현재 lasso를 취소한다.
Esc가 preview 중에는 selection reset을 수행한다.
```

### 좌표/렌더링

```text
브라우저 zoom 125%에서 lasso path와 실제 seed mask 좌표가 맞는다.
workbench resize 후에도 lasso preview가 이미지 위에 맞는다.
긴 가로 이미지와 긴 세로 이미지에서 path가 맞는다.
devicePixelRatio가 2 이상이어도 path가 어긋나지 않는다.
```

### validation

```text
짧은 클릭/짧은 선은 Selection is too small.
너무 작은 polygon은 Selection is too small.
point 수는 충분하지만 면적이 거의 0인 선형 path는 실패한다.
```

### segmentation

```text
물체 안쪽에 작은 lasso를 그리면 rough contour가 물체 색상 쪽으로 확장된다.
물체 내부 대부분을 lasso로 잡으면 preview가 안정적이다.
배경을 많이 포함한 lasso에서는 결과가 나빠질 수 있지만 앱은 실패하지 않는다.
workArea가 너무 크면 emergency fallback으로 lasso 내부 PNG가 생성된다.
foreground ratio가 너무 작거나 크면 emergency fallback이 동작한다.
```

### edge cases

```text
이미지 가장자리 근처 lasso.
이미지 밖으로 포인터가 잠깐 나갔다가 들어오는 lasso.
self-intersecting lasso.
같은 지점을 빙글빙글 도는 lasso.
큰 이미지에서 큰 lasso.
투명 PNG/GIF 원본.
data URL SVG 원본.
cross-origin CDN 이미지 fetch 성공/실패.
```

## 리스크 검토

### 사용자 기대 오해

사용자가 lasso path를 최종 cut boundary로 이해할 가능성이 높다.

완화:

```text
상태 문구를 "Trace inside the object"로 둔다.
README에 lasso는 final mask line이 아니라 foreground seed라고 설명한다.
preview에서 lasso 선보다 rough mask edge를 더 강조한다.
```

### foreground 오염

사용자가 배경까지 크게 둘러싸면 foreground mean이 오염된다.

완화:

```text
문구를 "inside"로 유지한다.
필요 시 foreground sample을 polygon 전체가 아니라 중심부/내부 erosion 영역으로 제한하는 후속 개선을 검토한다.
```

### lasso 내부가 너무 넓은 경우

큰 polygon은 workArea가 커지고 mask 생성과 getImageData가 부담된다.

완화:

```text
MAX_MASK_WORK_AREA_PIXELS를 유지한다.
초과하면 emergency fallback 또는 "Selection is too large" 처리 중 하나를 선택한다.
```

### self-intersecting path

복잡하게 꼬인 path의 내부 정의가 사용자 기대와 다를 수 있다.

완화:

```text
MVP에서는 canvas fill rule에 맡긴다.
문서에는 복잡하게 꼬인 lasso가 예측 불가능할 수 있다고 남긴다.
```

### 코드 복잡도 증가

brush와 lasso를 모두 유지하면 상태/렌더링/문서가 늘어난다.

완화:

```text
MVP는 lasso 단일화로 간다.
공통 seed mask 추상화만 남겨 후속 brush 복구 가능성을 유지한다.
```

## 모호한 결정 지점

### Q1. MVP 선택 도구 범위

추천: A

```text
A. brush를 UI에서 제거하고 lasso seed만 제공한다.
   장점: 단순하고 사용자 혼란이 적다.
   단점: brush가 유용한 경우를 잃는다.

B. brush와 lasso를 둘 다 제공하고 toggle을 둔다.
   장점: 상황별 선택 가능.
   단점: UI/상태/문서/테스트가 커진다.

C. brush를 기본으로 유지하고 lasso를 실험 옵션으로 숨긴다.
   장점: 기존 구현 리스크가 낮다.
   단점: 지금 느낀 문제를 근본적으로 해결하지 못한다.
```

### Q2. lasso의 의미

추천: A

```text
A. lasso 내부는 foreground seed이고, 최종 경계는 segmentation이 만든다.
   장점: 제품의 rough segmentation 원칙과 맞다.
   단점: 사용자가 그은 선과 결과 경계가 다를 수 있다.

B. lasso 내부를 그대로 최종 mask로 쓴다.
   장점: 사용자가 결과를 예측하기 쉽다.
   단점: 사실상 수동 올가미 crop 도구가 되어 제품 방향이 바뀐다.

C. 일반 상황은 seed로 쓰고 fallback만 final lasso mask로 쓴다.
   장점: 실패해도 결과물이 나온다.
   단점: fallback 때만 동작 의미가 달라진다.
```

실제 구현 추천은 A + emergency fallback은 C의 일부다.

### Q3. path 닫기 방식

추천: A

```text
A. pointer up 시 자동으로 첫 점과 마지막 점을 닫는다.
   장점: 가장 빠르고 모바일/트랙패드 친화적이다.
   단점: 사용자가 의도치 않게 열어둔 선도 닫힌다.

B. 시작점 근처로 돌아왔을 때만 닫고, 아니면 실패한다.
   장점: 전통적인 lasso 느낌이다.
   단점: 빠른 MVP 사용성이 떨어진다.

C. double click 또는 Enter로 닫는다.
   장점: 정밀한 path 작성이 가능하다.
   단점: MVP 흐름이 느려지고 설명이 필요하다.
```

### Q4. 이미지 밖 드래그 처리

추천: A

```text
A. 이미지 밖 point는 저장하지 않고 pointer capture는 유지한다.
   장점: 구현이 단순하고 좌표가 안전하다.
   단점: 밖으로 나갔다 들어온 구간이 직선으로 이어질 수 있다.

B. 이미지 밖 point를 이미지 경계로 clamp한다.
   장점: 가장자리 물체를 둘러싸기 쉽다.
   단점: 의도치 않은 경계선 구간이 생길 수 있다.

C. 이미지 밖으로 나가면 drawing을 취소한다.
   장점: 결과가 명확하다.
   단점: 사용감이 나쁘다.
```

### Q5. 큰 lasso 처리

추천: B

```text
A. 너무 크면 "Selection is too large"로 실패 처리한다.
   장점: 사용자가 다시 선택하게 되어 성능이 안정적이다.
   단점: 결과물을 얻지 못한다.

B. rough segmentation이 너무 크면 emergency fallback으로 lasso 내부 PNG를 만든다.
   장점: 사용자가 최소 결과물을 얻는다.
   단점: 큰 polygon mask fill 비용은 여전히 든다.

C. downsampled workArea로 rough segmentation을 계산한다.
   장점: 큰 선택에서도 rough 결과를 만들 수 있다.
   단점: 구현량이 MVP 범위를 넘을 수 있다.
```

### Q6. self-intersecting lasso 처리

추천: A

```text
A. 허용하고 canvas fill rule 결과를 사용한다.
   장점: 구현이 단순하다.
   단점: 꼬인 path 결과가 예측과 다를 수 있다.

B. self-intersection을 감지해 실패 처리한다.
   장점: 이상한 결과를 줄인다.
   단점: 교차 감지 구현이 늘어난다.

C. path simplification으로 일부 교차를 완화한다.
   장점: 노이즈가 줄 수 있다.
   단점: 사용자가 그린 모양과 달라질 수 있다.
```

### Q7. 기존 brush 코드 보존 방식

추천: B

```text
A. brush 관련 타입/함수/상수를 모두 삭제한다.
   장점: 코드가 작아진다.
   단점: 되돌리거나 비교하기 어렵다.

B. UI에서는 제거하지만 seed mask abstraction 안에 brush helper는 남긴다.
   장점: 후속 toggle 추가가 쉽고 리스크가 낮다.
   단점: 당장 쓰지 않는 코드가 일부 남는다.

C. 별도 git branch 또는 문서만 남기고 코드에서는 삭제한다.
   장점: 런타임 코드가 깨끗하다.
   단점: 후속 복구 시 git history를 봐야 한다.
```

### Q8. confirmed lasso 표시

추천: B

```text
A. preview 후 lasso seed를 계속 강하게 표시한다.
   장점: 사용자가 seed 위치를 명확히 본다.
   단점: rough mask edge와 시각적으로 경쟁한다.

B. preview 후 lasso seed는 약하게 표시하고 rough mask edge를 강조한다.
   장점: 최종 결과에 시선이 간다.
   단점: seed 확인성은 조금 줄어든다.

C. preview 후 lasso seed를 숨긴다.
   장점: 결과가 깔끔하다.
   단점: 사용자가 어떤 seed로 나온 결과인지 확인하기 어렵다.
```

## 최종 권장안 요약

```text
선택 도구: lasso seed 단일화
lasso 의미: final boundary가 아니라 foreground seed
path 닫기: pointer up 자동 close
이미지 밖 처리: 밖 point 무시 + pointer capture 유지
mask 생성: canvas fill 기반 lasso mask
near seed: seed mask dilation
fallback: lasso 내부 opaque PNG
기존 brush: UI 제거, seed abstraction에서 helper 보존 가능
```

이 방향은 현재 ImageThief의 "빠른 rough cut" 원칙을 유지하면서, 사용자가 seed 의도를 더 명확하게 전달하게 만든다.
