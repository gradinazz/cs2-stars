import SteamUser from 'steam-user';
import GlobalOffensive from 'globaloffensive';
import SessionManager from './SessionManager.js';

const APP_ID = 730;
const MSG_CLIENT_WELCOME = 4004;

function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function once(emitter, event) {
    return new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));
}

function readVarint(buffer, offset) {
    let result = 0;
    let shift = 0;
    let bytesRead = 0;

    while (true) {
        if (offset + bytesRead >= buffer.length) return null;
        const b = buffer[offset + bytesRead];
        result |= (b & 0x7f) << shift;
        shift += 7;
        bytesRead++;
        if ((b & 0x80) === 0) break;
    }

    return { value: result, bytesRead };
}

function skipByWireType(buf, offset, wireType) {
    if (wireType === 0) {
        const v = readVarint(buf, offset);
        if (!v) return null;
        return offset + v.bytesRead;
    }
    if (wireType === 2) {
        const len = readVarint(buf, offset);
        if (!len) return null;
        return offset + len.bytesRead + len.value;
    }
    if (wireType === 5) return offset + 4;
    if (wireType === 1) return offset + 8;
    return null;
}

function parseType6ObjectDataForStars(objectData) {
    if (!objectData || objectData.length === 0) return null;

    let offset = 0;
    let stars = null;

    while (offset < objectData.length) {
        const tagData = readVarint(objectData, offset);
        if (!tagData) break;

        offset += tagData.bytesRead;
        const tag = tagData.value;

        const fieldNumber = tag >> 3;
        const wireType = tag & 0x07;

        if (wireType === 0) {
            const v = readVarint(objectData, offset);
            if (!v) break;

            offset += v.bytesRead;

            if (fieldNumber === 2) {
                const n = v.value;
                if (Number.isFinite(n) && n >= 0 && n <= 5000) stars = n;
            }
        } else {
            const next = skipByWireType(objectData, offset, wireType);
            if (next == null) break;
            offset = next;
        }
    }

    return stars;
}

function findStarsInCache(buffer) {
    let offset = 0;
    let foundTypeId = null;
    let objectData = null;

    while (offset < buffer.length) {
        const tagData = readVarint(buffer, offset);
        if (!tagData) break;

        offset += tagData.bytesRead;
        const tag = tagData.value;

        const fieldNumber = tag >> 3;
        const wireType = tag & 0x07;

        if (wireType === 0) {
            const v = readVarint(buffer, offset);
            if (!v) break;
            offset += v.bytesRead;

            if (fieldNumber === 1) foundTypeId = v.value;
        } else if (wireType === 2) {
            const len = readVarint(buffer, offset);
            if (!len) break;
            offset += len.bytesRead;

            const l = len.value;
            const fieldData = buffer.subarray(offset, offset + l);
            offset += l;

            if (fieldNumber === 2 || fieldNumber === 3) objectData = fieldData;

            const inner = findStarsInCache(fieldData);
            if (inner !== null) return inner;
        } else {
            const next = skipByWireType(buffer, offset, wireType);
            if (next == null) break;
            offset = next;
        }
    }

    if (foundTypeId === 6 && objectData) {
        const stars = parseType6ObjectDataForStars(objectData);
        if (stars !== null) return stars;
    }

    return null;
}

function parseClientWelcomeManual(payload) {
    if (!payload || payload.length === 0) return null;

    let offset = 0;

    while (offset < payload.length) {
        const tagData = readVarint(payload, offset);
        if (!tagData) break;

        offset += tagData.bytesRead;
        const tag = tagData.value;
        const wireType = tag & 0x07;

        if (wireType === 2) {
            const len = readVarint(payload, offset);
            if (!len) break;

            offset += len.bytesRead;
            const l = len.value;

            const fieldData = payload.subarray(offset, offset + l);
            offset += l;

            const stars = findStarsInCache(fieldData);
            if (stars !== null) return stars;
        } else {
            const next = skipByWireType(payload, offset, wireType);
            if (next == null) break;
            offset = next;
        }
    }

    return null;
}

export default class SteamClient {
    constructor(username) {
        this.username = username;
        this.client = new SteamUser();
        this.csgo = new GlobalOffensive(this.client);

        this.connected = false;
        this.stars = null;

        this._gcHandlerBound = null;
        this._steamErrorHandlerBound = null;
    }

    async loginWithCredentials({ username, password, twoFactorCode, timeoutMs = 60000 }) {
        return new Promise((resolve, reject) => {
            let done = false;

            const cleanup = () => {
                this.client.removeListener('error', onError);
                this.client.removeListener('refreshToken', onRefreshToken);
                this.client.removeListener('disconnected', onDisconnected);
                this.client.removeListener('loggedOn', onLoggedOn);
            };

            const finishReject = (e) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                cleanup();
                try { this.client.logOff(); } catch {}
                reject(e);
            };

            const finishResolve = (token) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                cleanup();
                resolve(token);
            };

            const timer = setTimeout(() => finishReject(new Error('Login timeout')), timeoutMs);

            let pendingToken = null;
            let waitingDisconnect = false;

            const onError = (e) => {
                finishReject(e);
            };

            const onLoggedOn = () => {
            };

            const onDisconnected = () => {
                if (!waitingDisconnect) return;
                waitingDisconnect = false;
                const token = pendingToken;
                pendingToken = null;
                finishResolve(token);
            };

            const onRefreshToken = (refreshToken) => {
                pendingToken = refreshToken;
                waitingDisconnect = true;

                try { this.client.logOff(); } catch {}

                setTimeout(() => {
                    if (!waitingDisconnect) return;
                    waitingDisconnect = false;
                    const token = pendingToken;
                    pendingToken = null;
                    finishResolve(token);
                }, 1500);
            };

            this.client.on('error', onError);
            this.client.on('loggedOn', onLoggedOn);
            this.client.on('disconnected', onDisconnected);
            this.client.on('refreshToken', onRefreshToken);

            this.client.logOn({ accountName: username, password, twoFactorCode });
        });
    }

    async connectSteamOnly({ timeoutMs = 30000 } = {}) {
        const refreshToken = SessionManager.loadSession(this.username);

        this._steamErrorHandlerBound = (e) => {
            console.error('[SteamClient] Steam error:', e?.message || e);
        };

        this.client.on('error', this._steamErrorHandlerBound);
        this.client.logOn({ refreshToken });

        await Promise.race([
            once(this.client, 'loggedOn'),
            wait(timeoutMs).then(() => {
                throw new Error('Steam loggedOn timeout');
            }),
        ]);

        this.client.setPersona(SteamUser.EPersonaState.Online);
        return true;
    }

    async connect({ timeoutMs, steamTimeoutMs = 30000, gcTimeoutMs = 8000 } = {}) {
        const steamT = Number.isFinite(timeoutMs) ? timeoutMs : steamTimeoutMs;
        const gcT = Number.isFinite(timeoutMs) ? timeoutMs : gcTimeoutMs;

        const refreshToken = SessionManager.loadSession(this.username);

        this._steamErrorHandlerBound = (e) => {
            console.error('[SteamClient] Steam error:', e?.message || e);
        };

        this.client.on('error', this._steamErrorHandlerBound);

        const steamLoggedOnPromise = once(this.client, 'loggedOn');

        const gcConnectedPromise = new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('GC connection timeout')), gcT);
            this.csgo.once('connectedToGC', () => {
                clearTimeout(t);
                resolve();
            });
        });

        this._gcHandlerBound = (appid, msgType, payload) => {
            try {
                if (appid !== APP_ID || msgType !== MSG_CLIENT_WELCOME) return;
                const stars = parseClientWelcomeManual(payload);
                if (stars !== null) this.stars = stars;
            } catch (e) {
                console.error('[SteamClient] ClientWelcome parse error:', e?.message || e);
            }
        };

        this.client.on('receivedFromGC', this._gcHandlerBound);
        this.client.logOn({ refreshToken });

        await Promise.race([
            steamLoggedOnPromise,
            (async () => {
                await wait(steamT);
                throw new Error('Steam loggedOn timeout');
            })(),
        ]);

        this.client.setPersona(SteamUser.EPersonaState.Online);
        this.client.gamesPlayed([APP_ID]);

        await gcConnectedPromise;

        this.connected = true;
        return true;
    }

    async getStars({ timeoutMs = 12000 } = {}) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (this.stars != null) return this.stars;
            await wait(100);
        }
        return this.stars;
    }

    disconnect() {
        try {
            if (this._gcHandlerBound) {
                this.client.removeListener('receivedFromGC', this._gcHandlerBound);
                this._gcHandlerBound = null;
            }
            if (this._steamErrorHandlerBound) {
                this.client.removeListener('error', this._steamErrorHandlerBound);
                this._steamErrorHandlerBound = null;
            }

            this.connected = false;
            this.stars = null;

            try {
                this.client.gamesPlayed([]);
            } catch {}

            this.client.logOff();
        } catch {}
    }
}
