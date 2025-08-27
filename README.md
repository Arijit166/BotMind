# BotMind

BotMind is a powerful, self-hosted WhatsApp bot that uses the Gemini AI model to provide intelligent, conversational responses in both private and group chats. Designed for personal use, this bot allows for seamless on/off control directly from within WhatsApp, giving you complete command over its activity without needing to touch the server.

## 🚀 Features

* **Intelligent AI Responses:** Powered by the cutting-edge Gemini AI model.
* **On/Off Control:** Activate or deactivate the bot's conversational ability via simple WhatsApp commands.
* **Group and Private Chat Support:** Works in both group settings and private chats.
* **Rate Limiting:** Prevents excessive API usage to keep costs in check.
* **Stateful Memory:** Remembers previous conversation context to provide more coherent responses.

## 🛠️ Requirements

* Node.js (v18.0.0 or higher)
* A stable internet connection
* A dedicated, always-on server for hosting (e.g., VPS, Heroku)

## ⚙️ Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/BotMind.git
   cd BotMind
   ```
2. **Install dependencies:**
    ```
    bash

    npm install
    ```
**Configure environment variables:**
Create .env and fill in your details. You will need a Gemini API key.

**Connect to WhatsApp:**
Start the bot for the first time to generate the session files. You'll need to scan a QR code with your WhatsApp app.
 ```
  bash

  npm start
```
Follow the on-screen instructions to link your WhatsApp account.
**Remember:** this bot will use your personal phone number as its identity.

## 🔑 Environment Variables

Before running the bot, make sure to configure your `.env` file with the following variables:

```env
GEMINI_API_KEY
BOT_OWNER_NUMBER
BOT_NAME="WhatsApp AI Bot"
BOT_OWNER_NAME
LOG_LEVEL=info
SESSION_PATH=./data/sessions
BOT_OWNER_SCHOOL
BOT_OWNER_COLLEGE
BOT_OWNER_RESIDENCE
BOT_OWNER_STUDY_YEAR
```

## 🤖 Usage

Once the bot is running, you can control it directly from your WhatsApp account:

**To turn the bot off:** Send the command /off in any chat with the bot.

**To turn the bot on:** Send the command /on in any chat with the bot.

Since the bot uses your personal phone number, you can issue these commands by messaging your own contact on WhatsApp.



## 📜 License

This project is licensed under the MIT License.
