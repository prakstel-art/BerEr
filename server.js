// server.js — API-сервер для AdEarn.
// Запуск: npm start   (или node server.js)
// По умолчанию слушает http://localhost:3000

require("dotenv").config({ quiet: true }); // quiet: последние версии dotenv печатают в консоль промо-ссылки — отключаем
const path = require("path");
const fs = require("fs");
const express = require("express");
const db = require("./db");
const { verifyTelegramInitData } = require("./telegramAuth");

const app = express();
app.use(express.json());

// Отдаём фронтенд (index.html) с того же сервера и того же адреса, что и
// API. Ищем файл в двух местах — сначала в папке public/ (аккуратный
// вариант), а если там нет — прямо в корне проекта (если всё загружено
// "в кучу", одним уровнем, без подпапок). Благодаря этому не нужен
// отдельный GitHub Pages — один деплой поднимает и сайт, и API сразу.
const candidatePaths = [
  path.join(__dirname, "public", "index.html"),
  path.join(__dirname, "index.html"),
];
const INDEX_FILE = candidatePaths.find((p) => fs.existsSync(p));

if (!INDEX_FILE) {
  console.error("=".repeat(60));
  console.error("ВНИМАНИЕ: не найден index.html ни в одном из мест:");
  candidatePaths.forEach((p) => console.error("  - " + p));
  console.error("Проверь, что файл index.html точно загружен в репозиторий.");
  console.error("=".repeat(60));
} else {
  console.log(`OK: найден фронтенд по пути ${INDEX_FILE}`);
  // Отдаём статику (картинки/css/js, если появятся) из той же папки,
  // где лежит index.html.
  app.use(express.static(path.dirname(INDEX_FILE)));
}

app.get("/", (req, res) => {
  if (INDEX_FILE) {
    res.sendFile(INDEX_FILE);
  } else {
    res.status(500).send(
      "index.html не найден на сервере. Проверь, что файл index.html " +
      "точно загружен в репозиторий (в корень или в папку public/)."
    );
  }
});

// Разрешаем запросы с фронтенда (в проде лучше указать конкретный домен вместо "*")
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET,POST");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const CONFIG = {
  BOT_TOKEN: process.env.BOT_TOKEN || "",
  REWARD_PER_AD: Number(process.env.REWARD_PER_AD || 0.10),
  DAILY_AD_LIMIT: Number(process.env.DAILY_AD_LIMIT || 50),
  AD_COOLDOWN_SEC: Number(process.env.AD_COOLDOWN_SEC || 20),
  MIN_WITHDRAW: Number(process.env.MIN_WITHDRAW || 50),
  ADSGRAM_SECRET: process.env.ADSGRAM_SECRET || "", // см. примечание в /reward ниже
};

/* ==========================================================================
   AUTH — вызывается фронтендом сразу при открытии мини-приложения.
   Тело запроса: { initData: Telegram.WebApp.initData }
   ========================================================================== */
app.post("/api/auth", (req, res) => {
  const { initData } = req.body;
  const tgUser = verifyTelegramInitData(initData, CONFIG.BOT_TOKEN);

  if (!tgUser) {
    return res.status(401).json({ error: "invalid_telegram_data" });
  }

  const user = db.getOrCreateUser({
    id: String(tgUser.id),
    username: tgUser.username,
    first_name: tgUser.first_name,
  });

  res.json({ user: publicUser(user) });
});

/* ==========================================================================
   ADSGRAM REWARD CALLBACK
   Это URL, который ты вставляешь в личном кабинете AdsGram в поле "Reward Url"
   для своего блока. Формат по документации AdsGram:
     https://твой-домен.ru/reward?userid=[userId]
   AdsGram сам подставит вместо [userId] Telegram ID пользователя и сделает
   GET-запрос после того, как пользователь досмотрел рекламу до конца.
   Именно здесь, а не на клиенте, должно происходить начисление в проде —
   это защищает от подделки события "просмотр окончен" на телефоне пользователя.
   ========================================================================== */
app.get("/reward", (req, res) => {
  const userId = req.query.userid;
  if (!userId) return res.status(400).send("missing userid");

  const result = db.creditAdView(String(userId), {
    rewardAmount: CONFIG.REWARD_PER_AD,
    dailyLimit: CONFIG.DAILY_AD_LIMIT,
    cooldownMs: CONFIG.AD_COOLDOWN_SEC * 1000,
  });

  // AdsGram ожидает просто 200 OK в ответ — сами детали ему не нужны.
  // Если начисление не прошло (лимит/кулдаун/юзер не найден) — всё равно
  // отвечаем 200, чтобы AdsGram не повторял запрос, но логируем причину.
  if (!result.ok) console.log(`Reward skipped for ${userId}: ${result.reason}`);
  res.sendStatus(200);
});

/* ==========================================================================
   ПРОФИЛЬ / БАЛАНС
   ========================================================================== */
app.get("/api/me", (req, res) => {
  const userId = req.query.userid;
  const user = db.getUser(String(userId));
  if (!user) return res.status(404).json({ error: "not_found" });
  res.json({ user: publicUser(user), rank: db.getUserRank(user.id) });
});

/* ==========================================================================
   ВЫВОД СРЕДСТВ
   ========================================================================== */
app.post("/api/withdraw", (req, res) => {
  const { userId, amount, method, details } = req.body;
  if (!userId || !amount || !method || !details) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const result = db.createWithdrawal({
    userId: String(userId),
    amount: Number(amount),
    method,
    details,
    minWithdraw: CONFIG.MIN_WITHDRAW,
  });

  if (!result.ok) return res.status(400).json({ error: result.reason });
  res.json({ user: publicUser(result.user), withdrawalId: result.withdrawalId });
});

app.get("/api/my-withdrawals", (req, res) => {
  const userId = req.query.userid;
  res.json({ withdrawals: db.getUserWithdrawals(String(userId)) });
});

/* ==========================================================================
   ЖИВАЯ ЛЕНТА ВЫВОДОВ И ТОП — только реальные данные из базы
   ========================================================================== */
app.get("/api/live-withdrawals", (req, res) => {
  const rows = db.getLiveWithdrawals(25).map((w) => ({
    name: maskName(w.first_name || w.username || "Пользователь"),
    amount: w.amount,
    method: w.method,
    status: w.status,
    created_at: w.created_at,
  }));
  res.json({ withdrawals: rows });
});

app.get("/api/leaderboard", (req, res) => {
  const rows = db.getLeaderboard(10).map((u) => ({
    name: maskName(u.first_name || u.username || "Пользователь"),
    total_earned: u.total_earned,
  }));
  res.json({ leaderboard: rows });
});

/* ==========================================================================
   ХЕЛПЕРЫ
   ========================================================================== */
function publicUser(u) {
  // Отдаём фронтенду только то, что ему нужно — без внутренних полей
  return {
    id: u.id,
    first_name: u.first_name,
    balance: round2(u.balance),
    total_earned: round2(u.total_earned),
    ads_watched_today: u.ads_watched_today,
    ads_watched_total: u.ads_watched_total,
    streak: u.streak,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function maskName(name) {
  // "Марина" -> "Марина К." — простая анонимизация для публичной ленты
  return name.length > 2 ? name : name + ".";
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`AdEarn API запущен на порту ${PORT}`);
  findAndSavePublicUrl();
});

// Многие хостинги (Railway, Render и т.п.) передают публичный адрес твоего
// проекта через переменную окружения. Названия отличаются от платформы к
// платформе, поэтому просматриваем все переменные и ищем похожие на URL —
// а результат и печатаем в лог, и сохраняем в файл link.txt, чтобы не
// листать логи в поисках нужной строки.
function findAndSavePublicUrl() {
  const candidates = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    const keyLooksRelevant = /url|domain|host/i.test(key);
    const valueLooksLikeUrl = /^https?:\/\//i.test(value) || /^[a-z0-9-]+\.[a-z]{2,}/i.test(value);
    if (keyLooksRelevant && valueLooksLikeUrl) {
      candidates.push(`${key} = ${value}`);
    }
  }

  const filePath = path.join(__dirname, "link.txt");
  if (candidates.length > 0) {
    const content =
      "Похоже на публичный адрес проекта (найдено в переменных окружения):\n\n" +
      candidates.join("\n") +
      "\n\nЕсли среди этого нет реальной ссылки — она не передаётся через " +
      "переменные окружения, и её нужно искать в панели хостинга вручную " +
      "(разделы Domains / Networking / Settings).\n";
    fs.writeFileSync(filePath, content);
    console.log("=".repeat(60));
    console.log("Возможный публичный адрес найден, см. также файл link.txt:");
    candidates.forEach((c) => console.log("  " + c));
    console.log("=".repeat(60));
  } else {
    fs.writeFileSync(
      filePath,
      "Не нашёл ничего похожего на публичный адрес в переменных окружения.\n" +
        "Ищи ссылку в панели хостинга вручную (разделы Domains / Networking / Settings),\n" +
        "или спроси в поддержке хостинга, как получить публичный URL для проекта.\n"
    );
    console.log("Не нашёл публичный адрес в переменных окружения — см. link.txt");
  }
}
