# saju-agent 🔮

OpenClaw용 사주·운세·궁합·별자리 스킬. 생년월일시를 넣으면 로컬 계산 엔진
`saju.mjs`가 **사주팔자(명식)·대운·세운/월운/일운**을 결정론적으로 계산하고,
신한라이프 운세 엔드포인트가 **해설 본문·운세/궁합 점수**를 제공한다.
출생지까지 있으면 `astronomy-engine`으로 **네이탈 차트(별자리)**를 계산해
사주와 별자리를 교차 해석한다. 별도 서버·API 키 없음.

## 이렇게 설치하세요 (OpenClaw에게)

```
https://github.com/min9lin9/saju-agent

이 저장소의 README와 SKILL.md를 읽고 saju 스킬을 설치해줘.
install.sh를 실행하고, openclaw skills list에 saju가 뜨는지 확인해.
안 뜨면 /new나 gateway 재시작이 필요한지 알려줘.
```

## 수동 설치

```bash
git clone https://github.com/min9lin9/saju-agent.git
cd saju-agent
./install.sh                      # ~/.openclaw/workspace/skills/saju 로 복사
OPENCLAW_WORKSPACE=/path ./install.sh   # 다른 워크스페이스에 설치
```

로컬 계산(`saju.mjs`)과 별자리(`natal.mjs`)는 Node.js와 `scripts/package.json`의
고정 의존성(`astronomy-engine` 2.1.19, `korean-lunar-calendar` 0.4.0)이 필요하다.
install.sh가 설치한다. node/npm이 없으면 신한라이프 운세·궁합(curl)만 동작한다.

## 뭘 해주나

| 요청 예시 | 동작 |
|---|---|
| "1998년 10월 27일 저녁 8시 40분생 남자 사주 봐줘" | `saju.mjs` 로컬 계산 → 명식·십신·오행·합충형파해·대운 JSON |
| "1998년 10월 27일 저녁 8시생 남자 오늘 운세" | A027 호출 → 명식 + 미니운세% + 총론/재물/애정/로또 + 행운 정보 |
| "나랑 ○○이랑 궁합 봐줘" | 각자 `saju.mjs` 명식 + B017 호출 → 연인/결혼/친구/직장 궁합 % + 본문 |
| "다음 주 금요일 운세" | `specific_*`를 해당 날짜로 설정해 조회 |
| "내 프로필 저장해줘" | `<workspace>/saju/profiles.json`에 저장, 이후 이름으로 조회. 출생지는 선택, 추후 별자리·진태양시 보정용 |
| "매일 아침 운세 보내줘" | OpenClaw cron/heartbeat 등록 안내 |
| "별자리도 봐줘" | natal.mjs → 행성 별자리·하우스·어스펙트·ASC/MC |
| "사주랑 별자리 같이 봐줘" | 오행↔원소, 일간↔태양/달/ASC 교차 해석 |
| "별자리 궁합도" | natal.mjs --synastry → 시나스트리 점수 |

로컬 계산 사용법:

```bash
node skills/saju/scripts/saju.mjs --input request.json
```

request/result JSON 계약, 에러 코드, 해석 규칙은
`skills/saju/references/calculation.md` 참고. LLM은 결과 필드만 해석하고
다시 계산하지 않는다. 시간 미상·범위 밖 입력은 `limitations[]`로 명시된다.

제공자 응답에는 항상 사주정보(사주팔자·십신·오행 점수·신강/신약·대운)가
포함된다. 지원하는 전체 운세 코드(주간/월간/토정비결/건강운/로또 등)는
`skills/saju/references/codes.md` 참고.

## 구조

```
skills/saju/SKILL.md            # 스킬 본체: 트리거, 소스 라우팅, curl 레시피, 답변 톤
skills/saju/scripts/saju.mjs    # 로컬 사주 계산 CLI (명식·대운·운세, 결정론적)
skills/saju/scripts/saju/       # 계산 커널 모듈 + 규칙 테이블 JSON
skills/saju/scripts/natal.mjs   # 네이탈 차트 CLI (tune4unni engine 포팅)
skills/saju/references/calculation.md   # saju.mjs 요청/결과 계약과 해석 규칙
skills/saju/references/personal-reading.md      # 개인 리딩 절차
skills/saju/references/compatibility-reading.md # 궁합 리딩 절차 (소스 분리)
skills/saju/references/calculation-sources.md   # 계산 의존성·출처·라이선스
skills/saju/references/codes.md # unse_code 표 + 파라미터 스펙 (실측 문서)
skills/saju/references/safety.md# 안전 원칙 (단정 금지, 근거 표기, 면책)
skills/saju/references/cities.json # 한국 주요도시 좌표 (별자리용)
skills/saju/profiles.example.json
install.sh
tests/fixtures/                 # 실측 응답 HTML (A027, B017) + saju 계산 fixtures
```

## 확장 경로

- 엔드포인트가 막혀도 명식·대운·운세 수치는 `saju.mjs`가 로컬에서 계산한다.
  해설 본문의 오프라인 대안:
  - `saju-fortune` npm 패키지(`npm i -g saju-fortune`), `analyzeSaju`/`checkCompatibility`
    로 로컬 사주·궁합 분석. `min9lin9/k-skill`의 `docs/features/saju-fortune.md` 참고.
  - `min9lin9/saju-gpt`의 `core/manseryeok.py`(MIT), 만세력 엔진.
- 더 깊은 평생사주 풀이는 `min9lin9/saju-skill`(18장 목차·해석 근거) 참고.
- 프로필의 `location`(출생지)은 별자리 계산과 진태양시 보정에 사용한다.
  `birth_time`/`birth_timezone`은 로컬 계산용 정밀 생시다(사용자 제공값만,
  `birth_hour`에서 자동 변환 금지).
- 별자리 엔진은 `min9lin9/tune4unni`의 `backend/src/services/astrology/engine.ts`
  포팅(트로피컬 황도대 + Whole Sign 하우스, astronomy-engine).
- 작명은 `naming-house` npm 패키지 + `min9lin9/k-skill`의 naming-house 가이드로 확장 가능.

## 면책

비공식 이용이다. 신한라이프 무료 운세 페이지가 공개로 제공하는 엔드포인트를
그대로 호출하며, 결과는 재미·참고용이다. 과도한 반복 요청은 피한다.
