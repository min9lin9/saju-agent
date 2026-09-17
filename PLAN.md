# saju-agent — OpenClaw 사주/궁합 에이전트 계획 (확정안)

## 목표
`min9lin9/saju-agent` 레포를 만들고, 신한라이프 운세 엔드포인트를 curl로 직접 호출하는
OpenClaw 스킬을 구현한다. **GitHub URL을 OpenClaw에게 주고 "설치해"라고 하면 설치되는
구조**(one-pass-oci-openclaw와 같은 에이전트 주도 설치 패턴).

## 확정된 결정 (사용자 답변 반영)
- `?tab=packages` = 계정 내 기존 사주 레포 참고용 → `saju-gpt`, `saju-skill` 발견·분석 완료.
- 배포 = 레포 URL + "설치해" → README/SKILL.md/install.sh가 에이전트가 읽고 실행 가능해야 함.
- 범위 = **사주(명식+운세)와 궁합만**. 제공된 curl 방식 그대로, 별도 엔진/서버 불필요.
- 프로필 저장 = 포함 (생년월일시를 워크스페이스에 저장).

## 실측으로 확인된 사실 (2026-09-17)
- `POST https://shinhanlife.sinbiun.com/unse/good_luck.php`, form-urlencoded, 인증 불필요.
- 모든 응답에 **사주정보 블록** 포함: 사주팔자(년월일시 천간/지지/십신), 오행 점수,
  일주 강약(신강/신약), 대운 10년 흐름, 양력↔음력 변환 결과.
- `sl_cal`: S=양력, L=음력, Z=음력 윤달 (폼에서 확인).
- `birth_hour`: 00~24 짝수 = 2시간 간격 시주 (20 → 戌시 확인).
- **A027 오늘의 운세** ✅: 미니운세 %, 총론, 재물운, 애정운, 로또운, 행운의 색/숫자/방향/성씨.
- **B017 프리미엄 궁합** ✅: 상대방 파라미터(`name2, gender2, sl_cal2,
  birth_year2/month2/day2/hour2`) 추가 시 연인/결혼/친구/직장동료 궁합 % + 본문 반환.
- 그 외 코드(응답 메뉴에서 추출, codes.json에 기록): A040 주간, A103 월간, A104 신토정비결,
  A102 부자되기, A106 건강운, A042 평생운세, A002 로또, A105 반쪽찾기, A044 운명의 배우자.
  → 스킬은 사주/궁합 흐름만 문서화하되 코드표는 확장용으로 동봉.

## 참고 자산 (기존 레포에서 가져올 것)
- `min9lin9/saju-skill` (bdev-saju): SKILL.md 구조, **안전 원칙**(수명·중병·이혼 단정 금지,
  개운법은 무해한 처방까지, 면책 문구), `install.sh` 패턴, `references/interpretation.md`
  해석 근거 — 톤/안전장치를 그대로 계승.
- `min9lin9/saju-gpt`: `core/manseryeok.py`(MIT, 만세력 엔진) — 이번 범위엔 curl만 쓰지만
  향후 오프라인 명식 계산 옵션으로 README에 언급.
- `min9lin9/k-skill`: `saju-fortune` 스킬 가이드 — 인터뷰 입력 표(이름/양음력/생일/시간/성별/
  출생 시군구/주제), `saju-fortune`·`naming-house` npm 패키지(실재 확인, 오프라인 대안).
  출생 시군구(선택) 입력은 사용자 요청의 location 필드와 일치.
- 계정 전체 스윕 결과(101개 레포 README + 파일트리): 사주 관련은 saju-gpt, saju-skill,
  k-skill 3개뿐. 나머지 히트(astro=zodiac 무관, tarot 없음)는 무관.

## 레포 구조
```
saju-agent/
├── README.md                 # "이 URL을 OpenClaw에 주고 설치해" 안내 + 수동 설치 + 면책
├── SKILL.md                  # (레포 루트 사본 — 에이전트가 URL만 읽어도 지시 파악 가능)
├── skills/saju/
│   ├── SKILL.md              # name: saju — 트리거, 파라미터 수집 절차, curl 레시피, 톤
│   ├── references/
│   │   ├── codes.md          # unse_code 표 + 파라미터 스펙 (실측 문서)
│   │   └── safety.md         # saju-skill 안전 원칙 계승
│   └── profiles.example.json # 프로필 파일 형식 예시
├── install.sh                # skills/saju → ~/.openclaw/workspace/skills/saju 복사 + 검증
└── tests/fixtures/           # 실측 응답 HTML (A027, B017) — 회귀/파싱 참고용
```

## SKILL.md 핵심 로직 (curl만, 별도 빌드 없음)
1. **프로필 수집**: 이름·성별·양/음력·생년월일·태어난 시간(모르면 생략 → 시주 없이 조회).
   저장 동의 시 `<workspace>/saju/profiles.json`에 기록, 이후 "내 운세"로 재사용.
2. **사주/운세 요청**: SKILL.md에 기록된 curl 한 줄로 POST → 응답 HTML을
   `/tmp/unse_<code>.html`에 저장 → 에이전트가 사주정보+운세 본문을 읽고 요약.
   (HTML→텍스트 변환은 SKILL.md에 적힌 python3 원라이너 사용 — 별도 스크립트 아님.)
3. **궁합 요청**: 두 프로필(또는 즉석 입력)로 `*2` 파라미터 추가해 동일 호출.
4. **톤/안전**: 사주 상담사 페르소나, 단정 금지·면책 문구 — safety.md 참조.

## install.sh 동작
1. `OPENCLAW_WORKSPACE`(기본 `~/.openclaw/workspace`) 하위 `skills/saju/`로 복사.
2. `openclaw skills list`에 `saju`가 뜨는지 확인, 안 뜨면 `/new` 또는 gateway 재시작 안내.
3. 대화 테스트 예시 출력: "1998년 10월 27일 저녁 8시생 남자 오늘 운세 알려줘".

## 작업 순서
1. `gh repo create min9lin9/saju-agent --public` → 로컬 디렉토리를 origin에 연결.
2. `references/codes.md` 작성 (위 실측 표 + 파라미터 스펙).
3. `skills/saju/SKILL.md` + 루트 `SKILL.md` + `README.md` + `install.sh` 작성.
4. `profiles.example.json`, `safety.md`, fixture HTML 2건 커밋.
5. 검증: install.sh를 로컬에서 dry-run(대상 디렉토리 임시 지정) → 파일 배치 확인.
   실제 OpenClaw 로딩 확인은 사용자 인스턴스에서 수행(로컬에 openclaw 미설치).
6. push 후 "레포 URL + 설치해" 시나리오를 README대로 리허설.

## 가정 (확인 불필요한 선에서 결정)
- 대상 인스턴스: one-pass-oci-openclaw로 올린 OCI OpenClaw 또는 로컬 — install.sh는 둘 다 동작.
- 언어/톤: 한국어 사주 상담사.
- 운세 코드: 사주(A027 기본, 표에 전체 코드 기록) + 궁합(B017)만 흐름으로 문서화.
