require("dotenv").config();

const express = require("express");
const Database = require("better-sqlite3");
const { Telegraf, Markup, Input } = require("telegraf");
const path = require("path");
const fs = require("fs");

const {
  BOT_TOKEN,
  PUBLIC_BASE_URL,
  PAYMENT_GATEWAY_BASE = "https://mrkrishna-payment-api.onrender.com",
  ADMIN_CLAIM_CODE = "",
  WEBHOOK_SECRET,
  DATABASE_PATH = "./store.sqlite",
  INSTAGRAM_URL = "https://instagram.com/mrkrishna.in",
  PORT = 10000
} = process.env;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required.");
if (!PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL is required for Telegram webhooks.");
if (!WEBHOOK_SECRET) throw new Error("WEBHOOK_SECRET is required.");

const publicBase = PUBLIC_BASE_URL.replace(/\/+$/, "");
const gatewayBase = PAYMENT_GATEWAY_BASE.replace(/\/+$/, "");
const webhookPath = `/telegram/${WEBHOOK_SECRET}`;

const dbDir = path.dirname(DATABASE_PATH);
if (dbDir && dbDir !== "." && !fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DATABASE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    claimed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL CHECK (price > 0),
    link TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_code TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    requested_amount REAL NOT NULL,
    gateway_amount REAL,
    transaction_id TEXT UNIQUE,
    payment_link TEXT,
    qr_link TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    delivered_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(product_id) REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bot_messages (
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    persistent INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(chat_id, message_id)
  );
`);

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json({ limit: "1mb" }));

bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id;

  if (chatId !== undefined) {
    const currentMessageId = ctx.callbackQuery?.message?.message_id;
    const oldMessages = db.prepare(
      "SELECT message_id, persistent FROM bot_messages WHERE chat_id=?"
    ).all(String(chatId));

    for (const item of oldMessages) {
      if (item.persistent || item.message_id === currentMessageId) continue;

      try {
        await ctx.telegram.deleteMessage(chatId, item.message_id);
      } catch (_) {
        // Telegram may already have deleted the message.
      }

      db.prepare(
        "DELETE FROM bot_messages WHERE chat_id=? AND message_id=?"
      ).run(String(chatId), item.message_id);
    }
  }

  ctx.state = ctx.state || {};

  for (const method of ["reply", "replyWithPhoto"]) {
    const original = ctx[method].bind(ctx);

    ctx[method] = async (...args) => {
      const persistent = ctx.state.keepNextBotMessage === true;
      ctx.state.keepNextBotMessage = false;

      const sent = await original(...args);
      const messageId = sent?.message_id;
      const sentChatId = sent?.chat?.id ?? chatId;

      if (messageId && sentChatId !== undefined) {
        db.prepare(
          `INSERT OR REPLACE INTO bot_messages(chat_id, message_id, persistent)
           VALUES(?, ?, ?)`
        ).run(String(sentChatId), messageId, persistent ? 1 : 0);
      }

      return sent;
    };
  }

  return next();
});

const now = () => new Date().toISOString();
const money = (n) => `₹${Number(n).toFixed(2).replace(/\.00$/, "")}`;
const isAdmin = (ctx) => {
  const row = db.prepare("SELECT user_id FROM admin WHERE id = 1").get();
  return !!row && String(ctx.from?.id) === row.user_id;
};
const getSetting = (key, fallback = "") => {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
};
const setSetting = (key, value) => {
  db.prepare(`
    INSERT INTO settings(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
};
const mainMenu = () => Markup.inlineKeyboard([
  [Markup.button.callback("🛒 Store", "store:0")],
  [Markup.button.callback("🎮 Demo", "demo")],
  [Markup.button.callback("💬 Support", "support")]
]);

function safeUrl(value) {
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

async function gatewayGet(endpoint) {
  const url = `${gatewayBase}${endpoint}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(20000)
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error(`Gateway returned non-JSON response (HTTP ${response.status}).`); }
  if (!response.ok) {
    throw new Error(data?.error || `Gateway HTTP ${response.status}`);
  }
  return data;
}

function productKeyboard(products, page = 0) {
  const pageSize = 6;
  const start = page * pageSize;
  const shown = products.slice(start, start + pageSize);
  const rows = shown.map(p => [
    Markup.button.callback(`${p.name} — ${money(p.price)}`, `product:${p.id}`)
  ]);
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️ Previous", `store:${page - 1}`));
  if (start + pageSize < products.length) nav.push(Markup.button.callback("Next ➡️", `store:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback("🏠 Home", "home")]);
  return Markup.inlineKeyboard(rows);
}

function adminHelp() {
  return [
    "Admin commands:",
    "/beadmin CODE — claim the bot once (first setup only)",
    "/addproduct pname price plink",
    "/products — list products",
    "/editproduct ID pname price plink",
    "/removeproduct ID",
    "/setdemo URL",
    "/setsupport URL",
    "/setinstagram URL",
    "/setwelcome Your welcome text",
    "/orders",
    "/stats"
  ].join("\n");
}

// One-time owner claim. The optional configured claim code prevents a stranger
// from claiming the bot before the real owner reaches it.
bot.command("beadmin", async (ctx) => {
  if (ctx.chat?.type !== "private") {
    return ctx.reply("Please claim admin in a private chat with this bot.");
  }

  const existing = db.prepare("SELECT user_id FROM admin WHERE id = 1").get();
  if (existing) {
    return ctx.reply("Admin is already configured. Nobody else can become admin.");
  }

  if (!ADMIN_CLAIM_CODE) {
    return ctx.reply("Admin claiming is disabled. The owner must configure ADMIN_CLAIM_CODE in the server environment first.");
  }

  const suppliedCode = (ctx.message.text || "").trim().split(/\s+/).slice(1).join(" ");
  if (suppliedCode !== ADMIN_CLAIM_CODE) {
    return ctx.reply("Invalid admin claim code.");
  }

  const claim = db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO admin(id, user_id, chat_id, claimed_at)
      VALUES(1, ?, ?, ?)
    `).run(String(ctx.from.id), String(ctx.chat.id), now());
    return db.prepare("SELECT user_id, chat_id FROM admin WHERE id = 1").get();
  });
  const owner = claim();

  if (owner.user_id !== String(ctx.from.id)) {
    return ctx.reply("Admin was already claimed by another account. Claim rejected.");
  }

  return ctx.reply(
    `Admin successfully registered.\nYour Telegram user ID: ${ctx.from.id}\nYour chat ID: ${ctx.chat.id}\n\n${adminHelp()}`
  );
});

bot.start(async (ctx) => {
  const welcome = getSetting("welcome", "Welcome to our store!\nChoose an option below:");
  await ctx.reply(welcome, mainMenu());
});

bot.command("help", async (ctx) => {
  if (isAdmin(ctx)) return ctx.reply(adminHelp());
  return ctx.reply("Use the buttons below to browse the store.", mainMenu());
});

bot.command("addproduct", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("You are not authorized.");
  const parts = (ctx.message.text || "").trim().split(/\s+/);
  if (parts.length < 4) {
    return ctx.reply("Usage: /addproduct pname price plink\nExample: /addproduct Premium_VPS 100 https://example.com/access");
  }
  const link = safeUrl(parts[parts.length - 1]);
  const price = Number(parts[parts.length - 2]);
  const name = parts.slice(1, -2).join(" ").replace(/_/g, " ").trim();
  if (!name || !Number.isFinite(price) || price <= 0 || !link) {
    return ctx.reply("Invalid product. Price must be positive and link must be a valid http(s) URL.");
  }
  const count = db.prepare("SELECT COUNT(*) AS count FROM products WHERE active = 1").get().count;
  if (count >= 12) return ctx.reply("The store already has 12 active products. Remove one before adding another.");
  const result = db.prepare(`
    INSERT INTO products(name, price, link, created_at) VALUES(?, ?, ?, ?)
  `).run(name, price, link, now());
  return ctx.reply(`Product added successfully.\nID: ${result.lastInsertRowid}\nName: ${name}\nPrice: ${money(price)}`);
});

bot.command("products", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("You are not authorized.");
  const rows = db.prepare("SELECT id, name, price, link, active FROM products ORDER BY id").all();
  if (!rows.length) return ctx.reply("No products yet. Use /addproduct pname price plink");
  const text = rows.map(p => `#${p.id} ${p.name} — ${money(p.price)} — ${p.active ? "Active" : "Hidden"}\n${p.link}`).join("\n\n");
  return ctx.reply(text);
});

bot.command("editproduct", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("You are not authorized.");
  const parts = (ctx.message.text || "").trim().split(/\s+/);
  if (parts.length < 5) return ctx.reply("Usage: /editproduct ID pname price plink");
  const id = Number(parts[1]);
  const link = safeUrl(parts[parts.length - 1]);
  const price = Number(parts[parts.length - 2]);
  const name = parts.slice(2, -2).join(" ").replace(/_/g, " ").trim();
  if (!Number.isInteger(id) || !name || !Number.isFinite(price) || price <= 0 || !link) {
    return ctx.reply("Invalid values. Usage: /editproduct ID pname price plink");
  }
  const result = db.prepare("UPDATE products SET name=?, price=?, link=? WHERE id=? AND active=1")
    .run(name, price, link, id);
  return ctx.reply(result.changes ? `Product #${id} updated.` : "Active product not found.");
});

bot.command("removeproduct", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("You are not authorized.");
  const id = Number((ctx.message.text || "").trim().split(/\s+/)[1]);
  if (!Number.isInteger(id)) return ctx.reply("Usage: /removeproduct ID");
  const result = db.prepare("UPDATE products SET active=0 WHERE id=? AND active=1").run(id);
  return ctx.reply(result.changes ? `Product #${id} removed from the store.` : "Active product not found.");
});

bot.command("setdemo", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("You are not authorized.");
  const url = safeUrl((ctx.message.text || "").trim().split(/\s+/)[1] || "");
  if (!url) return ctx.reply("Usage: /setdemo https://your-demo-link");
  setSetting("demo_url", url);
  return ctx.reply("Demo link saved.");
});

bot.command("setsupport", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("You are not authorized.");
  const url = safeUrl((ctx.message.text || "").trim().split(/\s+/)[1] || "");
  if (!url) return ctx.reply("Usage: /setsupport https://your-support-link");
  setSetting("support_url", url);
  return ctx.reply("Support link saved.");
});

bot.command("setinstagram", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("You are not authorized.");
  const url = safeUrl((ctx.message.text || "").trim().split(/\s+/)[1] || "");
  if (!url) return ctx.reply("Usage: /setinstagram https://instagram.com/yourhandle");
  setSetting("instagram_url", url);
  return ctx.reply("Instagram link saved.");
});

bot.command("setwelcome", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("You are not authorized.");
  const value = (ctx.message.text || "").replace(/^\/setwelcome(?:@\w+)?\s*/i, "").trim();
  if (!value) return ctx.reply("Usage: /setwelcome Welcome to my store!");
  setSetting("welcome", value);
  return ctx.reply("Welcome message updated.");
});

bot.command("orders", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("You are not authorized.");
  const rows = db.prepare(`
    SELECT order_code, product_name, requested_amount, status, transaction_id, user_id, created_at
    FROM orders ORDER BY id DESC LIMIT 20
  `).all();
  if (!rows.length) return ctx.reply("No orders yet.");
  const text = rows.map(o =>
    `${o.order_code} | ${o.product_name} | ${money(o.requested_amount)} | ${o.status}\nUser: ${o.user_id} | Txn: ${o.transaction_id || "-"}`
  ).join("\n\n");
  return ctx.reply(text);
});

bot.command("stats", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("You are not authorized.");
  const total = db.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
  const paid = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(requested_amount),0) AS amount FROM orders WHERE status='paid'").get();
  const pending = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='pending'").get().n;
  return ctx.reply(`Orders: ${total}\nSuccessful: ${paid.n}\nRevenue (product prices): ${money(paid.amount)}\nPending: ${pending}`);
});

bot.command("myorders", async (ctx) => {
  const rows = db.prepare(`
    SELECT order_code, product_name, status, delivered_at
    FROM orders WHERE user_id=? AND status='paid' ORDER BY id DESC LIMIT 20
  `).all(String(ctx.from.id));
  if (!rows.length) return ctx.reply("You don't have any completed purchases yet.");
  for (const row of rows) {
    const order = db.prepare("SELECT p.link FROM orders o JOIN products p ON p.id=o.product_id WHERE o.order_code=?").get(row.order_code);
    // Preserve the purchased URL even if a product is later edited/removed:
    const stored = db.prepare("SELECT link FROM order_links WHERE order_code=?").get(row.order_code);
    const link = stored?.link || order?.link;
    if (link) {
      await ctx.reply(`${row.product_name}\nOrder: ${row.order_code}\n${link}`);
    }
  }
});

bot.action("home", async (ctx) => {
  await ctx.answerCbQuery();
  const welcome = getSetting("welcome", "Welcome to our store!\nChoose an option below:");
  return ctx.editMessageText(welcome, mainMenu()).catch(() => ctx.reply(welcome, mainMenu()));
});

bot.action(/^store:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const products = db.prepare("SELECT id, name, price FROM products WHERE active=1 ORDER BY id").all();
  if (!products.length) return ctx.reply("Our store is being updated. Please check back soon.");
  const page = Number(ctx.match[1]);
  return ctx.editMessageText("🛒 Choose a product:", productKeyboard(products, page))
    .catch(() => ctx.reply("🛒 Choose a product:", productKeyboard(products, page)));
});

bot.action(/^product:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const product = db.prepare("SELECT id, name, price FROM products WHERE id=? AND active=1").get(Number(ctx.match[1]));
  if (!product) return ctx.reply("This product is no longer available.");
  return ctx.reply(
    `${product.name}\nPrice: ${money(product.price)}\n\nTap Buy Now to create your payment.`,
    Markup.inlineKeyboard([
      [Markup.button.callback("💳 Buy Now", `buy:${product.id}`)],
      [Markup.button.callback("⬅️ Back to Store", "store:0")]
    ])
  );
});

bot.action(/^buy:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery("Creating payment...");
  const product = db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(Number(ctx.match[1]));
  if (!product) return ctx.reply("This product is no longer available.");

  try {
    const data = await gatewayGet(`/link?value=${encodeURIComponent(product.price)}`);
    if (data.success !== true || !data.transaction_id || !safeUrl(data.payment_link) || !safeUrl(data.qr_link)) {
      throw new Error(data.error || "Gateway did not return valid payment details.");
    }

    const orderCode = `MKSTORE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const gatewayAmount = Number(data.amount);
    if (!Number.isFinite(gatewayAmount) || gatewayAmount <= 0) {
      throw new Error("Gateway returned an invalid payable amount.");
    }

    db.prepare(`
      INSERT INTO orders(
        order_code,user_id,chat_id,product_id,product_name,requested_amount,
        gateway_amount,transaction_id,payment_link,qr_link,status,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?, 'pending',?)
    `).run(
      orderCode, String(ctx.from.id), String(ctx.chat.id), product.id, product.name,
      product.price, gatewayAmount, String(data.transaction_id),
      data.payment_link, data.qr_link, now()
    );

    db.prepare("INSERT OR REPLACE INTO order_links(order_code, link) VALUES(?,?)")
      .run(orderCode, product.link);

    await ctx.reply(
      `Order created: ${orderCode}\nProduct: ${product.name}\nProduct price: ${money(product.price)}\nGateway payable amount: ${money(gatewayAmount)}\n\nComplete payment, then tap Verify Payment.`,
      Markup.inlineKeyboard([
        [Markup.button.url("Pay Now", data.payment_link)],
        [Markup.button.callback("Show QR", `qr:${orderCode}`)],
        [Markup.button.callback("Verify Payment", `verify:${orderCode}`)]
      ])
    );
  } catch (error) {
    console.error("Payment creation failed:", error.message);
    await ctx.reply("Sorry, I couldn't create the payment right now. Please try again shortly.");
  }
});

bot.action(/^qr:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();

  const order = db.prepare(
    "SELECT * FROM orders WHERE order_code=? AND user_id=?"
  ).get(ctx.match[1], String(ctx.from.id));

  if (!order) return ctx.reply("Order not found.");
  if (order.status === "paid") {
    return ctx.reply("This order is already paid and delivered.");
  }

  try {
    const response = await fetch(order.qr_link, {
      headers: { Accept: "image/*" },
      signal: AbortSignal.timeout(20000)
    });

    if (!response.ok) throw new Error(`QR download HTTP ${response.status}`);

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) {
      throw new Error("Gateway QR URL did not return an image.");
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) {
      throw new Error("QR image is empty or exceeds the 8 MB safety limit.");
    }

    const extension = contentType.includes("png") ? "png" :
      contentType.includes("webp") ? "webp" : "jpg";

    ctx.state.keepNextBotMessage = true;

    await ctx.replyWithPhoto(
      Input.fromBuffer(bytes, `${order.order_code}.${extension}`),
      {
        caption:
          `PAYMENT QR\\nOrder: ${order.order_code}\\nProduct: ${order.product_name}\\nPayable: ${money(order.gateway_amount)}\\n\\nAfter paying, tap Verify Payment.`,
        ...Markup.inlineKeyboard([
          [Markup.button.url("Pay Now", order.payment_link)],
          [Markup.button.callback("Verify Payment", `verify:${order.order_code}`)]
        ])
      }
    );
  } catch (error) {
    ctx.state.keepNextBotMessage = false;
    console.error("QR download/display failed:", error.message);
    await ctx.reply("Could not download the QR image. Please use the Pay Now button from your order message and try again.");
  }
});

bot.action(/^verify:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Checking payment...");
  const order = db.prepare("SELECT * FROM orders WHERE order_code=? AND user_id=?")
    .get(ctx.match[1], String(ctx.from.id));
  if (!order) return ctx.reply("Order not found.");
  if (order.status === "paid") {
    const stored = db.prepare("SELECT link FROM order_links WHERE order_code=?").get(order.order_code);
    return ctx.reply(`Already paid. Your product link:\n${stored?.link || "Contact support to recover your link."}`);
  }

  try {
    const result = await gatewayGet(`/cheque?value=${encodeURIComponent(order.transaction_id)}`);

    // All fields are mandatory. A generic success:true is NOT payment proof.
    const returnedTxn = String(result.transaction_id || "");
    const returnedAmount = Number(result.amount);

    const paymentIsValid =
      result.success === true &&
      result.payment_confirmed === true &&
      result.status === "PAID" &&
      returnedTxn === String(order.transaction_id) &&
      Number.isFinite(returnedAmount) &&
      Math.round(returnedAmount * 100) ===
        Math.round(Number(order.gateway_amount) * 100);

    if (!paymentIsValid) {
      const looksLikeMismatch =
        result.success === true &&
        (result.payment_confirmed === true || result.status === "PAID");

      return ctx.reply(
        looksLikeMismatch
          ? "Payment details could not be securely matched with this order. Please contact support."
          : "Payment is not confirmed yet. If you have paid, wait a little and tap Verify Payment again."
      );
    }

    // Check the saved delivery URL before marking the order as paid.
    const stored = db.prepare(
      "SELECT link FROM order_links WHERE order_code=?"
    ).get(order.order_code);

    if (!stored?.link) {
      console.error("Paid transaction has no stored delivery URL:", order.order_code);
      return ctx.reply("Payment appears confirmed, but the delivery link needs recovery. Please contact support.");
    }

    const complete = db.transaction(() => {
      const fresh = db.prepare(
        "SELECT status FROM orders WHERE order_code=?"
      ).get(order.order_code);

      if (!fresh || fresh.status === "paid") return false;

      return db.prepare(
        "UPDATE orders SET status='paid', delivered_at=? WHERE order_code=? AND status='pending'"
      ).run(now(), order.order_code).changes > 0;
    });

    const didDeliver = complete();

    if (!stored?.link) {
      console.error("Paid order missing stored delivery URL:", order.order_code);
      return ctx.reply("Payment verified, but the delivery link needs recovery. Please contact support.");
    }

    if (didDeliver) {
      await ctx.reply(
        `Payment successful!\nProduct: ${order.product_name}\nOrder: ${order.order_code}\n\nYour product link:\n${stored.link}`
      );
    } else {
      await ctx.reply(`This order has already been delivered. Your product link:\n${stored.link}`);
    }
  } catch (error) {
    console.error("Payment verification failed:", error.message);
    await ctx.reply("Unable to check payment right now. Please try again shortly.");
  }
});

bot.action("demo", async (ctx) => {
  await ctx.answerCbQuery();
  const url = getSetting("demo_url");
  if (!url) return ctx.reply("Demo link hasn't been configured yet.");
  return ctx.reply("Open our demo:", Markup.inlineKeyboard([[Markup.button.url("Open Demo", url)]]));
});

bot.action("support", async (ctx) => {
  await ctx.answerCbQuery();
  const instagram = getSetting("instagram_url", INSTAGRAM_URL);
  const support = getSetting("support_url");
  const rows = [];
  if (instagram) rows.push([Markup.button.url("Instagram", instagram)]);
  if (support) rows.push([Markup.button.url("Contact Developer", support)]);
  if (!support) rows.push([Markup.button.callback("Contact Developer (not configured)", "support_missing")]);
  return ctx.reply("How can we help you?", Markup.inlineKeyboard(rows));
});

bot.action("support_missing", async (ctx) => {
  await ctx.answerCbQuery("Support contact is not configured yet.");
});

bot.catch((err, ctx) => {
  console.error("Telegram handler error:", err);
  if (ctx?.reply) ctx.reply("Something went wrong. Please try again.").catch(() => {});
});

// Store each delivered link separately from the product so future product edits
// do not change a customer's historical purchase.
db.exec(`
  CREATE TABLE IF NOT EXISTS order_links (
    order_code TEXT PRIMARY KEY,
    link TEXT NOT NULL
  );
`);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mrkrishna-telegram-store" });
});

app.post(webhookPath, async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook update failed:", error);
    res.sendStatus(500);
  }
});

async function start() {
  const webhookUrl = `${publicBase}${webhookPath}`;
  await bot.telegram.setWebhook(webhookUrl, {
    allowed_updates: ["message", "callback_query"]
  });
  app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`Store bot web service listening on port ${PORT}`);
    console.log(`Telegram webhook configured: ${webhookUrl}`);
  });
}

start().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});

process.once("SIGINT", () => {
  bot.telegram.deleteWebhook().catch(() => {});
  db.close();
  process.exit(0);
});
process.once("SIGTERM", () => {
  db.close();
  process.exit(0);
});
