# ZTA MCP Gateway 運用保守ガイド (OPERATOR_GUIDE.md)

本ドキュメントは、ZTA MCP Gateway（ゼロトラストMCPゲートウェイ）の日常運用、死活監視、設定変更、トラブルシューティングを担当する運用者向けのマニュアルです。

---

## 1. サービス概要

- **サービス名**: ZTA MCP Gateway (`zta-mcp-gateway`)
- **役割**: AIエージェントと社内MCPサーバー（DB等）を中継するリバースプロキシ兼セキュリティゲートウェイ
- **公開ポート**: `8080` (HTTP / SSE)
- **コンテナランタイム**: Docker / Docker Compose

---

## 2. 日常の運用コマンド集

本番環境（`docker-compose.prod.yml` 使用）における主要な運用コマンドです。

### 起動・停止・再起動

```bash
# バックグラウンド起動
docker compose -f docker-compose.prod.yml up -d

# 稼働ステータス確認 (Up (healthy) になっていることを確認)
docker compose -f docker-compose.prod.yml ps

# 再起動
docker compose -f docker-compose.prod.yml restart

# 停止
docker compose -f docker-compose.prod.yml down
```

### ログの監視

```bash
# リアルタイムでログを追跡 (Ctrl + C で終了)
docker compose -f docker-compose.prod.yml logs -f

# 直近100行のログを表示
docker compose -f docker-compose.prod.yml logs --tail=100
```

---

## 3. ヘルスチェックと監視設定

ゲートウェイはステートレスであり、死活監視用エンドポイントを提供しています。

- **URL**: `http://<ホストまたはロードバランサー>:8080/healthz`
- **HTTPメソッド**: `GET`
- **正常応答**: ステータス `200 OK`
  ```json
  {"status":"healthy","version":"1.0","timestamp":"2026-09-17T05:37:55.722Z"}
  ```

※ ロードバランサー（ALB等）のヘルスチェックパスには `/healthz` を設定してください。

---

## 4. 設定変更の反映手順

上流MCPサーバーの追加や認可ポリシー（`allowed_tools` や `firewall` の条件）を変更する場合の手順です。

1. `config/gateway-config.yaml` をエディタで編集します。
2. ゲートウェイコンテナを再起動して設定を再読み込みします。
   ```bash
   docker compose -f docker-compose.prod.yml restart
   ```
3. ログを確認し、設定が正常に読み込まれたことを確認します。
   ```bash
   docker compose -f docker-compose.prod.yml logs --tail=20
   ```
   ログに `[ZTA MCP Gateway] Loaded X upstream(s)` が出力されていれば反映完了です。

---

## 5. トラブルシューティング

| 現象 | 原因と確認事項 | 対処法 |
| :--- | :--- | :--- |
| **コンテナが起動しない** | ポート8080の重複、または設定ファイル（YAML）のインデント不正 | `docker compose -f docker-compose.prod.yml logs` でエラーを確認。YAML構文を修正。 |
| **401 Unauthorized エラー** | JWTトークンが無効または未指定 | `/oauth/token` で正しい client_id / client_secret を用いてトークンを再取得。 |
| **403 Forbidden エラー** | ZTAポリシーにより対象ツールの実行が拒否された | 監査ログを確認。正規の権限が必要な場合は `gateway-config.yaml` の `allowed_tools` を調整。 |
| **502 Bad Gateway エラー** | 上流のMCPサーバー（MariaDB MCP等）が停止または接続不可 | 接続先MCPサーバーの稼働状態・ネットワーク疎通を確認。 |
