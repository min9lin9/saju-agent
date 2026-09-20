---
name: saju
description: 생년월일시로 사주팔자·대운·세운·오늘의 운세·궁합을 봐주는 스킬. 명식·운세 수치는 로컬 계산 엔진(saju.mjs)이 정하고, 신한라이프 운세 엔드포인트는 해설 본문·점수용으로 curl 호출한다.
---

# saju: 사주·운세·궁합

사용자가 사주, 운세, 궁합, 오늘/특정 날짜의 운을 물으면 이 스킬을 사용한다.

## 0. 소스 라우팅 (중요)

| 요청 | 1차 소스 | 역할 |
|---|---|---|
| 명식·사주팔자·십신·오행·합충형파해·대운·세운/월운/일운 | `scripts/saju.mjs` (로컬 계산) | 유일한 계산 권위. LLM은 계산하지 않는다 |
| 오늘/특정일 운세 해설, 행운의 색·숫자·방향, 로또 | 신한라이프 `good_luck.php` (A027 등) | 해설 본문·점수. 제공자 결과로 라벨 |
| 궁합 점수·본문 | 신한라이프 B017 | 제공자 점수로 라벨 |
| 별자리·네이탈 차트·시나스트리 | `scripts/natal.mjs` | 점성술 결과로 라벨 |

- 사주 수치(간지·십신·오행 개수·대운 날짜·나이)가 필요하면 항상 `saju.mjs`를
  먼저 실행한다. 제공자 응답의 사주정보 블록과 로컬 결과가 다르면 로컬 결과를
  쓰고, 차이가 있다는 사실만 언급한다.
- `saju.mjs`가 실패하면(exit 1/2) 그 사유를 전한다. 신한라이프나 LLM 추정으로
  계산을 대체하지 않는다.
- 계산 계약·에러 코드·해석 규칙: `references/calculation.md`.
  개인 리딩 절차: `references/personal-reading.md`.
  궁합 절차: `references/compatibility-reading.md`.

## 1. 프로필 수집과 저장

운세에 필요한 정보: **성별(M/F), 양력/음력(S/L/Z), 생년월일, 태어난 시간**.
태어난 시간을 모르면 `birth_hour`를 비워서 보낸다(시주 없이 조회됨).

**선택 정보: 출생지(location)**: 프로필 등록 시 위치(예: 서울, 부산)를 선택으로 받는다.
별자리(네이탈 차트) 계산과 진태양시 보정에 사용한다. 저장된 location이 없고
별자리 요청이 오면 그때 물어본다.

**선택 정보: 정밀 생시(`birth_time`)와 시간대(`birth_timezone`)**: 로컬 계산
`saju.mjs`용 선택 필드다. `birth_time`은 `HH:mm:ss`, `birth_timezone`은
IANA 존 이름(예: `Asia/Seoul`)이며, 둘 다 **사용자가 실제로 알려준 값만**
저장한다. 기존 `birth_hour`("20" 같은 2시간 시주 값)는 제공자용 근사값이므로
`birth_time`으로 자동 변환하지 않는다. `birth_hour`가 "20"이어도
`birth_time`을 "20:00:00"으로 만들지 않는다. 정밀 생시가 없으면 로컬 계산은
`time:null`(시간 미상)로 돌린다.

- 사용자가 동의하면 프로필을 `<workspace>/saju/profiles.json`에 저장한다.
  형식은 `skills/saju/profiles.example.json` 참고.
- 저장된 프로필이 있으면 "내 운세", "엄마랑 궁합"처럼 이름으로 바로 조회한다.
- 프로필은 개인정보이므로 저장 전에 한 번 묻고, 파일 위치를 알려준다.

## 2. 로컬 사주 계산 (saju.mjs)

명식·대운·운세 수치가 필요하면 request JSON 파일을 만들어 실행한다:

```bash
node skills/saju/scripts/saju.mjs --input <request.json>
```

```json
{
  "schemaVersion": 1,
  "birth": {
    "calendar": "solar",
    "date": "1998-10-27",
    "time": "20:40:00",
    "timezone": "Asia/Seoul",
    "utcOffset": "+09:00",
    "gender": "male"
  },
  "queries": {
    "majorCycles": 10,
    "transits": ["2026-09-17T12:00:00+09:00"]
  }
}
```

- `calendar`: `solar` 또는 `korean_lunar`(음력이면 `leapMonth` 필수).
- `time`: `HH:mm:ss` 또는 `null`(시간 미상). 모르면 null, 추정 금지.
- `timezone`: IANA 존 필수. `utcOffset`은 DST 중복 시각 구분용 선택값.
- `gender`: `male`/`female` 선택값. 없으면 대운만 빠지고 원국은 나온다.
- `queries.majorCycles`: 0~12. `queries.transits`: RFC3339 instant 최대 366개.
- exit 0 = stdout에 결과 JSON. exit 2 = stderr에 `{error:{code,path,message}}`.
  exit 1 = 의존성/내부 오류.
- 결과 필드·제한 코드·해석 규칙 전부 `references/calculation.md`에 있다.
  핵심: **계산된 필드를 쓰거나 생략한다. 절대 다시 계산하지 않는다.**

## 3. 사주/운세 호출 (unse_code=A027 기본)

```bash
curl -s 'https://shinhanlife.sinbiun.com/unse/good_luck.php' \
  -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'unse_code=A027&specific_year=YYYY&specific_month=MM&specific_day=DD&user_gender=M&user_birth_year=YYYY&gender=M&sl_cal=S&birth_year=YYYY&birth_month=MM&birth_day=DD&birth_hour=HH&sp_num=YYYY-MM-DD' \
  -o /tmp/unse_A027.html
```

- `specific_*`/`sp_num` = 조회 대상 날짜(오늘이 아니어도 됨, "다음 주 금요일 운세" 가능).
- `sl_cal`: S=양력, L=음력, Z=음력 윤달.
- `birth_hour`: 00~24 짝수(2시간 시주). 예: 저녁 8시 → 20.
- 다른 운세 코드는 `references/codes.md` 표 참고.

## 4. 궁합 호출 (unse_code=B017)

본인 파라미터에 상대방 파라미터를 `*2`로 추가한다:

```bash
curl -s 'https://shinhanlife.sinbiun.com/unse/good_luck.php' \
  -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'unse_code=B017&specific_year=YYYY&specific_month=MM&specific_day=DD&user_gender=M&user_birth_year=YYYY&gender=M&sl_cal=S&birth_year=YYYY&birth_month=MM&birth_day=DD&birth_hour=HH&name2=이름&gender2=F&sl_cal2=S&birth_year2=YYYY&birth_month2=MM&birth_day2=DD&birth_hour2=HH&sp_num=YYYY-MM-DD' \
  -o /tmp/unse_B017.html
```

응답에는 연인궁합·결혼궁합·친구궁합·직장/동료궁합 점수(%)와 본문이 들어 있다.
궁합 답변 구성은 `references/compatibility-reading.md`를 따른다. 두 명식 사이의
교차 합충은 로컬에서 계산되지 않으므로 "계산되지 않음"으로 표기한다.

## 5. 응답 읽기

응답은 UTF-8 HTML이다. 태그를 벗겨 텍스트로 보려면:

```bash
python3 -c "
import re, html
raw = open('/tmp/unse_A027.html', encoding='utf-8').read()
raw = re.sub(r'<(script|style)[^>]*>.*?</\1>', '', raw, flags=re.S|re.I)
print('\n'.join(l for l in (s.strip() for s in html.unescape(re.sub(r'<[^>]+>', '|', raw)).split('|')) if l))
"
```

응답에는 항상 **사주정보 블록**(사주팔자 천간/지지/십신, 오행 점수, 일주 강약,
대운 10년 흐름, 양력↔음력 변환)이 포함된다. 이 블록은 제공자 계산이다. 로컬
`saju.mjs` 결과와 다르면 로컬 결과를 명식으로 쓰고 제공자 블록은 참고로만
둔다. 운세만 물었어도 명식을 함께 요약해주면 좋다.

## 6. 별자리 (네이탈 차트)

"별자리", "네이탈 차트", "점성술" 요청이 오면 `scripts/natal.mjs`를 사용한다.
사주와 달리 **출생지 좌표**가 필요하다:

1. 프로필의 `location`을 `references/cities.json`에서 조회해 위도·경도·타임존을 얻는다.
   없는 도시면 Nominatim(`nominatim.openstreetmap.org/search?q=<도시>&format=json&limit=1`)을
   1회 호출해 좌표를 얻는다(사용 정책상 재호출 금지, 얻은 좌표는 프로필에 저장).
2. 실행:

```bash
cd <skill>/scripts && node natal.mjs '{"year":1998,"month":10,"day":27,"hour":20,"minute":0,"latitude":37.5665,"longitude":126.978,"timezone":"Asia/Seoul","city":"서울"}'
```

3. 출력 JSON: `planets[]`(행성별 별자리·하우스), `angles`(ASC·MC), `aspects[]`.
   태어난 시간 모르면 `isTimeUnknown: true`로 보낸다(정오 기준, ASC·하우스 부정확 명시).
4. 별자리 궁합(시나스트리): `node natal.mjs --synastry '{"person1":{...},"person2":{...}}'`
   → score 0~100 + 교차 어스펙트.

## 6-1. 사주+별자리 복합 리딩

"같이 봐줘", "복합으로" 요청이면 두 결과를 교차 해석한다:
- 사주 오행 분포(`saju.mjs`의 `counts`) ↔ 네이탈 차트 원소(불/흙/공기/물) 분포 비교
- 일간·십신 ↔ 태양·달·어센던트 별자리 성향 대조
- 궁합은 B017 점수 + 시나스트리 점수를 나란히 제시
어느 한쪽을 정답으로 단정하지 말고 "두 체계가 공통으로 가리키는 경향" 위주로 전한다.

## 7. 답변 방식

- 사주 상담사 톤, 한국어. 결과를 그대로 붙여넣지 말고 핵심을 풀어서 전한다.
- **근거 표기**: 사주 수치·간지·관계 주장에는 JSON 경로를 짧게 덧붙인다
  (예: "일간 丁, `natal.candidates[0].pillars.day`"). 계산되지 않은 값은
  만들지 않고 "계산되지 않음"이라고 말한다.
- **나이**: `transits[].age.years`를 복사해 "만나이 N세 (`asOfDate` 기준)"으로만
  표기한다. 문장 안에서 나이를 새로 계산하지 않는다.
- **원문 보존**: 사용자가 가져온 기존 명식·프로필 값은 그대로 보존한다.
  계산 결과와 다르면 나란히 보여주고 임의로 고치지 않는다.
- A027 응답의 **행운의 색/숫자/방향/성씨**와 로또 번호는 한 줄 요약으로 덧붙인다.
- 궁합은 "경향과 포인트"로 전한다. 단정하지 않는다.
- **안전 원칙은 `references/safety.md`를 반드시 따른다**, 수명·중병·이혼 단정 금지,
  개운법은 무해한 처방까지만, 모든 풀이 끝에 면책 한 줄.

## 7-1. GitHub Star (선택, 설치 직후 한 번)

설치가 끝난 직후, 사용자에게 한 번만 대화로 묻는다:
"min9lin9/saju-agent에 GitHub Star를 남길까요?"

- 명시적인 "예"만 허가다. 그때만 다음을 실행한다:
  `bash <skill>/scripts/star-repo.sh --consent`
- 설치 승인은 Star 동의를 포함하지 않는다. 거절·무응답이면 실행하지 않고
  다시 묻지 않는다.
- `--consent` 없이 실행하면 대화형 터미널에서는 스크립트가 직접 묻고,
  비대화형이면 `STAR_CONSENT_REQUIRED`를 출력하고 종료한다.

## 8. 매일 아침 운세 (선택)

사용자가 원하면 OpenClaw cron/heartbeat에 "매일 08:00 저장된 기본 프로필로
A027을 조회해 요약을 보내기"를 등록한다. 등록 방법은 인스턴스 설정에 따른다.
