// telegramAuth.js — проверка подлинности данных, которые Telegram передаёт
// в window.Telegram.WebApp.initData. Это защита от того, чтобы кто-то
// подставил произвольный userId и накручивал себе баланс через API.
//
// Как это работает: Telegram подписывает initData секретным ключом,
// который получается из токена твоего бота. Мы пересчитываем подпись
// на сервере и сравниваем — если совпадает, значит запрос действительно
// пришёл из Telegram и данные не подделаны.
// Документация: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

const crypto = require("crypto");

function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) return null;

  // Необязательно, но полезно: отклонять слишком старые initData (например, старше 24 часов)
  const authDate = Number(params.get("auth_date")) * 1000;
  if (Date.now() - authDate > 24 * 60 * 60 * 1000) return null;

  const userJson = params.get("user");
  return userJson ? JSON.parse(userJson) : null;
}

module.exports = { verifyTelegramInitData };
