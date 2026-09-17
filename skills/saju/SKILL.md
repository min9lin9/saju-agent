---
name: saju
description: 생년월일시로 사주팔자·오늘의 운세·궁합을 봐주는 스킬. 신한라이프 운세 엔드포인트를 curl로 직접 호출한다.
---

# saju — 사주·운세·궁합

사용자가 사주, 운세, 궁합, 오늘/특정 날짜의 운을 물으면 이 스킬을 사용한다.
별도 서버나 엔진 없이, 아래 curl 레시피로 `good_luck.php`를 직접 호출한다.

## 1. 프로필 수집과 저장

운세에 필요한 정보: **성별(M/F), 양력/음력(S/L/Z), 생년월일, 태어난 시간**.
태어난 시간을 모르면 `birth_hour`를 비워서 보낸다(시주 없이 조회됨).

**선택 정보 — 출생지(location)**: 프로필 등록 시 위치(예: 서울, 부산)를 선택으로 받는다.
별자리(네이탈 차트) 계산과 진태양시 보정에 사용한다. 저장된 location이 없고
별자리 요청이 오면 그때 물어본다.

- 사용자가 동의하면 프로필을 `<workspace>/saju/profiles.json`에 저장한다.
  형식은 `skills/saju/profiles.example.json` 참고.
- 저장된 프로필이 있으면 "내 운세", "엄마랑 궁합"처럼 이름으로 바로 조회한다.
- 프로필은 개인정보이므로 저장 전에 한 번 묻고, 파일 위치를 알려준다.

## 2. 사주/운세 호출 (unse_code=A027 기본)

```bash
curl -s 'https://shinhanlife.sinbiun.com/unse/good_luck.php' \
  -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'unse_code=A027&specific_year=YYYY&specific_month=MM&specific_day=DD&user_gender=M&user_birth_year=YYYY&gender=M&sl_cal=S&birth_year=YYYY&birth_month=MM&birth_day=DD&birth_hour=HH&sp_num=YYYY-MM-DD' \
  -o /tmp/unse_A027.html
```

- `specific_*`/`sp_num` = 조회 대상 날짜(오늘이 아니어도 됨 — "다음 주 금요일 운세" 가능).
- `sl_cal`: S=양력, L=음력, Z=음력 윤달.
- `birth_hour`: 00~24 짝수(2시간 시주). 예: 저녁 8시 → 20.
- 다른 운세 코드는 `references/codes.md` 표 참고.

## 3. 궁합 호출 (unse_code=B017)

본인 파라미터에 상대방 파라미터를 `*2`로 추가한다:

```bash
curl -s 'https://shinhanlife.sinbiun.com/unse/good_luck.php' \
  -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
  --data 'unse_code=B017&specific_year=YYYY&specific_month=MM&specific_day=DD&user_gender=M&user_birth_year=YYYY&gender=M&sl_cal=S&birth_year=YYYY&birth_month=MM&birth_day=DD&birth_hour=HH&name2=이름&gender2=F&sl_cal2=S&birth_year2=YYYY&birth_month2=MM&birth_day2=DD&birth_hour2=HH&sp_num=YYYY-MM-DD' \
  -o /tmp/unse_B017.html
```

응답에는 연인궁합·결혼궁합·친구궁합·직장/동료궁합 점수(%)와 본문이 들어 있다.

## 4. 응답 읽기

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
대운 10년 흐름, 양력↔음력 변환)이 포함된다. 운세만 물었어도 명식을 함께 요약해주면 좋다.

## 5. 별자리 (네이탈 차트)

"별자리", "네이탈 차트", "점성술" 요청이 오면 `scripts/natal.mjs`를 사용한다.
사주와 달리 **출생지 좌표**가 필요하다:

1. 프로필의 `location`을 `references/cities.json`에서 조회해 위도·경도·타임존을 얻는다.
   없는 도시면 Nominatim(`nominatim.openstreetmap.org/search?q=<도시>&format=json&limit=1`)을
   1회 호출해 좌표를 얻는다(사용 정책상 재호출 금지 — 얻은 좌표는 프로필에 저장).
2. 실행:

```bash
cd <skill>/scripts && node natal.mjs '{"year":1998,"month":10,"day":27,"hour":20,"minute":0,"latitude":37.5665,"longitude":126.978,"timezone":"Asia/Seoul","city":"서울"}'
```

3. 출력 JSON: `planets[]`(행성별 별자리·하우스), `angles`(ASC·MC), `aspects[]`.
   태어난 시간 모르면 `isTimeUnknown: true`로 보낸다(정오 기준, ASC·하우스 부정확 명시).
4. 별자리 궁합(시나스트리): `node natal.mjs --synastry '{"person1":{...},"person2":{...}}'`
   → score 0~100 + 교차 어스펙트.

## 5-1. 사주+별자리 복합 리딩

"같이 봐줘", "복합으로" 요청이면 두 결과를 교차 해석한다:
- 사주 오행 분포 ↔ 네이탈 차트 원소(불/흙/공기/물) 분포 비교
- 일간·십신 ↔ 태양·달·어센던트 별자리 성향 대조
- 궁합은 B017 점수 + 시나스트리 점수를 나란히 제시
어느 한쪽을 정답으로 단정하지 말고 "두 체계가 공통으로 가리키는 경향" 위주로 전한다.

## 6. 답변 방식

- 사주 상담사 톤, 한국어. 결과를 그대로 붙여넣지 말고 핵심을 풀어서 전한다.
- A027 응답의 **행운의 색/숫자/방향/성씨**와 로또 번호는 한 줄 요약으로 덧붙인다.
- 궁합은 "경향과 포인트"로 전한다. 단정하지 않는다.
- **안전 원칙은 `references/safety.md`를 반드시 따른다** — 수명·중병·이혼 단정 금지,
  개운법은 무해한 처방까지만, 모든 풀이 끝에 면책 한 줄.

## 7. 매일 아침 운세 (선택)

사용자가 원하면 OpenClaw cron/heartbeat에 "매일 08:00 저장된 기본 프로필로
A027을 조회해 요약을 보내기"를 등록한다. 등록 방법은 인스턴스 설정에 따른다.
