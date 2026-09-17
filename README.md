# saju-agent 🔮

OpenClaw용 사주·운세·궁합 스킬. 생년월일시를 넣으면 신한라이프 운세 엔드포인트를
curl로 직접 호출해 **사주팔자(명식) + 오늘의 운세 + 궁합**을 봐준다.
별도 서버·엔진·API 키 없음.

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

## 뭘 해주나

| 요청 예시 | 동작 |
|---|---|
| "1998년 10월 27일 저녁 8시생 남자 오늘 운세" | A027 호출 → 명식 + 미니운세% + 총론/재물/애정/로또 + 행운 정보 |
| "나랑 ○○이랑 궁합 봐줘" | B017 호출 → 연인/결혼/친구/직장 궁합 % + 본문 |
| "다음 주 금요일 운세" | `specific_*`를 해당 날짜로 설정해 조회 |
| "내 프로필 저장해줘" | `<workspace>/saju/profiles.json`에 저장, 이후 이름으로 조회. 출생지는 선택 — 추후 별자리·진태양시 보정용 |
| "매일 아침 운세 보내줘" | OpenClaw cron/heartbeat 등록 안내 |

응답에는 항상 사주정보(사주팔자·십신·오행 점수·신강/신약·대운)가 포함된다.
지원하는 전체 운세 코드(주간/월간/토정비결/건강운/로또 등)는
`skills/saju/references/codes.md` 참고.

## 구조

```
skills/saju/SKILL.md            # 스킬 본체 — 트리거, curl 레시피, 답변 톤
skills/saju/references/codes.md # unse_code 표 + 파라미터 스펙 (실측 문서)
skills/saju/references/safety.md# 안전 원칙 (단정 금지, 면책)
skills/saju/profiles.example.json
install.sh
tests/fixtures/                 # 실측 응답 HTML (A027, B017)
```

## 확장 경로

- 엔드포인트가 막히면 오프라인 대안이 있다:
  - `saju-fortune` npm 패키지(`npm i -g saju-fortune`) — `analyzeSaju`/`checkCompatibility`
    로 로컬 사주·궁합 분석. `min9lin9/k-skill`의 `docs/features/saju-fortune.md` 참고.
  - `min9lin9/saju-gpt`의 `core/manseryeok.py`(MIT) — 만세력 엔진.
- 더 깊은 평생사주 풀이는 `min9lin9/saju-skill`(18장 목차·해석 근거) 참고.
- 프로필의 `location`(출생지)은 추후 별자리(서양 점성술) 기능과 진태양시 보정에 사용 예정.
- 작명은 `naming-house` npm 패키지 + `min9lin9/k-skill`의 naming-house 가이드로 확장 가능.

## 면책

비공식 이용이다. 신한라이프 무료 운세 페이지가 공개로 제공하는 엔드포인트를
그대로 호출하며, 결과는 재미·참고용이다. 과도한 반복 요청은 피한다.
