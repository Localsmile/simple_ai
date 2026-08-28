# NVIDIA API 중계

Simple AI의 GitHub Pages 클라이언트와 NVIDIA Chat Completions API 사이의 CORS 중계. 기존 Worker와 독립적으로 배포한다.

## 요청 경로

- `GET /health`: 중계 상태 확인. NVIDIA 인증·추론 상태와는 별개다.
- `OPTIONS /v1/chat/completions`: CORS 사전 요청.
- `POST /v1/chat/completions`: `https://integrate.api.nvidia.com/v1/chat/completions`으로 전달.

임의 대상 URL, 다른 경로, 쿼리 매개변수, 리다이렉트 전달은 허용하지 않는다. 모델·추론·도구 호출 설정은 요청 JSON을 변경하지 않고 전달한다. 요청과 응답을 스트리밍하며 별도 버퍼링·자동 재시도·캐싱·저장은 하지 않는다. Workers Logs와 traces도 비활성화한다.

각 요청의 Bearer API 키로 NVIDIA에 인증한다. 공유 API 키나 Cloudflare 인증정보를 앱·Worker 소스에 포함하지 않는다. 원본 쿠키·Origin·임의 헤더는 NVIDIA에 전달하지 않고, 응답 쿠키도 브라우저에 전달하지 않는다.

## 접근과 사용량

`ALLOWED_ORIGINS`는 쉼표로 구분한 정확한 웹 출처 목록이다. 기본값은 `https://localsmile.github.io`이며 경로 단위 제한은 아니다. `ALLOW_LOCALHOST`가 `true`이면 HTTP/HTTPS의 localhost·127.0.0.1·[::1] 출처도 허용한다. `file://`의 null 출처는 허용하지 않는다.

CORS 출처 검사는 사용자 인증이 아니며 서버에서 위조할 수 있다. NVIDIA가 각 API 키의 유효성을 검증한다. 남용 완화를 위해 Cloudflare 위치별·접속 IP별 분당 120건의 POST 요청 제한을 적용한다. 같은 IP를 공유하는 사용자는 한도를 공유하며, 제한 시 429와 Retry-After를 반환한다. 이 제한은 정확한 전역 사용량 한도나 비용 상한이 아니다.

Cloudflare 계정의 현재 Workers 요금제와 요청 본문 한도, NVIDIA의 사용량·본문·모델 제한이 별도로 적용된다. Worker를 추가해도 요금제는 자동 변경하지 않으며, 유료 계정에서는 포함량 초과 비용이 발생할 수 있다. 요청당 CPU 한도는 50ms이다. Free 계정 배포 시에는 `limits` 설정을 제거하고 Free 플랜 한도를 따른다.

API 키와 대화는 Cloudflare를 경유한다. Worker 자체의 미저장 정책과 별개로 Cloudflare·NVIDIA의 서비스 정책이 적용된다. Rate Limiting은 IP 식별자를 임시 카운터로 사용한다.

## 개발·검증·배포

이 디렉터리에서 실행한다. Node.js 22.13 이상이 필요하다.

```sh
npm ci
npx wrangler login --scopes account:read user:read workers:write workers_scripts:write
npx wrangler whoami
npm run typecheck
npm run dry-run
npm run dev
```

최초 OAuth 승인 후 인증은 Wrangler의 로컬 자격 증명 저장소에서 관리한다. 인증을 해제하려면 `npx wrangler logout`을 사용한다. 다른 Cloudflare 서비스의 권한은 요청하지 않는다.

```sh
npm run deploy
```

다른 계정으로 배포할 때는 Worker 이름·허용 출처를 확인하고 앱의 `app/lib/connection.ts`에 있는 중계 주소를 배포 결과로 변경한다. 복수 계정 환경에서는 `CLOUDFLARE_ACCOUNT_ID`로 대상 계정을 명시한다. 공급자 API 키를 Worker secret으로 등록할 필요는 없다.

타입 정의는 `npm run types`로 생성하며 Git에 포함하지 않는다. 저장소 루트의 `npm test`는 중계 보안·스트리밍·프리셋 저장·앱 요청 경로 테스트도 실행한다. Worker 배포는 GitHub Pages 워크플로와 분리돼 있다.
