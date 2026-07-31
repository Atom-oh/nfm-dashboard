# ADR-013: SigV4/STS Server-to-Server Auth for `/api/mcp`, Alongside Bearer

<a href="#english"><img src="https://img.shields.io/badge/lang-English-blue.svg" alt="English"></a>
<a href="#korean"><img src="https://img.shields.io/badge/lang-한국어-red.svg" alt="Korean"></a>

---

<a id="english"></a>

# English

## Status

Accepted — 2026-07-31. Amends ADR-012: its core premise ("awsops, a different AWS account") was **factually wrong** — both nfm-dashboard and awsops run in the same account (`180294183052`), confirmed via `aws sts get-caller-identity` / live `NfmDash-App` and `awsops-v2` stack/cluster ARNs during this session. ADR-012's design (a bearer token) is **not reverted** — same-account status doesn't make a static secret wrong for every consumer — but it is no longer the *only* reasonable choice, and for the specific consumer that motivated ADR-012 (awsops calling server-to-server) it is no longer the *best* one.

## Context

Same-account status changes the calculus for awsops specifically:

- nfm-dashboard's existing 27-tool **`nfm-gateway`** (AgentCore, `AWS_IAM` authorizer) is invokable by *any* same-account IAM principal granted `bedrock-agentcore:InvokeGateway` on its ARN — there is no cross-account barrier at all. Adding that grant to awsops's AgentCore runtime role would work **today, zero code changes** — but only reaches the 27 existing tools (topology/pod-flows/network-infra), not the 12 lens/overview/infra-topology tools added on top of `/api/mcp`, which only exist in the Next.js app's TypeScript code, not as Lambda targets on that gateway.
- The NEW capability — `/api/mcp`, a plain ALB+ECS HTTP endpoint, not an AWS-native service — still cannot verify an arbitrary SigV4 signature itself the way API Gateway with an IAM authorizer would (that free verification is API Gateway's, not ours; we're a bare ALB target). So "same account" alone doesn't let us skip building something — it changes *what's worth building*: a static bearer token was the pragmatic floor for an assumed cross-account boundary; same-account server-to-server calls deserve IAM-backed auth with no long-lived secret and CloudTrail attribution.

## Decision

Add a second, independent auth scheme to `/api/mcp`, tried before the ADR-012 bearer path and never falling through to it on failure:

1. **`Authorization: AWS4-GetCallerIdentity <presigned sts:GetCallerIdentity URL>`** — the caller (e.g. awsops's AgentCore runtime, using its own IAM credentials) presigns a real `sts:GetCallerIdentity` request and hands us the URL. This is the same forwarding trick `aws-iam-authenticator` (EKS) and Vault's `auth/aws` method use to let a plain server verify an AWS identity without being an AWS-native service itself: we perform that *exact* HTTP call against the real STS endpoint (`app/src/lib/sigv4-verify.ts::verifyStsCallerIdentity`) — AWS validates the signature, not us — and a 200 response's `<Arn>`/`<Account>` tells us who signed it. No shared secret ever exists on our side to leak; access is revoked by removing the caller's IAM grant, and every call is attributable in CloudTrail as the caller's own identity.
2. **SSRF guard**: the presigned URL's hostname is pinned to `sts(\.<region>)?\.amazonaws\.com`, protocol must be `https:`, and `Action` must be `GetCallerIdentity` — anything else returns `null` before any network call. `redirect: 'manual'` so a redirect can't be used to reach an unintended host.
3. **Allowlist, not "any valid AWS identity"**: `isAllowedMcpCaller` requires `identity.account === MCP_ACCOUNT_ID` (checked independently of the ARN string as defense in depth) **and** the ARN matches an entry in `MCP_ALLOWED_CALLERS` (comma-separated; either `assumed-role/<RoleName>` — matches any session of that role, since the session-name suffix is caller-controlled and not something an allowlist can pin — or an exact ARN). Empty allowlist (the default) denies everyone; there is no "SigV4 configured" bit to leak the way ADR-012's `MCP_BEARER_TOKEN`-unset→404 does, because an unconfigured allowlist is indistinguishable from a configured-but-non-matching one (both 401).
4. **The `AWS4-GetCallerIdentity` branch never falls through to the Bearer branch on failure** — a malformed or rejected SigV4 attempt is a hard 401, not a second chance at the token. Prevents a confused/misconfigured SigV4 client from silently degrading to a weaker check.
5. **Bearer stays** (ADR-012, unchanged) for consumers that cannot sign a request — Claude Code CLI's `claude mcp add --header` sends a static string; it has no SigV4 signer.
6. **No new IAM permission on nfm's own task role.** We're not calling STS on our own behalf via the SDK — we're relaying an already-signed URL as a bare `fetch()`. AWS's own signature check is what gates it; our role needs nothing new.

## Consequences

- awsops's path to the 12 new tools: grant its AgentCore runtime role `MCP_ALLOWED_CALLERS = assumed-role/<its-runtime-role-name>` here, and have it presign+send the `AWS4-GetCallerIdentity` header instead of a static bearer token. Its path to the *existing* 27-tool `nfm-gateway` is separate and already live same-account (item 1 in Context) — the two are independent choices, not sequenced.
- `/api/mcp` now makes an outbound HTTPS call to `sts.amazonaws.com` per SigV4-scheme request (5s timeout, no retry). This requires ECS's private subnets to have NAT/IGW egress to the public STS endpoint — already true (the task already calls Bedrock/other public AWS endpoints from the same subnets).
- Two independent perimeters on one route means two independent things to keep correct; `middleware.test.ts` and `sigv4-verify.test.ts` cover both paths and the account/role-name-prefix-collision edge case (`assumed-role/foo` must not match `assumed-role/foo-2`).
- `MCP_ACCOUNT_ID`/`MCP_ALLOWED_CALLERS` are plain task-def env vars (not secrets) — there is nothing sensitive in "which account" or "which role name," unlike the bearer token.
- Lesson for future ADRs written under this project: an unverified premise stated in an early brainstorming turn ("different AWS account") sat unchallenged through several turns of *actual* exploration that contradicted it (both accounts resolved to `180294183052` repeatedly) before anyone — including me — noticed. Re-verify load-bearing premises against what was actually observed, not what was assumed at the start of the conversation.

---

<a id="korean"></a>

# 한국어

## Status

승인됨 — 2026-07-31. ADR-012을 개정(amend)합니다: 그 핵심 전제("awsops, 다른 AWS 계정")가 **사실과 달랐습니다** — nfm-dashboard와 awsops는 같은 계정(`180294183052`)에서 돌아갑니다(이번 세션 중 `aws sts get-caller-identity`와 라이브 `NfmDash-App`/`awsops-v2` 스택·클러스터 ARN으로 확인). ADR-012의 설계(bearer 토큰)는 **되돌리지 않습니다** — 계정이 같다고 모든 소비자에게 정적 시크릿이 틀린 선택이 되는 건 아니지만, 이제 그것이 *유일한* 합리적 선택은 아니고, ADR-012를 촉발한 그 소비자(서버 간 호출하는 awsops)에게는 더 이상 *최선*도 아닙니다.

## Context

계정이 같다는 사실은 awsops에 한해 계산을 바꿉니다:

- nfm-dashboard의 기존 27툴 **`nfm-gateway`**(AgentCore, `AWS_IAM` authorizer)는 그 ARN에 `bedrock-agentcore:InvokeGateway`가 부여된 **같은 계정의 어떤 IAM principal이든** 호출 가능합니다 — 크로스 계정 장벽이 원래 없습니다. awsops의 AgentCore runtime role에 그 권한만 추가하면 **오늘, 코드 변경 0**으로 됩니다 — 하지만 그건 기존 27툴(topology/pod-flows/network-infra)까지만 닿고, `/api/mcp` 위에 얹은 12개 lens/overview/infra-topology 툴에는 닿지 않습니다. 그 툴들은 그 게이트웨이의 Lambda 타깃이 아니라 Next.js 앱의 TypeScript 코드에만 존재하기 때문입니다.
- 새 기능(`/api/mcp`)은 평범한 ALB+ECS HTTP 엔드포인트라, API Gateway의 IAM authorizer처럼 임의의 SigV4 서명을 자체적으로 검증할 방법이 없습니다(그 무료 검증은 API Gateway의 것이지 우리 것이 아닙니다 — 우리는 그냥 ALB 타깃입니다). 즉 "같은 계정"이라는 사실만으로 뭔가를 안 만들어도 되는 건 아니고, *무엇을 만들 가치가 있는지*가 바뀔 뿐입니다: 정적 bearer 토큰은 (잘못 가정한) 크로스 계정 경계에 대한 실용적 하한선이었고, 같은 계정 서버 간 호출이라면 장기 시크릿 없이 CloudTrail로 귀속되는 IAM 기반 인증을 받을 자격이 있습니다.

## Decision

`/api/mcp`에 독립적인 두 번째 인증 방식을 추가합니다. ADR-012의 bearer 경로보다 먼저 시도되며, 실패 시 그 경로로 넘어가지 않습니다:

1. **`Authorization: AWS4-GetCallerIdentity <presigned된 sts:GetCallerIdentity URL>`** — 호출자(예: 자기 IAM 자격증명을 쓰는 awsops의 AgentCore runtime)가 실제 `sts:GetCallerIdentity` 요청을 presign해서 그 URL을 우리에게 넘깁니다. `aws-iam-authenticator`(EKS)와 Vault의 `auth/aws` 방식이 쓰는 것과 같은 forwarding 트릭입니다 — 평범한 서버가 스스로 AWS 네이티브 서비스가 되지 않고도 AWS 아이덴티티를 검증하게 해줍니다: 우리는 그 **정확히 같은** HTTP 호출을 실제 STS 엔드포인트에 대해 수행하고(`app/src/lib/sigv4-verify.ts::verifyStsCallerIdentity`) — 서명 검증은 우리가 아니라 AWS가 합니다 — 200 응답의 `<Arn>`/`<Account>`가 누가 서명했는지 알려줍니다. 우리 쪽에 새어나갈 공유 시크릿이 전혀 없고, 접근 취소는 호출자의 IAM 권한을 빼는 것으로 끝나며, 모든 호출이 호출자 본인의 아이덴티티로 CloudTrail에 귀속됩니다.
2. **SSRF 가드**: presigned URL의 호스트는 `sts(\.<region>)?\.amazonaws\.com`으로 고정, 프로토콜은 `https:` 필수, `Action`은 `GetCallerIdentity`여야 함 — 그 외는 네트워크 호출 전에 `null`. `redirect: 'manual'`이라 리다이렉트로 의도치 않은 호스트에 도달할 수 없습니다.
3. **allowlist, "유효한 AWS 아이덴티티면 전부"가 아님**: `isAllowedMcpCaller`는 `identity.account === MCP_ACCOUNT_ID`(ARN 문자열과 독립적으로 한 번 더 확인, 심층 방어)이고 **동시에** ARN이 `MCP_ALLOWED_CALLERS`(쉼표 구분; `assumed-role/<RoleName>` — 세션명 접미사는 호출자가 정하므로 allowlist가 고정할 수 없어 해당 role의 모든 세션에 매치 — 또는 정확한 ARN)의 항목과 일치해야 합니다. 기본값(빈 allowlist)은 전원 거부이며, ADR-012의 `MCP_BEARER_TOKEN` 미설정→404처럼 "SigV4가 설정됐는지"를 흘리는 비트가 없습니다 — 설정 안 된 allowlist와 설정됐지만 안 맞는 경우가 똑같이 401로 구분 불가능합니다.
4. **`AWS4-GetCallerIdentity` 분기는 실패해도 Bearer 분기로 넘어가지 않습니다** — 잘못된/거부된 SigV4 시도는 그냥 401이고, 더 약한 검사로의 재시도 기회가 아닙니다. 혼란스러운/오설정된 SigV4 클라이언트가 조용히 더 약한 검증으로 격하되는 걸 막습니다.
5. **Bearer는 그대로 유지**(ADR-012, 무변경) — 요청에 서명할 수 없는 소비자(예: `claude mcp add --header`로 고정 문자열만 보내는 Claude Code CLI)를 위해서입니다.
6. **nfm 자신의 task role에 새 IAM 권한 불필요.** 우리가 SDK로 STS를 우리 이름으로 호출하는 게 아니라, 이미 서명된 URL을 그냥 `fetch()`로 중계할 뿐입니다. AWS 자신의 서명 검증이 문지기 역할을 하므로 우리 role엔 새로 필요한 게 없습니다.

## Consequences

- awsops가 새 12툴에 닿는 길: 여기 `MCP_ALLOWED_CALLERS = assumed-role/<자기 runtime role 이름>`을 부여하고, 정적 bearer 대신 presign한 `AWS4-GetCallerIdentity` 헤더를 보내게 합니다. 기존 27툴 `nfm-gateway`로 가는 길은 별개고 이미 같은 계정에서 살아있습니다(Context 1번) — 둘은 순서가 있는 게 아니라 독립적인 선택입니다.
- `/api/mcp`는 이제 SigV4 스킴 요청마다 `sts.amazonaws.com`으로 아웃바운드 HTTPS 호출을 합니다(5초 타임아웃, 재시도 없음). ECS의 private 서브넷이 공개 STS 엔드포인트로 NAT/IGW egress를 가져야 하는데, 이미 그렇습니다(같은 서브넷에서 이미 Bedrock 등 다른 공개 AWS 엔드포인트를 호출 중).
- 한 라우트에 독립적인 두 perimeter가 있다는 건 지켜야 할 것도 둘이라는 뜻입니다. `middleware.test.ts`와 `sigv4-verify.test.ts`가 두 경로 + 계정/role-name 접두사 충돌(`assumed-role/foo`가 `assumed-role/foo-2`에 매치되면 안 됨) 엣지케이스를 커버합니다.
- `MCP_ACCOUNT_ID`/`MCP_ALLOWED_CALLERS`는 시크릿이 아닌 평범한 태스크 정의 env var입니다 — bearer 토큰과 달리 "어느 계정"/"어느 role 이름"엔 민감할 게 없습니다.
- 이 프로젝트에서 앞으로 ADR을 쓸 때의 교훈: 초기 브레인스토밍 턴에서 던져진 미검증 전제("다른 AWS 계정")가 이후 여러 턴의 *실제* 탐색(양쪽 계정이 반복해서 `180294183052`로 확인됨)이 그걸 반박하는데도 아무도 — 저를 포함해서 — 눈치채지 못한 채 그대로 굳어 있었습니다. 대화 시작 시점의 가정이 아니라 실제로 관찰된 것에 대해 근거가 되는 전제를 재확인해야 합니다.
