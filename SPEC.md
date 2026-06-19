# KBC LINEJS Bot Spec

調査日: 2026-06-19

対象: `evex-dev/linejs` v3.1.4 / commit `5e9491b`

## 目的

KBC 用の LINE OpenChat bot を `@evex/linejs` で作る。まずは OpenChat 上で `!ping` などのコマンドに反応できる常駐 bot を最小構成で動かし、その後 KBC のイベント通知・検索・管理補助へ拡張する。

## 前提

- LINEJS は公式 Messaging API ではなく、LINE の通常アカウントとして動かす SelfBot ライブラリ。
- LINEJS では OpenChat は `Square` / `SquareChat` として扱われる。
- 公式 Messaging API は通常の group / room への公式アカウント参加を扱うが、OpenChat 参加は公式ドキュメント上の通常 group / room と別物として見るべき。
- OpenChat で動かす場合は、bot 用 LINE アカウントを OpenChat に参加させ、参加済み SquareChat のイベントを LINEJS で拾う。
- アカウント停止リスクがあるため、スパム、大量送信、短時間の再ログイン連発、無断ログ保存は避ける。

## 採用ライブラリ

- package: `@evex/linejs`
- package source: JSR
- runtime: Deno / Node.js / Bun 対応。初期実装は Node.js か Deno のどちらでも可能。
- recommended for this bot: Node.js + TypeScript か Deno。LINEJS 公式例は Deno 寄りだが、`FileStorage` は Node の `fs` を使う。

## 初期ログイン方針

1. 初回のみ `loginWithPassword` または `loginWithQR` でログインする。
2. `FileStorage("./storage/storage.json")` を使い、認証情報、E2EE キー、内部状態を永続化する。
3. `client.base.on("update:authtoken", ...)` で更新された auth token を `.env` または storage に保存する。
4. 2回目以降は `loginWithAuthToken` + 同じ `FileStorage` で起動する。

重要:

- メール/パスワードログインの繰り返しは避ける。LINEJS docs でも不正ログイン扱い・一時制限の可能性があるため auth token 再利用が推奨されている。
- auth token 単独ログインだけだと Talk group の E2EE 鍵不足が起き得る。一方、Square/OpenChat は auth token でも可能と docs に記載あり。ただし初回に `FileStorage` を作っておくほうが安全。
- `storage.json` と `.env` は秘密情報。Git 管理しない。

## OpenChat 受信方式

### 最小構成

`Client.listen({ square: true, talk: true })` を使い、OpenChat の `square:message` と個人チャット/通常グループの `message` を受ける。

```ts
client.on("square:message", async (message) => {
  if (message.text === "!ping") {
    await message.reply("pong!");
  }
});

client.listen({ talk: true, square: true });
```

### 特定 OpenChat 監視

参加済み SquareChat を明示的に取る場合:

- `client.fetchJoinedSquareChats()`
- `client.getSquareChat(squareChatMid)`
- `SquareChat.listen({ signal, syncToken, onError })`

`SquareChat.listen()` は `fetchSquareChatEvents()` を使い、`update:syncToken` を発火する。将来的に OpenChat ごとに syncToken を保存すると、再起動後の重複処理を減らせる。

## Talk 受信方式

個人チャットと通常グループは `Client.listen({ talk: true })` で受ける。LINEJS では Talk 側の新着メッセージは `message` イベント、OpenChat は `square:message` イベントとして発火する。

この bot では `.env` の `ENABLE_TALK=true` で個人チャット/通常グループ、`ENABLE_SQUARE=true` で OpenChat を有効化する。両方を true にすると同じコマンド処理を全チャット種別で使う。

注意: LINEJS の標準 Talk `message` イベントは E2EE メッセージを復号してから発火する。現在の初回ログインは `e2ee: false` で成功させているため、Talk の Letter Sealing メッセージでは `NoE2EEKey` で落ちる。実装では Talk だけ raw event を読み、本文が平文の場合だけコマンド処理する。暗号化本文は読めないので、bot 用 LINE アカウント側で Letter Sealing を無効化するか、E2EE 鍵を保存できるログイン手順を用意する必要がある。

現在の実装では raw event 上の暗号化メッセージに対して `client.base.e2ee.decryptE2EEMessage()` を試す。E2EE 鍵が storage に保存されていれば本文を復号してコマンド処理する。鍵を取り直す場合は `LINE_FORCE_LOGIN=true` で保存済み auth token を一度スキップし、QR ログインで E2EE 情報を storage に保存する。

## 送信・リアクション

OpenChat message object:

- `message.text`
- `message.reply("text")`
- `message.send("text")`
- `message.react("NICE")`
- `message.read()`
- `message.announce()`
- `message.unsend()` 自分の送信のみ
- `message.delete()` 権限依存の可能性あり

Talk message object:

- `message.text`
- `message.reply("text")`
- `message.send("text")`
- `message.react(...)`
- `message.read()`
- `message.announce()` グループのみ
- `message.unsend()` 自分の送信のみ

低レベルAPI:

- `client.base.square.sendMessage({ squareChatMid, text })`
- `client.base.square.reactToMessage(...)`
- `client.base.square.markAsRead(...)`

## 常時稼働方針

最初は単一プロセス常駐でよい。

- 起動時に auth token / FileStorage でログイン。
- `client.listen({ square: true, talk: true })` を開始。
- `SIGINT` / `SIGTERM` で `AbortController.abort()` して終了処理。
- handler 内で例外を握りつぶさずログに残す。
- 送信は queue / cooldown を入れ、同一 OpenChat への連投を避ける。

Windows 常駐候補:

- 開発中: `npm run dev` / `deno task dev`
- 本番に近い運用: NSSM で Windows Service 化、または pm2 の Windows 起動設定
- サーバー運用: systemd / Docker restart policy

## 推奨ディレクトリ案

```text
D:\KBC\KBC-rakv0-line-bot
  .env
  .gitignore
  package.json
  src/
    main.ts
    config.ts
    lineClient.ts
    commands/
      gatya.ts
      sale.ts
      item.ts
      shared.ts
      index.ts
    handlers/
      ping.ts
  storage/
    storage.json
  logs/
```

## 実装済み機能

- `!ping` -> `pong!`
- `!gatya` -> ガチャ予定一覧
- `!gatya R` / `!gatya E` / `!gatya N` -> レア / イベント / ノーマル絞り込み
- `!gatya 1056` -> ガチャID詳細
- `!gatya 極ネコ` -> ガチャ名検索
- `!gatya 1056 json` / `!gatya 1056 r` -> JSON / raw 表示
- `!sale` -> セール予定一覧
- `!sale 24052` -> セールID詳細
- `!sale 悪霊` -> セール名検索
- `!sale 24052 json` / `!sale 24052 r` -> JSON / raw 表示
- `!item` -> アイテム配布予定一覧
- `!item 827` -> giftType 詳細。giftType に無い場合は eventId でフォールバック検索
- `!item レアチケット` -> アイテム名検索
- `!item 827 json` / `!item 827 r` -> JSON / raw 表示

`gatya` / `sale` / `item` は `KBC_EVENT_RAW_BASE_URL` または既定の GitHub raw URL から `KBC-rakv0-event/data` を取得する。返信が長い場合は複数メッセージへ分割する。

## 初期機能案

- `!help` -> 利用可能コマンド
- `!event` -> KBC イベントURLまたは最新情報
- `!status` -> bot 稼働状況
- 管理者のみコマンド: 設定再読み込み、対象 OpenChat 確認、メンテ告知

## リスクと制約

- SelfBot 方式なので公式 bot よりアカウント停止リスクが高い。
- OpenChat の管理規約、禁止事項、各部屋のルールに従う必要がある。
- LINEJS は活発に更新されており、API surface が変わる可能性がある。v3 系前提で実装する。
- OpenChat/Square のイベント取得は通常の公式 webhook ではなく、LINE クライアント相当の常時接続/ポーリングに依存する。
- 高頻度送信、全メンション、ログの長期保存は避ける。

## 次に作るもの

1. `package.json` / TypeScript 設定
2. `.env.example`
3. `src/main.ts`
4. `src/lineClient.ts`
5. `src/handlers/ping.ts`
6. `storage/.gitkeep` と `.gitignore`
7. 起動手順 `README.md`

## 参考リンク

- LINEJS GitHub: https://github.com/evex-dev/linejs
- LINEJS docs: https://linejs.evex.land/
- JSR package: https://jsr.io/@evex/linejs
- v3.1.4 release: https://github.com/evex-dev/linejs/releases/tag/v3.1.4
- LINEJS OpenChat event article: https://instagit.com/evex-dev/linejs/how-to-handle-talk-events-versus-square-openchat-events-in-linejs/
- LINEJS message sending article: https://instagit.com/evex-dev/linejs/how-to-send-different-message-types-text-image-video-location-with-linejs/
- LINE Messaging API group docs: https://developers.line.biz/en/docs/messaging-api/group-chats/
- LINE Messaging API development guidelines: https://developers.line.biz/en/docs/messaging-api/development-guidelines/
- LINE OpenChat terms: https://terms.line.me/line_Square_TOU_JP
- LINE account suspension help: https://help.line.me/line/smartphone/sp?contentId=200002136&lang=en
