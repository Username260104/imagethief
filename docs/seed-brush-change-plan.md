# Seed Brush 변경 계획

## 목적

기존 MVP의 사각형 rect seed 선택을 foreground seed brush 방식으로 변경한다.
사용자는 오려낼 물체 안쪽을 대략 칠하고, 알고리즘은 칠한 영역을 foreground 힌트로 삼아 낮은 정확도의 hard alpha mask를 만든다.

이 변경은 mask를 직접 수정하는 브러쉬 편집기를 만드는 것이 아니다.
MVP 범위는 foreground seed 입력 방식 변경으로 제한한다.

## 확정 방향

```text
MVP 선택 방식은 foreground seed brush 하나만 제공한다.
rect seed와 lasso는 후속 확장 예약값으로만 남긴다.
background brush, erase brush, include/exclude mask edit brush는 제공하지 않는다.
브러쉬 크기는 MVP에서 화면 기준 고정값을 사용한다.
윤곽선 생성 후 자동 복사는 하지 않고 Copy PNG 버튼 복사를 유지한다.
```

## 사용자 흐름 변경

기존 흐름:

```text
원본 이미지 위에서 물체 주변을 사각형으로 드래그
-> 사각형 중심을 foreground 후보로 가정
-> rough contour 생성
```

변경 흐름:

```text
원본 이미지 위에서 물체 안쪽을 브러쉬로 칠함
-> 칠한 픽셀을 foreground 후보로 가정
-> brush seed 주변에서 background 후보를 샘플링
-> rough contour 생성
```

## 데이터 모델 변경

`ObjectSeedSelection.kind`의 MVP 생성값을 `"rect"`에서 `"brush"`로 바꾼다.

```ts
type BrushSeedPoint = {
  x: number;
  y: number;
  radius: number;
};

type ObjectSeedSelection = {
  kind: "brush" | "rect" | "lasso";
  bounds: ImagePixelRect;
  points: BrushSeedPoint[];
};
```

`bounds`는 모든 brush circle을 포함하는 원본 이미지 픽셀 좌표 bounding box다.
`points`는 화면 포인터 이동을 원본 이미지 좌표로 변환한 brush dab 목록이다.
포인트는 과도하게 많이 저장하지 않도록 최소 간격을 두고 샘플링한다.

## UI 변경 계획

1. workbench canvas 위 포인터 위치에 원형 brush cursor를 표시한다.
2. pointer down 이후 drag 중 brush stroke를 반투명 overlay로 표시한다.
3. pointer up 시 stroke가 충분하면 mask 계산을 시작한다.
4. 너무 짧거나 작은 stroke는 `Selection is too small`로 처리한다.
5. `ESC`는 현재 stroke 또는 preview를 취소한다.
6. `Reset Selection`은 brush seed, preview, PNG Blob을 모두 초기화한다.

MVP 기본 상수:

```ts
const BRUSH_RADIUS_CSS_PX = 18;
const MIN_BRUSH_IMAGE_RADIUS = 3;
const MAX_BRUSH_IMAGE_RADIUS = 128;
const MIN_OBJECT_SELECTION_SIZE = 8;
const MIN_FOREGROUND_SEED_POINTS = 3;
```

## 알고리즘 변경 계획

1. brush points를 기준으로 work area를 계산한다.
2. work area 안에 brush seed mask를 만든다.
3. seed mask 픽셀을 foreground 색상 후보로 샘플링한다.
4. seed mask에서 충분히 떨어진 픽셀과 work area 테두리를 background 후보로 샘플링한다.
5. 각 픽셀을 foreground/background 색상 거리, seed mask까지의 거리 prior, work area border prior, rough noise로 scoring한다.
6. threshold로 alpha 0 또는 255를 결정한다.
7. 작은 섬/구멍을 과하게 정리하지 않는다.
8. foreground ratio가 비정상적이면 emergency mask를 사용한다.

## Emergency Mask 변경

사각형 seed에서는 seed bounds 내부를 opaque로 둘 수 있었다.
브러쉬 seed에서는 사용자가 칠한 stroke가 물체 전체가 아닐 수 있으므로 fallback 결과가 더 거칠 수 있다.

MVP emergency mask는 다음을 따른다.

```text
brush seed stroke 영역을 opaque로 둔다.
stroke 주변을 brush radius의 1.5배만큼 거칠게 확장할 수 있다.
seed bounds 바깥쪽은 transparent로 둔다.
출력 bounds는 seed bounds + output padding이다.
```

## 검토 결과

장점:

```text
사각형 중심 가정이 사라져 긴 물체나 비정형 물체 선택이 자연스럽다.
사용자가 “물체 안쪽을 칠한다”는 정신 모델을 갖기 쉽다.
rough contour의 foreground 샘플 품질이 개선될 가능성이 높다.
```

리스크:

```text
사용자가 배경을 같이 칠하면 foreground 샘플이 오염된다.
brush point가 너무 많으면 메모리와 처리 시간이 늘어난다.
큰 이미지에서 brush seed 주변 work area가 커지면 여전히 메인 스레드가 멈출 수 있다.
background brush가 없으므로 배경 색상 샘플링은 여전히 추정에 의존한다.
emergency mask가 물체 전체가 아니라 칠한 blob처럼 보일 수 있다.
```

완화:

```text
brush point 간 최소 거리로 point 수를 제한한다.
work area pixel cap 또는 downsample mask 계산을 함께 도입한다.
brush seed에서 일정 거리 이상 떨어진 픽셀만 background 후보로 삼는다.
README에 foreground seed brush의 의미와 좋은 칠하기 방법을 설명한다.
```

## 구현 단계 제안

1. `ObjectSeedSelection` 타입을 brush 중심으로 변경한다.
2. workbench의 rect drag 상태를 brush stroke 상태로 바꾼다.
3. brush cursor와 stroke overlay 렌더링을 구현한다.
4. brush points에서 seed mask와 bounds를 생성한다.
5. segmentation foreground/background 샘플링을 brush seed mask 기준으로 바꾼다.
6. emergency mask를 brush stroke 기반으로 바꾼다.
7. PNG 생성과 preview는 기존 mask/output bounds 파이프라인을 유지한다.
8. README와 수동 테스트 페이지/체크리스트를 seed brush 기준으로 갱신한다.
9. 큰 work area 성능 보호를 추가한다.
10. Chrome 수동 E2E 테스트를 실행한다.

## 비범위

```text
mask edit brush
erase brush
background seed brush
brush size slider
압력 감지
feather/soft alpha
정교한 matting
undo/redo stack
```

brush size slider와 background seed brush는 실제 테스트 후 필요성이 확인되면 후속 범위로 검토한다.
