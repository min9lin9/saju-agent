# 개인 사주 리딩 템플릿 (로컬 계산 기반)

개인 명식·대운·운세 해석 절차. 모든 수치와 간지는 `saju.mjs` 결과 JSON에서만
가져온다. 계산 규칙과 필드 설명은 `references/calculation.md` 참고.

## 1. 요청 만들기

사용자 입력을 request JSON으로 옮긴다:

- 양력이면 `calendar:"solar"`, 음력이면 `calendar:"korean_lunar"` + `leapMonth`.
  윤달 여부를 모르면 물어본다. 임의로 false로 두지 않는다.
- `date`는 `YYYY-MM-DD`, `time`은 `HH:mm:ss`. 시각을 모르면 `time:null`.
  "아침쯤" 같은 애매한 답은 null로 두고 그 사실을 답변에 명시한다.
- `timezone`은 출생지의 IANA 존(한국이면 `Asia/Seoul`). 모르면 물어본다.
- `gender`는 대운 방향에만 쓰인다. 없으면 대운 없이 원국만 나온다.
- `queries.majorCycles`: 대운을 원하면 10 정도, 아니면 0.
- `queries.transits`: 특정 날짜 운세가 필요하면 그 날짜의 RFC3339 instant
  (예: `"2026-09-17T12:00:00+09:00"`). 최대 366개.

프로필의 `birth_hour`(예: "20")는 제공자용 근사값이다. `birth_time`으로
자동 변환하지 않는다. 정밀 시각은 사용자가 실제로 알려준 값만 쓴다.

## 2. 실행

```bash
node skills/saju/scripts/saju.mjs --input <request.json>
```

exit 0이면 stdout의 JSON을 해석한다. exit 2면 stderr의 `error.code`와
`error.path`를 보고 사용자에게 무엇이 잘못됐는지(없는 날짜, 모호한 시각 등)
설명하고 수정된 입력을 받는다. exit 1이면 의존성/환경 문제이므로 설치 상태를
안내한다. 어떤 실패도 신한라이프나 LLM 계산으로 대체하지 않는다.

## 3. 해석 순서와 근거 필드

각 항목은 괄호 안의 JSON 경로를 근거로만 말한다.

1. 명식 요약: `natal.candidates[i].pillars`의 year/month/day/hour `ganZhi`·
   `korean`. 시주가 null이면 "시간 미상으로 시주 없음"을 먼저 밝힌다.
2. 일간: `natal.dayMaster.stem` (한자·한글·오행·음양). 일간 해석의 기준점.
3. 십신 분포: 각 pillar의 `stemTenGod`, `branchTenGod`, `hiddenStems[].tenGod`.
4. 십이운성: 각 pillar의 `dayStemStage` (일간 기준)와 `stemStage`.
5. 오행 분포: `counts.combinedSurface.units`(표면 8단위)와
   `counts.stemsPlusWeightedHidden.units`(지장간 가중). 측정값 그대로 전한다.
   용신·신강신약 점수를 새로 만들지 않는다.
6. 합충형파해: `relations[]`의 `ruleId`+`occurrenceIds`+`completion`.
   partial은 partial로 말한다. `transformationStatus`는 항상
   `not_evaluated`이므로 합화·길흉 단정 금지.
7. 공망·원진·귀문: `specialRules[]`. 공망은 `voidBranches`와
   `referenceOccurrenceId`를 함께 표시한다.
8. 대운: `majorCycles.candidates[i].ranges[].cycles[]`의 `pillar`와
   `interval` 범위. `direction`·`directionBasis`·`distance`·`start.age`는
   요청하면 근거로 보여준다. `available:false`면 이유(`MISSING_MAJOR_DIRECTION`
   등)를 전하고 성별을 물어볼지 선택한다.
9. 운세(transits): 요청한 각 `transits[]`의 `pillarCandidates[].pillars`
   (annual/monthly/daily), `contexts[]`의 일간 기준 십신·십이운성,
   `activeMajorCycle`, `relations[]`(`sources`에 natal/major/transit 표기됨).
   나이는 `age.years`를 "만나이 N세 (`asOfDate` 기준)"으로만 표기한다.

## 4. 부분 결과·모호함 처리

- `limitations[]`가 있으면 해당 항목을 먼저 알린다:
  - `UNKNOWN_BIRTH_TIME`: 시주 null, 오행 6단위, 대운 시작이 범위.
  - `MISSING_MAJOR_DIRECTION`: 대운 없음, 원국은 정상.
  - `AMBIGUOUS_NATAL_BOUNDARY` / `SOLAR_TERM_UNCERTAINTY`: 후보가 둘 이상.
    각 후보를 따로 보여주고 하나로 합치지 않는다.
  - `LUNAR_METADATA_OUT_OF_RANGE`: 음력 메타데이터만 없음, 양력 계산은 정상.
- `coverageComplete:false`면 "시주를 제외한 부분 해석"임을 명시한다.
- 사용자가 가져온 기존 명식(만세력 출력 등)이 결과와 다르면 원문을 보존하고
  나란히 보여준다. 어느 쪽도 임의로 고치지 않는다.

## 5. 답변 톤

- 사주 상담사 톤, 한국어. JSON을 그대로 붙여넣지 말고 풀어서 전한다.
- 주장마다 근거 필드를 짧게 덧붙인다(예: "일간 丁(정), natal.dayMaster").
- `references/safety.md`의 안전 원칙과 면책 한 줄을 지킨다.
