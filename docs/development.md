# 개발 현황

## 구현한 기능

| 기능 | 현재 동작 |
| --- | --- |
| 역 뽑기 | 선택한 노선에서 역 하나를 같은 확률로 뽑습니다. 여러 노선이 지나는 역도 한 번만 포함합니다. 역 이름이 바뀌다가 당첨역에 멈추며, 모션 줄이기 설정에서는 결과를 바로 보여줍니다. |
| 뽑기 설정 | 노선 선택과 장소 후보 조건을 모달에서 바꿀 수 있습니다. 장소 조건은 세 분류의 기본 후보가 있는 역 또는 세 분류 모두 직선 800m 안에 후보가 있는 역으로 좁힙니다. |
| 노선도와 역 검색 | 25개 노선의 고유 역 659곳을 표시합니다. 노선은 역 좌표를 직선으로 이은 도식입니다. 배경은 OpenStreetMap 타일을 사용하며, 타일 요청에 실패해도 노선과 역은 표시됩니다. 확대·축소와 드래그, 두 손가락 조작, 키보드 이동을 지원합니다. |
| 데이트 코스 | 뽑기 결과에서 별도 코스 페이지를 엽니다. 놀거리·먹거리·카페를 방문 순서대로 카드에 표시합니다. 등록한 장소 사진과 네이버 지도 출처를 표시하고, 사진이 없는 카드는 장소 정보만 표시합니다. 지도는 펼칠 때 불러오며, 역 주변 지도에 역과 좌표가 있는 장소를 방문 순서대로 표시하고, 번호를 누르면 장소 정보로 이동합니다. 놀거리·식당·카페 후보를 표시합니다. 후보와 방문 순서를 바꿀 수 있고, 후보 거리는 300m·500m·800m·1km 중에서 고를 수 있습니다. 버스나 셔틀이 필요한 장소는 이동 방법을 별도로 표시합니다. |
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

### 카드 사진

`data/place-photos.js`에 후보 데이터와 같은 장소 이름·주소, `assets/place-photos/`의 WebP 파일명, 네이버 장소 ID를 넣습니다. 장소 카드에서 **사진 출처 · 네이버 지도**를 누르면 해당 플레이스로 이동합니다. 사진 파일을 불러오지 못하면 사진 영역이 접힙니다.

전체 후보 데이터의 중복을 제거한 사진 현황과 미확보 장소 목록은 `node scripts/check-data.cjs --photo-coverage`로 출력합니다.

사진 파일을 여러 장 전달받으면 UTF-8 CSV에 `name,address,placeId,file` 열로 정리합니다. `name`과 `address`에는 미확보 목록의 값을 쓰고, `file`에는 CSV 기준 상대경로를 넣습니다. Node.js와 `cwebp`가 설치된 환경에서 다음 명령을 실행하면 WebP 썸네일과 출처가 함께 등록됩니다. 기존 장소의 사진도 같은 키로 갱신할 수 있습니다.

```sh
python3 scripts/import-place-photos.py /path/to/place-photos.csv
```

네이버 지도 공개 장소 페이지에서 사진을 확인하고 등록하려면 아래 명령을 사용합니다. 처음 실행할 때 브라우저 검증과 동일하게 Playwright와 Google Chrome을 준비합니다. 두 번째 인수로 한 번에 확인할 최대 장소 수를 지정할 수 있습니다. 이전에 확인한 장소는 진행 파일에 기록되고, 네이버가 HTTP 429를 반환하면 그 시점까지의 결과를 저장하고 종료합니다.

```sh
NODE_PATH=/tmp/subway-date-browser-check/node_modules node scripts/collect-place-photos.cjs /tmp/subway-date-photo-progress.json 24
```

## 역 상세의 네이버 지도

네이버 클라우드 Maps의 **Web Dynamic Map**을 활성화한 애플리케이션에 서비스 URL을 등록합니다. 로컬 확인에는 포트 번호 없이 `http://localhost`를 등록하고, 브라우저에서는 `http://localhost:18473`으로 접속합니다. 배포 시에는 배포 호스트를 등록합니다. [클라이언트 아이디 발급 안내](https://navermaps.github.io/maps.js.ncp/docs/tutorial-1-Getting-Client-ID.html)

`index.html`의 `naver-maps-client-id` 메타 태그에는 브라우저용 Client ID(`ncpKeyId`)를 설정합니다. Client Secret은 사용하지 않습니다. ID가 없거나 인증에 실패하면 기존 OpenStreetMap 기반 지도가 표시됩니다.

웹 지도는 역과 선택한 장소의 좌표에 마커를 표시하고, 연결 가능한 구간을 방문 순서에 따라 직선 점선으로 그립니다. Directions API가 제공하는 경로는 자동차용입니다. 실제 도보 경로는 좌표가 있는 구간을 네이버 지도 앱으로 전달해 확인합니다. [Directions 5](https://guide.ncloud-docs.com/docs/ko/maps-direction5-api) · [지도 앱 연동](https://guide.ncloud-docs.com/docs/ko/maps-url-scheme)

## 검증

데이터 갱신 후 역 ID, 노선 연결, 장소 좌표와 거리를 확인합니다. 보강할 역과 분류는 `--coverage-gaps`, 노선별 후보 수와 800m 조건 충족 수는 `--app-coverage`로 확인합니다.

```sh
node scripts/check-data.cjs
node scripts/check-data.cjs --coverage-gaps
node scripts/check-data.cjs --app-coverage
```

브라우저 검증에는 [README](../README.md#내-컴퓨터에서-실행하기)의 로컬 서버, Node.js와 npm, Google Chrome이 필요합니다. 테스트는 뽑기 연출, 장소 조건, 지도 조작, 코스 편집과 공유를 확인합니다. 기기 공유는 브라우저 API를 대역으로 검증합니다.

```sh
npm install --prefix /tmp/subway-date-browser-check playwright
NODE_PATH=/tmp/subway-date-browser-check/node_modules node scripts/check-browser.cjs
```
