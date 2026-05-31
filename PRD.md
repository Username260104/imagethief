# ImageThief 제작 요구사항서

## 0. 문서 목적

이 문서는 `ImageThief`라는 Chrome Extension Manifest V3 MVP를 구현하기 위한 제품/기술 요구사항서다.

ImageThief의 핵심 경험은 다음 한 문장으로 정의한다.

```text
웹페이지에서 이미지를 고르고,
그 이미지의 원본을 별도 작업 화면에 띄운 뒤,
원본 이미지 위에서 오려낼 물체를 선택하면,
낮은 정확도의 거친 윤곽선으로 물체를 따고,
사용자가 Copy PNG를 누르면 투명 PNG로 클립보드에 복사한다.
```

이 문서는 구현자가 바로 작업할 수 있도록 제품 목표, 사용자 흐름, 권한 정책, MV3 구조, 원본 이미지 처리, 작업 화면, 물체 선택 방식, 낮은 정확도 윤곽선 생성, PNG 출력, 클립보드 복사, 에러 처리, 완료 기준, 테스트 기준을 모두 포함한다.

## 1. 제품 이름과 기본 정의

제품의 임시 이름은 `ImageThief`다.

ImageThief는 웹페이지에서 보이는 이미지를 최종 출력 대상으로 바로 잘라내는 도구가 아니다.
ImageThief는 먼저 웹페이지에서 작업할 원본 이미지를 고른다.
그 다음 확장 프로그램 내부 작업 화면에서 해당 원본 이미지를 띄우고, 사용자가 원본 이미지 위에서 오려낼 물체를 선택한다.

사용자 입장에서의 핵심 흐름은 다음이다.

```text
웹페이지에서 이미지 선택
-> 원본 이미지 작업 화면 열림
-> 원본 위에서 물체 선택
-> 낮은 정확도의 윤곽선 선택 생성
-> 사용자가 Copy PNG를 누르면 투명 PNG가 클립보드에 복사됨
```

여기서 "낮은 정확도"는 출력 이미지의 해상도가 낮다는 뜻이 아니다.
원본 이미지의 픽셀 해상도는 가능한 한 유지한다.
낮아야 하는 것은 물체 윤곽 판단의 정확도다.

원하는 결과는 다음에 가깝다.

```text
옛날 포토샵 빠른 선택 도구
매직완드로 대충 잡은 선택 영역
조금 빗나간 물체 윤곽
경계가 완벽하지 않은 hard alpha PNG
대상이 완전히 깨끗하게 분리되지 않은 상태
```

## 2. 가장 중요한 제품 원칙

제품 목표는 다음 순서로 중요하다.

```text
1. 웹페이지에서 작업할 이미지를 명확하게 선택할 수 있어야 한다.
2. 선택한 이미지의 원본을 작업 화면에 띄워야 한다.
3. 물체 선택은 원본 이미지 위에서 이루어져야 한다.
4. 출력 PNG는 가능한 한 원본 이미지 해상도 기준이어야 한다.
5. 윤곽선 판단은 의도적으로 낮은 정확도여야 한다.
6. 결과물은 투명 PNG여야 한다.
7. 결과물은 클립보드에 image/png로 복사되어야 한다.
8. 모든 이미지 처리는 로컬에서 이루어져야 한다.
9. 이미지를 외부 서버로 업로드하지 않는다.
```

명확히 피해야 하는 방향은 다음이다.

```text
웹페이지 viewport를 바로 crop하는 도구
스크린샷 영역을 잘라내는 도구
원본 이미지를 열지 않고 페이지 위에서 결과물을 만드는 도구
출력물 해상도를 낮추는 방식으로 거칠게 보이게 하는 도구
깨끗한 AI 배경 제거 도구
정교한 사진 편집기
단순 이미지 다운로드 도구
```

ImageThief의 핵심은 "원본 이미지를 작업 캔버스로 가져온 뒤, 사용자가 그 원본 위에서 물체를 거칠게 따는 경험"이다.

## 3. MVP 범위

MVP에서 반드시 만든다.

```text
Chrome Extension MV3 프로젝트 구조
TypeScript 기반 빌드
확장 프로그램 아이콘 클릭 실행
키보드 단축키 실행
웹페이지 이미지 선택 모드
이미지 후보 hover 하이라이트
이미지 후보 클릭 선택
일반 <img> 후보 탐색
<picture> 내부 img 처리
srcset/currentSrc 우선 사용
CSS background-image 단일 URL 후보 탐색
선택한 이미지의 원본 URL 해석
원본 이미지 fetch/decode
원본 이미지 작업 화면 열기
작업 화면에서 원본 이미지 표시
작업 화면에서 확대/축소에 대응하는 좌표 매핑
원본 이미지 위 물체 선택
선택 기반 낮은 정확도 윤곽선 생성
hard alpha mask 생성
마스크가 적용된 투명 PNG 생성
원본 해상도 기준 출력 크기 유지
image/png 클립보드 복사
복사 성공/실패 표시
복사 재시도 버튼
개발용 debug 정보
README와 알려진 한계 정리
수동 테스트 페이지 또는 테스트 절차
```

MVP에서 만들지 않는다.

```text
깨끗한 AI 배경 제거
SAM/MobileSAM 기반 segmentation
정교한 matting
머리카락/털 edge refine
feather
blur
edge cleanup
small artifact cleanup
morphological cleanup 중심의 고품질 보정
브러쉬로 수동 수정하는 전체 편집기
레이어 편집
이미지 히스토리 저장
다운로드 관리자
사용자 계정
클라우드 업로드
결제 시스템
Firefox/Safari 지원
데스크톱 앱
영상 프레임 전용 추출 도구
전체 페이지 캡쳐 도구
웹페이지 영역 스크린샷 crop 도구
```

### 3.1 MVP 확정 기본값

다음 항목은 MVP 구현 기본값으로 확정한다.

```text
작업 화면은 새 탭의 extension page로 연다.
물체 선택은 foreground seed brush 방식만 구현한다.
사각형 rect seed와 lasso 선택은 타입 확장 가능성만 남기고 MVP에서는 UI로 제공하지 않는다.
seed brush는 최종 mask를 직접 칠하는 편집 브러쉬가 아니다.
윤곽선 생성 후 자동 클립보드 복사는 시도하지 않는다.
사용자가 Copy PNG 버튼을 눌렀을 때만 클립보드 복사를 시도한다.
클립보드 복사 실패 시 다운로드 fallback은 제공하지 않는다.
원본 이미지 fetch/decode 실패 시 viewport screenshot fallback은 제공하지 않는다.
사용자에게 보이는 짧은 상태/오류 메시지는 영어로 작성한다.
README와 개발 문서는 한국어로 작성할 수 있다.
```

## 4. 사용자 흐름

### 4.1 실행

사용자는 Chrome에서 웹페이지를 보고 있다.

사용자는 다음 중 하나로 ImageThief를 실행한다.

```text
확장 프로그램 아이콘 클릭
또는
키보드 단축키 입력
```

기본 단축키 제안은 다음이다.

```text
Windows / Linux: Ctrl + Shift + X
macOS: Command + Shift + X
```

단축키가 Chrome 또는 다른 확장 프로그램과 충돌할 수 있으므로 README에 `chrome://extensions/shortcuts`에서 직접 변경할 수 있음을 안내한다.

### 4.2 웹페이지 이미지 선택 모드

실행하면 현재 웹페이지가 이미지 선택 모드로 전환된다.

이미지 선택 모드의 목적은 crop 영역을 고르는 것이 아니다.
목적은 작업 화면으로 가져갈 원본 이미지를 고르는 것이다.

이미지 선택 모드 요구사항은 다음이다.

```text
웹페이지 위에 가벼운 선택 레이어 표시
마우스가 이미지 후보 위에 올라가면 후보 영역 하이라이트
클릭하면 해당 이미지 후보 선택
ESC를 누르면 선택 모드 취소
선택 모드 중 페이지 스크롤은 가능하면 유지
이미지가 아닌 영역 클릭은 무시하거나 선택 모드 유지
선택된 후보의 원본 URL과 표시 rect를 수집
선택 후 작업 화면 열기
```

이미지 후보는 다음을 포함한다.

```text
HTMLImageElement
<picture> 내부 img
srcset/currentSrc를 사용하는 img
CSS background-image 중 단일 URL인 요소
```

MVP에서 다음은 원본 이미지 후보로 취급하지 않는다.

```text
canvas
WebGL canvas
video frame
cross-origin iframe 내부 DOM
복수 background-image
gradient background
data가 너무 큰 inline SVG
```

후보가 아닌 요소를 사용자가 클릭하면 다음 중 하나로 처리한다.

```text
아무 일도 하지 않음
또는 작은 안내 표시
```

사용자에게 긴 기술 오류를 보여주지 않는다.

### 4.3 원본 이미지 해석

이미지 후보가 선택되면 확장 프로그램은 원본 이미지 URL을 결정한다.

URL 우선순위는 다음이다.

```text
1. img.currentSrc
2. img.src
3. srcset에서 브라우저가 선택한 currentSrc
4. CSS background-image의 단일 url()
```

URL은 반드시 절대 URL로 변환한다.
상대 URL은 document URL 기준으로 해석한다.

원본 이미지 접근은 다음 원칙을 따른다.

```text
가능하면 credentials 포함 fetch
응답 content-type이 image인지 확인
Blob 또는 ArrayBuffer로 decode
decode 결과 width/height 확인
이미지 orientation과 브라우저 decode 차이 검토
decode 실패 시 작업 화면을 열지 않고 오류 표시
```

원본을 가져오지 못했을 때 웹페이지 viewport 캡쳐로 조용히 대체하지 않는다.
사용자가 원하는 작업 대상은 원본 이미지이므로, 원본 접근 실패는 별도의 실패 상태로 보여준다.

원본 접근 실패 메시지는 짧아야 한다.

```text
Original image unavailable
```

필요하면 개발용 debug에만 자세한 사유를 기록한다.

### 4.4 원본 이미지 작업 화면

원본 이미지가 준비되면 확장 프로그램은 별도 작업 화면을 연다.

작업 화면은 extension page로 구현한다.
MVP에서는 작업 화면을 현재 탭을 대체하지 않고 새 탭으로 연다.
사용자가 원래 웹페이지를 잃지 않도록 하기 위해서다.

예상 파일 이름은 다음과 같다.

```text
workbench.html
src/workbench/index.ts
```

작업 화면의 목적은 다음이다.

```text
선택된 원본 이미지를 보여준다.
사용자가 원본 이미지 위에서 오려낼 물체를 선택하게 한다.
선택 결과에서 낮은 정확도의 윤곽선을 생성한다.
사용자가 Copy PNG 버튼을 누르면 결과 PNG를 클립보드로 복사한다.
```

작업 화면의 기본 UI는 다음을 포함한다.

```text
원본 이미지 캔버스
이미지 fit-to-screen 표시
이미지 실제 픽셀 크기 표시
복사 상태 표시
Copy PNG 버튼
Reset Selection 버튼
닫기 또는 Back 버튼
```

작업 화면은 제품 설명용 landing page가 아니다.
첫 화면부터 원본 이미지를 중심으로 보여주는 실제 작업 화면이어야 한다.

### 4.5 원본 이미지 좌표계

작업 화면은 표시 좌표와 원본 이미지 픽셀 좌표를 분리해서 관리한다.

기본 타입은 다음이다.

```ts
type ImagePixelPoint = {
  x: number;
  y: number;
};

type ImagePixelRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type DisplayTransform = {
  scale: number;
  offsetX: number;
  offsetY: number;
};
```

사용자의 포인터 입력은 화면 좌표로 들어온다.
모든 선택 결과는 원본 이미지 픽셀 좌표로 변환해서 저장한다.

다음 상황에서도 좌표가 틀어지면 안 된다.

```text
이미지가 화면에 맞게 축소 표시됨
브라우저 zoom이 125%임
고해상도 디스플레이임
작업 화면이 리사이즈됨
사용자가 이미지 가장자리 근처를 선택함
```

### 4.6 물체 선택

사용자는 원본 이미지 위에서 오려낼 물체를 선택한다.

최종적으로 지원할 수 있는 선택 방식은 다음과 같다.

```text
물체 안쪽을 foreground seed brush로 대략 칠하기
물체 주변을 사각형으로 드래그해서 rough seed 영역 지정
물체 주변을 자유형 lasso로 대략 선택
```

MVP에서는 foreground seed brush 방식만 구현한다.
rect와 lasso는 타입과 후속 확장 가능성만 남기고, MVP UI에는 노출하지 않는다.

seed brush는 최종 mask 결과를 직접 칠하는 브러쉬가 아니다.
사용자가 칠한 영역은 "이 부분은 물체일 가능성이 높다"는 foreground seed 입력이다.
알고리즘은 이 seed를 기준으로 주변 픽셀을 거칠게 확장하거나 제외해 낮은 정확도의 hard alpha mask를 만든다.

선택 UI 요구사항은 다음이다.

```text
포인터 위치에 brush cursor 원 표시
드래그 중 brush stroke를 원본 이미지 위에 반투명 seed overlay로 표시
포인터를 놓으면 윤곽선 계산 시작
너무 짧거나 너무 작은 seed stroke는 무시
ESC로 현재 선택 취소
Reset Selection으로 다시 선택 가능
처리 중 중복 선택 방지
```

MVP brush는 foreground seed brush 하나만 제공한다.
배경을 칠하는 background brush, 포함/제외를 직접 수정하는 mask edit brush, 지우개는 MVP에서 제공하지 않는다.

MVP brush radius는 화면 기준 고정값을 사용한다.
브라우저 zoom, 디스플레이 배율, fit-to-screen 축소 상태와 무관하게 사용자가 보는 cursor 크기가 일정해야 한다.
저장할 때는 해당 display radius를 원본 이미지 픽셀 radius로 변환한다.

```ts
const BRUSH_RADIUS_CSS_PX = 18;
const MIN_BRUSH_IMAGE_RADIUS = 3;
const MAX_BRUSH_IMAGE_RADIUS = 128;
const MIN_FOREGROUND_SEED_POINTS = 3;
```

너무 작은 선택의 기본 기준은 다음이다.

```ts
const MIN_OBJECT_SELECTION_SIZE = 8;
```

seed bounds의 width 또는 height가 `MIN_OBJECT_SELECTION_SIZE`보다 작거나,
저장된 brush point가 `MIN_FOREGROUND_SEED_POINTS`보다 적으면 너무 작은 선택으로 처리한다.

선택 결과는 원본 이미지 픽셀 좌표로 저장한다.

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

MVP 구현에서 생성되는 `ObjectSeedSelection.kind`는 항상 `"brush"`다.
`"rect"`와 `"lasso"`는 후속 버전을 위한 타입 예약값이다.

## 5. 낮은 정확도 윤곽선 선택

ImageThief의 segmentation 목표는 깨끗한 배경 제거가 아니다.
목표는 원본 이미지에서 사용자가 고른 물체를 낮은 정확도로 대충 따는 것이다.

중요한 구분은 다음이다.

```text
출력 해상도는 낮추지 않는다.
윤곽선 판단 정확도를 낮춘다.
```

따라서 출력 PNG는 가능한 한 원본 이미지 픽셀 기준으로 생성한다.
내부 계산 과정에서 성능을 위해 축소 이미지를 사용할 수는 있다.
하지만 그 축소가 사용자에게 "낮은 해상도 결과물"로 드러나면 안 된다.

### 5.1 원하는 선택 품질

원하는 품질은 다음과 같다.

```text
경계가 조금 흔들림
배경이 조금 묻음
대상 일부가 조금 빠짐
hard alpha 경계
정확한 머리카락/털 표현 없음
부드러운 feather 없음
깨끗한 matting 없음
```

피해야 할 품질은 다음이다.

```text
AI 누끼처럼 깨끗함
경계가 과하게 부드러움
반투명 hair matte
후처리 blur로 꾸며진 거친 느낌
출력 자체가 저해상도라서 뭉개진 느낌
```

### 5.2 MVP segmentation 입력

segmentation 입력은 다음이다.

```text
원본 이미지 bitmap
사용자가 지정한 foreground brush seed selection
brush seed mask와 seed bounds 주변의 이미지 픽셀
```

MVP는 brush seed bounds를 기준으로 작업 영역을 만든다.
brush seed bounds는 모든 brush circle을 포함하는 원본 이미지 픽셀 좌표 bounding box다.
작업 영역은 brush seed bounds에 약간의 padding을 더한 영역이다.

```ts
const SELECTION_PADDING_RATIO = 0.08;
```

padding을 적용한 작업 영역은 원본 이미지 bounds 안으로 clamp한다.

### 5.3 MVP rough contour 알고리즘

MVP 기본 알고리즘은 Canvas 기반으로 구현한다.
OpenCV.js는 선택적 개선 경로로만 둔다.

Canvas 기반 rough contour의 기본 아이디어는 다음이다.

```text
brush로 칠한 픽셀을 foreground 후보로 가정
brush seed mask에서 충분히 떨어진 픽셀과 작업 영역 테두리를 background 후보로 가정
foreground/background 색상 분포를 대략 샘플링
각 픽셀이 foreground에 가까운지 background에 가까운지 거칠게 판단
brush seed mask에 가까운 픽셀에 foreground prior 부여
작업 영역 바깥쪽에 background prior 부여
threshold로 alpha 0 또는 255 결정
작은 구멍이나 작은 섬을 과하게 정리하지 않음
```

brush seed mask는 segmentation 계산 입력이다.
최종 출력 mask와 동일하지 않다.
사용자가 칠한 stroke 자체를 그대로 PNG로 내보내는 것이 아니라, stroke를 foreground 힌트로 삼아 주변을 거칠게 판단한다.

MVP는 다음 처리를 하지 않는다.

```text
정교한 edge refinement
feather
blur
soft alpha
hair matting
고품질 morphology cleanup
```

mask는 hard alpha만 사용한다.

```ts
alpha = 0 | 255;
```

### 5.4 윤곽선 preview

윤곽선이 생성되면 작업 화면에 preview를 보여준다.

preview 요구사항은 다음이다.

```text
원본 이미지 위에 선택 윤곽선 표시
brush seed와 선택된 foreground 영역을 반투명 overlay로 표시
복사 전/후 결과를 사용자가 시각적으로 이해할 수 있음
Reset Selection으로 다시 선택 가능
Copy PNG로 다시 복사 가능
```

윤곽선은 완벽하게 매끄러우면 안 된다.
거친 선택 도구처럼 보이는 것이 맞다.

### 5.5 출력 bounding box

최종 PNG는 전체 원본 이미지를 그대로 내보내지 않는다.
mask에서 foreground로 판단된 영역의 bounding box를 계산한다.

출력 영역은 다음과 같다.

```text
foreground mask bounding box
작은 padding 추가: max(4px, bounding box 긴 변의 2%)
원본 이미지 bounds 안으로 clamp
```

padding 기본값은 다음 상수로 구현한다.

```ts
const OUTPUT_PADDING_MIN_PX = 4;
const OUTPUT_PADDING_RATIO = 0.02;
```

foreground가 거의 없거나 mask가 비정상인 경우 emergency mask를 사용한다.
MVP에서는 foreground ratio가 1% 미만이거나 95% 초과이면 mask가 비정상이라고 판단한다.

```ts
const MIN_FOREGROUND_RATIO = 0.01;
const MAX_FOREGROUND_RATIO = 0.95;
```

## 6. Emergency mask

segmentation이 실패해도 가능한 한 결과물을 만든다.

Emergency mask는 사용자의 brush seed mask와 seed bounds를 기준으로 만든다.

기본 방식은 다음이다.

```text
brush seed stroke 영역을 opaque로 둔다.
stroke 주변을 brush radius의 1.5배만큼 거칠게 확장할 수 있다.
seed bounds 바깥쪽은 transparent로 둔다.
hard alpha를 사용한다.
출력은 seed bounds에 output bounding box와 같은 padding 규칙을 적용한 영역으로 만든다.
```

Emergency mask는 아름답지 않아도 된다.
목적은 segmentation 실패 때문에 작업 전체가 끝나지 않는 일을 줄이는 것이다.
seed brush 방식의 emergency mask는 물체 전체가 아니라 사용자가 칠한 대략적인 blob에 가까울 수 있다.

단, 원본 이미지 자체를 decode할 수 없거나 PNG를 생성할 수 없는 경우에는 실패로 처리한다.

## 7. PNG 생성

최종 출력은 반드시 RGBA PNG여야 한다.

PNG 생성 방식은 다음이다.

```text
원본 이미지 픽셀에서 출력 bounding box 영역을 읽음
mask alpha를 적용
RGB는 원본 픽셀을 유지
alpha는 mask 값을 사용
canvas.toBlob("image/png")로 PNG Blob 생성
```

각 픽셀 합성 규칙은 다음이다.

```ts
output.r = original.r;
output.g = original.g;
output.b = original.b;
output.a = maskAlpha;
```

출력물은 흰색 배경이나 검은색 배경으로 flatten하면 안 된다.
반드시 투명 배경을 유지한다.

출력 크기는 다음 원칙을 따른다.

```text
원본 이미지 픽셀 좌표 기준
foreground bounding box 기준
사용자의 화면 표시 크기와 무관
브라우저 zoom과 무관
```

## 8. 클립보드 복사

최종 PNG Blob은 사용자가 `Copy PNG` 버튼을 눌렀을 때 클립보드에 `image/png`로 복사한다.
윤곽선 preview 생성 직후 자동 복사는 시도하지 않는다.

가능하면 작업 화면에서 사용자 gesture 안에서 다음 방식을 사용한다.

```ts
await navigator.clipboard.write([
  new ClipboardItem({
    "image/png": pngBlob
  })
]);
```

복사 성공 시 작업 화면에 짧게 표시한다.

```text
Copied PNG
```

복사 실패 시 다음을 제공한다.

```text
Copy PNG 버튼 재시도
짧은 실패 메시지
debug 로그
```

파일 다운로드는 MVP 기본 동작이 아니다.
클립보드 복사가 실패해도 MVP에서는 다운로드 fallback 버튼을 제공하지 않는다.
클립보드 복사가 제품의 핵심이다.

## 9. 기술 스택과 MV3 구조

MVP는 Chrome Extension Manifest V3로 만든다.

권장 기술 스택은 다음과 같다.

```text
Chrome Extension MV3
TypeScript
Vite
Content Script
Background Service Worker
Extension Workbench Page
Canvas API
Clipboard API
chrome.storage.session
```

기본 구조는 다음과 같다.

```text
content script
- 웹페이지 이미지 선택 모드 표시
- 이미지 후보 hover 하이라이트
- 이미지 후보 클릭 처리
- 후보 정보 수집
- background service worker와 통신

background service worker
- 확장 프로그램 실행 관리
- content script 주입 또는 활성화
- 선택된 이미지 후보 정보 수신
- workbench session 생성
- chrome.storage.session에 session metadata 저장
- workbench page 열기

workbench page
- 선택된 원본 이미지 fetch/decode
- 원본 이미지 표시
- 원본 이미지 좌표 매핑
- foreground seed brush 입력 처리
- rough contour/mask 생성
- PNG 생성
- clipboard write
- preview/reset/copy 상태 관리
```

MV3 service worker는 DOM과 Canvas 문서 API를 직접 쓰지 않는다.
이미지 표시, Canvas 처리, clipboard write는 작업 화면에서 수행한다.

## 10. Manifest와 권한 정책

MVP의 기본 권한은 다음을 사용한다.

```json
{
  "permissions": [
    "activeTab",
    "scripting",
    "storage",
    "clipboardWrite"
  ],
  "host_permissions": [
    "http://*/*",
    "https://*/*"
  ],
  "commands": {
    "_execute_action": {
      "suggested_key": {
        "default": "Ctrl+Shift+X",
        "mac": "Command+Shift+X"
      }
    }
  }
}
```

`host_permissions`는 원본 이미지 fetch와 pixel processing 성공률을 위해 MVP에서 사용한다.
사용자에게 설치 권한 경고가 늘어날 수 있으므로 README에 이유를 명확히 적는다.

권한 사용 목적은 다음이다.

```text
activeTab: 사용자가 현재 보고 있는 페이지에서 이미지 선택 모드 실행
scripting: content script 주입
storage: workbench session metadata 저장
clipboardWrite: PNG 클립보드 복사
host_permissions: 선택된 원본 이미지 fetch/decode
```

다음은 하지 않는다.

```text
이미지 외부 서버 업로드
사용자 browsing history 저장
선택한 이미지 히스토리 영구 저장
원본 이미지 자동 다운로드
```

## 11. 데이터 흐름

기본 데이터 흐름은 다음이다.

```text
사용자 action
-> content script 활성화
-> 웹페이지 이미지 후보 탐색
-> 사용자가 이미지 후보 클릭
-> 후보 metadata background로 전송
-> background가 sessionId 생성
-> session metadata를 chrome.storage.session에 저장
-> workbench.html?sessionId=... 열기
-> workbench가 session metadata 로드
-> 원본 이미지 fetch/decode
-> 원본 이미지 표시
-> 사용자가 foreground seed brush로 물체 안쪽을 칠함
-> rough contour 생성
-> PNG Blob 생성
-> 사용자가 Copy PNG 클릭
-> clipboard write
```

이미지 후보 metadata 타입은 다음이다.

```ts
type SourceImageCandidate = {
  kind: "html-img" | "css-background";
  pageUrl: string;
  imageUrl: string;
  currentSrc?: string;
  src?: string;
  elementRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  naturalWidth?: number;
  naturalHeight?: number;
  css?: {
    backgroundSize?: string;
    backgroundPosition?: string;
    backgroundRepeat?: string;
  };
};
```

workbench session 타입은 다음이다.

```ts
type WorkbenchSession = {
  id: string;
  createdAt: number;
  candidate: SourceImageCandidate;
};
```

session은 브라우저 세션 동안만 유지한다.
영구 저장하지 않는다.

## 12. 웹페이지 이미지 후보 탐색

이미지 후보 탐색은 content script에서 수행한다.

탐색 방식은 다음이다.

```text
document.querySelectorAll("img")로 기본 후보 수집
마우스 hover 지점에서 elementFromPoint 사용
해당 element와 부모 element에서 img 또는 CSS background 확인
candidate rect를 getBoundingClientRect로 계산
candidate URL을 절대 URL로 변환
candidate가 화면에 보이는지 확인
0x0 크기 후보 제외
중복 URL과 중복 element 후보 정리
```

hover 하이라이트는 실제 candidate rect를 기준으로 표시한다.
클릭 시 가장 가까운 후보를 선택한다.

CSS background 후보는 다음 조건에서만 MVP 후보로 인정한다.

```text
background-image가 단일 url()
gradient가 아님
복수 background layer가 아님
elementRect가 유효함
URL을 절대 URL로 변환할 수 있음
```

CSS background의 원본 이미지는 작업 화면에 열 수 있다.
다만 CSS background의 page 내 표시 방식은 작업 화면의 원본 좌표와 직접 관련이 없다.
작업 화면은 항상 원본 이미지 자체를 기준으로 선택한다.

## 13. 원본 이미지 fetch/decode

workbench page는 session metadata의 imageUrl을 이용해 원본 이미지를 fetch한다.

fetch 요구사항은 다음이다.

```text
credentials: "include" 사용
응답 status 확인
content-type이 image/*인지 확인
Blob 생성
createImageBitmap 또는 HTMLImageElement decode
decode width/height 확인
너무 큰 이미지의 메모리 사용량 보호
```

너무 큰 이미지의 기본 제한은 다음을 권장한다.

```ts
const MAX_DECODED_PIXELS = 64_000_000;
```

제한을 초과하면 작업 화면에 간단한 오류를 표시한다.

```text
Image is too large
```

decode 실패 시 작업 화면은 물체 선택 UI를 보여주지 않는다.

## 14. 작업 화면 렌더링

작업 화면은 원본 이미지를 중심에 표시한다.

렌더링 요구사항은 다음이다.

```text
원본 이미지 전체가 첫 화면에 보이도록 fit-to-screen
이미지 밖 영역과 이미지 안 영역이 구분됨
이미지의 실제 pixel size 표시
브라우저 크기 변경 시 display transform 재계산
포인터 좌표를 원본 이미지 좌표로 정확히 변환
```

MVP에서 zoom/pan은 필수는 아니다.
하지만 fit-to-screen으로 축소된 이미지에서 선택해도 원본 픽셀 좌표가 정확해야 한다.

이미지 표시 품질은 다음을 따른다.

```text
원본을 어둡게 덮지 않음
선택 seed와 윤곽선만 overlay로 표시
작업에 불필요한 설명 문구를 크게 배치하지 않음
```

## 15. 작업 상태

작업 화면은 다음 상태를 가진다.

```ts
type WorkbenchState =
  | "loading-source"
  | "ready"
  | "selecting-object"
  | "processing-mask"
  | "preview-ready"
  | "copying"
  | "copied"
  | "failed";
```

상태별 동작은 다음이다.

```text
loading-source: 원본 이미지 fetch/decode 중
ready: 원본 이미지 표시 완료, 사용자가 선택 가능
selecting-object: 사용자가 foreground seed brush stroke 입력 중
processing-mask: 윤곽선/mask 생성 중, 중복 입력 방지
preview-ready: 결과 preview와 Copy PNG 가능
copying: clipboard write 중
copied: 복사 성공
failed: 복구 가능한 실패 메시지 표시
```

처리 중에는 중복 선택과 중복 복사를 막는다.

## 16. 에러 처리

사용자에게 짧게 보여줄 수 있는 오류는 다음이다.

```text
No image selected
Original image unavailable
Image decode failed
Image is too large
Selection is too small
Unable to create PNG
Unable to copy PNG
```

위 사용자 표시 메시지는 MVP에서 영어 그대로 사용한다.
README와 개발 문서는 한국어로 작성할 수 있다.

사용자에게 긴 기술 오류를 보여주지 않는다.

개발용 debug에는 다음을 기록한다.

```text
pageUrl
candidate kind
candidate imageUrl
fetch status
content-type
decoded width/height
display transform
foreground brush seed selection
brush seed bounds
brush point count
mask foreground ratio
output bounding box
output PNG size
clipboard success/failure
```

## 17. Debug 모드

debug 정보는 기본 사용자 UI에 노출하지 않는다.

개발용 상수는 다음이다.

```ts
const DEBUG = false;
```

`DEBUG === true`일 때만 다음을 허용한다.

```text
console.debug 출력
candidate URL 표시
원본 이미지 크기 표시
display 좌표와 image 좌표 표시
mask foreground ratio 표시
output bounding box 표시
```

## 18. README 요구사항

README에는 다음을 포함한다.

```text
개발 설치 방법
npm install
npm run build
Chrome에서 Load unpacked 하는 방법
필요 권한과 이유
기본 사용 방법
원본 이미지 접근 실패 가능성
클립보드 복사 실패 가능성
MVP 확정 기본값
알려진 한계
테스트 체크리스트
```

README는 제품을 과장하지 않는다.
깨끗한 배경 제거 도구가 아니라 낮은 정확도의 윤곽 선택 도구임을 명확히 적는다.

## 19. 구현 우선순위

구현 순서는 다음을 권장한다.

```text
1. MV3 + TypeScript + Vite 프로젝트 스캐폴딩
2. manifest 권한과 command/action 진입점 구현
3. content script 주입 구조 구현
4. 웹페이지 이미지 후보 탐색 구현
5. hover 하이라이트와 클릭 선택 구현
6. candidate metadata message protocol 구현
7. background session 생성과 workbench 열기 구현
8. chrome.storage.session 기반 session 전달 구현
9. workbench 원본 이미지 fetch/decode 구현
10. workbench 원본 이미지 표시와 display transform 구현
11. 원본 이미지 위 foreground seed brush 입력 구현
12. brush seed mask 기반 Canvas rough contour 구현
13. preview overlay 구현
14. output bounding box와 투명 PNG 생성 구현
15. clipboard write 구현
16. Copy PNG 재시도와 Reset Selection 구현
17. debug 로그 정리
18. README 작성
19. 수동 테스트 페이지/절차 작성
20. 전체 acceptance test 검증
```

MVP 완료 선언은 위 항목 중 필수 사용자 흐름이 실제로 동작할 때만 한다.

## 20. 완료 기준

MVP가 완성되었다고 볼 수 있는 기준은 다음이다.

```text
Chrome 확장 프로그램으로 설치할 수 있다.
확장 프로그램 아이콘으로 이미지 선택 모드를 실행할 수 있다.
키보드 단축키로 이미지 선택 모드를 실행할 수 있다.
웹페이지에서 이미지 후보가 hover 하이라이트된다.
사용자가 이미지 후보를 클릭해 선택할 수 있다.
일반 <img>의 currentSrc 원본을 작업 화면에 띄울 수 있다.
srcset/currentSrc 이미지가 작업 화면에 원본으로 열린다.
CSS background-image 단일 URL 이미지를 작업 화면에 열 수 있다.
원본 fetch/decode 실패 시 명확한 실패 상태를 보여준다.
작업 화면에서 원본 이미지가 fit-to-screen으로 보인다.
작업 화면의 포인터 입력이 원본 이미지 픽셀 좌표로 변환된다.
사용자가 원본 이미지 위에서 foreground seed brush로 물체 안쪽을 칠할 수 있다.
brush cursor 크기가 화면 기준으로 안정적으로 보인다.
너무 짧거나 너무 작은 brush seed 선택은 무시된다.
선택 후 낮은 정확도의 윤곽선이 생성된다.
윤곽선 preview가 작업 화면에 보인다.
출력 PNG는 원본 이미지 픽셀 기준 bounding box로 생성된다.
출력 PNG는 투명 배경 RGBA PNG다.
사용자가 Copy PNG 버튼을 누르면 PNG가 클립보드에 image/png로 복사된다.
Copy PNG 버튼으로 복사를 재시도할 수 있다.
Reset Selection으로 다시 선택할 수 있다.
결과물은 깨끗한 AI 누끼가 아니라 거친 윤곽선 선택처럼 보인다.
출력물이 저해상도로 강제 축소되지 않는다.
모든 처리는 로컬에서 이루어진다.
이미지를 외부 서버에 업로드하지 않는다.
README에 설치 방법과 알려진 한계가 정리되어 있다.
```

## 21. 테스트해야 할 상황

최소한 다음 상황에서 테스트한다.

```text
일반 <img> 이미지
srcset/currentSrc 이미지
CSS background-image 단일 URL
상대 URL 이미지
cross-origin CDN 이미지
쿠키가 필요한 이미지
fetch가 막히는 이미지
큰 이미지
작은 이미지
투명 PNG 원본 이미지
JPEG 원본 이미지
브라우저 zoom 125%
고해상도 디스플레이
작업 화면 리사이즈
이미지 가장자리 근처 물체 선택
이미지 가장자리 근처 brush stroke 입력
너무 짧거나 너무 작은 brush stroke 입력
긴 brush stroke 입력
brush stroke가 물체 중심에서 벗어난 경우
복잡한 배경의 물체
배경과 색이 비슷한 물체
윤곽선 생성 실패 후 emergency mask
clipboard write 성공
clipboard write 실패 후 Copy PNG 재시도
ESC로 웹페이지 이미지 선택 취소
Reset Selection으로 작업 화면 선택 초기화
```

기대 동작은 다음이다.

```text
웹페이지에서 이미지를 고를 수 있다.
선택한 원본 이미지가 작업 화면에 열린다.
물체 선택은 작업 화면의 원본 이미지 위에서 foreground seed brush로 이루어진다.
결과 PNG는 원본 이미지 픽셀 기준으로 생성된다.
윤곽은 낮은 정확도로 거칠게 생성된다.
출력물은 투명 PNG다.
최종적으로 편집 툴에 붙여넣을 수 있다.
```

## 22. 알려진 한계

MVP에서 인정하는 한계는 다음이다.

```text
원본 이미지 URL이 없으면 작업할 수 없다.
fetch가 막힌 이미지는 작업할 수 없다.
canvas/WebGL/video는 MVP 원본 선택 대상이 아니다.
cross-origin iframe 내부 이미지는 탐색하지 못할 수 있다.
복잡한 CSS background layer는 지원하지 않는다.
정교한 object segmentation은 목표가 아니다.
머리카락/털 경계는 제대로 처리하지 않는다.
결과물은 의도적으로 거칠다.
클립보드 쓰기는 브라우저 정책에 따라 실패할 수 있다.
```

이 한계는 README에도 정리한다.

## 23. 구현자에게 전달할 최종 지시

이 문서를 기준으로 ImageThief라는 Chrome Extension MV3 MVP를 구현한다.

핵심은 다음이다.

```text
웹페이지에서 이미지 선택
-> 원본 이미지 작업 화면 열기
-> 원본 이미지 위에서 물체 선택
-> 낮은 정확도의 윤곽선 선택 생성
-> 투명 PNG 생성
-> 사용자가 Copy PNG 클릭
-> 클립보드 복사
```

웹페이지 위에서 바로 crop하지 않는다.
웹페이지 viewport screenshot을 기본 작업 대상으로 삼지 않는다.
원본 이미지 작업 화면이 제품 경험의 중심이다.

낮은 정확도는 낮은 해상도가 아니다.
원본 해상도는 가능한 한 유지하고, 윤곽선 판단만 거칠게 만든다.

출력물은 깨끗한 AI 누끼가 아니다.
옛날 빠른 선택 도구나 매직완드처럼 조금 틀린 윤곽의 투명 PNG여야 한다.

이미지를 외부 서버에 업로드하지 않는다.
클립보드 복사가 제품의 핵심이다.
