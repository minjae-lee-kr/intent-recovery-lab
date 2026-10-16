# Local experiment boundary / 로컬 실험의 범위

This project binds to loopback only. It has no accounts, credentials, payment integrations, telemetry, or remote business services. All reservation data is fictional. Fault injection and the ledger inspector are intentional local teaching surfaces, not production endpoints.

Do not expose this server through a public tunnel or deploy it as a booking API. There is no authentication, ownership authorization, rate-limiting service, retention policy or deployment hardening. A recovery handle is not an access-control token.

The server validates Host/Origin, limits body size and read time, uses prepared statements, restricts static files to a configured directory and sanitizes server errors. Those controls reduce accidental local exposure; they are not a production security claim.

The separate retention fixture gives two loopback owners finite deduplication memory. Its parent-only controls inject clocks, pruning and lost responses; they are not HTTP administration endpoints. It does not add a production retention policy or a safe retry guarantee to the reservation application.

Runtime databases (`.local/`), generated reports, logs, dependencies and environment files are ignored by Git. The experiment runner owns and removes its temporary databases and child processes. It never needs employer records, real customer data or cloud credentials. Public examples must remain independently designed and synthetic.

Dependency audit is a point-in-time check against registry advisories, not a guarantee that no vulnerabilities exist. Local audit results should be dated and rerun before publication.

---

루프백 주소에서만 동작하는 개인 실험입니다. 계정, 인증 정보, 결제 연동, 텔레메트리, 외부 업무 서비스를 사용하지 않습니다. 예약 데이터는 가상입니다. 장애 주입과 기록 조회 화면은 로컬 학습용 기능입니다.

공개 터널로 노출하거나 실제 예약 API로 배포하지 마세요. 인증·소유 권한 검사·운영용 요청 제한·보관 정책·배포 보안은 구현하지 않았습니다. 복구용 식별자는 접근 권한을 부여하는 토큰이 아닙니다.

Host/Origin 검사, 본문 크기·수신 시간 제한, 준비된 SQL 구문, 정적 파일 경로 제한과 오류 정보 정리를 적용했습니다. 우발적인 로컬 노출을 줄이기 위한 조치이며 운영 보안을 보장하지 않습니다.

별도 보존 기간 실험은 두 루프백 시스템이 중복 방지 기록을 유한하게 기억하도록 구성합니다. 시계·기록 삭제·응답 유실은 부모 프로세스만 제어하며 HTTP 관리 API로 제공하지 않습니다. 예약 앱에 운영용 보관 정책이나 안전한 재시도 보장을 추가하는 기능은 아닙니다.

실행 중 생성하는 데이터베이스, 보고서, 로그, 의존성, 환경 파일은 Git에서 제외합니다. 실험은 자신이 만든 임시 데이터베이스와 자식 프로세스만 정리합니다. 회사 기록, 고객 데이터, 클라우드 인증 정보가 필요하지 않습니다. 공개 예제는 독립적으로 설계한 합성 데이터만 사용합니다.

의존성 감사는 특정 시점의 알려진 권고 목록을 확인하는 절차이며 취약점이 없다는 보증은 아닙니다. 공개 전에 실행 시점을 남기고 다시 확인해야 합니다.
