# MrKrishna Telegram Store Bot

Telegram digital store with 12 product slots, inline callback menus, one-time admin claiming, and MrKrishna Payment Gateway integration.

## Features

- `/start` welcome screen with inline **Store**, **Demo**, and **Support** buttons.
- Store supports up to 12 active products.
- Product purchase creates a payment using `GET /link?value=PRICE`.
- Customer can open the payment link, display the QR, and verify payment.
- Verification uses `GET /cheque?value=TRANSACTION_ID`.
- `TRANSACTION_NOT_FOUND` and other unsuccessful responses leave the order pending.
- On `success: true`, the bot checks transaction ID and amount when those fields are present, then sends the saved product URL.
- Delivery is protected against repeat verification and the order's original URL is retained.
- `/myorders` retrieves previously purchased product links.
- SQLite database for admin, products, orders, settings, and delivered links.
- Telegram webhook + Express health endpoint for Render.

## Admin security

**Important:** A public `/beadmin` command with no protection lets the first stranger who finds the bot claim ownership. Set a long random `ADMIN_CLAIM_CODE` in Render before deploying.

After deployment, open the bot in a private chat and send:

```text
/beadmin YOUR_ADMIN_CLAIM_CODE
```

The first successful claim is saved in SQLite. Further claims are rejected. The admin is identified by Telegram sender user ID; in a private chat, the chat ID is also stored. Never share the claim code or bot token.

If you leave `ADMIN_CLAIM_CODE` blank, `/beadmin` works without a code, but this is **not recommended** for a public bot.

## Admin commands

```text
/beadmin CODE
/addproduct Product_Name 100 https://example.com/access
/products
/editproduct 1 New_Product_Name 150 https://example.com/new-link
/removeproduct 1
/setdemo https://example.com/demo
/setsupport https://t.me/your_support
/setinstagram https://instagram.com/mrkrishna.in
/setwelcome Welcome to our store!
/orders
/stats
```

For `/addproduct`, use underscores for spaces in product names. The parser also accepts names with spaces if the final two arguments are price and URL:

```text
/addproduct Premium VPS 100 https://example.com/access
```

## Render deployment

1. Create a Telegram bot with `@BotFather` and copy its token.
2. Push this folder to a GitHub repository.
3. In Render, create a **Web Service** connected to that repository.
4. Build command: `npm install`
5. Start command: `npm start`
6. Add environment variables:

| Key | Value |
|---|---|
| `BOT_TOKEN` | Token from BotFather |
| `PUBLIC_BASE_URL` | `https://YOUR-SERVICE.onrender.com` |
| `PAYMENT_GATEWAY_BASE` | `https://mrkrishna-payment-api.onrender.com` |
| `ADMIN_CLAIM_CODE` | Long random secret |
| `WEBHOOK_SECRET` | Another long random secret |
| `DATABASE_PATH` | `/var/data/store.sqlite` |
| `PORT` | `10000` |
| `INSTAGRAM_URL` | `https://instagram.com/mrkrishna.in` |

7. Deploy, then open `https://YOUR-SERVICE.onrender.com/health`. It should return `{"ok":true,...}`.
8. Claim admin in the bot using `/beadmin YOUR_ADMIN_CLAIM_CODE`.
9. Add products.

## SQLite persistence warning

The default Render free web service filesystem is ephemeral. The database can be lost on redeploy/restart. For persistent SQLite, attach a Render Persistent Disk mounted at `/var/data` and keep `DATABASE_PATH=/var/data/store.sqlite`. Persistent disks are generally a paid Render feature. Do not use this for real sales until persistent storage is configured and tested.

## Payment gateway response expectations

Payment creation expects a JSON response containing:

```json
{
  "success": true,
  "amount": 100.01,
  "currency": "INR",
  "payment_link": "https://.../pay/...",
  "qr_link": "https://.../qr/...",
  "requested_amount": 100,
  "transaction_id": "MK..."
}
```

Payment verification calls `/cheque?value=MK...`. The bot treats `success: true` as confirmed, and `success: false` (including `TRANSACTION_NOT_FOUND`) as pending. If the verification response includes `transaction_id` and/or `amount`, those values are checked against the order. The gateway URL itself is queried using the transaction ID stored by the bot, never an ID supplied by the customer.

**Before accepting real payments:** test both successful and unsuccessful `/cheque` responses and confirm the success response fields from your gateway. If your gateway uses a different success flag or amount field, adjust the verification parser accordingly.

## Operational notes

- Configure the Render persistent disk before adding products or claiming admin.
- Use HTTPS and keep `WEBHOOK_SECRET` random.
- Do not expose `.env`, `BOT_TOKEN`, or `ADMIN_CLAIM_CODE`.
- Keep a backup of the SQLite database.
- This bot sends the configured product URL directly in Telegram. Use links with your own access controls if the content should not be publicly shareable.
