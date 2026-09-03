# Chat Completions CORS 중계

Simple AI의 GitHub Pages 클라이언트와 사용자 지정 OpenAI 호환 API 사이의 CORS 중계. 공급자별 고정 목록을 사용하지 않는다. 배포된 주소와 이전 클라이언트의 호환성을 위해 Worker 이름과 디렉터리는 `nvidia-proxy` 명칭을 유지한다.

## 요청 경로

- `GET /health`: 중계 상태 확인. 공급자 인증·추론 상태와는 별개다.
- `OPTIONS /proxy/openai`: CORS 사전 요청.
- `POST /proxy/openai`: `X-Upstream-Url` 헤더로 지정한 Chat Completions 또는 Responses 엔드포인트로 전달.
- 기존 `OPTIONS/POST /proxy/chat/completions`: 이전 클라이언트 호환 경로.
- 기존 `OPTIONS/POST /v1/chat/completions`: 이전 클라이언트를 위해 NVIDIA의 고정 엔드포인트를 유지한다. 이 경로에서 대상 변경은 허용하지 않는다.

대상은 공개 HTTPS 도메인, 기본 HTTPS 포트, `/chat/completions` 또는 `/responses`로 끝나는 경로만 허용한다. 대상의 쿼리 매개변수는 보존하며, Worker 자체 URL에는 쿼리를 허용하지 않는다. 대상 URL의 사용자명·비밀번호·fragment, IP 리터럴, 로컬·내부 도메인, 중계 자기 호출과 리다이렉트는 차단한다.

매 요청마다 Cloudflare DoH로 A·AAAA를 병렬 확인하고 사설·예약·매핑 주소가 포함된 응답은 거부한다. DNS 확인 제한은 5초, DNS 응답당 최대 크기는 128KiB이다. DNS 실패 시 공급자로 요청을 보내지 않는다. DNS 조회에는 호스트명만 포함하며 API 키·경로·쿼리·본문은 포함하지 않는다.

DNS 사전 검사는 주소 고정(pinning)이 아니다. 실제 연결 경계는 공개 인터넷용 Workers `fetch`에 의존한다. 이 Worker에는 origin route·VPC·사설망 바인딩을 추가하지 않는다. 관련 근거: [Cloudflare의 fetch/SSRF 설명](https://blog.cloudflare.com/workers-environment-live-object-bindings/).

모델·추론·도구 호출 설정은 요청 JSON을 변경하지 않고 전달한다. 채팅 요청과 응답을 스트리밍하며 별도 버퍼링·자동 재시도·캐싱·저장은 하지 않는다. Workers Logs와 traces도 비활성화한다.

각 요청의 Bearer API 키를 선택한 대상에 전달한다. API 키는 선택 사항이며, 공급자가 인증 여부를 결정한다. 공유 API 키나 Cloudflare 인증정보를 앱·Worker 소스에 포함하지 않는다. 원본 쿠키·Origin·중계 대상 헤더·임의 헤더는 공급자에 전달하지 않고, 응답 쿠키도 브라우저에 전달하지 않는다.

## 접근과 사용량

`ALLOWED_ORIGINS`는 쉼표로 구분한 정확한 웹 출처 목록이다. 기본값은 `https://localsmile.github.io`이며 경로 단위 제한은 아니다. `ALLOW_LOCALHOST`가 `true`이면 HTTP/HTTPS의 localhost·127.0.0.1·[::1] 출처도 허용한다. `file://`의 null 출처는 허용하지 않는다.

CORS 출처 검사는 사용자 인증이 아니며 서버에서 위조할 수 있다. 공급자가 각 API 키의 유효성을 검증한다. 남용 완화를 위해 DNS 조회 전에 Cloudflare 위치별·접속 IP별 분당 120건의 POST 요청 제한을 적용한다. 같은 IP를 공유하는 사용자는 한도를 공유하며, 제한 시 429와 Retry-After를 반환한다. 이 제한은 정확한 전역 사용량 한도나 비용 상한이 아니다.

Cloudflare 계정의 현재 Workers 요금제와 요청 본문 한도, 공급자의 사용량·본문·모델 제한이 별도로 적용된다. Worker를 추가해도 요금제는 자동 변경하지 않으며, 유료 계정에서는 포함량 초과 비용이 발생할 수 있다. 요청당 CPU 한도는 50ms이다. Free 계정 배포 시에는 `limits` 설정을 제거하고 Free 플랜 한도를 따른다.

API 키와 대화는 Cloudflare를 경유한다. Worker 자체의 미저장 정책과 별개로 Cloudflare·공급자의 서비스 정책이 적용된다. Rate Limiting은 IP 식별자를 임시 카운터로 사용한다. MCP·일반 웹사이트 프록시·로컬 서버 중계 용도로는 사용하지 않는다.

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

다른 계정으로 배포할 때는 Worker 이름·허용 출처를 확인하고 `shared/proxy-target.ts`의 `PROXY_HOST`를 배포 결과로 변경한다. 복수 계정 환경에서는 `CLOUDFLARE_ACCOUNT_ID`로 대상 계정을 명시한다. 공급자 API 키를 Worker secret으로 등록할 필요는 없다.

타입 정의는 `npm run types`로 생성하며 Git에 포함하지 않는다. 저장소 루트의 `npm test`는 중계 보안·스트리밍·프리셋 저장·앱 요청 경로 테스트도 실행한다. Worker 배포는 GitHub Pages 워크플로와 분리돼 있다.
