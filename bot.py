import os
from datetime import datetime
from zoneinfo import ZoneInfo

from pymongo import MongoClient, ASCENDING
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup, Update
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

BOT_TOKEN = os.getenv("BOT_TOKEN")
MONGODB_URI = os.getenv("MONGODB_URI")
DB_NAME = os.getenv("DB_NAME", "automessage_bot")

if not BOT_TOKEN:
    raise RuntimeError("BOT_TOKEN environment variable is missing")
if not MONGODB_URI:
    raise RuntimeError("MONGODB_URI environment variable is missing")

mongo_client = MongoClient(MONGODB_URI)
database = mongo_client[DB_NAME]
users = database["users"]
users.create_index([("telegram_id", ASCENDING)], unique=True)

main_menu = ReplyKeyboardMarkup(
    [["PLANS", "Balance"], ["Msg", "GP", "Time"]],
    resize_keyboard=True,
)

plans_menu = InlineKeyboardMarkup(
    [
        [InlineKeyboardButton("1 Account", callback_data="plan_1")],
        [InlineKeyboardButton("2 Account", callback_data="plan_2")],
        [InlineKeyboardButton("5 Account", callback_data="plan_5")],
    ]
)


def user_display_name(update: Update) -> str:
    user = update.effective_user
    if not user:
        return "User"
    return f"@{user.username}" if user.username else user.first_name


def save_user(update: Update) -> dict | None:
    user = update.effective_user
    if not user:
        return None

    now = datetime.utcnow()
    users.update_one(
        {"telegram_id": user.id},
        {
            "$set": {
                "username": user.username,
                "first_name": user.first_name,
                "updated_at": now,
            },
            "$setOnInsert": {
                "telegram_id": user.id,
                "balance": 0,
                "created_at": now,
            },
        },
        upsert=True,
    )
    return users.find_one({"telegram_id": user.id})


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    save_user(update)
    await update.message.reply_text(
        f"မဂ်လာပါ {user_display_name(update)} ရေ!!\n"
        "Automessage bot မှ ကြိုဆိုပါတယ်",
        reply_markup=main_menu,
    )


async def plans_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    save_user(update)
    await update.message.reply_text(
        "Plans အမျိုးအစားများကို ရွေးချယ်ပါ",
        reply_markup=plans_menu,
    )


async def balance_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = save_user(update)
    balance = user.get("balance", 0) if user else 0
    await update.message.reply_text(
        f"သင့်ရဲ့ Balance မှာ {balance} ဖြစ်ပါတယ်။",
        reply_markup=main_menu,
    )


async def msg_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    save_user(update)
    await update.message.reply_text(
        "Msg menu ကို မကြာမီ ထည့်သွင်းပေးပါမယ်။",
        reply_markup=main_menu,
    )


async def gp_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    save_user(update)
    await update.message.reply_text(
        "GP menu ကို မကြာမီ ထည့်သွင်းပေးပါမယ်။",
        reply_markup=main_menu,
    )


async def time_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    save_user(update)
    myanmar_time = datetime.now(ZoneInfo("Asia/Yangon")).strftime("%Y-%m-%d %H:%M:%S")
    await update.message.reply_text(
        f"လက်ရှိအချိန်: {myanmar_time}",
        reply_markup=main_menu,
    )


async def plan_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    save_user(update)

    account_count = query.data.replace("plan_", "")
    await query.message.reply_text(
        f"{account_count} Account plan ကို ရွေးချယ်ထားပါတယ်။",
        reply_markup=main_menu,
    )


async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    print(f"Bot error: {context.error}")


def main() -> None:
    application = Application.builder().token(BOT_TOKEN).build()

    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(MessageHandler(filters.Regex(r"^PLANS$"), plans_message))
    application.add_handler(MessageHandler(filters.Regex(r"^Balance$"), balance_message))
    application.add_handler(MessageHandler(filters.Regex(r"^Msg$"), msg_message))
    application.add_handler(MessageHandler(filters.Regex(r"^GP$"), gp_message))
    application.add_handler(MessageHandler(filters.Regex(r"^Time$"), time_message))
    application.add_handler(CallbackQueryHandler(plan_callback, pattern=r"^plan_(1|2|5)$"))
    application.add_error_handler(error_handler)

    print("Telegram bot is running with MongoDB...")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
