# Lasso seed final acceptance 수정 계획

## 구현 상태

이 계획은 구현에 반영되었다.

```text
connected growth에서 seed 내부 픽셀은 queue 시작점으로만 먼저 등록한다.
seed 내부 픽셀도 final mask에 들어가려면 useSeedPrior=false score를 통과해야 한다.
rectangular fallback도 같은 final acceptance score를 사용한다.
low-confidence 실패에서는 lasso 내부 opaque fallback을 반환하지 않는다.
technical failure에서만 emergency fallback을 유지한다.
workbench는 low-confidence 실패 시 선택을 유지하고 파라미터 조정을 허용한다.
```

## 목적

현재 lasso seed는 "최종 mask 경계"가 아니라 foreground seed로 정의되어 있다.
기존 연결 확장 구현에서는 normal path에서 lasso 내부 픽셀이 score 검사 없이 곧바로 최종 mask에 들어갔다.

이 문서의 목적은 lasso 내부 픽셀도 최종 선택 단계에서는 다른 픽셀과 같은 acceptance 기준을 통과하도록 수정하는 것이다.

## 현재 문제

수정 전 `createConnectedMask()` 초기화 흐름은 다음과 같았다.

```text
seedMask 생성
seedMask 내부 픽셀을 전부 visited 처리
seedMask 내부 픽셀을 전부 mask = 255 처리
seedMask 내부 픽셀을 전부 queue에 등록
이후 queue에서 주변 픽셀만 score 검사
```

문제 지점:

```ts
for each seed pixel:
  visited[index] = 1
  mask[index] = 255
  queue[queueEnd++] = index
  acceptedCount++
```

이 흐름에서는 lasso 내부에 배경 픽셀이 섞여도 그 픽셀은 최종 PNG에 100% 포함된다.
즉 seed가 "힌트"가 아니라 "강제 foreground"가 된다.

추가로 현재 score 함수는 seed 내부 픽셀에 `inSeedPrior`를 더한다.
따라서 seed 내부 픽셀에 score 검사를 적용하더라도, 기존 prior를 그대로 쓰면 "거의 무조건 통과" 문제가 남을 수 있다.

## 수정 원칙

```text
lasso 내부는 final boundary가 아니다.
seed pixel도 최종 mask에 들어가려면 score 기준을 통과해야 한다.
seed는 sampling, background 제외, growth 시작 frontier로만 사용한다.
최종 acceptance에서는 inSeedPrior로 seed 내부를 특별 대우하지 않는다.
fallback이 normal path의 의미를 뒤집지 않도록 confidence failure와 technical failure를 분리한다.
```

## 권장 설계

### 1. Seed 역할 분리

수정 후 seedMask의 역할을 다음처럼 분리한다.

```text
foreground sample source:
  foreground 평균을 계산하기 위한 후보 영역

near seed / background exclusion:
  background 평균 계산에서 seed 주변을 제외하기 위한 영역

growth frontier:
  connected growth가 시작되는 좌표 집합

final mask:
  seed 자체가 final mask는 아니다
```

핵심은 seed pixel을 queue 시작점으로는 사용할 수 있지만, mask에 넣을지는 score가 결정한다는 점이다.

### 2. Final acceptance score에서 seed bias 제거

현재 score는 다음 구조다.

```text
foregroundDistance = colorDistance(pixel, foregroundMean)
backgroundDistance = colorDistance(pixel, backgroundMean)
seedPrior = inSeed ? inSeedPrior : nearSeed ? nearSeedPrior : outsideSeedPrior
score = backgroundDistance - foregroundDistance + seedPrior + borderPrior + roughNoise
```

수정 후 final acceptance에서는 seedPrior를 제거한다.

```text
evidenceScore = backgroundDistance - foregroundDistance + borderPrior + roughNoise
accepted = evidenceScore > threshold
```

이 기준은 seed 내부/외부 모든 픽셀에 동일하게 적용된다.

`시드 영향` 파라미터는 final acceptance 직접 가산점으로 쓰지 않는다.
후속으로 필요하면 foreground sampling 안정화, near seed exclusion 폭, bootstrap 보조 정도에만 연결한다.

### 3. Connected growth 초기화 변경

수정 전에는 seed pixel을 곧바로 foreground로 확정했다.
수정 후에는 seed pixel을 "frontier"로 등록하되, mask에는 score 통과 픽셀만 넣는다.

권장 흐름:

```text
for each seed pixel:
  visited[index] = 1
  queue[queueEnd++] = index

  score = scoreFinalPixel(index, useSeedPrior = false)
  if score > growthScoreThreshold:
    mask[index] = 255
    acceptedCount++
    update foreground bounds
```

이 방식의 장점:

```text
lasso 내부 배경 픽셀이 자동 선택되지 않는다.
seed 내부에서 score를 통과한 픽셀은 정상적으로 결과에 들어간다.
score를 통과하지 못한 seed pixel도 시작 frontier 역할은 하므로, object가 lasso 경계 밖으로 이어져 있으면 주변으로 탐색할 수 있다.
```

주의:

```text
rejected seed pixel은 mask에는 들어가지 않지만 queue source로는 쓴다.
non-seed neighbor는 score를 통과할 때만 queue에 들어간다.
이렇게 해야 seed가 "시작 힌트"이고, 일반 픽셀은 "증거가 있을 때만 확장"되는 구조가 된다.
```

### 4. Queue cap 기준 조정

현재 queue는 `maxAcceptedPixels` 크기로 만들어져 있다.
수정 후에는 rejected seed pixel도 queue에 들어갈 수 있으므로 queue cap은 accepted cap이 아니라 visited cap 기준이어야 한다.

권장:

```text
queue = new Int32Array(maxVisitedPixels)
if seedMask.foregroundCount > maxVisitedPixels:
  connected growth 실패 처리
```

accepted cap은 여전히 최종 foreground 픽셀 수 제한에만 쓴다.

```text
maxVisitedPixels: 탐색/queue 안전 한계
maxAcceptedPixels: 최종 foreground 안전 한계
```

### 5. Neighbor growth 변경

neighbor는 기존과 비슷하지만 final score에서 seed bias를 제거한다.

```text
for each 8-neighbor:
  if outside growthArea continue
  if visited continue

  visited = 1
  visitedCount++

  score = scoreFinalPixel(neighbor, useSeedPrior = false)
  if score > growthScoreThreshold:
    mask = 255
    queue push
    acceptedCount++
    update foreground bounds
```

seed 내부 여부는 acceptance에 영향을 주지 않는다.
연결성과 color/background evidence가 결과를 결정한다.

### 6. Rectangular fallback도 같은 기준 사용

기존 rectangular scoring fallback은 모든 픽셀을 score 검사하긴 하지만, seed 내부에 `inSeedPrior`를 준다.
따라서 연결 확장만 고치면 fallback에서 seed 내부가 다시 과하게 선택될 수 있다.

수정 방향:

```text
createRectangularScoredMask도 final acceptance score에서는 useSeedPrior = false 사용
seed는 foreground/background sample과 nearSeedMask에만 사용
```

이렇게 해야 connected path와 rectangular fallback의 의미가 일관된다.

## Fallback 정책 검토

현재 emergency fallback은 lasso 내부 seed mask를 그대로 opaque로 만든다.
이는 기술적 장애가 있을 때는 유용하지만, "score 기준을 통과하지 못했다"는 confidence failure에 쓰면 이번 문제를 다시 만든다.

따라서 fallback 실패 유형을 나누는 것이 좋다.

### Technical failure

예:

```text
canvas context 없음
getImageData 실패
foreground/background sample 자체를 만들 수 없음
growthArea가 안전 cap을 초과함
```

처리:

```text
기존 emergency fallback 허용
status는 Preview ready (rough fallback)
```

이 경우는 알고리즘 판단 실패가 아니라 처리 자체가 불가능한 상황이다.

### Confidence failure

예:

```text
seed와 neighbor를 모두 검사했지만 accepted pixel이 없음
foregroundRatio가 너무 큼
rectangular fallback도 score 기준을 통과하지 못함
```

추천 처리:

```text
lasso 내부를 통째로 반환하지 않는다.
선택은 유지하고 preview만 비운 뒤, 더 정확히 seed를 그리거나 민감도를 조정하게 한다.
```

사용자 메시지 후보:

```text
Unable to find a confident object mask. Try a tighter lasso or increase sensitivity.
```

이 변경은 `createRoughMask()` 반환 타입을 `MaskResult | null`로 바꾸거나, confidence failure를 표현하는 별도 result 타입을 추가해야 한다.

## 구현 단계

### 1단계: score 함수에 seed bias 옵션 추가

```ts
type PixelScoreOptions = {
  useSeedPrior: boolean;
};
```

```ts
function scoreMaskPixel(
  context: PixelScoreContext,
  maskIndex: number,
  imageX: number,
  imageY: number,
  localX: number,
  localY: number,
  options: PixelScoreOptions
): number
```

`useSeedPrior = false`이면 `inSeedPrior`, `nearSeedPrior`, `outsideSeedPrior`를 모두 0으로 둔다.

### 2단계: connected seed 초기화 변경

기존:

```text
seed pixel -> mask 255 -> queue
```

수정:

```text
seed pixel -> queue
seed pixel -> score 통과 시에만 mask 255
```

accepted bounds/count는 score 통과 픽셀만 기준으로 계산한다.

### 3단계: connected neighbor score 변경

connected growth의 모든 final acceptance score는 `useSeedPrior = false`로 호출한다.

### 4단계: queue capacity 변경

```text
queue capacity: maxAcceptedPixels -> maxVisitedPixels
seedMask.foregroundCount > maxVisitedPixels이면 connected path 실패
```

### 5단계: rectangular fallback score 변경

rectangular fallback도 `useSeedPrior = false`로 scoring한다.

### 6단계: confidence failure 처리 정리

추천 구현:

```text
createConnectedMask: MaskResult | null
createRectangularScoredMask: MaskResult | null
createRoughMask: MaskResult | null
processSelection: null이면 ready 상태로 되돌리고 파라미터 조정 허용
```

단, technical failure와 confidence failure를 명확히 나누려면 `MaskAttempt` 타입을 추가한다.

```ts
type MaskAttempt =
  | { ok: true; result: MaskResult }
  | { ok: false; reason: "technical" | "low-confidence" };
```

MVP 구현에서는 우선 `null = low-confidence or failed attempt`로 단순화하고, context/getImageData 실패처럼 정말 처리 불가인 경우만 emergency fallback을 유지할 수 있다.

### 7단계: 문서와 UI 설명 갱신

갱신 대상:

```text
README.md
docs/connected-expansion-plan.md
docs/workbench-parameter-panel-plan.md
```

갱신 내용:

```text
lasso 내부도 최종 mask로 보장되지 않는다.
lasso는 foreground/background 추정과 growth 시작점이다.
시드 영향은 최종 포함 보장이 아니라 seed 주변 해석 강도다.
confidence failure에서는 lasso 내부가 통째로 결과가 되지 않을 수 있다.
```

## 테스트 계획

### 정상 케이스

```text
물체 내부만 lasso로 선택하면 seed 내부 대부분이 score를 통과한다.
긴 물체 중간을 lasso로 선택하면 연결 확장이 seed bounds 밖으로 이어진다.
대각선으로 연결된 물체가 8방향 연결로 확장된다.
```

### 문제 재현 케이스

```text
lasso 내부에 배경을 일부 포함한다.
수정 전: 배경 픽셀이 100% mask에 남는다.
수정 후: 배경 픽셀이 score를 통과하지 못하면 transparent가 된다.
```

### 파라미터 케이스

```text
민감도를 올리면 seed 내부/외부 모두 더 많이 통과한다.
민감도를 낮추면 seed 내부 배경이 더 잘 제외된다.
확장을 올리면 연결된 외부 영역을 더 멀리 따라간다.
시드 영향이 seed 내부 100% 보장으로 되돌아가지 않는다.
```

### fallback 케이스

```text
accepted pixel이 없으면 lasso 내부 opaque fallback으로 돌아가지 않는다.
기술적 실패에서는 rough fallback 상태가 유지된다.
confidence failure에서는 사용자에게 다시 선택/조정하라는 상태를 보여준다.
```

## 리스크

### 1. 너무 엄격해서 결과가 비는 문제

seed 내부도 score를 요구하면 일부 이미지에서는 accepted pixel이 매우 적을 수 있다.

완화:

```text
민감도 조정으로 threshold를 낮출 수 있다.
confidence failure 메시지를 제공한다.
필요하면 후속으로 foreground sample을 더 robust하게 만든다.
```

### 2. Foreground 평균 오염

lasso 내부에 배경이 많이 포함되면 foreground 평균 자체가 오염된다.
이번 수정은 "seed 내부 자동 포함"은 해결하지만, sample 오염을 완전히 해결하지는 않는다.

후속 개선 후보:

```text
seed mask 내부 erosion 후 core sample만 사용
seed 내부 RGB outlier trimming
seed 내부를 k-means 2색으로 나눈 뒤 더 일관된 cluster 사용
```

### 3. Seed frontier가 너무 넓은 문제

rejected seed pixel도 queue source로 쓰면 큰 lasso에서 탐색 시작점이 너무 많아질 수 있다.

완화:

```text
maxVisitedPixels cap 유지
seedMask.foregroundCount가 너무 크면 connected path 실패 처리
큰 lasso는 사용자가 더 작게 다시 그리도록 안내
```

## 최종 추천안

구현은 다음 순서가 가장 안전하다.

```text
1. final acceptance score에서 seed prior 제거
2. connected seed 초기화를 frontier와 accepted mask로 분리
3. rectangular fallback도 동일 기준으로 변경
4. confidence failure에서 lasso opaque fallback을 쓰지 않고 선택/파라미터 조정을 유지
5. 문서와 수동 테스트 체크리스트 갱신
```

이 방향이 사용자가 말한 "최초 seed 영역이어도 최종 선택 단계에서는 동일한 기준을 요구받아야 한다"는 원칙에 가장 잘 맞는다.
