# Docker イメージの移送・インポート手順 (ZTA MCP Gateway)

ローカル環境でエクスポートした Docker イメージ（`zta-mcp-gateway.tar`）を運用環境や AWS 等のサーバーへ展開・インポートする手順です。

---

## 📦 配布ファイル一覧

運用担当者に引き渡すファイル一式です：

| ファイル名 | 説明 |
| :--- | :--- |
| **`zta-mcp-gateway.tar`** | エクスポート済みの Docker イメージ本体（約79.7MB） |
| **`docker-compose.prod.yml`** | イメージから直接起動するための Docker Compose 定義ファイル |
| **`config/gateway-config.example.yaml`** | ゲートウェイのルーティング・認可ポリシー設定ファイル |
| **`.env.example`** | 環境変数設定例（JWT秘密鍵など） |
| **`OPERATOR_GUIDE.md`** | 運用保守マニュアル（日常の起動・停止・ログ確認） |
| **`VERIFICATION_REPORT.md`** | 開発環境での動作確認およびセキュリティ検証レポート |

---

## 方法 1：tar ファイルを直接転送してインポートする（推奨）

Docker レジストリを介さず、アーカイブファイル (`.tar`) を直接サーバーに転送して起動する方法です。

### 1. サーバーへのファイル転送
作成したファイルを、SCP / SFTP または S3 経由で対象サーバーへ転送します。
```bash
# 例: SCP でサーバーへ転送
scp zta-mcp-gateway.tar docker-compose.prod.yml .env.example user@<サーバーIP>:~/zta-gateway/
scp -r config user@<サーバーIP>:~/zta-gateway/
```

### 2. Docker イメージの読み込み (Import)
転送先のサーバーで以下のコマンドを実行し、イメージを復元します。
```bash
# tar ファイルからイメージを読み込む
docker load -i zta-mcp-gateway.tar

# 読み込まれたイメージを確認
docker images | grep zta-mcp-gateway
```
※ `zta-mcp-gateway:latest` が表示されれば成功です。

### 3. 設定ファイルの準備
```bash
# 設定ファイルをコピーして配置
cp config/gateway-config.example.yaml config/gateway-config.yaml
cp .env.example .env

# 必要に応じて .env の GATEWAY_JWT_SECRET などを本番用に更新
```

### 4. コンテナの起動
```bash
docker compose -f docker-compose.prod.yml up -d
```

### 5. 疎通確認
```bash
curl http://localhost:8080/healthz
```
正常であれば `{"status":"healthy","version":"1.0",...}` が返却されます。

---

## 方法 2：AWS ECR (Elastic Container Registry) を利用する場合

ECS (Fargate) や App Runner などのマネージドサービスを利用する場合は、ECR にプッシュします。

### 1. AWS ECR リポジトリの準備
AWS コンソールの ECR で `zta-mcp-gateway` という名前のリポジトリを作成します。

### 2. イメージのタグ付けとプッシュ
```bash
# 1. ECR へのログイン認証
aws ecr get-login-password --region <リージョン名> | docker login --username AWS --password-stdin <AWSアカウントID>.dkr.ecr.<リージョン名>.amazonaws.com

# 2. イメージに ECR 用のタグを付与
docker tag zta-mcp-gateway:latest <AWSアカウントID>.dkr.ecr.<リージョン名>.amazonaws.com/zta-mcp-gateway:latest

# 3. ECR へプッシュ
docker push <AWSアカウントID>.dkr.ecr.<リージョン名>.amazonaws.com/zta-mcp-gateway:latest
```
