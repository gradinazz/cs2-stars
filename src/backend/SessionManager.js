/**
 * SessionManager.js
 * Manages Steam session tokens for user accounts
 */

import fs from 'fs';
import path from 'path';

class SessionManager {
    static baseDir = './sessions';

    /**
     * Configure the base directory for session storage
     * @param {string} dir
     */
    static configureBaseDir(dir) {
        this.baseDir = dir;
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    /**
     * Save a session token for a user
     * @param {string} username
     * @param {string} refreshToken
     */
    static saveSession(username, refreshToken) {
        const filepath = path.join(this.baseDir, `${username}.steamsession`);
        const data = { DesktopRefreshToken: refreshToken };
        fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
    }

    /**
     * Load a session token for a user
     * @param {string} username
     * @returns {string}
     */
    static loadSession(username) {
        const filepath = path.join(this.baseDir, `${username}.steamsession`);
        if (!fs.existsSync(filepath)) {
            throw new Error(`Session file not found for ${username}`);
        }

        const raw = fs.readFileSync(filepath, 'utf8').trim();

        try {
            const data = JSON.parse(raw);
            return data.DesktopRefreshToken || data.refreshToken || raw;
        } catch {
            return raw;
        }
    }

    /**
     * List all saved accounts
     * @returns {string[]}
     */
    static listAccounts() {
        if (!fs.existsSync(this.baseDir)) return [];
        return fs
            .readdirSync(this.baseDir)
            .filter((f) => f.endsWith('.steamsession'))
            .map((f) => f.replace('.steamsession', ''));
    }

    /**
     * Delete a session file
     * @param {string} username
     * @returns {boolean}
     */
    static deleteSession(username) {
        const filepath = path.join(this.baseDir, `${username}.steamsession`);
        try {
            if (fs.existsSync(filepath)) {
                fs.unlinkSync(filepath);
            }
            return true;
        } catch (e) {
            console.error(`Failed to delete session for ${username}:`, e);
            return false;
        }
    }
}

export default SessionManager;
