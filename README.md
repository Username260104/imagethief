# ImageThief

ImageThief는 웹페이지에서 원본 이미지를 고른 뒤, 확장 프로그램 작업 화면에서 물체를 거칠게 따서 투명 PNG로 클립보드에 복사하는 Chrome MV3 확장 프로그램입니다.

깨끗한 AI 누끼 도구가 아닙니다. 옛날 빠른 선택 도구나 매직완드처럼 조금 틀린 hard alpha 윤곽을 만드는 MVP입니다.

## 개발 설치

```bash
npm install
npm run build
```

Chrome에서 설치:

1. `chrome://extensions`를 엽니다.
2. Developer mode를 켭니다.
3. Load unpacked를 누릅니다.
4. 이 프로젝트의 `dist` 폴더를 선택합니다.

단축키는 기본값으로 Windows/Linux `Ctrl+Shift+X`, macOS `Command+Shift+X`를 제안합니다. 충돌이 있으면 `chrome://extensions/shortcuts`에서 변경합니다.

## 기본 사용

1. 웹페이지에서 확장 프로그램 아이콘을 누르거나 단축키를 입력합니다.
2. 이미지 후보에 마우스를 올리면 주황색 하이라이트가 표시됩니다.
3. 이미지를 클릭하면 새 탭의 workbench가 열립니다.
4. 원본 이미지 위에서 오려낼 물체 안쪽을 올가미처럼 둘러싸며 선을 그립니다.
5. rough preview가 생성되면 우측 상단의 조정 패널에서 `민감도`, `확장`, `가장자리 정리`, `출력 여백` 등을 조정합니다. `확장`은 seed와 연결된 픽셀을 더 멀리 따라가는 정도도 함께 조정합니다.
6. 결과가 괜찮으면 `Copy PNG`를 눌러 클립보드에 복사합니다.
7. 다시 선택하려면 `Reset Selection`을 누릅니다.

올가미 선은 최종 mask 경계선을 직접 그리는 편집 도구가 아닙니다. 닫힌 선 내부는 "이 부분은 물체일 가능성이 높다"는 foreground seed로만 쓰이고, 실제 윤곽은 주변 픽셀을 기준으로 거칠게 다시 계산됩니다.
mask 계산은 lasso 내부 seed에서 시작해 8방향으로 연결된 유사 픽셀을 확장하지만, lasso 내부 픽셀도 최종 결과에 들어가려면 같은 score 기준을 통과해야 합니다. confidence가 부족하면 lasso 내부를 통째로 PNG로 만들지 않고 선택/파라미터 조정을 요구합니다.

## MVP 확정 기본값

```text
작업 화면은 새 탭의 extension page로 연다.
물체 선택은 foreground lasso seed 방식만 구현한다.
rect seed와 brush seed는 타입 확장 가능성만 남기고 MVP에서는 UI로 제공하지 않는다.
lasso seed는 최종 mask 경계선을 직접 그리는 편집 올가미가 아니다.
윤곽선 생성 후 자동 클립보드 복사는 시도하지 않는다.
사용자가 Copy PNG 버튼을 눌렀을 때만 클립보드 복사를 시도한다.
클립보드 복사 실패 시 다운로드 fallback은 제공하지 않는다.
원본 이미지 fetch/decode 실패 시 viewport screenshot fallback은 제공하지 않는다.
사용자에게 보이는 짧은 상태/오류 메시지는 영어로 작성한다.
```

## 권한

```text
activeTab: 현재 탭에서 이미지 선택 모드를 실행합니다.
scripting: content script를 현재 탭에 주입합니다.
storage: workbench session metadata를 chrome.storage.session에 임시 저장합니다.
clipboardWrite: PNG를 클립보드에 복사합니다.
host_permissions: 선택된 원본 이미지 fetch/decode 성공률을 높입니다.
```

이미지를 외부 서버로 업로드하지 않고, 선택 히스토리를 영구 저장하지 않습니다.

## 알려진 한계

```text
원본 이미지 URL이 없으면 작업할 수 없습니다.
fetch가 막힌 이미지는 작업할 수 없습니다.
canvas/WebGL/video는 MVP 원본 선택 대상이 아닙니다.
cross-origin iframe 내부 이미지는 탐색하지 못할 수 있습니다.
복잡한 CSS background layer는 지원하지 않습니다.
정교한 object segmentation은 목표가 아닙니다.
머리카락/털 경계는 제대로 처리하지 않습니다.
결과물은 의도적으로 거칠게 나옵니다.
클립보드 쓰기는 브라우저 정책에 따라 실패할 수 있습니다.
```

## 수동 테스트 체크리스트

`test-pages/manual.html`을 로컬 HTTP 서버로 열거나 임의의 웹페이지에서 테스트합니다. `file://` 페이지는 Chrome의 확장 프로그램 파일 URL 접근 설정에 따라 동작하지 않을 수 있습니다.

```text
일반 <img> 이미지 선택
srcset/currentSrc 이미지 선택
CSS background-image 단일 URL 선택
상대 URL 이미지 선택
cross-origin CDN 이미지 선택
fetch가 막히는 이미지 실패 상태
큰 이미지 제한 상태
작은 이미지 선택
브라우저 zoom 125%
작업 화면 리사이즈 후 좌표 매핑
이미지 가장자리 근처 lasso 입력
너무 짧거나 작은 lasso 입력
긴 lasso 입력
물체 안쪽을 잘 둘러싼 경우
배경을 같이 둘러싼 경우
선택 전 조정 패널 비활성 상태
선택 후 민감도 조정
선택 후 확장 조정
seed bounds 밖으로 길게 이어진 물체 확장
대각선으로 이어진 얇은 물체 확장
선택 후 가장자리 정리 조정
선택 후 출력 여백 조정
고급 조정 열기/닫기
파라미터 초기화
복잡한 배경의 물체
배경과 색이 비슷한 물체
emergency mask fallback
Copy PNG 성공
Copy PNG 실패 후 재시도
ESC로 웹페이지 이미지 선택 취소
Reset Selection으로 workbench 선택 초기화
```
