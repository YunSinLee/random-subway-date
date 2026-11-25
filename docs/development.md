# 개발 현황

## 구현한 기능

| 기능 | 현재 동작 |
| --- | --- |
| 역 뽑기 | 선택한 노선에서 역 하나를 같은 확률로 뽑습니다. 여러 노선이 지나는 역도 한 번만 포함합니다. 고정 축의 손잡이를 당기면 막대가 앞으로 회전하고, 누르거나 키보드로 뽑아도 짧게 당겨졌다 돌아옵니다. 뽑는 즉시 세로 릴이 연속으로 흐르며 감속하고 당첨역과 선택 노선의 인접역을 보여줍니다. 확인하기로 코스를 열고 손잡이로 다시 뽑을 수 있습니다. 후보가 한 곳이거나 모션 줄이기 설정 또는 애니메이션 미지원 환경에서는 결과를 바로 보여줍니다. |
| 뽑기 설정 | 노선 선택과 장소 후보 조건을 모달에서 바꿀 수 있습니다. 장소 조건은 세 분류의 기본 후보가 있는 역 또는 세 분류 모두 직선 800m 안에 후보가 있는 역으로 좁힙니다. |
| 노선도와 역 검색 | 25개 노선의 고유 역 659곳을 표시합니다. 노선은 역 좌표를 직선으로 이은 도식입니다. 배경은 OpenStreetMap 타일을 사용하며, 타일 요청에 실패해도 노선과 역은 표시됩니다. 확대·축소와 드래그, 두 손가락 조작, 키보드 이동을 지원합니다. |
| 데이트 코스 | 놀거리·식당·카페 후보를 표시합니다. 후보와 방문 순서를 바꿀 수 있고, 후보 거리는 300m·500m·800m·1km 중에서 고를 수 있습니다. 버스나 셔틀이 필요한 장소는 이동 방법을 별도로 표시합니다. |
| 저장과 공유 | 편집한 코스는 해당 브라우저에 저장합니다. 공유 메뉴에서 코스와 네이버 지도 링크를 복사하거나 기기 공유를 이용할 수 있습니다. 로컬 서버에서 기기 공유를 쓰면 상대가 열 수 있는 장소 링크를 보냅니다. |

현재 데이터에는 모든 역에 세 분류의 후보가 한 곳 이상 있습니다. 이 집계에는 버스나 셔틀 이동이 필요한 직접 등록 후보도 포함합니다. 직선 800m 뽑기 조건은 각 분류에 거리를 확인할 수 있는 후보가 가까이 있는 경우에만 충족됩니다. 이 조건으로 제외된 역은 노선도에 점선 테두리로 표시합니다.

## 다음에 개발하거나 논의할 항목

| 항목 | 논의할 내용 |
| --- | --- |
| 지역별 뽑기 범위 | 노선 선택과 별도로 `서울만` / `서울·경기·인천` / `전철 전체`를 둘지 정합니다. 서울·경기·인천을 고르면 1호선을 켠 상태에서 천안·아산을 뽑기에서 제외할 수 있습니다. 역의 행정구역 데이터와 기본 설정이 필요합니다. |
| 출발역 기준 이동 시간 | 출발역과 편도 허용 시간을 설정하는 방식도 검토합니다. 환승과 대기 시간을 포함하려면 경로 및 시간 데이터가 필요합니다. |
| 장소 후보 보강 | 자동 수집 후보 위주인 역부터 직접 등록 후보를 늘리고, 영업 여부와 데이트 코스로 방문할 만한지를 확인합니다. |
| 카카오맵 평점 활용 | 평점 데이터를 확보할 수 있는지, 후보 선별에 어떻게 반영할지 검토합니다. 현재 식당과 카페는 직선거리를 기준으로 제시하고, 장소 링크는 네이버 지도로 연결합니다. |

## 데이터 출처와 갱신

### 전철역과 노선

역과 연결 데이터는 [subway-etl](https://github.com/minseok852/subway-etl#출처표시)에서 가져와 가공했습니다. 원천은 서울교통공사와 행정안전부의 공공누리 제1유형 데이터인 [열차운행시각표](https://www.data.go.kr/data/15098251/fileData.do), [전국도시철도역사정보 표준데이터](https://www.data.go.kr/data/15013205/standard.do), [역간거리 및 소요시간](https://data.seoul.go.kr/dataList/OA-12034/F/1/datasetView.do), [환승역거리 소요시간 정보](https://data.seoul.go.kr/dataList/OA-13290/F/1/datasetView.do) 등입니다. 일부 역 연결에는 원본의 추정치가 있습니다. 저장소 데이터는 GTX-A의 운정중앙~서울역과 수서~동탄을 별도 구간으로 표시합니다.

```sh
python3 scripts/import-network.py station_nodes.csv station_edges.csv
```

앱은 `data/network.js`의 노선에서 필터를 생성합니다. 노선마다 연결할 역 ID 쌍과 각 역의 `lines` 항목에 해당 노선 ID가 필요합니다.

### 장소 후보

직접 등록한 `data/places.js` 후보를 먼저 표시합니다. 등록한 놀거리가 없으면 직선 1km 안의 공원과 전통시장을 유형별 최대 세 곳 표시합니다. 주변 식당과 카페는 직선 800m 안에서 유형별 최대 세 곳을 보여주고, 여러 후보를 고를 때 서로 다른 주소를 우선합니다.

- 공원·시장은 2026-11-14에 내려받은 [전국도시공원정보표준데이터](https://www.data.go.kr/data/15012890/standard.do)와 [전국전통시장표준데이터](https://www.data.go.kr/data/15012894/standard.do)를 사용했습니다.
- 직접 등록한 공공도서관 좌표는 [전국도서관표준데이터](https://www.data.go.kr/data/15013109/standard.do)에서 가져왔습니다.
- 식당·카페는 [2026년 9월 소상공인시장진흥공단 상가(상권)정보](https://www.data.go.kr/data/15083033/fileData.do)의 서울·경기·인천·충남·강원 자료를 사용했습니다. 가져오기 스크립트에는 전국 ZIP 원본을 전달합니다.

```sh
python3 scripts/import-nearby.py parks 전국도시공원정보표준데이터.csv
python3 scripts/import-nearby.py markets 전국전통시장표준데이터.csv
python3 scripts/import-shops.py '소상공인시장진흥공단_상가(상권)정보_20260930.zip'
```

## 검증

데이터 갱신 후 역 ID, 노선 연결, 장소 좌표와 거리를 확인합니다. 보강할 역과 분류는 `--coverage-gaps`, 노선별 후보 수와 800m 조건 충족 수는 `--app-coverage`로 확인합니다.

```sh
node scripts/check-data.cjs
node scripts/check-data.cjs --coverage-gaps
node scripts/check-data.cjs --app-coverage
```

브라우저 검증에는 [README](../README.md#내-컴퓨터에서-실행하기)의 로컬 서버, Node.js와 npm, Google Chrome이 필요합니다. 테스트는 릴의 실제 위치와 감속, 손잡이 입력과 취소, 장소 조건, 지도 조작, 코스 편집과 공유를 확인합니다. 세 화면 크기의 릴 자연 재생 샘플은 `/tmp/subway-slot-motion-*`, 손잡이 축과 원근 기하 및 시점별 화면은 `/tmp/subway-lever-motion-*`에 기록합니다. 기기 공유는 브라우저 API를 대역으로 검증합니다. 기본 실행은 설치된 Chrome을 사용하며, 별도로 설치한 Playwright 번들 Chromium을 쓰려면 `PLAYWRIGHT_BROWSERS_PATH`와 `PLAYWRIGHT_USE_BUNDLED_CHROMIUM=1`을 지정합니다.

```sh
npm install --prefix /tmp/subway-date-browser-check playwright
NODE_PATH=/tmp/subway-date-browser-check/node_modules node scripts/check-browser.cjs
```

번들 Chromium 예시: `NODE_PATH=/tmp/subway-date-browser-check/node_modules PLAYWRIGHT_BROWSERS_PATH=/tmp/subway-date-browser-check/browsers PLAYWRIGHT_USE_BUNDLED_CHROMIUM=1 node scripts/check-browser.cjs`
