# Northflank Deployment

KBC LINE bot を Northflank の常駐サービスとして動かすためのメモです。

## 構成

- Source: Git repository
- Build: Dockerfile
- Service type: long-running service / combined service
- Public port: none
- Replicas: 1
- Persistent volume mount: `/app/storage`
- Runtime command: Dockerfile の `CMD ["node", "dist/main.js"]`

Northflank 側でコンテナが落ちた場合はサービスが再起動されます。LINE アカウントは多重ログインや重複返信を避けるため、replica は必ず 1 にしてください。

## Runtime Variables

`.env` ファイルはデプロイしません。Northflank の runtime variables または secret group に次を設定します。

```env
NODE_ENV=production
LINE_LOGIN_METHOD=password
LINE_EMAIL=bot@example.com
LINE_PASSWORD=your-password
LINE_AUTH_TOKEN=
LINE_DEVICE=IOSIPAD
LINE_STORAGE_FILE=/app/storage/storage.json
LINE_FORCE_LOGIN=false
LINE_E2EE_LOGIN=true
COMMAND_PREFIX=!
ENABLE_TALK=true
ENABLE_SQUARE=true
KBC_EVENT_RAW_BASE_URL=https://raw.githubusercontent.com/sinsuirakv0/KBC-rakv0-event/main
OMOROIRIE_DATA_DIR=/app/data/omoroirie
```

`LINE_EMAIL`、`LINE_PASSWORD`、`LINE_AUTH_TOKEN` は secret として扱ってください。`LINE_AUTH_TOKEN` は空で問題ありません。永続 volume に `/app/storage/storage.json` があれば、保存済み auth token と E2EE 鍵で起動します。

## 初回起動

推奨は Northflank 上で初回ログインして、永続 volume に `storage.json` を作る方法です。

1. Service に volume を追加し、mount path を `/app/storage` にする
2. Runtime variables を設定する
3. Service を deploy する
4. Logs に pincode が出たら、bot 用 LINE アカウントのスマホ側で入力する
5. Logs に `[line] E2EE self key is available` が出ることを確認する
6. 以後は `LINE_FORCE_LOGIN=false` のまま運用する

ローカルで作成済みの `storage/storage.json` を使う場合は、Northflank の実行中コンテナへファイルを転送するか、volume に同じ内容を配置します。このファイルには auth token と E2EE 鍵が含まれるため、GitHub や公開ログには絶対に出さないでください。

## Northflank UI 手順

1. Project を作成する
2. Create new -> Service -> Combined を選ぶ
3. Repository と branch を選ぶ
4. Build type は Dockerfile を使う
5. Runtime variables / secret group を設定する
6. Volumes で `/app/storage` を追加する
7. Ports は公開しない
8. Resources は小さめで開始する
9. Deploy して logs を確認する

## 運用

- 再起動: Northflank の restart / redeploy
- ログ確認: Service logs
- E2EE が読めない場合: logs に `E2EE self key is not available` または復号失敗警告が出る
- 再ログインが必要な場合: 一時的に `LINE_FORCE_LOGIN=true` にして deploy し、成功後に `false` へ戻す

## 参考

- Build and deploy your code: https://northflank.com/docs/v1/application/getting-started/build-and-deploy-your-code
- Inject runtime variables: https://northflank.com/docs/v1/application/run/inject-runtime-variables
- Add a persistent volume: https://northflank.com/docs/v1/application/databases-and-persistence/add-a-volume
- Configure health checks: https://northflank.com/docs/v1/application/observe/configure-health-checks
