# unse_code 레퍼런스 (2026-09-17 실측)

엔드포인트: `POST https://shinhanlife.sinbiun.com/unse/good_luck.php`
Content-Type: `application/x-www-form-urlencoded` — 인증·쿠키·Referer 불필요.

## 공통 파라미터

| 파라미터 | 의미 | 값 |
|---|---|---|
| `unse_code` | 운세 종류 | 아래 표 |
| `specific_year` `specific_month` `specific_day` | 조회 대상 날짜 | YYYY MM DD (0패딩) |
| `sp_num` | 조회 대상 날짜 | `YYYY-MM-DD` |
| `gender` / `user_gender` | 본인 성별 | `M` / `F` |
| `user_birth_year` | 본인 출생연도(나이 표시용) | YYYY |
| `sl_cal` | 생년월일 기준 | `S`=양력, `L`=음력, `Z`=음력 윤달 |
| `birth_year` `birth_month` `birth_day` | 본인 생년월일 | YYYY MM DD |
| `birth_hour` | 태어난 시간 | 00~24 짝수(2시간 시주). 모르면 빈 값 |

## 궁합(B017) 추가 파라미터

`name2`(상대 이름), `gender2`, `sl_cal2`, `birth_year2`, `birth_month2`,
`birth_day2`, `birth_hour2` — 본인 필드에 `2`를 붙인 형태.

## 운세 코드표

| 코드 | 메뉴 | 상태 |
|---|---|---|
| A027 | 오늘의 운세 | ✅ 미니운세%, 총론, 재물운, 애정운, 로또운, 행운의 색/숫자/방향/성씨 |
| B017 | 프리미엄 궁합 | ✅ 연인/결혼/친구/직장동료 궁합 % + 본문 (상대방 파라미터 필요) |
| A040 | 주간 종합운세 | ✅ 응답 확인 |
| A103 | 월간 종합운세 | ✅ 응답 확인 |
| A104 | 신토정비결(연간) | ✅ 응답 확인 |
| A106 | 건강운 | ✅ 응답 확인 (230KB, 대용량) |
| A102 | 부자되기 | 응답 확인됨(연간 계열) |
| A042 | 평생운세 | 미검증 |
| A002 | 프리미엄 로또운세 | ✅ 사주정보+로또 내용 반환 |
| A105 | 내사랑 반쪽찾기 | 미검증 |
| A044 | 내 운명의 배우자 | 미검증 |
| A2xx | 타로 계열 | `/unse/tarot/tarot.php`로 라우팅됨 — good_luck.php 대상 아님 |

## 응답 구조

모든 응답에 공통으로 포함:
- 사주정보: 년/월/일/시주의 천간·지지·십신, 지장간, 오행 점수(목화토금수),
  일주 강약(신강/신약 + 점수), 대운(10년 단위 간지 흐름)
- 사주정보의 날짜는 양력 기준, 음력 입력 시 변환 결과도 표시됨
- 그 뒤에 운세별 본문 섹션
