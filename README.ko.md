<div align="center">

<a href="https://mqttsnet.com"><img src="./docs/images/logo.png" alt="ThingLinks" width="180"></a>

# ThingLinks Edge

**엣지 컴퓨팅 게이트웨이 —— 현장의 한 대에, `docker compose up` 한 번으로**

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

[![Node.js](https://img.shields.io/badge/Node.js-24_LTS-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![Vue](https://img.shields.io/badge/Vue-3.5-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![Docker](https://img.shields.io/badge/Docker-Required-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square)](LICENSE)

<br>

[![Website](https://img.shields.io/badge/Website-mqttsnet.com-blue?style=for-the-badge)](https://mqttsnet.com)
[![GitHub](https://img.shields.io/badge/GitHub-mqttsnet/thinglinks--edge-181717?style=for-the-badge&logo=github)](https://github.com/mqttsnet/thinglinks-edge)

</div>

---

## 소개

ThingLinks Edge 는 고객 현장의 단일 머신에서 동작하는 **엣지 컴퓨팅 게이트웨이 플랫폼**입니다.
목표는 **클라우드-엣지 협업**입니다. 현장 장비를 ThingLinks 클라우드에 연결하고, 클라우드의
기능을 현장으로 내려보냅니다. 클라우드 회선이 끊긴 동안에도 수집·버퍼링·로컬 로직은 계속 동작합니다.

Node-RED 멀티 인스턴스 호스팅은 **여러 기능 중 하나**이며 제품 전체가 아닙니다.
현재 우선적으로 완성해 나가고 있는 영역입니다.

## 핵심 기능

| 기능 | 설명 |
| --- | --- |
| **인스턴스 호스팅** | Node-RED 를 형제 컨테이너로 실행 —— 관리 콘솔을 업그레이드해도 현장 수집이 끊기지 않음 |
| **내장 리버스 프록시** | 진입점도 인증서도 하나. 인스턴스 포트를 공개하지 않으므로 인증이 구조적으로 통일됨 |
| **비밀번호 없는 진입** | 콘솔에서 각 인스턴스 에디터로 자격 증명 재입력 없이 이동 |
| **3 계층 헬스 프로브** | 컨테이너 / 애플리케이션 / 플로우. "프로세스는 살아 있으나 동작하지 않음"을 탐지 |
| **네트워크 격리** | 인스턴스당 네트워크 하나 —— 인스턴스 간 접근 불가 |
| **제한된 Docker 엔드포인트** | Manager 는 호스트 소켓에 접근하지 않으며, 메서드별 정규식 허용 목록을 거침 |
| **런타임 마운트 접두사** | 하나의 이미지로 루트 경로와 기업 리버스 프록시의 임의 하위 경로 모두 지원 |
| **클라우드-엣지 협업** | 가상 게이트웨이, 서브 디바이스 등록, 마이크로 배치, 오프라인 스풀 및 재전송 *(진행 중)* |

## 기술 스택

![Node.js](https://img.shields.io/badge/Node.js-24_LTS-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?style=flat-square&logo=fastify&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?style=flat-square&logo=sqlite&logoColor=white)
![Vue 3](https://img.shields.io/badge/Vue.js-3.5-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)
![Naive UI](https://img.shields.io/badge/Naive%20UI-2.45-63E2B7?style=flat-square)
![Vite](https://img.shields.io/badge/Vite-8.x-646CFF?style=flat-square&logo=vite&logoColor=white)
![Node-RED](https://img.shields.io/badge/Node--RED-5.0-8F0000?style=flat-square&logo=nodered&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-10.x-F69220?style=flat-square&logo=pnpm&logoColor=white)

## 빠른 시작

### 요구 사항

| 구성 요소 | 버전 |
| --- | --- |
| Docker Engine | 24+ (Compose v2 포함) |
| Node.js | 24 LTS (개발 시에만) |
| pnpm | 10.32+ (개발 시에만) |

### 배포

```bash
cp .env.example .env        # 최소한 EXTERNAL_URL 과 MASTER_KEY 를 설정
docker compose up -d
docker compose logs manager | grep '\[init\]'   # 초기 비밀번호는 한 번만 출력됩니다
```

브라우저에서 `EXTERNAL_URL` 을 열면 콘솔이 표시됩니다. 프론트엔드는 Manager 가 직접 제공합니다.

`EXTERNAL_URL` 은 외부 URL·리다이렉트·쿠키 정책의 **유일한 진실 공급원**입니다.
프로세스가 자신의 외부 주소를 추측하는 일은 결코 없습니다.

### 개발

```bash
pnpm install

# 터미널 1 —— 백엔드
cd apps/manager && pnpm build && \
  EXTERNAL_URL=http://localhost:5173 DATA_DIR=/tmp/tle-dev \
  MASTER_KEY=dev-key INITIAL_PASSWORD=initial-password-123 node dist/index.js

# 터미널 2 —— 콘솔
cd apps/web-console && pnpm dev      # http://localhost:5173
```

## 디렉터리 구조

```
thinglinks-edge/
├── apps/
│   ├── manager/                  컨트롤 플레인 서비스
│   │   ├── src/
│   │   │   ├── core/             도메인 계층: 설정·암호·저장소·인증·인스턴스·
│   │   │   │                     포트·헬스·컨테이너 스펙·docker 클라이언트
│   │   │   ├── http/             HTTP 계층: 조립·세션·인스턴스·
│   │   │   │                     SSO·리버스 프록시·콘솔 호스팅
│   │   │   └── index.ts          진입점
│   │   ├── scripts/              실제 컨테이너 검증 스위트
│   │   └── Dockerfile
│   └── web-console/              콘솔 프론트엔드 (Vue 3 + TypeScript + Naive UI)
├── changelogs/                   릴리스마다 파일 하나
├── docker-compose.yml            단일 머신 배포
└── .env.example
```

## 검증

모든 변경은 전체 회귀 테스트를 그린으로 유지해야 합니다. `pnpm verify` 는 단위 테스트·
타입 체크·빌드에 더해 실제 Docker 데몬을 대상으로 **11 회의 실제 컨테이너 검증**을 수행합니다.
모의 업스트림은 사용하지 않습니다.

```bash
cd apps/manager && pnpm verify
```

| 스위트 | 대상 |
| --- | --- |
| `verify-container-guard` | 컨테이너 생성 파라미터 허용 목록이 실제 Docker 에서 동작하는지 |
| `verify-instance` | 인스턴스 생성, `settings.js` 배치, 마운트 접두사 (루트/하위 경로) |
| `verify-proxy` | 리버스 프록시, 정적 자원, WebSocket, 비밀번호 없는 진입 (루트/하위 경로) |
| `verify-api` | 인스턴스 CRUD 라이프사이클과 로그 디코딩 |
| `verify-health` | 3 계층 프로브 |
| `verify-isolation` | 인스턴스 간 네트워크 격리 |
| `verify-container` | Manager 자체의 컨테이너화 (루트/하위 경로) |
| `verify-compose` | Compose 배포, 읽기 전용 루트 파일시스템, 제한된 Docker 엔드포인트 |

## 보안

- Manager 와 인스턴스 모두 **비 root**, **읽기 전용 루트 파일시스템**으로 실행
- Manager 는 **호스트 Docker 소켓을 마운트하지 않으며**, 엔드포인트마다 HTTP 메서드 단위로
  허용된 프록시를 통해서만 Docker 에 접근
- **인스턴스당 네트워크 하나** —— 인스턴스 간에도, 프록시로도 접근 불가
- 컨테이너 생성은 **하드 허용 목록**을 통과: 특권 모드 금지, 호스트 네임스페이스 금지,
  플랫폼 관리 명명 볼륨만 허용, 인스턴스 포트는 호스트에 공개하지 않음
- `MASTER_KEY` 가 없으면 **기동을 거부**하며 기본값으로 조용히 되돌아가지 않음

각 규칙의 배경이 된 실제 장애는 [기여 가이드](CONTRIBUTING.md)를 참조하세요.

## 문서

배포 가이드·API 레퍼런스·아키텍처 문서는 [mqttsnet.com](https://mqttsnet.com) 을 참조하세요.

이 코드베이스가 처음이라면 [CONTRIBUTING.md](CONTRIBUTING.md) 부터 읽으세요.
거기 담긴 개발 규율이 지금까지 겪은 비자명한 동작을 모두 반영합니다.

## 기여하기

[기여자 가이드](CONTRIBUTING.md) 를 참조하세요. 그곳의 개발 규율은 스타일 취향이 아니라,
각각이 실제로 발생한 조용한 버그에 대응합니다.

## 연락처

- 비즈니스 협력: [mqttsnet@163.com](mailto:mqttsnet@163.com)
- 이슈 신고: [GitHub Issues](https://github.com/mqttsnet/thinglinks-edge/issues)
- 코드 기여: [GitHub PRs](https://github.com/mqttsnet/thinglinks-edge/pulls)

> **참고:** 본 프로젝트는 여러 호스팅 플랫폼에 미러링됩니다. 버그 신고·기능 제안·기술 논의의
> **유일한 공식 창구**는 [GitHub Issues](https://github.com/mqttsnet/thinglinks-edge/issues) 입니다.

## 감사의 말

- [Node-RED](https://nodered.org) —— IoT 를 위한 플로우 기반 프로그래밍
- [Fastify](https://fastify.dev) —— 빠르고 오버헤드가 낮은 웹 프레임워크

## 라이선스

ThingLinks Edge 는 [Apache License 2.0](LICENSE) 으로 배포됩니다.

---

<div align="center">

Copyright &copy; 2019-present [MqttsNet](https://mqttsnet.com). All rights reserved.

</div>
