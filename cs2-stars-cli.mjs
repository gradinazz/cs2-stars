import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

import SessionManager from './src/backend/SessionManager.js';
import ArmoryManager from './src/backend/ArmoryManager.js';
import SteamClient from './src/backend/SteamClient.js';
import SchemaResolver from './src/backend/SchemaResolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const ITEMS_DB_PATH = path.join(__dirname, 'src', 'backend', 'items_database.json');
const SCHEMA_PATH = path.join(__dirname, 'schema.json');

const schemaResolver = new SchemaResolver(SCHEMA_PATH);

const TIMEOUTS = {
    steamLogonMs: 30000,
    gcConnectMs: 8000,
    starsWaitMs: 2500,
    disconnectDelayMs: 500,
};

const isWin = process.platform === 'win32';
const winBuild = isWin ? Number(String(os.release()).split('.')[2] || 0) : 0;
const isWindowsTerminal = Boolean(process.env.WT_SESSION);
const isVSCodeTerminal = process.env.TERM_PROGRAM === 'vscode';
const isConEmu = process.env.ConEmuANSI === 'ON';
const isAnsiCon = Boolean(process.env.ANSICON);

const supportsEmoji = !isWin ? true : winBuild >= 22000 || isWindowsTerminal || isVSCodeTerminal || isConEmu || isAnsiCon;

const ICONS = {
    star: supportsEmoji ? '⭐' : '*',
    success: supportsEmoji ? '✅' : '[OK]',
    error: supportsEmoji ? '❌' : '[X]',
    warning: supportsEmoji ? '⚠️' : '[!]',
    loading: supportsEmoji ? '⏳' : '[...]',
};

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function rlCreate() {
    return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, q) {
    return new Promise((resolve) => rl.question(q, (ans) => resolve(ans.trim())));
}

function clearScreen() {
    console.log('\x1Bc');
}

function banner() {
    clearScreen();
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║               CS2 STARS SHOP MANAGER v1.0                      ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('');
}

function ensureSessionsDir() {
    if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function safeJsonParse(raw, fallback) {
    try {
        if (!raw || !String(raw).trim()) return fallback;
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function loadItemsDb() {
    if (!fs.existsSync(ITEMS_DB_PATH)) return { items: [] };

    const raw = fs.readFileSync(ITEMS_DB_PATH, 'utf8');
    const parsed = safeJsonParse(raw, null);

    if (!parsed) return { items: [] };
    if (Array.isArray(parsed)) return { items: parsed };
    if (Array.isArray(parsed.items)) return { items: parsed.items };
    return { items: [] };
}

function normalizeItem(it, idx) {
    const id = it.id ?? it.armoryId ?? it.armoryid ?? idx + 1;
    const name = it.name ?? it.title ?? it.market_hash_name ?? it.market_hashname ?? `Item ${id}`;
    const price = Number(it.price ?? it.cost ?? it.stars ?? it.starPrice ?? 0);
    const armoryId = Number(it.armoryId ?? it.armoryid ?? it.id ?? 0);
    return { id, name, price, armoryId };
}

function printMenuAccounts(accounts) {
    console.log('═══════════════════ АККАУНТЫ ═══════════════════');
    accounts.forEach((a, i) => console.log(` [${i + 1}] ${a}`));
    console.log('');
    console.log(' [N] Добавить новый аккаунт');
    console.log(' [Q] Выход');
    console.log('════════════════════════════════════════════════');
    console.log('');
}

function printItems(items, balance) {
    console.log('');
    console.log(`═══════════════════ ТОВАРЫ (Баланс: ${balance}${ICONS.star}) ═══════════════════`);

    items.forEach((it, i) => {
        const canBuy = balance >= it.price ? '' : ' (недостаточно звёзд)';
        console.log(` [${i + 1}] ${it.name} - ${it.price}${ICONS.star}${canBuy}`);
    });

    console.log('');
    console.log(' [B] Назад');
    console.log('════════════════════════════════════════════════════════════');
    console.log('');
}

function toInt(s) {
    const n = Number.parseInt(String(s), 10);
    return Number.isFinite(n) ? n : null;
}

function parseItemFromGC(item) {
    const defindex = item?.defindex ?? item?.def_index;
    if (defindex == null) return { type: 'unknown', name: 'Unknown Item', floatValue: null, paintSeed: null, rarity: 0 };

    let paintindex = null;
    let paintwear = null;
    let paintseed = null;
    let charmId = null;
    let charmPattern = null;
    let stickerId = null;

    const attrs = item?.attribute;
    if (Array.isArray(attrs)) {
        for (const attr of attrs) {
            const valueHex = attr?.valuebytes ?? attr?.value_bytes;
            if (!valueHex) continue;

            const buf = Buffer.from(valueHex, 'hex');
            const attrDef = attr?.defindex ?? attr?.def_index;

            switch (attrDef) {
                case 6:
                    paintindex = Math.floor(buf.readFloatLE(0));
                    break;
                case 7:
                    paintseed = buf.readUInt32LE(0) % 1000;
                    break;
                case 8:
                    paintwear = buf.readFloatLE(0);
                    break;
                case 113:
                    stickerId = buf.readUInt32LE(0);
                    break;
                case 299:
                    charmId = buf.readUInt32LE(0);
                    break;
                case 306:
                    charmPattern = buf.readUInt32LE(0);
                    break;
                default:
                    break;
            }
        }
    }

    if (paintindex !== null && paintindex > 0) {
        const weaponData = schemaResolver.schema?.weapons?.[String(defindex)];
        const weaponName = weaponData?.name || `Weapon #${defindex}`;
        const skinData = weaponData?.paints?.[String(paintindex)];
        const skinName = skinData?.name || `Skin #${paintindex}`;

        const exterior = schemaResolver.resolveExterior({ defindex, paintindex, paintwear });
        const displayName = `${weaponName} | ${skinName}${exterior ? ` (${exterior})` : ''}`;
        const rarity = skinData?.rarity ?? 0;

        return { type: 'weapon', name: displayName, floatValue: paintwear, paintSeed: paintseed, rarity };
    }

    if (charmId !== null) {
        const charmData = schemaResolver.schema?.keychains?.[String(charmId)];
        const charmName = charmData?.market_hash_name || charmData?.markethashname || `Unknown Charm (ID: ${charmId})`;
        const displayName = charmPattern != null ? `${charmName} #${charmPattern}` : charmName;
        return { type: 'charm', name: displayName, floatValue: null, paintSeed: charmPattern, rarity: 0 };
    }

    if (stickerId !== null) {
        const stickerData = schemaResolver.schema?.stickers?.[String(stickerId)];
        const stickerName = stickerData?.market_hash_name || stickerData?.markethashname || `Unknown Sticker (ID: ${stickerId})`;
        return { type: 'sticker', name: stickerName, floatValue: null, paintSeed: null, rarity: 0 };
    }

    if (schemaResolver.schema?.containers?.[String(defindex)]) {
        const containerData = schemaResolver.schema.containers[String(defindex)];
        return {
            type: 'container',
            name: containerData.market_hash_name || containerData.markethashname || `Container #${defindex}`,
            floatValue: null,
            paintSeed: null,
            rarity: 0,
        };
    }

    return {
        type: 'unknown',
        name: `Unknown Item (defindex: ${defindex})`,
        floatValue: paintwear,
        paintSeed: paintseed,
        rarity: 0,
    };
}

async function addNewAccountFlow(rl) {
    banner();
    console.log('═══════════════════ ДОБАВЛЕНИЕ АККАУНТА ═══════════════════');
    console.log('');

    const username = await ask(rl, 'Логин Steam: ');
    if (!username) {
        console.log(`${ICONS.error} Логин обязателен`);
        await ask(rl, '\nНажмите Enter для продолжения...');
        return null;
    }

    const password = await ask(rl, 'Пароль: ');
    if (!password) {
        console.log(`${ICONS.error} Пароль обязателен`);
        await ask(rl, '\nНажмите Enter для продолжения...');
        return null;
    }

    const twoFactorCode = await ask(rl, 'Код Steam Guard: ');
    if (!twoFactorCode) {
        console.log(`${ICONS.error} Код Steam Guard обязателен`);
        await ask(rl, '\nНажмите Enter для продолжения...');
        return null;
    }

    console.log(`\n${ICONS.loading} Авторизация...`);

    const sc = new SteamClient(username);
    try {
        const refreshToken = await sc.loginWithCredentials({
            username,
            password,
            twoFactorCode,
            timeoutMs: 60000,
        });

        SessionManager.saveSession(username, refreshToken);

        console.log(`${ICONS.success} Авторизация успешна`);
        console.log(`${ICONS.success} Аккаунт "${username}" добавлен`);

        await ask(rl, '\nНажмите Enter для продолжения...');
        return username;
    } catch (e) {
        console.log(`${ICONS.error} Ошибка авторизации: ${e?.message || e}`);
        await ask(rl, '\nНажмите Enter для продолжения...');
        return null;
    } finally {
        sc.disconnect();
        await wait(TIMEOUTS.disconnectDelayMs);
    }
}

async function selectAccountFlow(rl) {
    while (true) {
        banner();
        const accounts = SessionManager.listAccounts();
        printMenuAccounts(accounts);

        const input = (await ask(rl, 'Выберите аккаунт: ')).toLowerCase();

        if (input === 'q' || input === 'quit' || input === 'exit') return null;

        if (input === 'n' || input === 'new') {
            await addNewAccountFlow(rl);
            continue;
        }

        const pick = toInt(input);
        if (pick === null) continue;

        const idx = pick - 1;
        if (idx < 0 || idx >= accounts.length) continue;

        return accounts[idx];
    }
}

async function getStarsAutoDetailed(username) {
    const sc = new SteamClient(username);

    try {
        await sc.connect({ steamTimeoutMs: TIMEOUTS.steamLogonMs, gcTimeoutMs: TIMEOUTS.gcConnectMs });
        const stars = await sc.getStars({ timeoutMs: TIMEOUTS.starsWaitMs });
        if (stars == null) throw new Error('Stars not received');
        return { ok: true, stars, note: null };
    } catch (e) {
        const msg = e?.message || String(e);

        if (
            msg.includes('Invalid') ||
            msg.includes('JWT') ||
            msg.includes('AccessDenied') ||
            msg.includes('InvalidPassword') ||
            msg.includes('Session file not found')
        ) {
            SessionManager.deleteSession(username);
            return { ok: false, stars: 0, note: 'INVALID_TOKEN' };
        }

        if (msg.includes('GC connection timeout') || msg.includes('Stars not received')) {
            return { ok: false, stars: 0, note: 'GC недоступен, баланс неизвестен' };
        }

        if (msg.includes('LogonSessionReplaced')) {
            return { ok: false, stars: 0, note: 'Сессия заменена другим входом (LogonSessionReplaced)' };
        }

        return { ok: false, stars: 0, note: 'Не удалось получить баланс' };
    } finally {
        sc.disconnect();
        await wait(TIMEOUTS.disconnectDelayMs);
    }
}

async function reauthFlow(rl, username) {
    console.log(`${ICONS.error} Сессия устарела. Требуется повторная авторизация.`);
    SessionManager.deleteSession(username);

    const reauth = await ask(rl, '\nАвторизоваться заново? (y/n): ');
    if (!/^y(es)?$/i.test(reauth)) return false;

    const password = await ask(rl, 'Пароль: ');
    const twoFactorCode = await ask(rl, 'Код Steam Guard: ');

    if (!password || !twoFactorCode) {
        console.log(`${ICONS.error} Данные не введены`);
        await ask(rl, '\nНажмите Enter для продолжения...');
        return false;
    }

    console.log(`${ICONS.loading} Авторизация...`);

    const sc = new SteamClient(username);
    try {
        const refreshToken = await sc.loginWithCredentials({
            username,
            password,
            twoFactorCode,
            timeoutMs: 60000,
        });

        SessionManager.saveSession(username, refreshToken);
        console.log(`${ICONS.success} Авторизация успешна!`);
        await wait(600);
        return true;
    } catch (e) {
        console.log(`${ICONS.error} Ошибка авторизации: ${e?.message || e}`);
        await ask(rl, '\nНажмите Enter для продолжения...');
        return false;
    } finally {
        sc.disconnect();
        await wait(TIMEOUTS.disconnectDelayMs);
    }
}

async function buyFlow(rl, username, items) {
    banner();
    console.log(`Аккаунт: ${username}`);
    console.log(`${ICONS.loading} Получение баланса звёзд...`);

    let starsInfo = await getStarsAutoDetailed(username);

    if (!starsInfo.ok && starsInfo.note === 'INVALID_TOKEN') {
        const ok = await reauthFlow(rl, username);
        if (!ok) return;

        banner();
        console.log(`Аккаунт: ${username}`);
        console.log(`${ICONS.loading} Получение баланса звёзд...`);
        starsInfo = await getStarsAutoDetailed(username);
    }

    if (!starsInfo.ok) {
        banner();
        console.log(`Аккаунт: ${username}`);
        console.log(`${ICONS.warning} ${starsInfo.note}`);
        await ask(rl, '\nНажмите Enter чтобы вернуться назад...');
        return;
    }

    if (!items.length) {
        console.log(`${ICONS.warning} Товары не загружены`);
        await ask(rl, '\nНажмите Enter для продолжения...');
        return;
    }

    let currentStars = starsInfo.stars;

    while (true) {
        banner();
        console.log(`Аккаунт: ${username}`);
        printItems(items, currentStars);

        const input = (await ask(rl, 'Выберите товар: ')).toLowerCase();
        if (input === 'b' || input === 'back') return;

        const pick = toInt(input);
        if (pick === null) continue;

        const item = items[pick - 1];
        if (!item) continue;

        const qty = toInt(await ask(rl, `Количество "${item.name}" (цена ${item.price}${ICONS.star}): `));
        if (qty === null || qty <= 0) continue;

        const totalCost = item.price * qty;

        console.log('');
        console.log(`Итого: ${qty} × ${item.price}${ICONS.star} = ${totalCost}${ICONS.star}`);

        if (totalCost > currentStars) {
            console.log(`${ICONS.warning} Недостаточно звёзд`);
            await ask(rl, '\nНажмите Enter для продолжения...');
            continue;
        }

        const confirm = await ask(rl, 'Подтвердить покупку? (y/n): ');
        if (!/^y(es)?$/i.test(confirm)) continue;

        console.log('');
        console.log(`${ICONS.loading} Покупка...`);

        let starsLeft = currentStars;
        const results = [];

        for (let i = 0; i < qty; i++) {
            try {
                const r = await ArmoryManager.purchaseItem(username, item.armoryId, starsLeft, item.price);
                starsLeft = r?.newStars ?? starsLeft - item.price;

                const itemInfo = parseItemFromGC(r?.item);
                results.push({ ok: true, itemInfo, starsLeft });

                let line = itemInfo.name;
                if (itemInfo.floatValue !== null) line += ` | Float: ${itemInfo.floatValue.toFixed(9)}`;
                if (itemInfo.paintSeed !== null && itemInfo.type === 'weapon') line += ` | Seed: ${itemInfo.paintSeed}`;

                console.log(`${ICONS.success} #${i + 1}: ${line}, осталось ${starsLeft}${ICONS.star}`);
            } catch (e) {
                const msg = e?.message || String(e);

                if (msg.includes('LogonSessionReplaced')) {
                    console.log(`${ICONS.error} Сессия заменена другим входом (LogonSessionReplaced).`);
                    console.log(`${ICONS.warning} Закрой Steam-клиент/другие боты на этом аккаунте и повтори.`);
                } else {
                    console.log(`${ICONS.error} #${i + 1}: ${msg}`);
                }

                results.push({ ok: false, error: msg });
                break;
            }
        }

        console.log('');
        console.log('═══════════════════ РЕЗУЛЬТАТ ═══════════════════');
        console.log(`Аккаунт: ${username}`);
        console.log(`Товар: ${item.name}`);
        console.log(`Осталось звёзд: ${starsLeft}${ICONS.star}`);
        console.log('');

        const successResults = results.filter((x) => x.ok);
        if (successResults.length > 0) {
            const grouped = {};
            const weapons = [];

            for (const r of successResults) {
                const info = r.itemInfo;
                if (info.type === 'weapon') weapons.push(info);
                else {
                    if (!grouped[info.name]) grouped[info.name] = { count: 0, rarity: info.rarity ?? 0 };
                    grouped[info.name].count++;
                }
            }

            weapons.sort((a, b) => (b.rarity ?? 0) - (a.rarity ?? 0));

            const groupedEntries = Object.entries(grouped).sort((a, b) => (b[1].rarity ?? 0) - (a[1].rarity ?? 0));
            for (const [name, data] of groupedEntries) console.log(`${ICONS.success} ${name} × ${data.count}`);

            for (const w of weapons) {
                let line = w.name;
                if (w.floatValue !== null) line += ` | Float: ${w.floatValue.toFixed(9)}`;
                if (w.paintSeed !== null) line += ` | Seed: ${w.paintSeed}`;
                console.log(`${ICONS.success} ${line}`);
            }
        }

        const failedCount = results.filter((x) => !x.ok).length;
        if (failedCount > 0) console.log(`${ICONS.error} Ошибок: ${failedCount}`);

        currentStars = starsLeft;

        console.log('═════════════════════════════════════════════════');
        const again = await ask(rl, '\nКупить ещё? (y/n): ');
        if (!/^y(es)?$/i.test(again)) return;
    }
}

async function main() {
    ensureSessionsDir();
    SessionManager.configureBaseDir(SESSIONS_DIR);

    try {
        schemaResolver.init();
    } catch (e) {
        console.log(`${ICONS.error} Не удалось загрузить схему: ${e?.message || e}`);
        process.exit(1);
    }

    const { items } = loadItemsDb();
    const normalizedItems = items.map(normalizeItem).filter((x) => x.armoryId && x.price > 0);

    const rl = rlCreate();

    try {
        while (true) {
            const username = await selectAccountFlow(rl);
            if (username === null) {
                banner();
                console.log('До свидания!');
                rl.close();
                process.exit(0);
            }

            await buyFlow(rl, username, normalizedItems);
        }
    } finally {
        rl.close();
        process.exit(0);
    }
}

main().catch((e) => {
    console.error('FATAL:', e?.message || e);
    process.exit(1);
});
