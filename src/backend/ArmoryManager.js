import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import SteamUser from 'steam-user';
import GlobalOffensive from 'globaloffensive';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_ID = 730;
const MSG_GC_REDEEM = 9209;
const MSG_ESO_CREATE = 21;

const PURCHASE_TIMEOUT_MS = 30000;

class ArmoryManager {
    readVarint(buffer, offset) {
        let result = 0n;
        let shift = 0n;
        let bytesRead = 0;

        while (true) {
            if (offset + bytesRead >= buffer.length) return null;
            const b = BigInt(buffer[offset + bytesRead]);
            result |= (b & 0x7fn) << shift;
            shift += 7n;
            bytesRead++;
            if ((b & 0x80n) === 0n) break;
        }

        return { value: result, bytesRead };
    }

    encodeVarint(n) {
        let x = typeof n === 'bigint' ? n : BigInt(n);
        const out = [];

        while (x >= 0x80n) {
            out.push(Number((x & 0x7fn) | 0x80n));
            x >>= 7n;
        }

        out.push(Number(x));
        return Buffer.from(out);
    }

    encodeRedeemBody(armoryId, stars, price) {
        const values = [11, armoryId, stars, price];
        const chunks = [];

        for (let i = 0; i < values.length; i++) {
            const fieldNumber = i + 1;
            const tag = (fieldNumber << 3) | 0;
            chunks.push(this.encodeVarint(tag));
            chunks.push(this.encodeVarint(BigInt(values[i])));
        }

        return Buffer.concat(chunks);
    }

    readField(buffer, offset) {
        const tagData = this.readVarint(buffer, offset);
        if (!tagData) return null;

        const tag = Number(tagData.value);
        const fieldNumber = tag >> 3;
        const wireType = tag & 0x07;

        let cursor = offset + tagData.bytesRead;

        if (wireType === 0) {
            const v = this.readVarint(buffer, cursor);
            if (!v) return null;
            cursor += v.bytesRead;
            return { fieldNumber, wireType, value: v.value, nextOffset: cursor };
        }

        if (wireType === 2) {
            const len = this.readVarint(buffer, cursor);
            if (!len) return null;

            cursor += len.bytesRead;
            const l = Number(len.value);

            const start = cursor;
            const end = cursor + l;
            if (end > buffer.length) return null;

            cursor = end;
            return { fieldNumber, wireType, value: buffer.subarray(start, end), nextOffset: cursor };
        }

        if (wireType === 5) {
            if (cursor + 4 > buffer.length) return null;
            cursor += 4;
            return { fieldNumber, wireType, value: null, nextOffset: cursor };
        }

        if (wireType === 1) {
            if (cursor + 8 > buffer.length) return null;
            cursor += 8;
            return { fieldNumber, wireType, value: null, nextOffset: cursor };
        }

        return null;
    }

    findVarint(buffer, wantedField) {
        let offset = 0;

        while (offset < buffer.length) {
            const f = this.readField(buffer, offset);
            if (!f) return null;

            offset = f.nextOffset;

            if (f.wireType === 0 && f.fieldNumber === wantedField) {
                return Number(f.value);
            }
        }

        return null;
    }

    parseAttribute(buffer) {
        const attr = { def_index: null, value_bytes: null };
        let offset = 0;

        while (offset < buffer.length) {
            const f = this.readField(buffer, offset);
            if (!f) break;

            offset = f.nextOffset;

            if (f.fieldNumber === 1 && f.wireType === 0) {
                attr.def_index = Number(f.value);
            }

            if (f.fieldNumber === 3 && f.wireType === 2 && Buffer.isBuffer(f.value)) {
                attr.value_bytes = f.value.toString('hex');
            }
        }

        return attr.def_index !== null ? attr : null;
    }

    parseCSOEconItem(buffer) {
        const item = { def_index: null, attribute: [] };
        let offset = 0;

        while (offset < buffer.length) {
            const f = this.readField(buffer, offset);
            if (!f) break;

            offset = f.nextOffset;

            if (f.fieldNumber === 4 && f.wireType === 0) {
                item.def_index = Number(f.value);
            }

            if (f.fieldNumber === 12 && f.wireType === 2 && Buffer.isBuffer(f.value)) {
                const attr = this.parseAttribute(f.value);
                if (attr) item.attribute.push(attr);
            }
        }

        return item.def_index ? item : null;
    }

    findDefIndexDeep(buffer) {
        const direct = this.findVarint(buffer, 4);
        if (direct != null && direct > 0) return direct;

        let offset = 0;

        while (offset < buffer.length) {
            const f = this.readField(buffer, offset);
            if (!f) return null;

            offset = f.nextOffset;

            if (f.wireType === 2 && Buffer.isBuffer(f.value) && f.value.length > 0) {
                const inner = this.findDefIndexDeep(f.value);
                if (inner != null && inner > 0) return inner;
            }
        }

        return null;
    }

    findCSOEconItem(buffer) {
        const direct = this.parseCSOEconItem(buffer);
        if (direct && direct.def_index) return direct;

        let offset = 0;

        while (offset < buffer.length) {
            const f = this.readField(buffer, offset);
            if (!f) break;

            offset = f.nextOffset;

            if (f.wireType === 2 && Buffer.isBuffer(f.value) && f.value.length > 0) {
                const item = this.findCSOEconItem(f.value);
                if (item && item.def_index) return item;
            }
        }

        return null;
    }

    async purchaseItem(username, armoryId, currentStars, itemPrice) {
        return new Promise((resolve, reject) => {
            const sessionFile = path.join(__dirname, '../../sessions', `${username}.steamsession`);
            if (!fs.existsSync(sessionFile)) return reject(new Error('Session file not found'));

            const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

            const client = new SteamUser();
            const csgo = new GlobalOffensive(client);

            let settled = false;

            const settle = (err, ok, data) => {
                if (settled) return;
                settled = true;

                clearTimeout(timeout);

                try {
                    client.removeAllListeners();
                } catch {}
                try {
                    csgo.removeAllListeners();
                } catch {}

                try {
                    client.gamesPlayed([]);
                } catch {}
                try {
                    client.logOff();
                } catch {}

                if (ok) resolve(data);
                else reject(err);
            };

            const timeout = setTimeout(() => {
                settle(new Error('Purchase timeout'), false);
            }, PURCHASE_TIMEOUT_MS);

            client.on('error', (e) => settle(e, false));
            client.on('disconnected', () => settle(new Error('Disconnected'), false));

            client.on('loggedOn', () => {
                try {
                    client.setPersona(SteamUser.EPersonaState.Online);
                    client.gamesPlayed([APP_ID]);
                } catch {}
            });

            csgo.on('connectedToGC', () => {
                const body = this.encodeRedeemBody(armoryId, currentStars, itemPrice);
                client.sendToGC(APP_ID, MSG_GC_REDEEM, {}, body);
            });

            client.on('receivedFromGC', (appid, msgType, payload) => {
                if (appid !== APP_ID) return;
                if (msgType !== MSG_ESO_CREATE) return;

                const item = this.findCSOEconItem(payload);
                if (!item || !item.def_index) return settle(new Error('Could not parse CSOEconItem'), false);

                settle(null, true, {
                    success: true,
                    defIndex: item.def_index,
                    newStars: currentStars - itemPrice,
                    item,
                });
            });

            client.logOn({ refreshToken: sessionData.DesktopRefreshToken });
        });
    }
}

export default new ArmoryManager();
