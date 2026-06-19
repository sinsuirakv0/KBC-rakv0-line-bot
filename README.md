# KBC LINE Bot

LINEJS を使った KBC 用 OpenChat bot です。

Northflank で常時起動する場合は [NORTHFLANK.md](./NORTHFLANK.md) を参照してください。

## Local Setup

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

初回は QR URL または pincode がコンソールに出ます。ログイン後、`storage/storage.json` に LINEJS の内部状態と auth token が保存されます。

QR ログインでは `logs/line-login-qr.png` も生成されます。bot 用 LINE アカウントでログインしているスマホの QR スキャナーから、この画像を読み取ってください。自分のプロフィール QR ではなく、このログイン用 QR を読み取ります。

メール/パスワードでログインする場合は `.env` を次のように設定します。

```env
LINE_LOGIN_METHOD=password
LINE_EMAIL=bot@example.com
LINE_PASSWORD=your-password
```

ログイン時に pincode が表示されたら、bot 用 LINE アカウントが入っているスマホ側で入力してください。

## Commands

OpenChat、個人チャット、通常グループで次のコマンドを使えます。接頭辞は `.env` の `COMMAND_PREFIX` で変更できます。

```text
!ping
!gatya
!gatya R
!gatya E
!gatya N
!gatya 1056
!gatya 極ネコ
!gatya 1056 json
!gatya 1056 r
!sale
!sale 24052
!sale 悪霊
!sale 24052 json
!sale 24052 r
!item
!item 827
!item レアチケット
!item 827 json
!item 827 r
!unit ネコ
!unit 0
!unit ネコ origin f
!enemy わんこ
!enemy 0
!enemy わんこ origin
!stage 日本編
!stage 0000-000
!stage 3000
```

`unit` / `enemy` / `stage` はそれぞれ `ut` / `tut` / `st` でも呼び出せます。名前検索では全角英数字、ひらがな/カタカナ、長音記号を正規化します。完全な表記で絞りたい場合は検索語の末尾に `-force` または `-f` を付けます。

ユニット・敵ユニット・ステージ検索は [Sugar2550/omoroirie](https://github.com/Sugar2550/omoroirie) の実装とデータを、作者の許可を得てLINE向けに移植しています。詳細は [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) を参照してください。

`gatya` / `sale` / `item` は既定で `https://raw.githubusercontent.com/sinsuirakv0/KBC-rakv0-event/main/data/...` からイベントデータを取得します。別ブランチやローカルミラーを使う場合は `.env` に `KBC_EVENT_RAW_BASE_URL` を設定してください。

受信対象は `.env` の `ENABLE_TALK` と `ENABLE_SQUARE` で切り替えます。個人チャット/通常グループは `ENABLE_TALK=true`、OpenChat は `ENABLE_SQUARE=true` です。

Talk 側のメッセージが Letter Sealing / E2EE で暗号化されている場合、現在の保存済みログイン状態では本文を読めないことがあります。その場合は bot は落ちずにログへ警告を出します。個人チャット/通常グループで反応させるには、bot 用 LINE アカウント側で Letter Sealing を無効化するか、E2EE 鍵を保存できるログイン手順へ切り替える必要があります。

E2EE 鍵を取り直す場合は、`.env` を次のようにして再起動します。

```env
LINE_LOGIN_METHOD=qr
LINE_FORCE_LOGIN=true
LINE_E2EE_LOGIN=true
```

起動後に `logs/line-login-qr.png` を bot 用 LINE アカウントが入っているスマホで読み取ります。ログに `[line] E2EE self key is available` が出たら、`.env` の `LINE_FORCE_LOGIN=false` に戻して次回以降は保存済み token で起動します。
