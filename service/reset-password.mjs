// service/reset-password.mjs — сброс пароля из терминала (для оператора сервиса).
// На случай, если супер-админ забыл свой пароль и не может войти в /admin.
// Запуск на сервере (читает .env через config):
//   node --experimental-sqlite reset-password.mjs <email> <новый-пароль>
import { Users } from './models.js';

const [, , email, password] = process.argv;
if (!email || !password) {
  process.stderr.write('Использование: node --experimental-sqlite reset-password.mjs <email> <новый-пароль>\n');
  process.exit(2);
}
if (password.length < 8) {
  process.stderr.write('Пароль должен быть не короче 8 символов.\n');
  process.exit(2);
}
const u = Users.byEmail(email);
if (!u) {
  process.stderr.write(`Пользователь с email ${email} не найден.\n`);
  process.exit(1);
}
Users.setPassword(u.id, password);
process.stdout.write(`Пароль пользователя ${email} изменён.\n`);
process.exit(0);
