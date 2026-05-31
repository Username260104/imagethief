# 연결 확장 구현 계획

## 구현 상태

이 문서의 방향대로 구현을 진행했다.
현재 `createRoughMask()`는 연결 확장을 먼저 시도하고, 연결 확장이 실패하거나 비정상 결과를 만들면 기존 rectangular scoring으로 fallback한다.

후속 수정 반영:

```text
seed 내부 픽셀을 connected growth 초기 mask에 바로 포함하던 문제를 수정했다.
lasso 내부도 최종 selection에서는 같은 score 기준을 통과해야 한다.
세부 기준은 docs/lasso-seed-final-acceptance-plan.md에 정리했다.
```

구현 반영 사항:

```text
8방향 queue 기반 연결 확장
foreground 평균은 최초 seed 내부 평균으로 고정
확장 슬라이더는 growthArea와 연결 성장 score 기준에 함께 반영
growthArea/visited/accepted pixel cap 추가
cap에 닿으면 현재까지 확장된 mask 사용
연결 확장 결과가 너무 큰 경우 rectangular fallback
연결 확장에서는 전체 이미지 탐색 가능성을 고려해 foregroundRatio 하한 guard를 적용하지 않음
```

## 목적

현재 lasso seed 기반 rough mask는 seed bounds를 사각형 workArea로 확장한 뒤, 그 사각형 내부의 모든 픽셀을 독립적으로 scoring한다.
이 방식은 lasso 주변으로 어느 정도 확장되지만, 물체가 사각형 workArea 밖으로 이어져 있어도 더 따라가지 못한다.

연결 확장은 lasso 내부 seed에서 시작해 색상/score가 충분히 연관된 인접 픽셀을 queue 방식으로 계속 편입하는 방식이다.
목표는 "seed와 연결된 물체 영역이 끝날 때까지" 더 자연스럽게 확장하는 것이다.

## 확정 방향

사용자 결정에 따라 다음 추천안을 그대로 채택한다.

```text
Q1: 연결 확장을 기본 알고리즘으로 교체
Q2: 8방향 연결 사용
Q3: 이미지 전체까지 탐색 가능, 최대 픽셀 수로 안전 제한
Q4: RGB 거리 기준 유지
Q5: foreground 평균은 처음 lasso 내부 평균으로 고정
Q6: 한계에 닿으면 현재까지 확장된 결과를 사용
Q7: 기존 확장 슬라이더에 연결 확장 관대함을 합침
Q8: 기존 rectangular scoring은 내부 fallback으로 보존
```

## 현재 알고리즘과 차이

### 현재 방식

```text
lasso seed mask 생성
seed bounds + padding으로 workArea 생성
workArea 내부 모든 픽셀을 독립 scoring
score > threshold면 foreground
foreground ratio가 비정상이면 emergency fallback
```

특징:

```text
workArea 바깥은 절대 보지 않는다.
픽셀 간 연결성은 고려하지 않는다.
seed와 떨어진 비슷한 색 픽셀도 foreground가 될 수 있다.
긴 물체가 사각형 밖으로 이어지면 중간에서 잘린다.
```

### 연결 확장 방식

```text
lasso seed mask 생성
seed 내부 픽셀을 queue에 넣는다
queue에서 픽셀을 하나 꺼낸다
8방향 이웃을 검사한다
이웃 픽셀이 아직 방문되지 않았고 score가 기준 이상이면 foreground로 편입한다
새 foreground 픽셀을 queue에 넣는다
queue가 비거나 안전 한계에 닿으면 종료한다
```

특징:

```text
seed와 연결된 픽셀만 결과에 들어간다.
사각형 workArea 한계에 덜 묶인다.
긴 물체나 비정형 물체를 더 자연스럽게 따라간다.
배경과 비슷한 색으로 연결되면 번질 수 있으므로 안전장치가 필요하다.
```

## 추천 구현 구조

`createRoughMask()` 안에 연결 확장 경로를 기본으로 넣고, 기존 사각형 scoring은 fallback 함수로 분리한다.

```ts
export function createRoughMask(
  sourceCanvas: HTMLCanvasElement,
  selection: ObjectSeedSelection,
  options: MaskTuningOptions = DEFAULT_MASK_TUNING_OPTIONS
): MaskResult {
  const tuning = resolveMaskTuning(options);
  const connectedResult = createConnectedMask(sourceCanvas, selection, tuning);
  if (connectedResult) {
    return connectedResult;
  }
  return createRectangularScoredMask(sourceCanvas, selection, tuning);
}
```

MVP에서는 `connectedResult`가 safety limit에 닿아도 null을 반환하지 않고 현재까지의 mask를 사용한다.
null은 seed/background sample 자체가 불가능한 경우처럼 치명적인 상황에만 사용한다.

## 데이터 구조

### GrowthArea

연결 확장은 이미지 전체를 탐색 가능하게 하되, 실제로는 typed array 크기와 처리량 때문에 탐색 영역이 필요하다.

권장:

```text
sourceCanvas 전체를 coordinate space로 사용한다.
visited/mask는 source image 전체 크기의 Uint8Array로 둔다.
이미지 최대 크기는 MAX_DECODED_PIXELS로 이미 제한되어 있다.
64MP 전체 Uint8Array 두 개는 약 128MB라 부담이 있을 수 있다.
```

더 안전한 MVP:

```text
탐색 영역을 동적으로 넓히되, 초기 구현은 source image 전체 rect를 growthArea로 둔다.
MAX_GROWTH_VISITED_PIXELS로 실제 방문 픽셀 수를 제한한다.
large image에서는 기존 MAX_MASK_WORK_AREA_PIXELS보다 약간 큰 별도 cap을 둔다.
```

최종 추천:

```text
source image 전체 getImageData는 피한다.
growthArea는 seed bounds를 크게 확장한 사각형으로 시작한다.
확장 슬라이더가 커질수록 growthArea를 더 크게 잡는다.
단, growthArea가 커도 queue는 연결된 픽셀만 방문한다.
```

이 방식은 "이미지 전체까지 탐색 가능" 요구와 성능 사이의 절충이다.
확장 슬라이더 최대값에서는 source image 전체까지 growthArea가 넓어질 수 있다.

### Queue

브라우저에서 `Array.shift()`는 느릴 수 있으므로 typed array queue를 사용한다.

```ts
const queue = new Int32Array(maxQueueSize);
let queueStart = 0;
let queueEnd = 0;
```

index는 local coordinate를 1D index로 저장한다.

```text
index = localY * growthArea.width + localX
```

### Visited

```ts
const visited = new Uint8Array(growthArea.width * growthArea.height);
const mask = new Uint8ClampedArray(growthArea.width * growthArea.height);
```

visited:

```text
0 = 미방문
1 = 방문 완료 또는 queue 등록
```

mask:

```text
0 = transparent
255 = foreground
```

## GrowthArea 산정

기본값:

```text
seedBounds를 기준으로 growth padding을 계산한다.
growth padding은 max(seedBounds.width, seedBounds.height)에 비례한다.
확장 슬라이더 값이 클수록 더 넓어진다.
```

권장 매핑:

```text
baseGrowthRatio = 0.35
expansionBoost = expansionNormalized * 1.4
growthRatio = clamp(baseGrowthRatio + expansionBoost, 0.12, 1.75)
growthArea = expandRectByRatio(seedBounds, growthRatio)
```

`expansionNormalized`:

```text
expansion UI 값 -50 ~ +50을 0 ~ 1로 변환한다.
expansionNormalized = (expansion + 50) / 100
```

특이점:

```text
확장 값이 낮아도 기존 0.08보다 넓은 0.12 이상을 사용한다.
확장 값이 높으면 seed bounds의 175%까지 탐색한다.
그래도 source image 전체를 넘지는 않는다.
```

이미지 전체까지 허용하는 옵션:

```text
expansion >= 45이면 growthArea를 source image 전체로 확장한다.
```

이렇게 하면 사용자가 명시적으로 확장을 크게 올렸을 때 긴 물체를 끝까지 따라갈 기회를 준다.

## 샘플링

### Foreground

foreground 평균은 lasso seed 내부로 고정한다.

```text
seedMask 내부 픽셀을 sampleMean한다.
region growing 중 새로 편입된 픽셀로 평균을 업데이트하지 않는다.
```

이유:

```text
평균을 계속 업데이트하면 배경으로 번진 뒤 배경 색까지 foreground로 학습할 수 있다.
고정 foreground는 더 보수적이고 예측 가능하다.
```

### Background

background 평균은 seed 주변 ring과 growthArea border에서 샘플링한다.

현재 코드의 background sampling:

```text
workArea border
nearSeedMask 바깥
```

연결 확장용 권장:

```text
seed를 dilation한 nearSeedMask를 만든다.
background 후보는 nearSeedMask 바깥 + growthArea border다.
```

주의:

```text
growthArea가 이미지 전체로 커질 경우 border 샘플이 물체와 너무 멀 수 있다.
그래도 background 평균의 안정성에는 유리하다.
```

## 픽셀 편입 score

final acceptance score는 seed 내부/외부에 같은 기준을 적용한다.

```text
foregroundDistance = colorDistance(pixel, foregroundMean)
backgroundDistance = colorDistance(pixel, backgroundMean)
onBorder = growthArea border
borderPrior = onBorder ? borderPenalty : 0
roughNoise = (hashNoise(imageX, imageY) - 0.5) * roughNoiseAmount
score = backgroundDistance - foregroundDistance + borderPrior + roughNoise
accept if score > scoreThreshold
```

연결 확장에서는 seed 내부를 시작 frontier로 사용한다.
seed 내부 픽셀도 final mask에 들어가려면 같은 score 기준을 통과해야 한다.
final acceptance에서는 seed prior를 적용하지 않는다.

이웃 픽셀에는 score를 적용한다.

## 이웃 연결

8방향 연결을 사용한다.

```text
[-1, -1], [0, -1], [1, -1]
[-1,  0],          [1,  0]
[-1,  1], [0,  1], [1,  1]
```

장점:

```text
대각선으로 이어진 물체를 자연스럽게 따라간다.
브러시/올가미 도구의 기대감에 더 가깝다.
```

리스크:

```text
대각선 한 픽셀 연결만으로 얇게 새는 경우가 생길 수 있다.
```

완화:

```text
score threshold와 edgeCleanup이 이를 제어한다.
필요하면 후속으로 diagonal acceptance에 더 높은 threshold를 줄 수 있다.
```

## 종료 조건

### 정상 종료

```text
queue가 비면 종료한다.
```

이는 "연결된 후보 픽셀이 더 이상 없다"는 의미다.

### 안전 종료

다음 중 하나에 닿으면 현재까지의 결과를 사용한다.

```text
accepted foreground count > maxAcceptedPixels
visited count > maxVisitedPixels
processing budget 초과
```

권장 기본값:

```text
maxGrowthAreaPixels = 12_000_000
maxVisitedPixels = min(growthAreaPixels, 6_000_000)
maxAcceptedPixels = min(growthAreaPixels, 4_000_000)
```

MVP에서는 processing time budget은 생략해도 된다.
대신 typed array cap을 명확히 둔다.

### 비정상 종료

다음 경우에는 기존 rectangular scoring fallback을 사용한다.

```text
foreground sample count === 0
background sample count === 0
seedMask foregroundCount === 0
growthArea 생성 실패
growthArea pixel cap 초과
foreground ratio가 너무 큰 경우
```

연결 확장은 full image growth를 허용하므로 foreground ratio가 작다는 이유만으로 실패시키지 않는다.
작은 물체가 큰 이미지 안에서 정상적으로 선택될 수 있기 때문이다.

foreground ratio가 너무 큰 경우:

```text
연결 확장 결과가 있으면 바로 emergency fallback하지 않고 rectangular fallback을 한 번 시도한다.
rectangular fallback도 비정상이면 emergency fallback한다.
```

## MaskResult 생성

연결 확장 결과도 기존 `MaskResult`를 그대로 반환한다.

```text
workArea = growthArea
width = growthArea.width
height = growthArea.height
mask = connected mask
foregroundBounds = accepted foreground bounds
outputBounds = foregroundBounds + output padding
foregroundRatio = acceptedCount / growthAreaPixels
usedEmergency = false
```

preview/PNG 생성은 기존 파이프라인을 그대로 사용한다.

## 파라미터와 연결

기존 패널 항목을 새 알고리즘에 매핑한다.

### 민감도

```text
scoreThreshold를 낮춰 더 많은 이웃 픽셀을 편입한다.
```

현재 매핑 유지:

```text
scoreThreshold = 8 - sensitivity * 0.4
```

### 확장

두 역할을 한다.

```text
growthArea를 넓힌다.
nearSeedDilationRatio를 키워 background sample에서 seed 주변을 더 제외한다.
growthScoreThreshold를 낮춰 연결된 이웃 픽셀 편입을 더 관대하게 한다.
```

추가 매핑:

```text
growthRatio = clamp(0.35 + ((expansion + 50) / 100) * 1.4, 0.12, 1.75)
growthScoreThreshold = scoreThreshold - expansion * 0.12
if expansion >= 45:
  growthArea = full image
```

### 가장자리 정리

```text
growthArea border 근처 픽셀의 score를 낮춘다.
background border sampling 폭을 조정한다.
```

기존 매핑 유지.

### 시드 영향

```text
nearSeedDilationRatio에 영향을 준다.
seed 주변 픽셀을 background sample에서 얼마나 강하게 제외할지 조절한다.
```

final acceptance에서는 seed 내부 여부에 따른 가산점을 쓰지 않는다.
따라서 시드 영향은 "seed 내부 보장"이 아니라 샘플링 안정화에 가깝다.

### 거칠기

```text
roughNoiseAmount 유지.
```

주의:

```text
region growing에서 noise가 크면 얇은 leak path가 생길 수 있다.
기본 roughness 24는 유지하되, 사용자가 낮출 수 있게 둔다.
```

### 출력 여백

```text
outputBounds 계산에만 사용한다.
```

## 코드 변경 계획

### 1단계: tuning 타입 확장

`ResolvedMaskTuning`에 다음을 추가한다.

```ts
growthScoreThreshold: number;
growthRatio: number;
useFullImageGrowth: boolean;
maxVisitedPixels: number;
maxAcceptedPixels: number;
```

`MaskTuningOptions` UI 필드는 추가하지 않는다.
`확장` 슬라이더에서 파생한다.

### 2단계: 기존 알고리즘 함수 분리

현재 `createRoughMask()` 본문을 `createRectangularScoredMask()`로 옮긴다.

```ts
function createRectangularScoredMask(
  sourceCanvas: HTMLCanvasElement,
  selection: ObjectSeedSelection,
  tuning: ResolvedMaskTuning
): MaskResult
```

### 3단계: connected growth 함수 추가

```ts
function createConnectedMask(
  sourceCanvas: HTMLCanvasElement,
  selection: ObjectSeedSelection,
  tuning: ResolvedMaskTuning
): MaskResult | null
```

실패 attempt는 fallback이나 low-confidence 처리가 필요한 상황을 의미한다.

### 4단계: growthArea 생성

```ts
function createGrowthArea(
  seedBounds: ImagePixelRect,
  sourceWidth: number,
  sourceHeight: number,
  tuning: ResolvedMaskTuning
): ImagePixelRect
```

### 5단계: queue 초기화

seedMask 내부 foreground 픽셀은 queue 시작점으로 등록한다.
다만 mask에는 score를 통과한 픽셀만 넣는다.

```text
for each seed pixel:
  visited[index] = 1
  queue[queueEnd++] = index
  if scoreAccepted:
    mask[index] = 255
    acceptedCount++
```

성능 개선:

```text
seed pixel이 너무 많으면 stride 없이 전부 queue에 넣어도 된다.
lasso seed 자체가 크면 queue도 크지만 초기 foreground가 넓다는 뜻이다.
```

### 6단계: growth loop

```text
while queueStart < queueEnd:
  current = queue[queueStart++]
  for each 8-neighbor:
    if outside growthArea continue
    if visited continue
    visited = 1
    visitedCount++
    if scoreAccepted:
      mask = 255
      acceptedCount++
      queue[queueEnd++] = neighbor
      update foreground bounds
    if visitedCount or acceptedCount exceeds limit:
      stop and return current result
```

### 7단계: validation/fallback

```text
if acceptedCount === 0:
  return null

foregroundRatio = acceptedCount / mask.length
if foregroundRatio > MAX_FOREGROUND_RATIO:
  return null

return MaskResult
```

연결 확장에서는 growthArea가 source image 전체까지 커질 수 있으므로 `MIN_FOREGROUND_RATIO` 하한은 적용하지 않는다.

`createRoughMask()`는 null이면 rectangular fallback을 호출한다.

### 8단계: 문서/README 갱신

README에는 `확장`이 연결된 영역을 더 멀리 따라간다는 설명을 추가한다.
테스트 체크리스트에는 긴 물체/사각형 밖 확장 사례를 추가한다.

## 테스트 계획

### 수동 테스트

```text
긴 물체의 중간만 lasso로 seed 지정 후 끝까지 따라가는지 확인
가늘게 이어진 물체가 대각선 방향으로 이어질 때 따라가는지 확인
비슷한 색 배경으로 새는 경우 민감도/가장자리 정리로 줄일 수 있는지 확인
확장 값을 낮추면 더 보수적으로 멈추는지 확인
확장 값을 높이면 더 멀리 따라가는지 확인
거칠기를 낮추면 leak path가 줄어드는지 확인
큰 이미지에서 UI가 지나치게 멈추지 않는지 확인
foreground ratio 상한 guard가 비정상적으로 큰 결과를 막는지 확인
rectangular fallback과 emergency fallback이 여전히 동작하는지 확인
```

### 빌드 검증

```text
npm run typecheck
npm run build
Chrome Load unpacked dist
```

## 리스크 검토

### 1. 배경으로 새는 문제

연결 확장은 색상이 이어져 있으면 배경으로 계속 번질 수 있다.

완화:

```text
foreground 평균을 고정한다.
background 평균을 nearSeed 바깥과 border에서 샘플링한다.
maxAcceptedPixels와 maxVisitedPixels를 둔다.
민감도/가장자리 정리/거칠기로 사용자가 제어할 수 있게 한다.
```

### 2. 큰 이미지 성능

source image 전체를 탐색하면 메모리와 시간이 커질 수 있다.

완화:

```text
growthArea를 expansion 기반으로 제한한다.
확장 최대값일 때만 full image growth를 허용한다.
visited/accepted cap을 둔다.
기존 MAX_DECODED_PIXELS와 MAX_MASK_WORK_AREA_PIXELS를 유지한다.
```

### 3. seed가 너무 넓은 경우

lasso 내부가 이미 배경을 많이 포함하면 foreground 평균이 오염된다.

완화:

```text
foreground 평균 업데이트를 하지 않는다.
후속 개선으로 lasso 내부 erosion sample을 검토한다.
```

### 4. outputBounds가 너무 커지는 경우

연결 확장이 멀리 가면 output PNG가 커질 수 있다.

완화:

```text
maxAcceptedPixels cap을 둔다.
outputBounds는 foregroundBounds 기준으로만 계산한다.
```

### 5. 기존 파라미터 의미 변화

`확장`이 기존에는 사각형 workArea padding에 가까웠지만, 이제 연결 성장 범위를 조정한다.

완화:

```text
README와 계획 문서에 확장 의미를 갱신한다.
UI label은 그대로 "확장"이 적절하다.
```

## 최종 권장안

다음 형태로 구현한다.

```text
createRoughMask:
  1. connected growth 시도
  2. 실패 또는 비정상 결과이면 rectangular scoring fallback
  3. fallback도 실패하면 emergency mask

growth:
  8방향 queue 기반
  foreground 평균 고정
  RGB distance score 유지
  expansion slider로 growthArea와 관대함 제어
  cap 도달 시 현재 결과 사용
```

이 설계는 현재 ImageThief의 rough MVP 성격을 유지하면서, "seed에서 연결된 물체를 끝까지 따라간다"는 사용자의 기대에 훨씬 가깝다.
