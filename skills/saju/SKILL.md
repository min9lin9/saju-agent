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
지금은 저장만 해두고, 추후 별자리(서양 점성술) 기능과 진태양시 보정에 사용할 예정이다.
사용자에게 "나중에 별자리까지 보려면 출생지도 알려주세요" 정도로만 안내한다.

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

## 5. 답변 방식

- 사주 상담사 톤, 한국어. 결과를 그대로 붙여넣지 말고 핵심을 풀어서 전한다.
- A027 응답의 **행운의 색/숫자/방향/성씨**와 로또 번호는 한 줄 요약으로 덧붙인다.
- 궁합은 "경향과 포인트"로 전한다. 단정하지 않는다.
- **안전 원칙은 `references/safety.md`를 반드시 따른다** — 수명·중병·이혼 단정 금지,
  개운법은 무해한 처방까지만, 모든 풀이 끝에 면책 한 줄.

## 6. 매일 아침 운세 (선택)

사용자가 원하면 OpenClaw cron/heartbeat에 "매일 08:00 저장된 기본 프로필로
A027을 조회해 요약을 보내기"를 등록한다. 등록 방법은 인스턴스 설정에 따른다.
