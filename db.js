// db.js — вся работа с базой данных в одном месте.
//
// ВАЖНО: раньше здесь использовался встроенный модуль node:sqlite, но он
// доступен только начиная с Node.js 22.5+. Многие хостинги (в том числе
// bothost) используют более старые версии Node (например, 20.x), где
// этого модуля просто нет — оттуда ошибка ERR_UNKNOWN_BUILTIN_MODULE.
//
// Поэтому здесь — простое хранилище в одном JSON-файле (data.json).
// Это работает вообще на любой версии Node.js, без единой внешней
// зависимости. Для проекта такого размера (десятки-сотни пользователей)
// этого более чем достаточно. Когда пользователей станет много тысяч —
// стоит перейти на настоящую БД (Postgres/MySQL), но это отдельный шаг.

const fs = require("fs");
const path = require("path");

const DB_FILE = path.join(__dirname, "data.json");

function loadData() {
  if (!fs.existsSync(DB_FILE)) {
    return { users: {}, withdrawals: [], nextWithdrawalId: 1 };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (e) {
    console.error("Не удалось прочитать data.json, создаю новую базу:", e);
    return { users: {}, withdrawals: [], nextWithdrawalId: 1 };
  }
}

function saveData(data) {
  // Пишем во временный файл и переименовываем — так при сбое посреди записи
  // не остаётся повреждённый data.json.
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

let data = loadData();

function todayStr() {
  return new Date().toISOString().slice(0, 10); // "2026-07-05"
}

function resetDailyIfNeeded(user) {
  const today = todayStr();
  if (user.last_reset_date !== today) {
    const watchedYesterday = user.ads_watched_today > 0;
    user.streak = watchedYesterday ? user.streak + 1 : 0;
    user.ads_watched_today = 0;
    user.last_reset_date = today;
  }
  return user;
}

function getOrCreateUser({ id, username, first_name }) {
  id = String(id);
  let user = data.users[id];

  if (!user) {
    user = {
      id,
      username: username || null,
      first_name: first_name || null,
      balance: 0,
      total_earned: 0,
      ads_watched_total: 0,
      ads_watched_today: 0,
      last_watch_at: 0,
      last_reset_date: todayStr(),
      streak: 0,
      created_at: Date.now(),
    };
    data.users[id] = user;
  } else {
    if (username) user.username = username;
    if (first_name) user.first_name = first_name;
    resetDailyIfNeeded(user);
  }

  saveData(data);
  return user;
}

function getUser(userId) {
  const user = data.users[String(userId)];
  if (!user) return null;
  resetDailyIfNeeded(user);
  saveData(data);
  return user;
}

// Основная функция начисления награды за просмотр рекламы.
function creditAdView(userId, { rewardAmount, dailyLimit, cooldownMs }) {
  const user = getUser(userId);
  if (!user) return { ok: false, reason: "user_not_found" };

  if (user.ads_watched_today >= dailyLimit) {
    return { ok: false, reason: "daily_limit_reached" };
  }

  const now = Date.now();
  if (now - user.last_watch_at < cooldownMs) {
    return { ok: false, reason: "cooldown" };
  }

  user.balance += rewardAmount;
  user.total_earned += rewardAmount;
  user.ads_watched_total += 1;
  user.ads_watched_today += 1;
  user.last_watch_at = now;
  saveData(data);

  return { ok: true, user };
}

function createWithdrawal({ userId, amount, method, details, minWithdraw }) {
  const user = getUser(userId);
  if (!user) return { ok: false, reason: "user_not_found" };
  if (amount < minWithdraw) return { ok: false, reason: "below_minimum" };
  if (amount > user.balance) return { ok: false, reason: "insufficient_balance" };

  user.balance -= amount;

  const withdrawal = {
    id: data.nextWithdrawalId++,
    user_id: user.id,
    amount,
    method,
    details,
    status: "pending",
    created_at: Date.now(),
  };
  data.withdrawals.unshift(withdrawal);
  saveData(data);

  return { ok: true, withdrawalId: withdrawal.id, user };
}

function getUserWithdrawals(userId, limit = 20) {
  return data.withdrawals
    .filter((w) => w.user_id === String(userId))
    .slice(0, limit);
}

// Живая лента выводов — только реальные записи из базы, с других
// пользователей. Никаких сгенерированных данных.
function getLiveWithdrawals(limit = 25) {
  return data.withdrawals.slice(0, limit).map((w) => {
    const u = data.users[w.user_id] || {};
    return {
      amount: w.amount,
      method: w.method,
      status: w.status,
      created_at: w.created_at,
      first_name: u.first_name,
      username: u.username,
    };
  });
}

function getLeaderboard(limit = 10) {
  return Object.values(data.users)
    .sort((a, b) => b.total_earned - a.total_earned)
    .slice(0, limit)
    .map((u) => ({
      id: u.id,
      first_name: u.first_name,
      username: u.username,
      total_earned: u.total_earned,
    }));
}

function getUserRank(userId) {
  const user = data.users[String(userId)];
  if (!user) return null;
  const better = Object.values(data.users).filter(
    (u) => u.total_earned > user.total_earned
  ).length;
  return better + 1;
}

module.exports = {
  getOrCreateUser,
  getUser,
  creditAdView,
  createWithdrawal,
  getUserWithdrawals,
  getLiveWithdrawals,
  getLeaderboard,
  getUserRank,
};
