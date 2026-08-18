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
const MAX_ACTIVE_USERS = 10;
const CAPACITY_NOTICE_DELAY_MS = 3 * 60 * 60 * 1000;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!MONGO_URI) throw new Error("MONGO_URI or MONGODB_URI is missing");
if (!ADMIN_ID) throw new Error("ADMIN_ID is missing");
if (!API_ID || !API_HASH) throw new Error("API_ID and API_HASH are required for account sessions");

const bot = new Telegraf(BOT_TOKEN);

function isChatUnavailableError(error) {
  const code = error?.response?.error_code || error?.code;
  const description = String(error?.response?.description || error?.description || error?.message || "").toLowerCase();
  return Number(code) === 403 || description.includes("bot was blocked by the user") || description.includes("user is deactivated") || description.includes("chat not found");
}

async function markChatUnavailable(chatId, error) {
  if (!db || !chatId || !isChatUnavailableError(error)) return;
  await db.collection("users").updateOne({ telegramId: Number(chatId) }, { $set: { botBlocked: true, botBlockedAt: now(), botBlockedReason: String(error?.response?.description || error?.message || "chat unavailable") } }).catch(() => {});
  sessions.delete(Number(chatId));
}

function installSafeTelegramMethods() {
  const originalSendMessage = bot.telegram.sendMessage.bind(bot.telegram);
  bot.telegram.sendMessage = async (chatId, ...args) => {
    try { return await originalSendMessage(chatId, ...args); }
    catch (error) { await markChatUnavailable(chatId, error); console.warn(`Telegram sendMessage skipped for ${chatId}: ${error.message}`); return null; }
  };
  const originalSendPhoto = bot.telegram.sendPhoto.bind(bot.telegram);
  bot.telegram.sendPhoto = async (chatId, ...args) => {
    try { return await originalSendPhoto(chatId, ...args); }
    catch (error) { await markChatUnavailable(chatId, error); console.warn(`Telegram sendPhoto skipped for ${chatId}: ${error.message}`); return null; }
  };
  const originalSendDocument = bot.telegram.sendDocument.bind(bot.telegram);
  bot.telegram.sendDocument = async (chatId, ...args) => {
    try { return await originalSendDocument(chatId, ...args); }
    catch (error) { await markChatUnavailable(chatId, error); console.warn(`Telegram sendDocument skipped for ${chatId}: ${error.message}`); return null; }
  };
}

bot.catch((error, ctx) => {
  console.error("Telegraf update error:", error?.stack || error);
  if (ctx?.chat?.id && isChatUnavailableError(error)) markChatUnavailable(ctx.chat.id, error).catch(() => {});
});

process.on("unhandledRejection", error => console.error("Unhandled promise rejection:", error?.stack || error));
process.on("uncaughtException", error => console.error("Uncaught exception captured:", error?.stack || error));

installSafeTelegramMethods();
const mongo = new MongoClient(MONGO_URI);
let db;
const sessions = new Map();
const clientPool = new Map();
let sending = false;
let sendIntervalMinutes = 20;
const recurringTimers = new Map();
const joinTimers = new Map();
let capacityNoticeTimer;


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

function normalizePlanKey(value) {
  const raw = String(value || "").toLowerCase();
  return raw === "1" || raw === "one" ? "one" : raw === "2" || raw === "two" ? "two" : null;
}

function normalizeDurationKey(value) {
  const raw = String(value || "").toLowerCase();
  return raw === "d1" || raw === "1day" || raw === "1d" ? "d1" : raw === "d2" || raw === "2day" || raw === "2d" ? "d2" : raw === "w1" || raw === "1week" || raw === "week" ? "w1" : null;
}

function applyPlanPrice(planKey, durationKey, price) {
  const duration = plans[planKey]?.durations?.[durationKey];
  if (!duration) return;
  duration.price = price;
  const label = durationKey === "d1" ? "1 Day" : durationKey === "d2" ? "2 Day" : "1 Week";
  duration.label = `${label} (${price} Ks)`;
}

async function loadPlanPrices() {
  const settings = await db.collection("settings").findOne({ _id: "planPrices" });
  for (const planKey of ["one", "two"]) for (const durationKey of ["d1", "d2", "w1"]) {
    const price = Number(settings?.[`${planKey}_${durationKey}`]);
    if (Number.isInteger(price) && price >= 1) applyPlanPrice(planKey, durationKey, price);
  }
}

function now() { return new Date(); }
function isAdmin(ctx) { return Boolean(ctx.from && ctx.from.id === ADMIN_ID); }
function nameOf(ctx) { return ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name || "User"); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function parseAmount(value) {
  const normalized = String(value || "").trim();
  if (!/^\d+(?:\s*(?:ks|ကျပ်))?$/i.test(normalized)) return NaN;
  return Number(normalized.replace(/\s*(?:ks|ကျပ်)\s*$/i, ""));
}
function adminOnly(ctx, next) { if (isAdmin(ctx)) return next(); }

const ADMIN_HELP = `Admin command အသုံးပြုနည်း

Account:
/addaccount acc1 — session file/text ထည့်ပြီး account ချိတ်ရန်
/replaceaccount acc1 — account session အစားထိုးရန်
/removeaccount acc1 — account ဖြုတ်ရန်
/accounts — account စာရင်း၊ connection နှင့် lease User ကြည့်ရန်
/accountstatus — account တစ်ခုချင်း connection/lease/expiry အပြည့်အစုံကြည့်ရန်
/status — bot/account status ကြည့်ရန်
/capacity — active plan count၊ free slots နှင့် ပြည့်ရန်လိုသော User count ကြည့်ရန်
/capacitystatus — capacity အတိုချုပ်ကြည့်ရန်

User/Plan:
/credit USER_ID AMOUNT — User balance ဖြည့်ရန်
/ban USER_ID reason — User ban လုပ်ရန်
/unban USER_ID — User ပြန်ဖွင့်ရန်
/stop plan USER_ID — User plan ချက်ချင်းရပ်ရန်
/stopplan USER_ID — User plan ချက်ချင်းရပ်ရန်
/totalusers — User အရေအတွက် စစ်ရန်
/planusers — Active plan User များကြည့်ရန်
/userplans USER_ID — User plan စစ်ရန်
/useraccounts USER_ID — User သုံးနေသော account/GP စစ်ရန်
/setprice PLAN DURATION PRICE — plan price ပြင်ရန် (ဥပမာ /setprice 1 d1 1200)
/prices — လက်ရှိ plan prices ကြည့်ရန်

Payment:
/setpayment KPay PHONE NAME — KPay payment account ထည့်ရန်
/setpayment WavePay PHONE NAME — Wave Pay payment account ထည့်ရန်
/paymentinfo — Payment setting စစ်ရန်

System:
/setinterval MINUTES — GP message interval ပြောင်းရန်
/interval — လက်ရှိ interval စစ်ရန်
/setfullbot @test_bot — Capacity ပြည့်လျှင် User ကိုပြမည့် bot link သတ်မှတ်ရန်
/fullbot — လက်ရှိ redirect bot စစ်ရန်
/addtarget @channel_or_chat_id Title — Target ထည့်ရန်
/removetarget @channel_or_chat_id — Target ဖြုတ်ရန်

BOT_TOKEN၊ API_HASH၊ session string နှင့် MONGO_URI များကို command message သို့မဟုတ် log ထဲ မထည့်ပါနှင့်။`;

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

async function activePlanUserCount() {
  return db.collection("subscriptions").countDocuments({ status: "active", expiresAt: { $gt: now() } });
}

async function ensureCapacitySlots() {
  const slots = Array.from({ length: MAX_ACTIVE_USERS }, (_, index) => ({ _id: index + 1, createdAt: now() }));
  await db.collection("capacitySlots").bulkWrite(slots.map(slot => ({ updateOne: { filter: { _id: slot._id }, update: { $setOnInsert: slot }, upsert: true } })));
}

async function acquirePurchaseLock(userId) {
  const lock = await db.collection("users").findOneAndUpdate(
    { telegramId: Number(userId), $or: [{ purchaseLockUntil: { $exists: false } }, { purchaseLockUntil: { $lte: now() } }] },
    { $set: { purchaseLockUntil: new Date(Date.now() + 120000) } },
    { returnDocument: "after" },
  );
  return Boolean(lock);
}

async function releasePurchaseLock(userId) {
  await db.collection("users").updateOne({ telegramId: Number(userId) }, { $unset: { purchaseLockUntil: "" } });
}

async function capacityFullForNewUser(userId) {
  await expireSubscriptions();
  const ownActive = await db.collection("subscriptions").findOne({ userId: Number(userId), status: "active", expiresAt: { $gt: now() } });
  if (ownActive) return false;
  return (await activePlanUserCount()) >= MAX_ACTIVE_USERS;
}

async function getFullBotLink() {
  const settings = await db.collection("settings").findOne({ _id: "runtime" });
  return settings?.fullBotLink || "";
}

async function capacityFullMessage() {
  const link = await getFullBotLink();
  return `ယခုလက်ရှိတွင် သုံးစွဲသူ ပြည့်နေပါသဖြင့် bot အသစ်တွင် plan ဝယ်ယူပါ။\nbot link - ${link || "Admin က link မထည့်ရသေးပါ"}`;
}

async function acquireCapacitySlot(userId, subscriptionId, expiresAt) {
  const slot = await db.collection("capacitySlots").findOneAndUpdate(
    { $or: [{ lease: { $exists: false } }, { "lease.expiresAt": { $lte: now() } }] },
    { $set: { lease: { userId: Number(userId), subscriptionId, expiresAt, claimedAt: now() } } },
    { sort: { _id: 1 }, returnDocument: "after" },
  );
  return slot || null;
}

async function releaseCapacity(subscriptionId) {
  await db.collection("capacitySlots").updateMany({ "lease.subscriptionId": subscriptionId }, { $unset: { lease: "" } });
}

async function notifyAdminCapacityRelease(reason = "capacity_release") {
  const active = await activePlanUserCount();
  const free = Math.max(0, MAX_ACTIVE_USERS - active);
  if (free <= 0) return;
  await bot.telegram.sendMessage(ADMIN_ID, `Plan နေရာလွတ်လာပါပြီ။\nလက်ရှိ active plan User: ${active}/${MAX_ACTIVE_USERS}\nလွတ်နေသော plan: ${free}\nပြည့်ရန် User ${free} ယောက်လိုပါသေးသည်။\nအကြောင်းပြချက်: ${reason}`).catch(() => {});
}

async function scheduleCapacityNotice() {
  const existing = await db.collection("capacityNotices").findOne({ status: "pending" });
  if (existing) return;
  await db.collection("capacityNotices").insertOne({ status: "pending", runAt: new Date(Date.now() + CAPACITY_NOTICE_DELAY_MS), createdAt: now() });
}

async function processCapacityNotices() {
  const notice = await db.collection("capacityNotices").findOne({ status: "pending", runAt: { $lte: now() } });
  if (!notice) return;
  const activeCount = await activePlanUserCount();
  if (activeCount >= MAX_ACTIVE_USERS) {
    await db.collection("capacityNotices").updateOne({ _id: notice._id, status: "pending" }, { $set: { status: "skipped", skippedAt: now() } });
    return;
  }
  const users = await db.collection("users").find({ banned: { $ne: true }, botBlocked: { $ne: true } }).toArray();
  const message = `ယခုတွင် plan ${MAX_ACTIVE_USERS - activeCount} နေရာ လွတ်နေပါသဖြင့် plan ဝယ်ယူနိုင်ပါတယ်။`;
  for (const user of users) {
    const active = await db.collection("subscriptions").findOne({ userId: user.telegramId, status: "active", expiresAt: { $gt: now() } });
    if (!active) await bot.telegram.sendMessage(user.telegramId, message).catch(() => {});
  }
  await db.collection("capacityNotices").updateOne({ _id: notice._id, status: "pending" }, { $set: { status: "sent", sentAt: now(), activeCount } });
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
    await releaseCapacity(subscription._id);
    await notifyAdminCapacityRelease("plan_expired");
    await scheduleCapacityNotice();
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

async function stopUserPlans(userId, reason = "admin_stop") {
  const subscriptions = await db.collection("subscriptions").find({ userId: Number(userId), status: "active" }).toArray();
  for (const subscription of subscriptions) {
    await db.collection("subscriptions").updateOne(
      { _id: subscription._id, status: "active" },
      { $set: { status: "stopped", stoppedAt: now(), stopReason: reason } },
    );
    await releaseAccounts(subscription._id);
    await releaseCapacity(subscription._id);
    await notifyAdminCapacityRelease(reason);
    await scheduleCapacityNotice();
    const recurringKey = String(subscription._id);
    if (recurringTimers.has(recurringKey)) {
      clearTimeout(recurringTimers.get(recurringKey));
      recurringTimers.delete(recurringKey);
    }
    const jobs = await db.collection("joinJobs").find({ subscriptionId: subscription._id, status: { $in: ["running", "waiting"] } }).toArray();
    for (const job of jobs) {
      await db.collection("joinJobs").updateOne({ _id: job._id, status: { $in: ["running", "waiting"] } }, { $set: { status: "stopped", stoppedAt: now(), stopReason: reason } });
      const joinKey = String(job._id);
      if (joinTimers.has(joinKey)) {
        clearTimeout(joinTimers.get(joinKey));
        joinTimers.delete(joinKey);
      }
    }
  }
  sessions.delete(Number(userId));
  return subscriptions.length;
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

function editGpKeyboard(subscription) {
  const rows = [];
  for (let accountIndex = 0; accountIndex < (subscription.accountConfigs || []).length; accountIndex += 1) {
    const config = subscription.accountConfigs[accountIndex];
    for (let targetIndex = 0; targetIndex < (config.targets || []).length; targetIndex += 1) {
      rows.push([Markup.button.callback(`Account ${accountIndex + 1} GP${targetIndex + 1} Edit GP link`, `editlink:${subscription._id}:${accountIndex}:${targetIndex}`)]);
    }
  }
  return Markup.inlineKeyboard(rows);
}

function messageEditKeyboard(subscription) {
  const rows = [];
  for (let accountIndex = 0; accountIndex < (subscription.accountConfigs || []).length; accountIndex += 1) {
    const config = subscription.accountConfigs[accountIndex];
    for (let targetIndex = 0; targetIndex < (config.targets || []).length; targetIndex += 1) {
      rows.push([Markup.button.callback(`Account ${accountIndex + 1} GP${targetIndex + 1} Msg edit`, `msgedit:${subscription._id}:${accountIndex}:${targetIndex}`)]);
    }
  }
  return Markup.inlineKeyboard(rows);
}

function subscriptionGpText(subscription) {
  return (subscription.accountConfigs || []).map((config, accountIndex) => {
    const links = (config.targets || []).map((target, targetIndex) => `GP${targetIndex + 1}: ${target.inviteLink}`).join("\n") || "GP မရှိသေးပါ";
    return `Account ${accountIndex + 1}:\n${links}`;
  }).join("\n\n");
}

function scheduleJoinJob(jobId, delayMs = 0) {
  const key = String(jobId);
  if (joinTimers.has(key)) clearTimeout(joinTimers.get(key));
  const timer = setTimeout(() => {
    joinTimers.delete(key);
    processJoinJob(jobId).catch(error => console.error(`Join job ${jobId} failed:`, error));
  }, Math.max(0, delayMs));
  joinTimers.set(key, timer);
}

async function completeJoinJob(job) {
  await db.collection("joinJobs").updateOne({ _id: job._id }, { $set: { status: "completed", completedAt: now() } });
  await bot.telegram.sendMessage(job.userId, "GP joined ခြင်းအကုန်အောင်မြင်ပါသည်။ 2 စက္ကန့်စောင့်ပြီး message ရေးရန် button များကို ပြပါမယ်။");
  await sleep(2000);
  const totalMessages = job.accountConfigs.reduce((sum, item) => sum + item.targets.length, 0);
  sessions.set(job.userId, { step: "messagePick", accountConfigs: job.accountConfigs, subscriptionId: job.subscriptionId, remainingMessages: totalMessages });
  return bot.telegram.sendMessage(job.userId, "ပို့မည့် message များ ပို့ပေးပါ။", messageKeyboard(job.accountConfigs));
}

async function processJoinJob(jobId) {
  const job = await db.collection("joinJobs").findOne({ _id: jobId, status: { $in: ["running", "waiting"] } });
  if (!job) return;
  const nowTime = Date.now();
  const nextRun = job.nextRunAt ? new Date(job.nextRunAt).getTime() : nowTime;
  if (nextRun > nowTime) return scheduleJoinJob(jobId, nextRun - nowTime);
  const config = job.accountConfigs[job.accountIndex];
  if (!config) return completeJoinJob(job);
  if (job.targetIndex === 0) await bot.telegram.sendMessage(job.userId, `Account ${job.accountIndex + 1} အတွက် GP join စတင်ပါပြီ။`);
  const account = await db.collection("accounts").findOne({ _id: config.accountId, enabled: true });
  if (!account || !clientPool.has(String(account._id))) throw new Error(`Account ${job.accountIndex + 1} ချိတ်ဆက်ထားခြင်းမရှိပါ။`);
  const client = clientPool.get(String(account._id));
  const target = config.targets[job.targetIndex];
  try {
    await joinTarget(client, target);
    const joinedCount = job.joinedCount + 1;
    await bot.telegram.sendMessage(job.userId, `${target.inviteLink} joined ပြီးပါပြီ။`);
    const nextTargetIndex = job.targetIndex + 1;
    const accountFinished = nextTargetIndex >= config.targets.length;
    const allFinished = accountFinished && job.accountIndex + 1 >= job.accountConfigs.length;
    if (allFinished) {
      if (job.editOnly) {
        const subscription = await db.collection("subscriptions").findOne({ _id: job.subscriptionId, userId: job.userId, status: "active" });
        const editFor = job.editFor;
        const replacement = config.targets[0];
        if (subscription && editFor) {
          const today = new Date().toISOString().slice(0, 10);
          const currentUsage = subscription.editUsage?.dayKey === today ? subscription.editUsage : { dayKey: today, count: 0, total: subscription.editUsage?.total || 0 };
          await db.collection("subscriptions").updateOne({ _id: subscription._id, status: "active" }, { $set: { [`accountConfigs.${editFor.accountIndex}.targets.${editFor.targetIndex}`]: replacement, editUsage: { dayKey: today, count: currentUsage.count + 1, total: (currentUsage.total || 0) + 1 } } });
          await bot.telegram.sendMessage(job.userId, `${replacement.inviteLink} joined ပြီးပါပြီ။ GP link ကို အစားထိုးပြီးပါပြီ။`);
        }
        await db.collection("joinJobs").updateOne({ _id: jobId }, { $set: { status: "completed", completedAt: now() } });
        return;
      }
      const completedJob = { ...job, targetIndex: nextTargetIndex, joinedCount };
      return completeJoinJob(completedJob);
    }
    if (accountFinished) {
      await bot.telegram.sendMessage(job.userId, `Account ${job.accountIndex + 1} အတွက် GP join ပြီးပါပြီ။`);
      await db.collection("joinJobs").updateOne({ _id: jobId }, { $set: { accountIndex: job.accountIndex + 1, targetIndex: 0, joinedCount: 0, status: "running", nextRunAt: new Date(Date.now() + 5000) } });
      return scheduleJoinJob(jobId, 5000);
    }
    const cooldownMs = joinedCount % 4 === 0 ? 10 * 60 * 1000 : 5000;
    const status = joinedCount % 4 === 0 ? "waiting" : "running";
    if (status === "waiting") await bot.telegram.sendMessage(job.userId, `GP ${joinedCount} ခု join ပြီးပါပြီ။ နောက် GP များကို 10 မိနစ်နေ auto ဆက် join ပါမယ်။`);
    await db.collection("joinJobs").updateOne({ _id: jobId }, { $set: { targetIndex: nextTargetIndex, joinedCount, status, nextRunAt: new Date(Date.now() + cooldownMs) } });
    return scheduleJoinJob(jobId, cooldownMs);
  } catch (error) {
    const floodMatch = String(error.message || "").match(/FLOOD_WAIT[_ ](\d+)/i);
    const waitSeconds = Number(error.seconds || floodMatch?.[1] || 0);
    if (waitSeconds > 0) {
      const cooldownMs = Math.max(waitSeconds * 1000, 10 * 60 * 1000);
      await bot.telegram.sendMessage(job.userId, `Telegram cooldown ဖြစ်နေပါသည်။ နောက် GP များကို ${Math.ceil(cooldownMs / 60000)} မိနစ်နေ auto ဆက် join ပါမယ်။`);
      await db.collection("joinJobs").updateOne({ _id: jobId }, { $set: { status: "waiting", nextRunAt: new Date(Date.now() + cooldownMs) } });
      return scheduleJoinJob(jobId, cooldownMs);
    }
    await db.collection("joinJobs").updateOne({ _id: jobId }, { $set: { status: "failed", failedTargetIndex: job.targetIndex, failedAccountIndex: job.accountIndex }, $unset: { nextRunAt: "" } });
    const editButton = job.editOnly
      ? Markup.inlineKeyboard([[Markup.button.callback("Edit GP link", `editlink:${job.subscriptionId}:${job.editFor.accountIndex}:${job.editFor.targetIndex}`)]])
      : Markup.inlineKeyboard([[Markup.button.callback("Edit GP link", `editgp:${jobId}:${job.accountIndex}:${job.targetIndex}`)]]);
    await bot.telegram.sendMessage(job.userId, `${target.inviteLink} join မအောင်မြင်ပါ။ User account link မဟုတ်ဘဲ public GP link သာ ပို့ရပါမယ်။`, editButton);
    return;
  }
}

async function resumeJoinJobs() {
  const jobs = await db.collection("joinJobs").find({ status: { $in: ["running", "waiting"] } }).toArray();
  for (const job of jobs) scheduleJoinJob(job._id, Math.max(0, new Date(job.nextRunAt || now()).getTime() - Date.now()));
}

async function sendCycle(userId, accountConfigs, subscriptionId = null) {
  for (let accountIndex = 0; accountIndex < accountConfigs.length; accountIndex += 1) {
    const config = accountConfigs[accountIndex];
    const account = await db.collection("accounts").findOne({ _id: config.accountId, enabled: true });
    if (!account || !clientPool.has(String(account._id))) throw new Error(`Account ${accountIndex + 1} မရနိုင်ပါ။`);
    const client = clientPool.get(String(account._id));
    for (let i = 0; i < config.targets.length; i += 1) {
      if (subscriptionId) {
        const live = await db.collection("subscriptions").findOne({ _id: subscriptionId, status: "active" }, { projection: { sendPaused: 1 } });
        if (!live || live.sendPaused) {
          await bot.telegram.sendMessage(userId, "စာပို့ခြင်း ရပ်လိုက်ပါပြီ။");
          return false;
        }
      }
      const target = config.targets[i];
      await sendWithAccount(client, target, config.messages?.[i] || "");
      await bot.telegram.sendMessage(userId, `GP${accountIndex + 1}-${i + 1} ပို့ပြီးပါပြီ။`);
      if (i < config.targets.length - 1) {
        await bot.telegram.sendMessage(userId, `GP${accountIndex + 1}-${i + 2} ပို့နေပါသည်။ 6 စက္ကန့်စောင့်ပါမယ်။`);
        await sleep(6000);
      }
    }
  }
  return true;
}

function remainingMinutes(dateValue) {
  return Math.max(1, Math.ceil((new Date(dateValue).getTime() - Date.now()) / 60000));
}
function sendIntervalMs() { return Math.max(1, Number(sendIntervalMinutes) || 20) * 60 * 1000; }

async function getActiveUserSubscription(userId) {
  await expireSubscriptions();
  return db.collection("subscriptions").findOne({ userId: Number(userId), status: "active", expiresAt: { $gt: now() } });
}

async function startUserSend(userId, reply) {
  const subscription = await getActiveUserSubscription(userId);
  if (!subscription) return reply("Active plan မရှိတော့ပါ။", mainMenu);
  if (!subscription.accountConfigs?.length || !subscription.accountConfigs.every(config => (config.messages || []).every(Boolean))) return reply("GP အားလုံးအတွက် စာသား မပြည့်သေးပါ။");
  if (subscription.sendNextAt && new Date(subscription.sendNextAt) > now()) return reply(`GP ထဲသို့ စာပို့ရန် မိနစ် ${remainingMinutes(subscription.sendNextAt)} လိုပါသေးတယ်။`);
  const current = await db.collection("subscriptions").findOneAndUpdate(
    { _id: subscription._id, status: "active", $or: [{ sendNextAt: { $exists: false } }, { sendNextAt: { $lte: now() } }] },
    { $set: { sendPaused: false, sendNextAt: new Date(Date.now() + sendIntervalMs()) } },
    { returnDocument: "after" },
  );
  if (!current) return reply("စာပို့ခြင်းကို အခြားလုပ်ဆောင်မှုတစ်ခုက စတင်ထားပြီးဖြစ်ပါတယ်။ ခဏစောင့်ပါ။");
  await reply("GP များကို စာပို့ရန် လုပ်ဆောင်နေပါပြီ။");
  try {
    const completed = await sendCycle(userId, current.accountConfigs, current._id);
    if (completed) await reply(`GP အားလုံးပို့ပြီးပါပြီ။ မိနစ် ${sendIntervalMinutes} နားနေပါသည်။`);
    scheduleRecurringSend(userId, current._id);
  } catch (error) {
    await reply(`စာပို့ခြင်း မအောင်မြင်ပါ: ${error.message}`);
    scheduleRecurringSend(userId, current._id);
  }
}

async function stopUserSend(userId, reply) {
  const subscription = await getActiveUserSubscription(userId);
  if (!subscription) return reply("Active plan မရှိတော့ပါ။", mainMenu);
  const control = await db.collection("sendControls").findOne({ userId: Number(userId) });
  if (control?.stopNextAt && new Date(control.stopNextAt) > now()) return reply(`Stop button ကို ထပ်နှိပ်ရန် မိနစ် ${remainingMinutes(control.stopNextAt)} စောင့်ပါ။`);
  const changed = await db.collection("subscriptions").updateOne({ _id: subscription._id, status: "active" }, { $set: { sendPaused: true }, $unset: { nextSendAt: "" } });
  await db.collection("sendControls").updateOne({ userId: Number(userId) }, { $set: { stopNextAt: new Date(Date.now() + sendIntervalMs()) } }, { upsert: true });
  if (recurringTimers.has(String(subscription._id))) {
    clearTimeout(recurringTimers.get(String(subscription._id)));
    recurringTimers.delete(String(subscription._id));
  }
  return reply(changed.modifiedCount ? "စာပို့ခြင်း ရပ်လိုက်ပါပြီ။" : "စာပို့ခြင်း ရပ်ထားပြီးသားပါ။");
}

function scheduleRecurringSend(userId, subscriptionId) {
  if (recurringTimers.has(String(subscriptionId))) clearTimeout(recurringTimers.get(String(subscriptionId)));
  const timer = setTimeout(async () => {
    recurringTimers.delete(String(subscriptionId));
    try {
      await expireSubscriptions();
      const subscription = await db.collection("subscriptions").findOne({ _id: subscriptionId, userId, status: "active", expiresAt: { $gt: now() } });
      if (!subscription || subscription.sendPaused || await isBanned(userId)) return;
      if (subscription.sendNextAt && new Date(subscription.sendNextAt) > now()) return scheduleRecurringSend(userId, subscriptionId);
      await bot.telegram.sendMessage(userId, `မိနစ် ${sendIntervalMinutes} ပြည့်ပါပြီ။ GP1 မှ စာပြန်ပို့နေပါပြီ။`);
      const completed = await sendCycle(userId, subscription.accountConfigs || [], subscriptionId);
      if (completed) {
        await db.collection("subscriptions").updateOne({ _id: subscriptionId, status: "active" }, { $set: { sendNextAt: new Date(Date.now() + sendIntervalMs()) } });
        await bot.telegram.sendMessage(userId, `GP အားလုံးထပ်ပို့ပြီးပါပြီ။ မိနစ် ${sendIntervalMinutes} နားနေပါသည်။`);
      }
      scheduleRecurringSend(userId, subscriptionId);
    } catch (error) {
      await bot.telegram.sendMessage(userId, `Auto send မအောင်မြင်ပါ: ${error.message}`).catch(() => {});
      scheduleRecurringSend(userId, subscriptionId);
    }
  }, sendIntervalMs());
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

const mainMenu = Markup.keyboard([["PLANS", "Balance"], ["GP", "Msg"], ["Send", "Stop"]]).resize();
const paymentMenu = Markup.inlineKeyboard([
  [Markup.button.callback("KPay ဖြင့်ငွေဖြည့်မည်", "topup:KPay")],
  [Markup.button.callback("Wave Pay ဖြင့်ငွေဖြည့်မည်", "topup:WavePay")],
]);
const planMenu = Markup.inlineKeyboard([
  [Markup.button.callback("1 Account", "plan:one")],
  [Markup.button.callback("2 Account", "plan:two")],
]);

bot.command("admin", adminOnly, async ctx => {
  await ctx.reply(ADMIN_HELP);
});

bot.start(async ctx => {
  await ensureUser(ctx);
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  if (await capacityFullForNewUser(ctx.from.id)) return ctx.reply(await capacityFullMessage());
  await ctx.reply(`မင်္ဂလာပါ ${nameOf(ctx)} ရေ။\nauto message sender bot မှကြိုဆိုပါတယ်။`, mainMenu);
});

bot.hears("PLANS", async ctx => {
  await ensureUser(ctx);
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  if (await capacityFullForNewUser(ctx.from.id)) return ctx.reply(await capacityFullMessage());
  await ctx.reply("အသုံးပြုမည့် account အရေအတွက်ကို ရွေးပါ။", planMenu);
});

bot.hears("Balance", async ctx => {
  const user = await ensureUser(ctx);
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  if (await capacityFullForNewUser(ctx.from.id)) return ctx.reply(await capacityFullMessage());
  const pending = await db.collection("topups").findOne({ userId: ctx.from.id, status: "pending" });
  if (pending) return ctx.reply(`သင့် Balance မှာ ${user.balance || 0} Ks ရှိပါတယ်။\n\nယခင် top-up request ${pending.amount} Ks ကို Admin အတည်ပြုရန် စောင့်ပါသည်။`, Markup.inlineKeyboard([[Markup.button.callback("Cancel", "topup:usercancel")]]));
  await ctx.reply(`သင့် Balance မှာ ${user.balance || 0} Ks ရှိပါတယ်။`, paymentMenu);
});

bot.hears("Send", async ctx => {
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  await startUserSend(ctx.from.id, (text, markup) => ctx.reply(text, markup));
});

bot.hears("Stop", async ctx => {
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  await stopUserSend(ctx.from.id, (text, markup) => ctx.reply(text, markup));
});

bot.action(/^topup:(KPay|WavePay)$/, async ctx => {
  await ctx.answerCbQuery();
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  if (await capacityFullForNewUser(ctx.from.id)) return ctx.reply(await capacityFullMessage());
  const pending = await db.collection("topups").findOne({ userId: ctx.from.id, status: "pending" });
  if (pending) {
    const receiptState = { step: "topupReceipt", topupId: pending._id };
    sessions.set(ctx.from.id, receiptState);
    await db.collection("users").updateOne({ telegramId: ctx.from.id }, { $set: { paymentState: receiptState } });
    return ctx.reply(`ယခင် top-up request ${pending.amount} Ks ကို Admin အတည်ပြုရန် စောင့်ပါသည်။ ပြေစာပို့ရန် သို့မဟုတ် request ကို ရပ်ရန် ရွေးပါ။`, Markup.inlineKeyboard([[Markup.button.callback("Cancel", "topup:usercancel")]]));
  }
  const paymentState = { step: "topupAmount", method: ctx.match[1] };
  sessions.set(ctx.from.id, paymentState);
  await db.collection("users").updateOne({ telegramId: ctx.from.id }, { $set: { paymentState } }, { upsert: true });
  await ctx.reply(`${ctx.match[1]} ဖြင့် ဖြည့်မည့်ငွေအရေအတွက် ပို့ပေးပါ။ (အနည်းဆုံး 1000 Ks မှ စဖြည့်ပါ)\nဥပမာ: 1000 သို့မဟုတ် 1000 Ks`, Markup.inlineKeyboard([[Markup.button.callback("Cancel", "topup:usercancel")]]));
});

bot.action("topup:usercancel", async ctx => {
  await ctx.answerCbQuery();
  if (await isBanned(ctx.from.id)) return;
  const pending = await db.collection("topups").findOne({ userId: ctx.from.id, status: "pending" });
  if (pending) await db.collection("topups").updateOne({ _id: pending._id, status: "pending" }, { $set: { status: "cancelled", cancelledAt: now(), cancelledBy: "user" } });
  await db.collection("users").updateOne({ telegramId: ctx.from.id }, { $unset: { paymentState: "" } });
  sessions.delete(ctx.from.id);
  return ctx.reply("ငွေဖြည့်လုပ်ဆောင်ချက်ကို ရပ်လိုက်ပါပြီ။ Balance menu မှ ပြန်စနိုင်ပါတယ်။", mainMenu);
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
  let state = sessions.get(ctx.from.id);
  if (!state) {
    const savedUser = await db.collection("users").findOne({ telegramId: ctx.from.id }, { projection: { paymentState: 1 } });
    state = savedUser?.paymentState || null;
    if (state) sessions.set(ctx.from.id, state);
  }
  if (!state || state.step !== "topupReceipt") return;
  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  const topup = await db.collection("topups").findOne({ _id: state.topupId, userId: ctx.from.id, status: "pending" });
  if (!topup) return ctx.reply("ဒီ top-up request မရှိတော့ပါ။ Balance menu မှ ပြန်စပါ။");
  await db.collection("topups").updateOne({ _id: topup._id }, { $set: { receiptFileId: fileId, receiptReceivedAt: now() } });
  await db.collection("users").updateOne({ telegramId: ctx.from.id }, { $unset: { paymentState: "" } });
  sessions.delete(ctx.from.id);
  const caption = `Receipt ပုံ | User: ${ctx.from.id} | Method: ${topup.method} | Amount: ${topup.amount} Ks`;
  await bot.telegram.sendMessage(ADMIN_ID, `ငွေဖြည့်တောင်းဆိုမှု ရရှိပါပြီ။\nUser ID: ${ctx.from.id}\nငွေဖြည့်ပမာဏ: ${topup.amount} Ks\nPayment: ${topup.method}`);
  await bot.telegram.sendPhoto(ADMIN_ID, fileId, { caption });
  await bot.telegram.sendMessage(ADMIN_ID, `အပေါ်က amount နှင့် receipt ကို စစ်ပြီး Confirm သို့ Cancel ရွေးပါ။`, Markup.inlineKeyboard([
    [Markup.button.callback("Confirm", `topup:confirm:${topup._id}`), Markup.button.callback("Cancel", `topup:cancel:${topup._id}`)],
  ]));
  await ctx.reply("ပြေစာကို Admin ထံ ပို့ပြီးပါပြီ။ Admin အတည်ပြုချက်ကို စောင့်ပါ။");
});

bot.hears("GP", async ctx => {
  const subscription = await getActiveUserSubscription(ctx.from.id);
  if (!subscription) return ctx.reply("Active plan မရှိတော့ပါ။", mainMenu);
  if (!subscription.accountConfigs?.length) return ctx.reply("GP link မပြင်ဆင်ရသေးပါ။", mainMenu);
  const canEdit = subscription.durationKey === "w1";
  return ctx.reply(`သင်အသုံးပြုထားသော GP link များ:\n\n${subscriptionGpText(subscription)}${canEdit ? `\n\nGP link ပြောင်းခွင့်: ယနေ့ ${subscription.editUsage?.dayKey === new Date().toISOString().slice(0, 10) ? (subscription.editUsage?.count || 0) : 0}/1၊ စုစုပေါင်း ${subscription.editUsage?.total || 0}/4` : ""}`, canEdit ? editGpKeyboard(subscription) : mainMenu);
});

bot.hears("Msg", async ctx => {
  const subscription = await getActiveUserSubscription(ctx.from.id);
  if (!subscription) return ctx.reply("Active plan မရှိတော့ပါ။", mainMenu);
  if (subscription.durationKey !== "w1") return ctx.reply("Msg ပြောင်းခွင့်မှာ 1 Week plan အတွက်သာ ဖြစ်ပါတယ်။", mainMenu);
  if (!subscription.accountConfigs?.length) return ctx.reply("GP link မပြင်ဆင်ရသေးပါ။", mainMenu);
  return ctx.reply("ပြောင်းလိုသော GP ၏ message button ကို ရွေးပါ။", messageEditKeyboard(subscription));
});

bot.hears("Help", ctx => ctx.reply("PLANS ကိုနှိပ်ပြီး plan ရွေးပါ။ ထို့နောက် GP နှင့် Msg menu များမှ link/message များကို ပြင်ဆင်နိုင်ပါတယ်။", mainMenu));

bot.action(/^plan:(one|two)$/, async ctx => {
  await ctx.answerCbQuery();
  const planKey = ctx.match[1];
  await ensureUser(ctx);
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  const existing = await activeSubscription(ctx.from.id);
  if (existing) return ctx.reply("သင့်မှာ active plan ရှိပြီးသားပါ။ လက်ရှိသက်တမ်းကုန်မှ ထပ်ဝယ်ပါ။");
  if (await capacityFullForNewUser(ctx.from.id)) return ctx.reply(await capacityFullMessage());
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
  if (await capacityFullForNewUser(ctx.from.id)) return ctx.reply(await capacityFullMessage());
  if (!await acquirePurchaseLock(ctx.from.id)) return ctx.reply("ဝယ်ယူမှုတစ်ခု လုပ်ဆောင်နေပြီးသားပါ။ ခဏစောင့်ပြီး ပြန်ကြိုးစားပါ။");
  const expiresAt = new Date(Date.now() + duration.days * 24 * 60 * 60 * 1000);
  const subscriptionId = new ObjectId();
  const slot = await acquireCapacitySlot(ctx.from.id, subscriptionId, expiresAt);
  if (!slot) {
    await releasePurchaseLock(ctx.from.id);
    await bot.telegram.sendMessage(ADMIN_ID, `Active plan User 10 ယောက်ပြည့်နေသောကြောင့် User ${ctx.from.id} ၏ ${duration.label} ဝယ်ယူမှုကို လက်မခံနိုင်ပါ။`).catch(() => {});
    return ctx.reply(await capacityFullMessage());
  }
  await db.collection("users").updateOne({ telegramId: ctx.from.id }, { $inc: { balance: -duration.price } });
  const subscription = { _id: subscriptionId, userId: ctx.from.id, plan: planKey, durationKey: ctx.match[2], accountCount: plans[planKey].accounts, price: duration.price, startedAt: now(), expiresAt, status: "active", accountConfigs: [], message: "" };
  await db.collection("subscriptions").insertOne(subscription);
  const reserved = await acquireAccounts(ctx.from.id, subscriptionId, plans[planKey].accounts, expiresAt);
  if (reserved.length < plans[planKey].accounts) {
    await releaseAccounts(subscriptionId);
    await releaseCapacity(subscriptionId);
    await db.collection("subscriptions").updateOne({ _id: subscriptionId }, { $set: { status: "cancelled", cancelledAt: now(), cancelReason: "no_free_accounts" } });
    await db.collection("users").updateOne({ telegramId: ctx.from.id }, { $inc: { balance: duration.price } });
    await releasePurchaseLock(ctx.from.id);
    await bot.telegram.sendMessage(ADMIN_ID, `Account မလုံလောက်သောကြောင့် User ${ctx.from.id} က ${duration.label} plan ဝယ်ရန် ကြိုးစားသော်လည်း မအောင်မြင်ပါ။ လိုအပ်သော account: ${plans[planKey].accounts}` ).catch(() => {});
    return ctx.reply("လက်ရှိမှာ အသုံးပြုနေသော account များဖြစ်နေသောကြောင့် account ပစ္စည်း မအားသေးပါ။ လွတ်သော account ရရှိမှ ပြန်ဝယ်ပါ။");
  }
  await releasePurchaseLock(ctx.from.id);
  sessions.set(ctx.from.id, { step: "gpCount", accountIndex: 0, accountCount: plans[planKey].accounts, accountIds: reserved.map(account => account._id), accountConfigs: [], subscriptionId });
  await ctx.reply(`${duration.label} ဝယ်ပြီးပါပြီ။\n\nပို့မည့် GP အရေအတွက် ပို့ပေးပါ။ (အနည်းဆုံး 1 မှ အများဆုံး 8)`);
});

bot.command("stop", adminOnly, async ctx => {
  const [, type, userId] = ctx.message.text.trim().split(/\s+/);
  if (type?.toLowerCase() !== "plan" || !userId || !/^\d+$/.test(userId)) return ctx.reply("အသုံးပြုပုံ: /stop plan USER_ID");
  const stopped = await stopUserPlans(Number(userId), "admin_stop");
  if (!stopped) return ctx.reply(`User ${userId} အတွက် active plan မတွေ့ပါ။`);
  await bot.telegram.sendMessage(Number(userId), "Admin က သင့် plan အသုံးပြုမှုကို ရပ်လိုက်ပါပြီ။ ထပ်သုံးရန် plan အသစ် ပြန်ဝယ်ပါ။").catch(() => {});
  return ctx.reply(`User ${userId} ၏ plan ကို ရပ်ပြီး account ကို လွှတ်ပေးလိုက်ပါပြီ။ Cashback မပေးထားပါ။`);
});

bot.command("stopplan", adminOnly, async ctx => {
  const [, userId] = ctx.message.text.trim().split(/\s+/);
  if (!userId || !/^\d+$/.test(userId)) return ctx.reply("အသုံးပြုပုံ: /stopplan USER_ID");
  const stopped = await stopUserPlans(Number(userId), "admin_stop");
  if (!stopped) return ctx.reply(`User ${userId} အတွက် active plan မတွေ့ပါ။`);
  await bot.telegram.sendMessage(Number(userId), "Admin က သင့် plan အသုံးပြုမှုကို ရပ်လိုက်ပါပြီ။ ထပ်သုံးရန် plan အသစ် ပြန်ဝယ်ပါ။").catch(() => {});
  return ctx.reply(`User ${userId} ၏ plan ကို ရပ်ပြီး account ကို လွှတ်ပေးလိုက်ပါပြီ။ Cashback မပေးထားပါ။`);
});

bot.command("ban", adminOnly, async ctx => {
  const [, userId, ...reasonParts] = ctx.message.text.trim().split(/\s+/);
  if (!userId || !/^\d+$/.test(userId)) return ctx.reply("အသုံးပြုပုံ: /ban USER_ID reason");
  await db.collection("users").updateOne({ telegramId: Number(userId) }, { $set: { telegramId: Number(userId), banned: true, banReason: reasonParts.join(" ") || "Admin ban", bannedAt: now() } }, { upsert: true });
  const active = await db.collection("subscriptions").find({ userId: Number(userId), status: "active" }).toArray();
  for (const sub of active) {
    await db.collection("subscriptions").updateOne({ _id: sub._id }, { $set: { status: "cancelled", cancelledAt: now(), cancelReason: "banned" } });
    await releaseAccounts(sub._id);
    await releaseCapacity(sub._id);
    await notifyAdminCapacityRelease("user_banned");
    await scheduleCapacityNotice();
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

bot.command("setfullbot", adminOnly, async ctx => {
  const link = ctx.message.text.slice("/setfullbot".length).trim();
  if (!link || !/^@?[A-Za-z0-9_]{5,}$/.test(link)) return ctx.reply("အသုံးပြုပုံ: /setfullbot @test_bot");
  await db.collection("settings").updateOne({ _id: "runtime" }, { $set: { fullBotLink: link, updatedAt: now() } }, { upsert: true });
  return ctx.reply(`Capacity ပြည့်သောအခါ ပြမည့် bot link ကို ${link} အဖြစ် သိမ်းပြီးပါပြီ။`);
});

bot.command("fullbot", adminOnly, async ctx => {
  return ctx.reply(`Capacity ပြည့်သောအခါ ပြမည့် bot link: ${await getFullBotLink() || "မထည့်ရသေးပါ"}`);
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
  let state = sessions.get(ctx.from.id);
  if (!state) {
    const savedUser = await db.collection("users").findOne({ telegramId: ctx.from.id }, { projection: { paymentState: 1 } });
    state = savedUser?.paymentState || null;
    if (state) sessions.set(ctx.from.id, state);
  }
  if (!state || state.step !== "topupReceipt") return next();
  const fileId = ctx.message.document.file_id;
  const topup = await db.collection("topups").findOne({ _id: state.topupId, userId: ctx.from.id, status: "pending" });
  if (!topup) return ctx.reply("ဒီ top-up request မရှိတော့ပါ။ Balance menu မှ ပြန်စပါ။");
  await db.collection("topups").updateOne({ _id: topup._id }, { $set: { receiptFileId: fileId, receiptReceivedAt: now() } });
  await db.collection("users").updateOne({ telegramId: ctx.from.id }, { $unset: { paymentState: "" } });
  sessions.delete(ctx.from.id);
  await bot.telegram.sendMessage(ADMIN_ID, `ငွေဖြည့်တောင်းဆိုမှု ရရှိပါပြီ။\nUser ID: ${ctx.from.id}\nငွေဖြည့်ပမာဏ: ${topup.amount} Ks\nPayment: ${topup.method}`);
  await bot.telegram.sendDocument(ADMIN_ID, fileId, { caption: `Receipt file | User: ${ctx.from.id} | Amount: ${topup.amount} Ks` });
  await bot.telegram.sendMessage(ADMIN_ID, "အပေါ်က amount နှင့် receipt ကို စစ်ပြီး Confirm သို့ Cancel ရွေးပါ။", Markup.inlineKeyboard([[Markup.button.callback("Confirm", `topup:confirm:${topup._id}`), Markup.button.callback("Cancel", `topup:cancel:${topup._id}`)]]));
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

bot.command("replaceaccount", adminOnly, async ctx => {
  const name = ctx.message.text.slice("/replaceaccount".length).trim();
  if (!name) return ctx.reply("အသုံးပြုပုံ: /replaceaccount acc1");
  pendingAccount.set(ADMIN_ID, name);
  return ctx.reply(`${name} အတွက် session အသစ်ကို .txt file သို့မဟုတ် ရိုးရိုး text အဖြစ် ပို့ပါ။ အဟောင်း session ကို အစားထိုးပါမယ်။`);
});

bot.command("removeaccount", adminOnly, async ctx => {
  const [, name] = ctx.message.text.trim().split(/\s+/);
  if (!name) return ctx.reply("အသုံးပြုပုံ: /removeaccount acc1");
  const account = await db.collection("accounts").findOne({ name, enabled: true });
  if (!account) return ctx.reply(`${name} account မတွေ့ပါ။`);
  if (account.lease) return ctx.reply(`${name} ကို User တစ်ယောက်အသုံးပြုနေသောကြောင့် ယခုဖြုတ်၍မရပါ။ Plan ရပ်ပြီးမှ ဖြုတ်ပါ။`);
  const client = clientPool.get(String(account._id));
  if (client) await client.disconnect().catch(() => {});
  clientPool.delete(String(account._id));
  await db.collection("accounts").updateOne({ _id: account._id }, { $set: { enabled: false, removedAt: now() } });
  return ctx.reply(`${name} account ကို ဖြုတ်ပြီးပါပြီ။ ပြန်ထည့်ရန် /replaceaccount ${name} ကို သုံးပါ။`);
});

bot.command("setinterval", adminOnly, async ctx => {
  const [, rawMinutes] = ctx.message.text.trim().split(/\s+/);
  const minutes = Number(rawMinutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return ctx.reply("အသုံးပြုပုံ: /setinterval MINUTES (1 မှ 1440)");
  sendIntervalMinutes = minutes;
  await db.collection("settings").updateOne({ _id: "runtime" }, { $set: { sendIntervalMinutes: minutes, updatedAt: now() } }, { upsert: true });
  return ctx.reply(`GP message send interval ကို ${minutes} မိနစ် သတ်မှတ်ပြီးပါပြီ။ နောက် cycle မှစပြီး ${minutes} မိနစ်ခြား ပို့ပါမယ်။`);
});

bot.command("interval", adminOnly, async ctx => ctx.reply(`လက်ရှိ GP message send interval: ${sendIntervalMinutes} မိနစ်`));

bot.command("accounts", adminOnly, async ctx => {
  const accounts = await loadAccounts();
  await ctx.reply(accounts.length ? accounts.map((a, i) => `${i + 1}. ${a.name} — ${clientPool.has(String(a._id)) ? "Connected" : "Disconnected"}${a.lease ? ` — User ${a.lease.userId}` : " — Free"}`).join("\n") : "Account မရှိသေးပါ။");
});

bot.command("status", adminOnly, async ctx => {
  const accounts = await loadAccounts();
  await ctx.reply(`Accounts: ${accounts.length}\nConnected: ${accounts.filter(a => clientPool.has(String(a._id))).length}\nSending: ${sending ? "Yes" : "No"}`);
});

bot.command("capacity", adminOnly, async ctx => {
  await expireSubscriptions();
  const active = await activePlanUserCount();
  const free = Math.max(0, MAX_ACTIVE_USERS - active);
  return ctx.reply(`Active plan users: ${active}/${MAX_ACTIVE_USERS}\nလွတ်နေသော plan: ${free}\n10 ယောက်ပြည့်ရန် လိုသေးသော User: ${free}\nRedirect bot: ${await getFullBotLink() || "မထည့်ရသေးပါ"}`);
});

bot.command("capacitystatus", adminOnly, async ctx => {
  const active = await activePlanUserCount();
  const free = Math.max(0, MAX_ACTIVE_USERS - active);
  return ctx.reply(`Capacity: ${active}/${MAX_ACTIVE_USERS}\nFree slots: ${free}\nပြည့်ရန် User ${free} ယောက်လိုပါသေးသည်။`);
});

bot.command("setprice", adminOnly, async ctx => {
  const [, rawPlan, rawDuration, rawPrice] = ctx.message.text.trim().split(/\s+/);
  const planKey = normalizePlanKey(rawPlan);
  const durationKey = normalizeDurationKey(rawDuration);
  const price = Number(rawPrice);
  if (!planKey || !durationKey || !Number.isInteger(price) || price < 1) return ctx.reply("အသုံးပြုပုံ: /setprice 1 d1 1000\nDuration: d1, d2, w1");
  applyPlanPrice(planKey, durationKey, price);
  await db.collection("settings").updateOne({ _id: "planPrices" }, { $set: { [`${planKey}_${durationKey}`]: price, updatedAt: now() } }, { upsert: true });
  return ctx.reply(`${planKey === "one" ? "1 Account" : "2 Account"} ${durationKey} price ကို ${price} Ks အဖြစ် ပြောင်းပြီးပါပြီ။ Active plan အဟောင်းများ၏ price မပြောင်းပါ။`);
});

bot.command("prices", adminOnly, async ctx => {
  return ctx.reply(`1 Account: ${plans.one.durations.d1.price}/${plans.one.durations.d2.price}/${plans.one.durations.w1.price} Ks\n2 Account: ${plans.two.durations.d1.price}/${plans.two.durations.d2.price}/${plans.two.durations.w1.price} Ks\nအစီအစဉ်: 1 Day / 2 Day / 1 Week`);
});

bot.command("accountstatus", adminOnly, async ctx => {
  const accounts = await loadAccounts();
  if (!accounts.length) return ctx.reply("Admin ထည့်ထားသော account မရှိသေးပါ။");
  const lines = accounts.map((account, index) => {
    const lease = account.lease;
    const leaseText = lease ? `အသုံးပြုနေ: User ${lease.userId}, expire ${new Date(lease.expiresAt).toISOString()}` : "လွတ်နေသည်";
    return `${index + 1}. ${account.name} | ${clientPool.has(String(account._id)) ? "Connected" : "Disconnected"} | ${account.enabled ? "Enabled" : "Disabled"} | ${leaseText}`;
  });
  return ctx.reply(lines.join("\n"));
});

bot.action(/^editlink:([a-f0-9]{24}):(\d+):(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  const subscription = await db.collection("subscriptions").findOne({ _id: new ObjectId(ctx.match[1]), userId: ctx.from.id, status: "active", expiresAt: { $gt: now() } });
  if (!subscription) return ctx.reply("Active plan မရှိတော့ပါ။ Plan ပြန်ဝယ်ပါ။");
  if (subscription.durationKey !== "w1") return ctx.reply("GP link ပြောင်းခွင့်မှာ 1 Week plan အတွက်သာ ဖြစ်ပါတယ်။");
  const today = new Date().toISOString().slice(0, 10);
  const usage = subscription.editUsage?.dayKey === today ? subscription.editUsage : { dayKey: today, count: 0, total: subscription.editUsage?.total || 0 };
  if ((usage.count || 0) >= 1) return ctx.reply("ယနေ့ GP link ပြောင်းခွင့် အသုံးပြုပြီးပါပြီ။ နောက်နေ့မှ ထပ်ပြောင်းနိုင်ပါမယ်။");
  const activeEditJob = await db.collection("joinJobs").findOne({ subscriptionId: subscription._id, editOnly: true, status: { $in: ["running", "waiting"] } });
  if (activeEditJob) return ctx.reply("အခြား GP link ပြောင်းခြင်း တစ်ခု လုပ်ဆောင်နေပါသည်။ ပြီးဆုံးသည်အထိ စောင့်ပါ။");
  if ((usage.total || 0) >= 4) return ctx.reply("ဤ 1 Week plan အတွက် GP link ပြောင်းခွင့် 4 ကြိမ် ပြည့်သွားပါပြီ။");
  sessions.set(ctx.from.id, { step: "editActiveGp", subscriptionId: subscription._id, accountIndex: Number(ctx.match[2]), targetIndex: Number(ctx.match[3]), dayKey: today });
  return ctx.reply("အစားထိုးမည့် public GP link တစ်ခုတည်းသာ ပို့ပါ။ GP link အများကြီး မပို့ရပါ။");
});

bot.action(/^editgp:([a-f0-9]{24}):(\d+):(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  const state = { step: "editGp", jobId: new ObjectId(ctx.match[1]), accountIndex: Number(ctx.match[2]), targetIndex: Number(ctx.match[3]) };
  sessions.set(ctx.from.id, state);
  return ctx.reply("အစားထိုးမည့် public GP link တစ်ခုတည်းသာ ပို့ပါ။ GP link အများကြီး မပို့ရပါ။\nဥပမာ: https://t.me/example");
});

bot.action(/^msgedit:([a-f0-9]{24}):(\d+):(\d+)$/, async ctx => {
  await ctx.answerCbQuery();
  if (await isBanned(ctx.from.id)) return ctx.reply("သင့် account ကို Admin က ban လုပ်ထားပါတယ်။");
  const subscription = await db.collection("subscriptions").findOne({ _id: new ObjectId(ctx.match[1]), userId: ctx.from.id, status: "active", expiresAt: { $gt: now() } });
  if (!subscription || subscription.durationKey !== "w1") return ctx.reply("Msg ပြောင်းခွင့်မှာ 1 Week plan အတွက်သာ ဖြစ်ပါတယ်။");
  const today = new Date().toISOString().slice(0, 10);
  const usage = subscription.messageEditUsage?.dayKey === today ? subscription.messageEditUsage : { dayKey: today, count: 0, total: subscription.messageEditUsage?.total || 0 };
  if ((usage.count || 0) >= 1) return ctx.reply("ယနေ့ message ပြောင်းခွင့် အသုံးပြုပြီးပါပြီ။ နောက်နေ့မှ ထပ်ပြောင်းနိုင်ပါမယ်။");
  if ((usage.total || 0) >= 4) return ctx.reply("ဤ 1 Week plan အတွက် message ပြောင်းခွင့် 4 ကြိမ် ပြည့်သွားပါပြီ။");
  const activeMessageJob = await db.collection("messageEdits").findOne({ subscriptionId: subscription._id, status: "pending" });
  if (activeMessageJob) return ctx.reply("အခြား message ပြောင်းခြင်း တစ်ခု လုပ်ဆောင်နေပါသည်။ ပြီးဆုံးသည်အထိ စောင့်ပါ။");
  sessions.set(ctx.from.id, { step: "editMessage", subscriptionId: subscription._id, accountIndex: Number(ctx.match[2]), targetIndex: Number(ctx.match[3]) });
  return ctx.reply("အစားထိုးမည့် message တစ်ခု ပို့ပါ။");
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
  await startUserSend(ctx.from.id, (text, markup) => ctx.reply(text, markup));
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
  if (state.step === "editMessage") {
    const subscription = await db.collection("subscriptions").findOne({ _id: state.subscriptionId, userId: ctx.from.id, status: "active", expiresAt: { $gt: now() } });
    if (!subscription || subscription.durationKey !== "w1") return ctx.reply("1 Week active plan မရှိတော့ပါ။");
    const today = new Date().toISOString().slice(0, 10);
    const usage = subscription.messageEditUsage?.dayKey === today ? subscription.messageEditUsage : { dayKey: today, count: 0, total: subscription.messageEditUsage?.total || 0 };
    if ((usage.count || 0) >= 1 || (usage.total || 0) >= 4) return ctx.reply((usage.total || 0) >= 4 ? "ဤ 1 Week plan အတွက် message ပြောင်းခွင့် 4 ကြိမ် ပြည့်သွားပါပြီ။" : "ယနေ့ message ပြောင်းခွင့် အသုံးပြုပြီးပါပြီ။ နောက်နေ့မှ ထပ်ပြောင်းနိုင်ပါမယ်။");
    const messageText = ctx.message.text.trim();
    if (!messageText) return ctx.reply("Message အလွတ်မပို့ရပါ။");
    await db.collection("subscriptions").updateOne({ _id: subscription._id, status: "active" }, { $set: { [`accountConfigs.${state.accountIndex}.messages.${state.targetIndex}`]: messageText, messageEditUsage: { dayKey: today, count: (usage.count || 0) + 1, total: (usage.total || 0) + 1 } } });
    sessions.delete(ctx.from.id);
    return ctx.reply("GP message ကို ပြောင်းပြီးပါပြီ။");
  }
  if (state.step === "editActiveGp") {
    const links = ctx.message.text.split(",").map(value => value.trim()).filter(Boolean);
    if (links.length !== 1) return ctx.reply("အစားထိုးမည့် GP link တစ်ခုတည်းသာ ပို့ပါ။");
    if (!isPublicGpLink(links[0])) return ctx.reply("Public GP link တစ်ခုတည်းသာ ပို့ပါ။ User account link မပို့ရပါ။ ဥပမာ https://t.me/example");
    const subscription = await db.collection("subscriptions").findOne({ _id: state.subscriptionId, userId: ctx.from.id, status: "active", expiresAt: { $gt: now() } });
    if (!subscription || subscription.durationKey !== "w1") return ctx.reply("1 Week active plan မရှိတော့ပါ။");
    const today = new Date().toISOString().slice(0, 10);
    const usage = subscription.editUsage?.dayKey === today ? subscription.editUsage : { dayKey: today, count: 0, total: subscription.editUsage?.total || 0 };
    if ((usage.count || 0) >= 1 || (usage.total || 0) >= 4) return ctx.reply((usage.total || 0) >= 4 ? "ဤ 1 Week plan အတွက် GP link ပြောင်းခွင့် 4 ကြိမ် ပြည့်သွားပါပြီ။" : "ယနေ့ GP link ပြောင်းခွင့် အသုံးပြုပြီးပါပြီ။ နောက်နေ့မှ ထပ်ပြောင်းနိုင်ပါမယ်။");
    const activeEditJob = await db.collection("joinJobs").findOne({ subscriptionId: subscription._id, editOnly: true, status: { $in: ["running", "waiting"] } });
    if (activeEditJob) return ctx.reply("အခြား GP link ပြောင်းခြင်း တစ်ခု လုပ်ဆောင်နေပါသည်။ ပြီးဆုံးသည်အထိ စောင့်ပါ။");
    const target = targetsFromUserLinks(links)[0];
    const editJob = { userId: ctx.from.id, subscriptionId: subscription._id, accountConfigs: [{ accountId: subscription.accountConfigs[state.accountIndex].accountId, targets: [target], messages: [subscription.accountConfigs[state.accountIndex].messages?.[state.targetIndex] || ""] }], accountIndex: 0, targetIndex: 0, joinedCount: 0, status: "running", nextRunAt: now(), createdAt: now(), editOnly: true, editFor: { accountIndex: state.accountIndex, targetIndex: state.targetIndex } };
    const result = await db.collection("joinJobs").insertOne(editJob);
    sessions.delete(ctx.from.id);
    await ctx.reply("GP link အသစ်ကို လက်ခံပြီးပါပြီ။ GP join စတင်ပါမယ်။");
    scheduleJoinJob(result.insertedId, 0);
    return;
  }
  if (state.step === "editGp") {
    const links = ctx.message.text.split(",").map(value => value.trim()).filter(Boolean);
    if (links.length !== 1) return ctx.reply("အစားထိုးမည့် GP link တစ်ခုတည်းသာ ပို့ပါ။");
    if (!isPublicGpLink(links[0])) return ctx.reply("Public GP link တစ်ခုတည်းသာ ပို့ပါ။ User account link မပို့ရပါ။ ဥပမာ https://t.me/example");
    const job = await db.collection("joinJobs").findOne({ _id: state.jobId, userId: ctx.from.id, status: "failed" });
    if (!job) { sessions.delete(ctx.from.id); return ctx.reply("Edit လုပ်ရန် failed GP job မတွေ့တော့ပါ။"); }
    const target = targetsFromUserLinks(links)[0];
    const accountConfigs = job.accountConfigs.map((config, accountIndex) => accountIndex === state.accountIndex
      ? { ...config, targets: config.targets.map((item, targetIndex) => targetIndex === state.targetIndex ? target : item) }
      : config);
    await db.collection("joinJobs").updateOne({ _id: job._id, status: "failed" }, { $set: { accountConfigs, status: "running", targetIndex: state.targetIndex, accountIndex: state.accountIndex, nextRunAt: new Date(Date.now() + 5000) } });
    await db.collection("subscriptions").updateOne({ _id: job.subscriptionId }, { $set: { accountConfigs } });
    sessions.delete(ctx.from.id);
    await ctx.reply("GP link အသစ်ကို သိမ်းပြီးပါပြီ။ 5 စက္ကန့်နောက်တွင် ပြန် join စတင်ပါမယ်။");
    scheduleJoinJob(job._id, 5000);
    return;
  }
  if (state.step === "topupAmount") {
    const amount = parseAmount(ctx.message.text);
    if (!Number.isInteger(amount) || amount < 1000) return ctx.reply("English number သာ ပို့ပေးပါ။ အနည်းဆုံး 1000 ဖြစ်ရပါမယ်။ ဥပမာ: 1000 သို့မဟုတ် 1000 Ks");
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
    return ctx.reply(`${amount} Ks top-up request တင်ပြီးပါပြီ။\n\n${state.method}-${phone}\nName-${accountName}\n\nယခု အကောင့်ကို ငွေလွှဲပါ။ ထို့နောက် ပြေစာပို့ပါ။`);
  }
  if (state.step === "topupReceipt") return ctx.reply("ငွေလွှဲပြီးသော ပြေစာ screenshot/photo သို့မဟုတ် .jpg/.png file ကို ပို့ပါ။");
  await expireSubscriptions();
  const subscription = await db.collection("subscriptions").findOne({ _id: state.subscriptionId, userId: ctx.from.id, status: "active", expiresAt: { $gt: now() } });
  if (!subscription) { sessions.delete(ctx.from.id); return ctx.reply("Active plan မရှိတော့ပါ။", mainMenu); }
  if (state.step === "gpCount") {
    const count = Number(ctx.message.text.trim());
    if (!Number.isInteger(count) || count < 1 || count > 8) return ctx.reply("အနည်းဆုံး 1 မှ အများဆုံး 8 ထိပဲ ရေးပေးပါ။");
    const gpCounts = [...(state.gpCounts || [])];
    gpCounts[state.accountIndex] = count;
    sessions.set(ctx.from.id, { ...state, step: "accountTargets", gpCounts, gpCount: count, currentCount: 0 });
    return ctx.reply(`Account ${state.accountIndex + 1} အတွက် public GP link များ ပို့ပေးပါ။\nအနည်းဆုံး 1 ခုမှ အများဆုံး ${count} ခု ပို့ပါ။\nComma (,) ခံပြီး ပို့ပါ။\nဥပမာ: https://t.me/sellingggp,https://t.me/sellingmyanmargp`);
  }
  if (state.step === "accountTargets") {
    const expectedCount = state.gpCounts?.[state.accountIndex] || state.gpCount;
    const links = ctx.message.text.split(",").map(value => value.trim()).filter(Boolean);
    if (links.length !== expectedCount) return ctx.reply(`Account ${state.accountIndex + 1} အတွက် GP link ${expectedCount} ခုတိတိ ပို့ပါ။ User account link မဟုတ်ဘဲ public GP link သာ ပို့ရပါမယ်။`);
    if (!links.every(isPublicGpLink)) return ctx.reply("Public GP link သာ ပို့ရပါမယ်။ User account link မပို့ရပါ။ ဥပမာ https://t.me/example");
    const targets = targetsFromUserLinks(links);
    const accountConfigs = [...state.accountConfigs, { accountId: state.accountIds[state.accountIndex], targets, messages: Array(targets.length).fill("") }];
    if (state.accountIndex + 1 < state.accountCount) {
      const nextIndex = state.accountIndex + 1;
      sessions.set(ctx.from.id, { ...state, step: "gpCount", accountIndex: nextIndex, accountConfigs, gpCounts });
      return ctx.reply(`Account ${state.accountIndex + 1} အတွက် GP link ${expectedCount} ခု ရပါပြီ။\nယခု Account ${nextIndex + 1} အတွက် ပို့မည့် GP အရေအတွက်ကို ပို့ပေးပါ။ (အနည်းဆုံး 1 မှ အများဆုံး 8)`);
    }
    const existingJob = await db.collection("joinJobs").findOne({ subscriptionId: subscription._id, status: { $in: ["running", "waiting"] } });
    if (existingJob) return ctx.reply("GP join job တစ်ခု လုပ်ဆောင်နေပြီးသားပါ။");
    const job = {
      userId: ctx.from.id,
      subscriptionId: subscription._id,
      accountConfigs,
      accountIndex: 0,
      targetIndex: 0,
      joinedCount: 0,
      status: "running",
      nextRunAt: now(),
      createdAt: now(),
    };
    const result = await db.collection("joinJobs").insertOne(job);
    await db.collection("subscriptions").updateOne({ _id: subscription._id }, { $set: { accountConfigs, joinJobId: result.insertedId, gpCounts } });
    await ctx.reply("GP link အားလုံးရပါပြီ။ GP များကို စတင် joined လုပ်ပါမည်။");
    scheduleJoinJob(result.insertedId, 0);
    return;
  }
  if (state.step === "messageInput") {
    const config = state.accountConfigs[state.accountIndex];
    config.messages[state.gpIndex] = ctx.message.text;
    await db.collection("subscriptions").updateOne({ _id: state.subscriptionId, status: "active" }, { $set: { accountConfigs: state.accountConfigs } });
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
  await db.collection("joinJobs").createIndex({ status: 1, nextRunAt: 1 });
  await db.collection("joinJobs").createIndex({ subscriptionId: 1, status: 1 });
  await db.collection("accounts").createIndex({ name: 1 }, { unique: true });
  await db.collection("targets").createIndex({ chatId: 1 }, { unique: true });
  await db.collection("capacitySlots").createIndex({ "lease.subscriptionId": 1 });
  await db.collection("capacityNotices").createIndex({ status: 1, runAt: 1 });
  await ensureCapacitySlots();
  http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("Telegram Bot is running"); }).listen(PORT, "0.0.0.0");
  const runtimeSettings = await db.collection("settings").findOne({ _id: "runtime" });
  sendIntervalMinutes = Number(runtimeSettings?.sendIntervalMinutes) || 20;
  await loadPlanPrices();
  await connectStoredAccounts();
  setInterval(() => expireSubscriptions().catch(error => console.error("Expiry cleanup error:", error)), 60 * 1000);
  setInterval(() => processCapacityNotices().catch(error => console.error("Capacity notice error:", error)), 60 * 1000);
  await expireSubscriptions();
  await processCapacityNotices();
  let launchAttempt = 0;
  while (true) {
    try {
      await bot.launch({ dropPendingUpdates: true });
      break;
    } catch (error) {
      launchAttempt += 1;
      console.error(`Telegram launch failed (attempt ${launchAttempt}):`, error?.stack || error);
      await sleep(Math.min(60000, 5000 * launchAttempt));
    }
  }
  await resumeRecurringSchedules().catch(error => console.error("Recurring recovery error:", error));
  await resumeJoinJobs().catch(error => console.error("Join recovery error:", error));
  console.log("Merged Telegram bot started");
}

async function startResilient() {
  try { await main(); }
  catch (error) {
    console.error("Startup error; keeping process alive for retry:", error?.stack || error);
    setTimeout(() => startResilient().catch(err => console.error("Retry startup error:", err)), 10000);
  }
}

startResilient();
process.once("SIGINT", () => { try { bot.stop("SIGINT"); } catch (error) { console.error("SIGINT stop error:", error); } });
process.once("SIGTERM", () => { try { bot.stop("SIGTERM"); } catch (error) { console.error("SIGTERM stop error:", error); } });
