const { Telegraf, Markup } = require("telegraf");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram/tl");
const { MongoClient, ObjectId } = require("mongodb");
const https = require("https");
const http = require("http");
require("dotenv").config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const API_ID = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const DB_NAME = process.env.DB_NAME || "gpbot";
const PORT = Number(process.env.PORT || 10000);

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!MONGO_URI) throw new Error("MONGO_URI or MONGODB_URI is missing");
if (!ADMIN_ID) throw new Error("ADMIN_ID is missing");
if (!API_ID || !API_HASH) throw new Error("API_ID and API_HASH are required for account sessions");

const bot = new Telegraf(BOT_TOKEN);
const mongo = new MongoClient(MONGO_URI);
let db;
const sessions = new Map();
const clientPool = new Map();
let sending = false;
const recurringTimers = new Map();

const plans = {
  one: {
    label: "1 Account",
    accounts: 1,
    durations: {
      d1: { label: "1 Day (1000 Ks)", days: 1, price: 1000 },
      d2: { label: "2 Day (1500 Ks)", days: 2, price: 1500 },
      w1: { label: "1 Week (5000 Ks)", days: 7, price: 5000 },
    },
  },
  two: {
    label: "2 Account",
    accounts: 2,
    durations: {
      d1: { label: "1 Day (2000 Ks)", days: 1, price: 2000 },
      d2: { label: "2 Day (2500 Ks)", days: 2, price: 2500 },
      w1: { label: "1 Week (10000 Ks)", days: 7, price: 10000 },
    },
  },
};

function now() { return new Date(); }
function isAdmin(ctx) { return Boolean(ctx.from && ctx.from.id === ADMIN_ID); }
function nameOf(ctx) { return ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name || "User"); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function parseAmount(value) {
  const normalized = String(value || "").trim().replace(/,/g, "").replace(/\s*(?:ks|ကျပ်)\s*$/i, "");
  return /^\d+$/.test(normalized) ? Number(normalized) : NaN;
}
function adminOnly(ctx, next) { if (isAdmin(ctx)) return next(); }

async function ensureUser(ctx) {
  const u = ctx.from;
  await db.collection("users").updateOne(
    { telegramId: u.id },
    { $set: { username: u.username || null, firstName: u.first_name || null, updatedAt: now() }, $setOnInsert: { telegramId: u.id, balance: 0, createdAt: now() } },
    { upsert: true },
  );
  return db.collection("users").findOne({ telegramId: u.id });
}

async function getPaymentSettings() {
  return db.collection("settings").findOne({ _id: "payments" }) || {};
}

async function savePayment(method, phone, name) {
  await db.collection("settings").updateOne({ _id: "payments" }, { $set: { [`${method}Phone`]: phone, [`${method}Name`]: name, updatedAt: now() } }, { upsert: true });
}

async function isBanned(userId) {
  const user = await db.collection("users").findOne({ telegramId: Number(userId) }, { projection: { banned: 1 } });
  return Boolean(user?.banned);
}

async function activeSubscription(userId) {
  await expireSubscriptions();
  return db.collection("subscriptions").findOne({ userId, status: "active", expiresAt: { $gt: now() } });
}

async function expireSubscriptions() {
  if (!db) return;
  const current = now();
  const expired = await db.collection("subscriptions").find({ status: "active", expiresAt: { $lte: current } }).toArray();
  for (const subscription of expired) {
    const changed = await db.collection("subscriptions").updateOne(
      { _id: subscription._id, status: "active" },
      { $set: { status: "expired", expiredAt: current } },
    );
    if (!changed.modifiedCount) continue;
    await db.collection("accounts").updateMany(
      { "lease.subscriptionId": subscription._id },
      { $unset: { lease: "" } },
    );
    const planText = subscription.durationKey === "d1" ? "1 ရက်စာ" : subscription.durationKey === "d2" ? "2 ရက်စာ" : "1 ပတ်စာ";
    await bot.telegram.sendMessage(subscription.userId, `သင်ဝယ်ထားသော ${planText} plan မှာ ကုန်ဆုံးသွားပါပြီ။ ထပ်သုံးရန် plan ထပ်ဝယ်ပါ။`).catch(() => {});
  }
}

async function acquireAccounts(userId, subscriptionId, count, expiresAt) {
  const acquired = [];
  for (let i = 0; i < count; i += 1) {
    const account = await db.collection("accounts").findOneAndUpdate(
      {
        enabled: true,
        $or: [
          { lease: { $exists: false } },
          { "lease.expiresAt": { $lte: now() } },
        ],
      },
      { $set: { lease: { userId, subscriptionId, expiresAt, claimedAt: now() } } },
      { sort: { order: 1, addedAt: 1 }, returnDocument: "after" },
    );
    if (!account) break;
    acquired.push(account);
  }
  return acquired;
}

async function releaseAccounts(subscriptionId) {
  await db.collection("accounts").updateMany({ "lease.subscriptionId": subscriptionId }, { $unset: { lease: "" } });
}

async function getSessionFile(ctx, fileId) {
  const info = await ctx.telegram.getFile(fileId);
  return new Promise((resolve, reject) => {
    https.get(`https://api.telegram.org/file/bot${BOT_TOKEN}/${info.file_path}`, res => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => resolve(data.trim()));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function buildClient(sessionString) {
  const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, { connectionRetries: 5 });
  await client.connect();
  return client;
}

async function connectAccount(name, sessionString) {
  const cleanSession = String(sessionString || "").trim();
  if (cleanSession.length < 20) throw new Error("Session string မမှန်ပါ။");
  const client = await buildClient(cleanSession);
  const result = await db.collection("accounts").findOneAndUpdate(
    { name },
    { $set: { name, sessionString: cleanSession, enabled: true, updatedAt: now() }, $setOnInsert: { addedAt: now(), order: Date.now() } },
    { upsert: true, returnDocument: "after" },
  );
  clientPool.set(String(result._id), client);
  return result;
}

async function loadAccounts() {
  return db.collection("accounts").find({ enabled: true }).sort({ order: 1, addedAt: 1 }).toArray();
}

async function connectStoredAccounts() {
  for (const account of await loadAccounts()) {
    try {
      const client = await buildClient(account.sessionString);
      clientPool.set(String(account._id), client);
      console.log(`Connected account: ${account.name}`);
    } catch (error) {
      console.error(`Account ${account.name} failed: ${error.message}`);
    }
  }
}

function normalizeTarget(value) {
  return value.trim().replace(/^https?:\/\/(www\.)?t\.me\//i, "").replace(/^@/, "").replace(/\/$/, "");
}

function isPublicGpLink(value) {
  return /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/[A-Za-z0-9_]{3,}$/i.test(value.trim());
}

function targetsFromUserLinks(values) {
  return values.map(value => value.trim()).filter(Boolean).map(link => {
    const clean = link.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    const slug = clean.split("/").pop();
    return { chatId: `@${slug}`, username: `@${slug}`, inviteLink: `https://${clean}` };
  });
}

async function joinTarget(client, target) {
  const raw = String(target.inviteLink || target.chatId);
  const invite = raw.match(/t\.me\/\+(\w+)/i);
  if (invite) {
    try {
      const result = await client.invoke(new Api.messages.ImportChatInvite({ hash: invite[1] }));
      return result.chats?.[0] || await client.getEntity(raw);
    } catch (error) {
      if (!String(error.message).toLowerCase().includes("already")) throw error;
    }
  }
  const entity = await client.getEntity(target.chatId || target.username);
  if (entity.className === "User") throw new Error("User account link မဟုတ်ဘဲ public GP link သာ ပို့ရပါမယ်။");
  if (entity.className === "Channel") {
    try { await client.invoke(new Api.channels.JoinChannel({ channel: entity })); } catch (error) {
      if (!String(error.message).toLowerCase().includes("already")) throw error;
    }
  }
  return entity;
}

async function sendWithAccount(client, entityOrTarget, message) {
  const entity = typeof entityOrTarget === "object" && entityOrTarget.className
    ? entityOrTarget
    : await client.getEntity(entityOrTarget.chatId || entityOrTarget.username);
  await client.sendMessage(entity, { message, parseMode: "html", linkPreview: false });
}

function messageKeyboard(accountConfigs) {
  const rows = [];
  for (let accountIndex = 0; accountIndex < accountConfigs.length; accountIndex += 1) {
    for (let gpIndex = 0; gpIndex < accountConfigs[accountIndex].targets.length; gpIndex += 1) {
      rows.push([Markup.button.callback(`GP${accountIndex + 1}-${gpIndex + 1} အတွက်စာသားရေးပါ`, `message:${accountIndex}:${gpIndex}`)]);
    }
  }
  return Markup.inlineKeyboard(rows);
}

async function joinConfiguredTargets(userId, accountConfigs) {
  for (let accountIndex = 0; accountIndex < accountConfigs.length; accountIndex += 1) {
    const config = accountConfigs[accountIndex];
    const account = await db.collection("accounts").findOne({ _id: config.accountId, enabled: true });
    if (!account || !clientPool.has(String(account._id))) throw new Error(`Account ${accountIndex + 1} ချိတ်ဆက်ထားခြင်းမရှိပါ။`);
    const client = clientPool.get(String(account._id));
    await bot.telegram.sendMessage(userId, `Account ${accountIndex + 1} အတွက် GP join စတင်ပါပြီ။`);
    let joined = 0;
    for (let i = 0; i < config.targets.length; i += 1) {
      const target = config.targets[i];
      try {
        await joinTarget(client, target);
        joined += 1;
        await bot.telegram.sendMessage(userId, `${target.inviteLink} joined ပြီးပါပြီ။`);
      } catch (error) {
        const floodMatch = String(error.message || "").match(/FLOOD_WAIT[_ ](\d+)/i);
        const waitSeconds = Number(error.seconds || floodMatch?.[1] || 0);
        if (waitSeconds > 0) {
          const waitMs = Math.max(waitSeconds * 1000, 10 * 60 * 1000);
          await bot.telegram.sendMessage(userId, `Telegram cooldown ဖြစ်နေပါသည်။ နောက် GP များကို ${Math.ceil(waitMs / 60000)} မိနစ်နေ auto ဆက် join ပါမယ်။`);
          await sleep(waitMs);
        } else {
          await bot.telegram.sendMessage(userId, `${target.inviteLink} join မအောင်မြင်ပါ။ User account link မဟုတ်ဘဲ public GP link သာ ပို့ပါ။`);
        }
      }
      if (i < config.targets.length - 1) {
        if (joined > 0 && joined % 4 === 0) {
          await bot.telegram.sendMessage(userId, `GP ${joined} ခု join ပြီးပါပြီ။ နောက် GP များကို 10 မိနစ်နေ auto ဆက် join ပါမယ်။`);
          await sleep(10 * 60 * 1000);
        } else {
          await sleep(5000);
        }
      }
    }
    await bot.telegram.sendMessage(userId, `Account ${accountIndex + 1} အတွက် GP join ပြီးပါပြီ။`);
  }
  await bot.telegram.sendMessage(userId, "GP joined ခြင်းအကုန်အောင်မြင်ပါသည်။ 2 စက္ကန့်စောင့်ပြီး message ရေးရန် button များကို ပြပါမယ်။");
  await sleep(2000);
}

async function sendCycle(userId, accountConfigs) {
  for (let accountIndex = 0; accountIndex < accountConfigs.length; accountIndex += 1) {
    const config = accountConfigs[accountIndex];
    const account = await db.collection("accounts").findOne({ _id: config.accountId, enabled: true });
    if (!account || !clientPool.has(String(account._id))) throw new Error(`Account ${accountIndex + 1} မရနိုင်ပါ။`);
    const client = clientPool.get(String(account._id));
    for (let i = 0; i < config.targets.length; i += 1) {
      const target = config.targets[i];
      await sendWithAccount(client, target, config.messages?.[i] || "");
      await bot.telegram.sendMessage(userId, `GP${accountIndex + 1}-${i + 1} ပို့ပြီးပါပြီ။`);
      if (i < config.targets.length - 1) {
        await bot.telegram.sendMessage(userId, `GP${accountIndex + 1}-${i + 2} ပို့နေပါသည်။ 6 စက္ကန့်စောင့်ပါမယ်။`);
        await sleep(6000);
      }
    }
  }
}

function scheduleRecurringSend(userId, subscriptionId) {
  if (recurringTimers.has(String(subscriptionId))) clearTimeout(recurringTimers.get(String(subscriptionId)));
  const timer = setTimeout(async () => {
    recurringTimers.delete(String(subscriptionId));
    try {
      await expireSubscriptions();
      const subscription = await db.collection("subscriptions").findOne({ _id: subscriptionId, userId, status: "active", expiresAt: { $gt: now() } });
      if (!subscription || await isBanned(userId)) return;
      await bot.telegram.sendMessage(userId, "မိနစ် 20 ပြည့်ပါပြီ။ GP1 မှ စာပြန်ပို့နေပါပြီ။");
      await sendCycle(userId, subscription.accountConfigs || []);
      await bot.telegram.sendMessage(userId, "GP အားလုံးထပ်ပို့ပြီးပါပြီ။ မိနစ် 20 နားနေပါသည်။");
      scheduleRecurringSend(userId, subscriptionId);
    } catch (error) {
      await bot.telegram.sendMessage(userId, `Auto send မအောင်မြင်ပါ: ${error.message}`).catch(() => {});
      scheduleRecurringSend(userId, subscriptionId);
    }
  }, 20 * 60 * 1000);
  recurringTimers.set(String(subscriptionId), timer);
}

async function resumeRecurringSchedules() {
  await expireSubscriptions();
  const subscriptions = await db.collection("subscriptions").find({ status: "active", expiresAt: { $gt: now() }, accountConfigs: { $exists: true, $ne: [] } }).toArray();
  for (const subscription of subscriptions) {
    if ((subscription.accountConfigs || []).every(config => (config.messages || []).every(Boolean))) scheduleRecurringSend(subscription.userId, subscription._id);
  }
}

async function runUserJob(userId, accountConfigs) {
  if (sending) throw new Error("အခြားစာပို့မှုတစ်ခု လုပ်ဆောင်နေဆဲဖြစ်ပါတယ်။ ခဏစောင့်ပါ။");
  sending = true;
  try {
    let totalSuccess = 0;
    for (let accountIndex = 0; accountIndex < accountConfigs.length; accountIndex += 1) {
      const config = accountConfigs[accountIndex];
      const account = await db.collection("accounts").findOne({ _id: config.accountId, enabled: true });
      if (!account || !clientPool.has(String(account._id))) throw new Error(`Account ${accountIndex + 1} ချိတ်ဆက်ထားခြင်းမရှိပါ။`);
      const client = clientPool.get(String(account._id));
      await bot.telegram.sendMessage(userId, `Account ${accountIndex + 1} (${account.name}) အတွက် GP join စတင်ပါပြီ။`);
      for (let i = 0; i < config.targets.length; i += 1) {
        const target = config.targets[i];
        const entity = await joinTarget(client, target);
        await bot.telegram.sendMessage(userId, `Account ${accountIndex + 1} GP ${i + 1} join ပြီးပါပြီ။`);
        await sleep(1500);
        await sendWithAccount(client, entity || target, config.message);
        totalSuccess += 1;
        if ((i + 1) % 4 === 0 && i < config.targets.length - 1) {
          await bot.telegram.sendMessage(userId, `Account ${accountIndex + 1} GP 4 ခု join ပြီးပါပြီ။ မိနစ် 20 နားပြီးနောက် auto ဆက်လုပ်ပါမယ်။`);
          await sleep(20 * 60 * 1000);
        } else if (i < config.targets.length - 1) {
          await sleep(5000);
        }
      }
      await bot.telegram.sendMessage(userId, `Account ${accountIndex + 1} အတွက် join နှင့် စာပို့ခြင်း ပြီးပါပြီ။`);
    }
    await bot.telegram.sendMessage(userId, `အားလုံးပြီးပါပြီ။ Account ${accountConfigs.length} ခုဖြင့် စာ ${totalSuccess} ကြိမ် ပို့ပြီးပါပြီ။`);
  } finally {
    sending = false;
  }
}

const mainMenu = Markup.keyboard([["PLANS", "Balance"], ["GP", "Help"]]).resize();
const paymentMenu = Markup.inlineKeyboard([
  [Markup.button.callback("KPay ဖြင့်ငွေဖြည့်မည်", "topup:KPay")],
  [Markup.button.callback("Wave Pay ဖြင့်ငွေဖြည့်မည်", "topup:WavePay")],
]);
const planMenu = Markup.inlineKeyboard([
  [Markup.button.callback("1 Account", "plan:one")],
  [Markup.button.callback("2 Account", "plan:two")],
]);

bot.start(async ctx => {
  await ensureUser(ctx);
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  await ctx.reply(`မင်္ဂလာပါ ${nameOf(ctx)} ရေ။\nAdmin နှင့် User ခွဲခြားထားသော GP sender bot မှ ကြိုဆိုပါတယ်။`, mainMenu);
});

bot.hears("PLANS", async ctx => {
  await ensureUser(ctx);
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  await ctx.reply("အသုံးပြုမည့် account အရေအတွက်ကို ရွေးပါ။", planMenu);
});

bot.hears("Balance", async ctx => {
  const user = await ensureUser(ctx);
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  await ctx.reply(`သင့် Balance မှာ ${user.balance || 0} Ks ရှိပါတယ်။`, paymentMenu);
});

bot.action(/^topup:(KPay|WavePay)$/, async ctx => {
  await ctx.answerCbQuery();
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  const paymentState = { step: "topupAmount", method: ctx.match[1] };
  sessions.set(ctx.from.id, paymentState);
  await db.collection("users").updateOne({ telegramId: ctx.from.id }, { $set: { paymentState } }, { upsert: true });
  await ctx.reply(`${ctx.match[1]} ဖြင့် ဖြည့်မည့်ငွေအရေအတွက် ပို့ပေးပါ။ (အနည်းဆုံး 1000 Ks မှ စဖြည့်ပါ)\nဥပမာ: 1000 သို့မဟုတ် 1000 Ks`);
});

bot.action(/^topup:(confirm|cancel):([a-f0-9]{24})$/, async ctx => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;
  const topupId = new ObjectId(ctx.match[2]);
  const topup = await db.collection("topups").findOne({ _id: topupId, status: "pending" });
  if (!topup) return ctx.reply("ဒီ top-up request ကို အတည်ပြုပြီးသား သို့မဟုတ် ပယ်ဖျက်ပြီးသား ဖြစ်ပါတယ်။");
  if (ctx.match[1] === "cancel") {
    await db.collection("topups").updateOne({ _id: topupId, status: "pending" }, { $set: { status: "cancelled", cancelledAt: now(), reviewedBy: ADMIN_ID } });
    await db.collection("users").updateOne({ telegramId: topup.userId }, { $unset: { paymentState: "" } });
    await bot.telegram.sendMessage(topup.userId, `သင်တင်ထားသော ${topup.amount} Ks ${topup.method} ငွေဖြည့် request ကို Admin က cancel လုပ်လိုက်ပါပြီ။`);
    return ctx.reply(`Top-up ${topup.userId} ကို cancel လုပ်ပြီးပါပြီ။`);
  }
  const changed = await db.collection("topups").updateOne({ _id: topupId, status: "pending" }, { $set: { status: "confirmed", confirmedAt: now(), reviewedBy: ADMIN_ID } });
  if (!changed.modifiedCount) return ctx.reply("ဒီ top-up request ကို အခြားနေရာမှ ပြောင်းလဲပြီးပါပြီ။");
  await db.collection("users").updateOne({ telegramId: topup.userId }, { $inc: { balance: topup.amount }, $unset: { paymentState: "" } }, { upsert: true });
  await bot.telegram.sendMessage(topup.userId, `သင်တင်ထားသော ${topup.amount} Ks ကို Balance ထဲ ထည့်ပေးပြီးပါပြီ။`);
  await ctx.reply(`Top-up ${topup.userId} အတွက် ${topup.amount} Ks ဖြည့်ပြီးပါပြီ။`);
});

bot.on("photo", async ctx => {
  if (isAdmin(ctx)) return;
  const state = sessions.get(ctx.from.id);
  if (!state || state.step !== "topupReceipt") return;
  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  const topup = await db.collection("topups").findOne({ _id: state.topupId, userId: ctx.from.id, status: "pending" });
  if (!topup) return ctx.reply("ဒီ top-up request မရှိတော့ပါ။ Balance menu မှ ပြန်စပါ။");
  await db.collection("topups").updateOne({ _id: topup._id }, { $set: { receiptFileId: fileId, receiptReceivedAt: now() } });
  await db.collection("users").updateOne({ telegramId: ctx.from.id }, { $unset: { paymentState: "" } });
  sessions.delete(ctx.from.id);
  const caption = `Top-up request\nUser: ${ctx.from.id}\nMethod: ${topup.method}\nAmount: ${topup.amount} Ks`;
  await bot.telegram.sendPhoto(ADMIN_ID, fileId, { caption });
  await bot.telegram.sendMessage(ADMIN_ID, `Receipt ကို စစ်ပြီး Confirm သို့ Cancel ရွေးပါ။`, Markup.inlineKeyboard([
    [Markup.button.callback("Confirm", `topup:confirm:${topup._id}`), Markup.button.callback("Cancel", `topup:cancel:${topup._id}`)],
  ]));
  await ctx.reply("ပြေစာကို Admin ထံ ပို့ပြီးပါပြီ။ Admin အတည်ပြုချက်ကို စောင့်ပါ။");
});

bot.hears("GP", async ctx => {
  const targets = await db.collection("targets").find({ enabled: true }).sort({ order: 1 }).toArray();
  await ctx.reply(targets.length ? `Admin ခွင့်ပြုထားသော GP များ:\n${targets.map((t, i) => `${i + 1}. ${t.title || t.chatId}`).join("\n")}` : "Admin က authorized GP မထည့်ရသေးပါ။", mainMenu);
});

bot.hears("Help", ctx => ctx.reply("PLANS ကိုနှိပ်ပြီး plan ရွေးပါ။ ထို့နောက် ပို့မည့် GP link များကို comma (,) ခံပြီး ပို့ကာ စာသားပို့ပါ။", mainMenu));

bot.action(/^plan:(one|two)$/, async ctx => {
  await ctx.answerCbQuery();
  const planKey = ctx.match[1];
  await ensureUser(ctx);
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  const existing = await activeSubscription(ctx.from.id);
  if (existing) return ctx.reply("သင့်မှာ active plan ရှိပြီးသားပါ။ လက်ရှိသက်တမ်းကုန်မှ ထပ်ဝယ်ပါ။");
  const plan = plans[planKey];
  await ctx.reply("အသုံးပြုမည့်အချိန်ကာလကို ရွေးပါ။", Markup.inlineKeyboard([
    [Markup.button.callback(plan.durations.d1.label, `duration:${planKey}:d1`)],
    [Markup.button.callback(plan.durations.d2.label, `duration:${planKey}:d2`)],
    [Markup.button.callback(plan.durations.w1.label, `duration:${planKey}:w1`)],
  ]));
});

bot.action(/^duration:(one|two):(d1|d2|w1)$/, async ctx => {
  await ctx.answerCbQuery();
  const planKey = ctx.match[1];
  const duration = plans[planKey].durations[ctx.match[2]];
  const user = await ensureUser(ctx);
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  const existing = await activeSubscription(ctx.from.id);
  if (existing) return ctx.reply("သင့်မှာ active plan ရှိပြီးသားပါ။ လက်ရှိသက်တမ်းကုန်မှ ထပ်ဝယ်ပါ။");
  if ((user.balance || 0) < duration.price) return ctx.reply(`Balance မလုံလောက်ပါ။ ${duration.label} အတွက် ${duration.price} Ks လိုအပ်ပါတယ်။`);
  await db.collection("users").updateOne({ telegramId: ctx.from.id }, { $inc: { balance: -duration.price } });
  const expiresAt = new Date(Date.now() + duration.days * 24 * 60 * 60 * 1000);
  const subscription = { userId: ctx.from.id, plan: planKey, durationKey: ctx.match[2], accountCount: plans[planKey].accounts, price: duration.price, startedAt: now(), expiresAt, status: "active", accountConfigs: [], message: "" };
  const result = await db.collection("subscriptions").insertOne(subscription);
  const reserved = await acquireAccounts(ctx.from.id, result.insertedId, plans[planKey].accounts, expiresAt);
  if (reserved.length < plans[planKey].accounts) {
    await releaseAccounts(result.insertedId);
    await db.collection("subscriptions").updateOne({ _id: result.insertedId }, { $set: { status: "cancelled", cancelledAt: now(), cancelReason: "no_free_accounts" } });
    await db.collection("users").updateOne({ telegramId: ctx.from.id }, { $inc: { balance: duration.price } });
    return ctx.reply("လက်ရှိမှာ အသုံးပြုနေသော account များဖြစ်နေသောကြောင့် account ပစ္စည်း မအားသေးပါ။ လွတ်သော account ရရှိမှ ပြန်ဝယ်ပါ။");
  }
  sessions.set(ctx.from.id, { step: "gpCount", accountIndex: 0, accountCount: plans[planKey].accounts, accountIds: reserved.map(account => account._id), accountConfigs: [], subscriptionId: result.insertedId });
  await ctx.reply(`${duration.label} ဝယ်ပြီးပါပြီ။\n\nပို့မည့် GP အရေအတွက် ပို့ပေးပါ။ (အနည်းဆုံး 1 မှ အများဆုံး 8)`);
});

bot.command("ban", adminOnly, async ctx => {
  const [, userId, ...reasonParts] = ctx.message.text.trim().split(/\s+/);
  if (!userId || !/^\d+$/.test(userId)) return ctx.reply("အသုံးပြုပုံ: /ban USER_ID reason");
  await db.collection("users").updateOne({ telegramId: Number(userId) }, { $set: { telegramId: Number(userId), banned: true, banReason: reasonParts.join(" ") || "Admin ban", bannedAt: now() } }, { upsert: true });
  const active = await db.collection("subscriptions").find({ userId: Number(userId), status: "active" }).toArray();
  for (const sub of active) {
    await db.collection("subscriptions").updateOne({ _id: sub._id }, { $set: { status: "cancelled", cancelledAt: now(), cancelReason: "banned" } });
    await releaseAccounts(sub._id);
  }
  await ctx.reply(`User ${userId} ကို ban လုပ်ပြီး active plan/account အသုံးပြုခွင့်ကို ရပ်လိုက်ပါပြီ။`);
});

bot.command("unban", adminOnly, async ctx => {
  const [, userId] = ctx.message.text.trim().split(/\s+/);
  if (!userId || !/^\d+$/.test(userId)) return ctx.reply("အသုံးပြုပုံ: /unban USER_ID");
  await db.collection("users").updateOne({ telegramId: Number(userId) }, { $set: { banned: false, unbannedAt: now() } });
  await ctx.reply(`User ${userId} ကို unban လုပ်ပြီးပါပြီ။`);
});

bot.command("totalusers", adminOnly, async ctx => {
  const [total, banned, activePlans] = await Promise.all([
    db.collection("users").countDocuments(),
    db.collection("users").countDocuments({ banned: true }),
    db.collection("subscriptions").countDocuments({ status: "active", expiresAt: { $gt: now() } }),
  ]);
  await ctx.reply(`Total users: ${total}\nBanned users: ${banned}\nActive plan users: ${activePlans}`);
});

bot.command("planusers", adminOnly, async ctx => {
  await expireSubscriptions();
  const subscriptions = await db.collection("subscriptions").find({ status: "active", expiresAt: { $gt: now() } }).sort({ startedAt: 1 }).toArray();
  if (!subscriptions.length) return ctx.reply("လက်ရှိ active plan user မရှိသေးပါ။");
  const lines = [];
  for (const sub of subscriptions) {
    const user = await db.collection("users").findOne({ telegramId: sub.userId });
    const accountIds = (sub.accountConfigs || []).map(config => config.accountId).filter(Boolean);
    const accountDocs = await db.collection("accounts").find({ _id: { $in: accountIds } }).toArray();
    const accountNames = (sub.accountConfigs || []).map((config, index) => {
      const account = accountDocs.find(doc => String(doc._id) === String(config.accountId));
      const links = (config.targets || []).map(target => target.inviteLink).join(", ");
      return `${account?.name || `Account${index + 1}`} [${links || "GP မပြင်ဆင်ရသေး"}]`;
    }).join(" | ") || "မပြင်ဆင်ရသေး";
    lines.push(`${sub.userId} ${user?.username ? `@${user.username}` : ""} | ${sub.plan} | expire ${sub.expiresAt.toISOString()} | ${accountNames}`);
  }
  await ctx.reply(`Active plan users (${lines.length}):\n\n${lines.join("\n")}`);
});

bot.command("userplans", adminOnly, async ctx => {
  const [, userId] = ctx.message.text.trim().split(/\s+/);
  if (!userId || !/^\d+$/.test(userId)) return ctx.reply("အသုံးပြုပုံ: /userplans USER_ID");
  const subscriptions = await db.collection("subscriptions").find({ userId: Number(userId) }).sort({ startedAt: -1 }).limit(10).toArray();
  if (!subscriptions.length) return ctx.reply("ဒီ User အတွက် plan မတွေ့ပါ။");
  await ctx.reply(subscriptions.map(sub => `${sub.status} | ${sub.plan} | ${sub.price} Ks | expire ${sub.expiresAt?.toISOString?.() || "-"}`).join("\n"));
});

bot.command("useraccounts", adminOnly, async ctx => {
  const [, userId] = ctx.message.text.trim().split(/\s+/);
  if (!userId || !/^\d+$/.test(userId)) return ctx.reply("အသုံးပြုပုံ: /useraccounts USER_ID");
  const accounts = await db.collection("accounts").find({ "lease.userId": Number(userId) }).toArray();
  const subscriptions = await db.collection("subscriptions").find({ userId: Number(userId) }).sort({ startedAt: -1 }).limit(1).toArray();
  if (!accounts.length && !subscriptions.length) return ctx.reply("ဒီ User ထံတွင် account/plan မရှိပါ။");
  const lines = accounts.map(account => `${account.name} | lease expire ${account.lease?.expiresAt?.toISOString?.() || "-"}`);
  const latest = subscriptions[0];
  for (const config of latest?.accountConfigs || []) lines.push(`GP links: ${(config.targets || []).map(target => target.inviteLink).join(", ") || "မရှိသေး"}`);
  await ctx.reply(lines.join("\n") || "GP link မပြင်ဆင်ရသေးပါ။");
});

bot.command("setpayment", adminOnly, async ctx => {
  const [, rawMethod, phone, ...nameParts] = ctx.message.text.trim().split(/\s+/);
  const method = rawMethod?.toLowerCase() === "kpay" ? "kpay" : rawMethod?.toLowerCase() === "wavepay" ? "wavepay" : null;
  if (!method || !phone || !nameParts.length) return ctx.reply("အသုံးပြုပုံ: /setpayment KPay 09xxxxxx AccountName");
  await savePayment(method, phone, nameParts.join(" "));
  await ctx.reply(`${method === "kpay" ? "KPay" : "Wave Pay"} payment account သိမ်းပြီးပါပြီ။`);
});

bot.command("paymentinfo", adminOnly, async ctx => {
  const settings = await getPaymentSettings();
  await ctx.reply(`KPay: ${settings.kpayPhone || "မထည့်ရသေး"} | ${settings.kpayName || "-"}\nWave Pay: ${settings.wavepayPhone || "မထည့်ရသေး"} | ${settings.wavepayName || "-"}`);
});

bot.command("credit", adminOnly, async ctx => {
  const [, userId, amount] = ctx.message.text.trim().split(/\s+/);
  if (!userId || !Number.isFinite(Number(amount)) || Number(amount) <= 0) return ctx.reply("အသုံးပြုပုံ: /credit USER_ID AMOUNT");
  await db.collection("users").updateOne({ telegramId: Number(userId) }, { $inc: { balance: Number(amount) } }, { upsert: true });
  await ctx.reply("Balance ဖြည့်ပြီးပါပြီ။");
});

bot.command("addtarget", adminOnly, async ctx => {
  const [, chatId, ...titleParts] = ctx.message.text.trim().split(/\s+/);
  if (!chatId) return ctx.reply("အသုံးပြုပုံ: /addtarget @channel_or_chat_id Title");
  await db.collection("targets").updateOne({ chatId }, { $set: { chatId, username: chatId.startsWith("@") ? chatId : null, title: titleParts.join(" ") || chatId, enabled: true, order: Date.now(), addedAt: now() } }, { upsert: true });
  await ctx.reply("Authorized target ထည့်ပြီးပါပြီ။ User များသည် ဒီ target များထဲမှသာ ရွေးနိုင်ပါမည်။");
});

bot.command("removetarget", adminOnly, async ctx => {
  const [, chatId] = ctx.message.text.trim().split(/\s+/);
  if (!chatId) return ctx.reply("အသုံးပြုပုံ: /removetarget @channel_or_chat_id");
  await db.collection("targets").updateOne({ chatId }, { $set: { enabled: false } });
  await ctx.reply("Authorized target ပိတ်ပြီးပါပြီ။");
});

const pendingAccount = new Map();

bot.on("document", async (ctx, next) => {
  if (isAdmin(ctx)) return next();
  const state = sessions.get(ctx.from.id);
  if (!state || state.step !== "topupReceipt") return next();
  const fileId = ctx.message.document.file_id;
  const topup = await db.collection("topups").findOne({ _id: state.topupId, userId: ctx.from.id, status: "pending" });
  if (!topup) return ctx.reply("ဒီ top-up request မရှိတော့ပါ။ Balance menu မှ ပြန်စပါ။");
  await db.collection("topups").updateOne({ _id: topup._id }, { $set: { receiptFileId: fileId, receiptReceivedAt: now() } });
  await db.collection("users").updateOne({ telegramId: ctx.from.id }, { $unset: { paymentState: "" } });
  sessions.delete(ctx.from.id);
  await bot.telegram.sendDocument(ADMIN_ID, fileId, { caption: `Top-up request | User: ${ctx.from.id} | Method: ${topup.method} | Amount: ${topup.amount} Ks` });
  await bot.telegram.sendMessage(ADMIN_ID, "Receipt ကိုစစ်ပြီး Confirm သို့ Cancel ရွေးပါ။", Markup.inlineKeyboard([[Markup.button.callback("Confirm", `topup:confirm:${topup._id}`), Markup.button.callback("Cancel", `topup:cancel:${topup._id}`)]]));
  return ctx.reply("ပြေစာကို Admin ထံ ပို့ပြီးပါပြီ။ Admin အတည်ပြုချက်ကို စောင့်ပါ။");
});

bot.command("addaccount", adminOnly, async ctx => {
  const name = ctx.message.text.slice("/addaccount".length).trim();
  if (!name) return ctx.reply("အသုံးပြုပုံ: /addaccount acc1");
  pendingAccount.set(ADMIN_ID, name);
  await ctx.reply(`acc1 အစား သတ်မှတ်ထားသော account name: ${name}\nယခု Telegram session ကို .txt file အဖြစ် upload လုပ်ပါ သို့မဟုတ် session string ကို ရိုးရိုး text အဖြစ် ပို့ပါ။`);
});

bot.on("document", adminOnly, async ctx => {
  const name = pendingAccount.get(ADMIN_ID);
  if (!name) return ctx.reply("/addaccount acc1 ကို အရင်အသုံးပြုပါ။");
  try {
    const sessionString = await getSessionFile(ctx, ctx.message.document.file_id);
    await ctx.reply(`${name} ကို connect လုပ်နေပါတယ်...`);
    await connectAccount(name, sessionString);
    pendingAccount.delete(ADMIN_ID);
    await ctx.reply(`${name} connected ဖြစ်ပါပြီ။`);
  } catch (error) {
    await ctx.reply(`Connect မအောင်မြင်ပါ: ${error.message}`);
  }
});

bot.command("accounts", adminOnly, async ctx => {
  const accounts = await loadAccounts();
  await ctx.reply(accounts.length ? accounts.map((a, i) => `${i + 1}. ${a.name} — ${clientPool.has(String(a._id)) ? "Connected" : "Disconnected"}`).join("\n") : "Account မရှိသေးပါ။");
});

bot.command("status", adminOnly, async ctx => {
  const accounts = await loadAccounts();
  await ctx.reply(`Accounts: ${accounts.length}\nConnected: ${accounts.filter(a => clientPool.has(String(a._id))).length}\nSending: ${sending ? "Yes" : "No"}`);
});

bot.action(/^message:(\d+):(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  const state = sessions.get(ctx.from.id);
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  if (!state || state.step !== "messagePick") return ctx.reply("ဒီ message setup session မရှိတော့ပါ။");
  const accountIndex = Number(ctx.match[1]);
  const gpIndex = Number(ctx.match[2]);
  if (!state.accountConfigs[accountIndex]?.targets[gpIndex]) return ctx.reply("GP မတွေ့ပါ။");
  sessions.set(ctx.from.id, { ...state, step: "messageInput", accountIndex, gpIndex });
  await ctx.reply(`GP${accountIndex + 1}-${gpIndex + 1} အတွက် စာသားရေးပို့ပါ။`);
});

bot.action("send:all", async ctx => {
  await ctx.answerCbQuery();
  const state = sessions.get(ctx.from.id);
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  if (!state || !state.accountConfigs?.length || state.remainingMessages > 0) return ctx.reply("GP အားလုံးအတွက် စာသား မပြည့်သေးပါ။");
  sessions.delete(ctx.from.id);
  await ctx.reply("စာသားပို့ခြင်း စတင်ပါပြီ။ GP တစ်ခုနှင့်တစ်ခုကြား 6 စက္ကန့်နားပါမယ်။");
  try {
    await sendCycle(ctx.from.id, state.accountConfigs);
    await db.collection("subscriptions").updateOne({ _id: state.subscriptionId }, { $set: { accountConfigs: state.accountConfigs, nextSendAt: new Date(Date.now() + 20 * 60 * 1000) } });
    await ctx.reply("GP အားလုံးပို့ပြီးပါပြီ။ မိနစ် 20 နားနေပါသည်။ ပြီးလျှင် GP1 မှ auto ပြန်ပို့ပါမယ်။");
    scheduleRecurringSend(ctx.from.id, state.subscriptionId);
  } catch (error) {
    await ctx.reply(`စာပို့ခြင်း မအောင်မြင်ပါ: ${error.message}`);
  }
});

bot.on("text", async ctx => {
  if (ctx.message.text.startsWith("/")) return;
  if (isAdmin(ctx) && pendingAccount.has(ADMIN_ID)) {
    const name = pendingAccount.get(ADMIN_ID);
    try {
      await ctx.reply(`${name} ကို connect လုပ်နေပါတယ်...`);
      await connectAccount(name, ctx.message.text);
      pendingAccount.delete(ADMIN_ID);
      return ctx.reply(`${name} connected ဖြစ်ပါပြီ။`);
    } catch (error) {
      return ctx.reply(`Connect မအောင်မြင်ပါ: ${error.message}`);
    }
  }
  let state = sessions.get(ctx.from.id);
  if (!state) {
    const savedUser = await db.collection("users").findOne({ telegramId: ctx.from.id }, { projection: { paymentState: 1 } });
    state = savedUser?.paymentState || null;
    if (state) sessions.set(ctx.from.id, state);
  }
  if (!state) return;
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  if (state.step === "topupAmount") {
    const amount = parseAmount(ctx.message.text);
    if (!Number.isInteger(amount) || amount < 1000) return ctx.reply("အနည်းဆုံး 1000 Ks ကစပြီး ဖြည့်ပေးပါ။");
    const settings = await getPaymentSettings();
    const phone = state.method === "KPay" ? settings.kpayPhone : settings.wavepayPhone;
    const accountName = state.method === "KPay" ? settings.kpayName : settings.wavepayName;
    if (!phone || !accountName) {
      sessions.delete(ctx.from.id);
      await db.collection("users").updateOne({ telegramId: ctx.from.id }, { $unset: { paymentState: "" } });
      return ctx.reply(`${state.method} payment account ကို Admin က မထည့်ရသေးပါ။`);
    }
    const existingTopup = await db.collection("topups").findOne({ userId: ctx.from.id, status: "pending" });
    if (existingTopup) return ctx.reply("ယခင် top-up request ကို Admin အတည်ပြုရန် စောင့်ပါ။");
    const result = await db.collection("topups").insertOne({ userId: ctx.from.id, method: state.method, amount, status: "pending", createdAt: now() });
    const receiptState = { step: "topupReceipt", topupId: result.insertedId };
    sessions.set(ctx.from.id, receiptState);
    await db.collection("users").updateOne({ telegramId: ctx.from.id }, { $set: { paymentState: receiptState } });
    return ctx.reply(`${amount} Ks top-up request တင်ပြီးပါပြီ။\n\nယခု အကောင့်ကို ငွေလွှဲပါ။ ထို့နောက် ပြေစာပို့ပါ။\n\n${state.method}-${phone}\nName-${accountName}`);
  }
  if (state.step === "topupReceipt") return ctx.reply("ငွေလွှဲပြီးသော ပြေစာ screenshot/photo သို့မဟုတ် .jpg/.png file ကို ပို့ပါ။");
  await expireSubscriptions();
  const subscription = await db.collection("subscriptions").findOne({ _id: state.subscriptionId, userId: ctx.from.id, status: "active", expiresAt: { $gt: now() } });
  if (!subscription) { sessions.delete(ctx.from.id); return ctx.reply("Active plan မရှိတော့ပါ။", mainMenu); }
  if (state.step === "gpCount") {
    const count = Number(ctx.message.text.trim());
    if (!Number.isInteger(count) || count < 1 || count > 8) return ctx.reply("အနည်းဆုံး 1 မှ အများဆုံး 8 ထိပဲ ရေးပေးပါ။");
    sessions.set(ctx.from.id, { ...state, step: "accountTargets", gpCount: count, currentCount: 0 });
    return ctx.reply(`စာပို့မည့် public GP link များ ပို့ပေးပါ။\nအနည်းဆုံး 1 ခုမှ အများဆုံး ${count} ခု ပို့ပါ။\nComma (,) ခံပြီး ပို့ပါ။\nဥပမာ: https://t.me/sellingggp,https://t.me/sellingmyanmargp`);
  }
  if (state.step === "accountTargets") {
    const links = ctx.message.text.split(",").map(value => value.trim()).filter(Boolean);
    if (links.length !== state.gpCount) return ctx.reply(`GP link ${state.gpCount} ခုတိတိ ပို့ပါ။ User account link မဟုတ်ဘဲ public GP link သာ ပို့ရပါမယ်။`);
    if (!links.every(isPublicGpLink)) return ctx.reply("Public GP link သာ ပို့ရပါမယ်။ User account link မပို့ရပါ။ ဥပမာ https://t.me/example");
    const targets = targetsFromUserLinks(links);
    const accountConfigs = [...state.accountConfigs, { accountId: state.accountIds[state.accountIndex], targets, messages: Array(targets.length).fill("") }];
    if (state.accountIndex + 1 < state.accountCount) {
      const nextIndex = state.accountIndex + 1;
      sessions.set(ctx.from.id, { ...state, step: "accountTargets", accountIndex: nextIndex, accountConfigs, gpCount: state.gpCount });
      return ctx.reply(`Account ${state.accountIndex + 1} GP link များ ရပါပြီ။ ယခု Account ${nextIndex + 1} အတွက် public GP link များ ပို့ပါ။`);
    }
    await ctx.reply("GP link အားလုံးရပါပြီ။ Account များဖြင့် GP join စတင်ပါမယ်။");
    try {
      await joinConfiguredTargets(ctx.from.id, accountConfigs);
      const totalMessages = accountConfigs.reduce((sum, config) => sum + config.targets.length, 0);
      sessions.set(ctx.from.id, { step: "messagePick", accountConfigs, subscriptionId: subscription._id, remainingMessages: totalMessages });
      await ctx.reply("ပို့မည့် message များ ပို့ပေးပါ။", messageKeyboard(accountConfigs));
    } catch (error) {
      await ctx.reply(`GP join flow မအောင်မြင်ပါ: ${error.message}`);
    }
    return;
  }
  if (state.step === "messageInput") {
    const config = state.accountConfigs[state.accountIndex];
    config.messages[state.gpIndex] = ctx.message.text;
    const remainingMessages = state.remainingMessages - 1;
    const nextState = { ...state, step: "messagePick", remainingMessages };
    sessions.set(ctx.from.id, nextState);
    if (remainingMessages > 0) return ctx.reply(`GP${state.accountIndex + 1}-${state.gpIndex + 1} စာသားသိမ်းပြီးပါပြီ။ ကျန် GP ${remainingMessages} ခုအတွက် button များကို ဆက်နှိပ်ပါ။`, messageKeyboard(nextState.accountConfigs));
    return ctx.reply("ရွေးထားသော GP အားလုံးအတွက် စာသားရေးပြီးပါပြီ။ Send စာသားကိုနှိပ်ပါ။", Markup.inlineKeyboard([[Markup.button.callback("Send စာသား", "send:all")]]));
  }
});

async function main() {
  await mongo.connect();
  db = mongo.db(DB_NAME);
  await db.collection("users").createIndex({ telegramId: 1 }, { unique: true });
  await db.collection("accounts").createIndex({ name: 1 }, { unique: true });
  await db.collection("targets").createIndex({ chatId: 1 }, { unique: true });
  http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("Telegram Bot is running"); }).listen(PORT, "0.0.0.0");
  await connectStoredAccounts();
  setInterval(() => expireSubscriptions().catch(error => console.error("Expiry cleanup error:", error)), 60 * 1000);
  await expireSubscriptions();
  await bot.launch({ dropPendingUpdates: true });
  await resumeRecurringSchedules();
  console.log("Merged Telegram bot started");
}

main().catch(error => { console.error(error); process.exit(1); });
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
