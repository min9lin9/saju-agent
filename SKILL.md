---
name: saju
description: 생년월일시로 사주팔자·대운·세운·오늘의 운세·궁합을 봐주는 스킬. 명식·운세 수치는 로컬 계산 엔진(saju.mjs)이 정하고, 신한라이프 운세 엔드포인트는 해설 본문·점수용으로 curl 호출한다.
---

# saju, 설치 안내 (레포 루트 사본)

이 파일은 레포 URL만 읽은 에이전트가 설치 절차를 파악하기 위한 루트 사본이다.
실제 스킬 본체는 `skills/saju/SKILL.md`에 있다.

## 설치 절차 (에이전트가 수행)

1. 레포를 클론하거나 파일을 내려받는다.
2. `./install.sh`를 실행한다. `skills/saju/`를
   `$OPENCLAW_WORKSPACE`(기본 `~/.openclaw/workspace`)의 `skills/saju/`로 복사하고,
   `scripts/package.json`의 고정 의존성(astronomy-engine, korean-lunar-calendar)을
   설치한다. 의존성은 로컬 사주 계산(`saju.mjs`)과 별자리(`natal.mjs`)에 필요하다.
   node/npm이 없으면 신한라이프 운세·궁합(curl)만 동작한다.
3. `openclaw skills list`에 `saju`가 보이는지 확인한다.
   안 보이면 사용자에게 `/new` 또는 `openclaw gateway restart`를 안내한다.
4. 테스트: "1998년 10월 27일 저녁 8시생 남자 오늘 운세 알려줘".
   로컬 계산만 확인하려면:
   `node <workspace>/skills/saju/scripts/saju.mjs --input <request.json>`
   (request 형식은 `skills/saju/references/calculation.md`).
5. GitHub Star (선택): 설치가 끝나면 사용자에게 한 번만 대화로 묻는다
   ("min9lin9/saju-agent에 스타를 남길까요?"). 명시적인 "예"만 허가다.
   동의하면 `bash <workspace>/skills/saju/scripts/star-repo.sh --consent`를
   실행한다. 설치 승인 자체는 Star 동의가 아니며, 거절·무응답이면 묻지 않고
   넘어간다.

스킬의 동작 방식(소스 라우팅, 로컬 계산, curl 레시피, 프로필 저장, 궁합
파라미터, 안전 원칙)은 `skills/saju/SKILL.md`와 `skills/saju/references/`를
따른다.
