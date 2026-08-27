<div align="center">

<a href="https://mqttsnet.com"><img src="./docs/images/logo.png" alt="ThingLinks" width="180"></a>

# ThingLinks Edge

**エッジコンピューティングゲートウェイ —— 現場の 1 台に、`docker compose up` 一発で**

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

[![Node.js](https://img.shields.io/badge/Node.js-24_LTS-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev/)
[![Vue](https://img.shields.io/badge/Vue-3.5-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)](https://vuejs.org/)
[![Docker Image](https://img.shields.io/docker/v/mqttsnet/thinglinks-edge?sort=semver&style=flat-square&logo=docker&logoColor=white&label=image&color=2496ED)](https://hub.docker.com/r/mqttsnet/thinglinks-edge)
[![Docker Pulls](https://img.shields.io/docker/pulls/mqttsnet/thinglinks-edge?style=flat-square&logo=docker&logoColor=white&color=2496ED)](https://hub.docker.com/r/mqttsnet/thinglinks-edge)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square)](LICENSE)

<br>

[![Website](https://img.shields.io/badge/Website-mqttsnet.com-blue?style=for-the-badge)](https://mqttsnet.com)
[![GitHub](https://img.shields.io/badge/GitHub-mqttsnet/thinglinks--edge-181717?style=for-the-badge&logo=github)](https://github.com/mqttsnet/thinglinks-edge)

</div>

---

## 概要

ThingLinks Edge は、顧客の現場にある 1 台のマシン上で動作する**エッジコンピューティング
ゲートウェイ基盤**です。目的は**クラウドとエッジの協調**にあります。現場の機器を ThingLinks
クラウドに接続し、クラウドの機能を現場へ届けます。クラウドへの回線が切れている間も、
収集・バッファリング・ローカルロジックは動き続けます。

Node-RED マルチインスタンスのホスティングは**機能の一つ**であり、製品のすべてではありません。
現時点で最初に作り込んでいる領域です。

## 主な機能

| 機能 | 説明 |
| --- | --- |
| **インスタンスホスティング** | Node-RED を兄弟コンテナとして実行 —— 管理台を更新しても現場の収集は止まらない |
| **内蔵リバースプロキシ** | 入口も証明書も一つ。インスタンスのポートは公開しないため、認証は構造上統一される |
| **パスワードレス遷移** | コンソールから各インスタンスのエディタへ、認証情報の再入力なしで移動 |
| **3 層ヘルスプローブ** | コンテナ / アプリケーション / フロー。「プロセスは生きているが機能していない」を検知 |
| **ネットワーク分離** | 1 インスタンス 1 ネットワーク —— インスタンス同士は到達不可 |
| **制限付き Docker エンドポイント** | Manager はホストのソケットに触れず、メソッド単位の正規表現許可リストを経由する |
| **実行時マウントプレフィクス** | 同一イメージでルートにも企業リバースプロキシの任意のサブパスにも対応 |
| **クラウド・エッジ協調** | 仮想ゲートウェイ、サブデバイス登録、マイクロバッチ、オフラインスプールと再送 *(進行中)* |

## 技術スタック

![Node.js](https://img.shields.io/badge/Node.js-24_LTS-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?style=flat-square&logo=fastify&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?style=flat-square&logo=sqlite&logoColor=white)
![Vue 3](https://img.shields.io/badge/Vue.js-3.5-4FC08D?style=flat-square&logo=vuedotjs&logoColor=white)
![Naive UI](https://img.shields.io/badge/Naive%20UI-2.45-63E2B7?style=flat-square)
![Vite](https://img.shields.io/badge/Vite-8.x-646CFF?style=flat-square&logo=vite&logoColor=white)
![Node-RED](https://img.shields.io/badge/Node--RED-5.0-8F0000?style=flat-square&logo=nodered&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-10.x-F69220?style=flat-square&logo=pnpm&logoColor=white)

## クイックスタート

### 動作要件

| コンポーネント | バージョン |
| --- | --- |
| Docker Engine | 24+（Compose v2 同梱） |
| ホストアーキテクチャ | `x86_64` または `aarch64` —— 32 ビット ARM は**非対応** |
| Node.js | 24 LTS（開発時のみ） |
| pnpm | 10.32+（開発時のみ） |

> **32 ビット ARM は公開していません。** 決定的な理由は下流にあります —— Node-RED
> 公式イメージの 5.x 系は `amd64` / `arm64` のみで、`armv7` 上の Manager が起動できても
> インスタンスは Node-RED 4.1.x に固定されてしまいます。ビルド側の負担も加わります
> （`better-sqlite3` に 32 ビット ARM のビルド済みバイナリがない）。
> そもそも適合しません：真に 32 ビット専用の SoC（i.MX6、AM335x、A20）は
> 一般に 256MB〜1GB のメモリしかなく、Manager は実測 53 MiB、
> 各インスタンスは約 104 MiB を必要とします。
>
> **Raspberry Pi ユーザーはほぼ影響を受けません**：Pi 3 / 3B+ / Zero 2 W はいずれも
> 64 ビット対応で、32 ビット OS を入れた場合だけ `armv7` 扱いになります。
> `uname -m` が `aarch64` なら動作し、`armv7l` では動作しません。

### デプロイ

Manager イメージは Docker Hub で [`mqttsnet/thinglinks-edge`](https://hub.docker.com/r/mqttsnet/thinglinks-edge) として公開されています。
`linux/amd64` と `linux/arm64` を含むマルチアーキテクチャのマニフェストなので、
x86 産業用 PC でも ARM エッジボックスでも同じコマンドが使えます。
現場のマシンでビルドは一切行われません。Docker さえあれば動きます。

```bash
cp .env.example .env        # 最低限 EXTERNAL_URL と MASTER_KEY を設定
docker compose up -d
docker compose logs manager | grep '\[init\]'   # 初期パスワードは一度だけ出力されます
```

ブラウザで `EXTERNAL_URL` を開くとコンソールが表示されます。フロントエンドは Manager 自身が配信します。

`EXTERNAL_URL` は外部向け URL・リダイレクト・Cookie ポリシーの**唯一の情報源**です。
プロセスが自分の外部アドレスを推測することは決してありません。

アップグレードは `.env` の `MANAGER_IMAGE` を新しいタグに変更してから
`docker compose pull && docker compose up -d` を実行します。稼働中の Node-RED
インスタンスは**中断されません** —— それらは Manager の子プロセスではなく
兄弟コンテナだからです。管理コンソールの更新のために生産ラインを止める必要はありません。

### 開発

```bash
pnpm install

# ターミナル 1 —— バックエンド
cd apps/manager && pnpm build && \
  EXTERNAL_URL=http://localhost:5173 DATA_DIR=/tmp/tle-dev \
  MASTER_KEY=dev-key INITIAL_PASSWORD=initial-password-123 node dist/index.js

# ターミナル 2 —— コンソール
cd apps/web-console && pnpm dev      # http://localhost:5173
```

公開イメージではなく**自分でビルドしたイメージ**でスタック全体を動かすには、
ビルド用のオーバーライドファイルを重ねます：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

`docker-compose.yml` 単体は意図的に「pull 専用」です —— 現場のマシンが使う形態だからです。


## ディレクトリ構成

```
thinglinks-edge/
├── apps/
│   ├── manager/                  コントロールプレーン
│   │   ├── src/
│   │   │   ├── core/             ドメイン層：設定・暗号・永続化・認証・インスタンス・
│   │   │   │                     ポート・ヘルス・コンテナ仕様・docker クライアント
│   │   │   ├── http/             HTTP 層：組み立て・セッション・インスタンス・
│   │   │   │                     SSO・リバースプロキシ・コンソール配信
│   │   │   └── index.ts          エントリポイント
│   │   ├── scripts/              実コンテナ検証スイート
│   │   └── Dockerfile
│   └── web-console/              コンソール（Vue 3 + TypeScript + Naive UI）
├── changelogs/                   リリースごとに 1 ファイル
├── docker-compose.yml            単一マシン向けデプロイ
└── .env.example
```

## 検証

すべての変更は、全回帰テストをグリーンに保たなければなりません。`pnpm verify` は
ユニットテスト・型チェック・ビルドに加え、実際の Docker デーモンに対する
**11 回の実コンテナ検証**を実行します。モックの上流は使いません。

```bash
cd apps/manager && pnpm verify
```

| スイート | 対象 |
| --- | --- |
| `verify-container-guard` | コンテナ生成パラメータの許可リストが実 Docker 上で機能すること |
| `verify-instance` | インスタンス生成、`settings.js` の配置、マウントプレフィクス（ルート／サブパス） |
| `verify-proxy` | リバースプロキシ、静的資産、WebSocket、パスワードレス遷移（ルート／サブパス） |
| `verify-api` | インスタンス CRUD のライフサイクルとログのデコード |
| `verify-health` | 3 層プローブ |
| `verify-isolation` | インスタンス間のネットワーク分離 |
| `verify-container` | Manager 自身のコンテナ化（ルート／サブパス） |
| `verify-compose` | Compose デプロイ、読み取り専用ルートファイルシステム、制限付き Docker エンドポイント |

## セキュリティ

- Manager もインスタンスも**非 root**・**読み取り専用ルートファイルシステム**で動作
- Manager は**ホストの Docker ソケットをマウントしない**。エンドポイントごとに
  HTTP メソッド単位で許可されたプロキシ経由でのみ Docker に到達する
- **1 インスタンス 1 ネットワーク** —— インスタンス同士もプロキシへも到達不可
- コンテナ生成は**ハード許可リスト**を通過：特権モード禁止、ホスト名前空間禁止、
  プラットフォーム管理の名前付きボリュームのみ、インスタンスのポートは公開しない
- `MASTER_KEY` が無い場合は**起動を拒否**し、既定値へ暗黙にフォールバックしない

各ルールの背景にある実際の障害については[コントリビュートガイド](CONTRIBUTING.md)を参照してください。

## ドキュメント

デプロイ手順・API リファレンス・アーキテクチャ文書は [mqttsnet.com](https://mqttsnet.com) を参照してください。

このコードベースが初めてなら [CONTRIBUTING.md](CONTRIBUTING.md) から読み始めてください。
そこに記された開発規律が、これまでに踏んだ非自明な挙動をすべて反映しています。

## コントリビュート

[コントリビュータガイド](CONTRIBUTING.md) を参照してください。そこに書かれた開発規律は
スタイルの好みではなく、それぞれが実際のサイレント障害に対応しています。

## お問い合わせ

- ビジネス連携：[mqttsnet@163.com](mailto:mqttsnet@163.com)
- 不具合報告：[GitHub Issues](https://github.com/mqttsnet/thinglinks-edge/issues)
- コード貢献：[GitHub PRs](https://github.com/mqttsnet/thinglinks-edge/pulls)

> **注意：** 本プロジェクトは複数のホスティングプラットフォームにミラーされています。
> 不具合報告・機能要望・技術的な議論の**唯一の公式窓口**は
> [GitHub Issues](https://github.com/mqttsnet/thinglinks-edge/issues) です。

## 謝辞

- [Node-RED](https://nodered.org) —— IoT 向けフローベースプログラミング
- [Fastify](https://fastify.dev) —— 高速・低オーバーヘッドな Web フレームワーク

## ライセンス

ThingLinks Edge は [Apache License 2.0](LICENSE) のもとで公開されています。

---

<div align="center">

Copyright &copy; 2019-present [MqttsNet](https://mqttsnet.com). All rights reserved.

</div>
