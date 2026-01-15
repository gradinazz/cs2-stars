/**
 * SchemaResolver.js
 * Resolves CS2 item information from schema.json
 * @module SchemaResolver
 */

import fs from 'fs';
import path from 'path';

const DEFAULT_WEAR_BOUNDS = [
    { max: 0.07, name: 'Factory New' },
    { max: 0.15, name: 'Minimal Wear' },
    { max: 0.38, name: 'Field-Tested' },
    { max: 0.45, name: 'Well-Worn' },
    { max: 1.0, name: 'Battle-Scarred' }
];

function normalizeExteriorFromGC(quality) {
    if (typeof quality === 'string' && quality.trim()) return quality.trim();
    return null;
}

function clamp01(x) {
    if (typeof x !== 'number' || Number.isNaN(x)) return null;
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
}

function wearToExteriorByFloat(wear) {
    if (typeof wear !== 'number') return '';
    for (const b of DEFAULT_WEAR_BOUNDS) {
        if (wear <= b.max) return b.name;
    }
    return 'Battle-Scarred';
}

export default class SchemaResolver {
    constructor(schemaPath) {
        this.schemaPath = schemaPath;
        this.schema = null;
        this.ready = false;
    }

    /**
     * Initialize and load schema from file
     * @throws {Error} If schema file cannot be read
     */
    init() {
        if (this.ready) return;
        const p = path.isAbsolute(this.schemaPath)
            ? this.schemaPath
            : path.join(process.cwd(), this.schemaPath);
        const raw = fs.readFileSync(p, 'utf8');
        this.schema = JSON.parse(raw);
        this.ready = true;
    }

    /**
     * Resolve weapon and skin information
     * @param {number} defindex - Weapon definition index
     * @param {number} paintindex - Paint definition index
     * @returns {Object} Weapon and paint data
     */
    resolveWeaponPaint(defindex, paintindex) {
        if (!this.ready) throw new Error('SchemaResolver not initialized');
        const weapons = this.schema?.weapons;
        const w = weapons?.[String(defindex)] || null;
        const weaponName = w?.name || null;
        const p = w?.paints?.[String(paintindex)] || null;
        const paintName = p?.name || null;
        const imageUrl = p?.image || null;
        return { weaponName, paintName, imageUrl };
    }

    /**
     * Resolve sticker information
     * @param {number} stickerId - Sticker ID
     * @returns {Object} Sticker data
     */
    resolveSticker(stickerId) {
        if (!this.ready) throw new Error('SchemaResolver not initialized');
        const s = this.schema?.stickers?.[String(stickerId)] || null;
        const marketHashName = s?.market_hash_name || s?.name || null;
        const imageUrl = s?.image || null;
        return { marketHashName, imageUrl };
    }

    /**
     * Resolve generic item (cases, capsules, keys, agents)
     * @param {number} defindex - Item definition index
     * @returns {Object} Item data
     */
    resolveGenericItem(defindex) {
        if (!this.ready) return { marketHashName: null, imageUrl: null };
        const item = this.schema?.items?.[String(defindex)];
        if (item) {
            return {
                marketHashName: item.market_hash_name || item.name || item.item_name,
                imageUrl: item.image || item.image_inventory
            };
        }
        return { marketHashName: null, imageUrl: null };
    }

    /**
     * Resolve exterior condition from float value
     * @param {Object} params - Parameters
     * @param {number} params.defindex - Weapon definition index
     * @param {number} params.paintindex - Paint definition index
     * @param {number} params.paintwear - Float value
     * @param {string} [params.gcQuality] - Quality from GC
     * @returns {string} Exterior name
     */
    resolveExterior({ defindex, paintindex, paintwear, gcQuality }) {
        const fromGC = normalizeExteriorFromGC(gcQuality);
        if (fromGC) return fromGC;

        const wear = clamp01(paintwear);
        if (wear === null) return '';

        const w = this.schema?.weapons?.[String(defindex)];
        const p = w?.paints?.[String(paintindex)];
        const min = typeof p?.min === 'number' ? p.min : null;
        const max = typeof p?.max === 'number' ? p.max : null;

        let effectiveWear = wear;
        if (min !== null && effectiveWear < min) effectiveWear = min;
        if (max !== null && effectiveWear > max) effectiveWear = max;

        return wearToExteriorByFloat(effectiveWear);
    }

    /**
     * Build display name for an item
     * @param {Object} params - Parameters
     * @returns {string} Display name
     */
    buildDisplayName({ defindex, paintindex, exterior, sticker_id, is_sticker }) {
        const looksLikeSticker = is_sticker || (sticker_id && (!paintindex || paintindex === 0));

        if (looksLikeSticker && sticker_id) {
            const { marketHashName } = this.resolveSticker(sticker_id);
            return marketHashName || `Sticker #${sticker_id}`;
        }

        const { weaponName, paintName } = this.resolveWeaponPaint(defindex, paintindex);
        if (weaponName) {
            const base = weaponName;
            const skin = paintName ? `${base} | ${paintName}` : base;
            return exterior ? `${skin} (${exterior})` : skin;
        }

        const generic = this.resolveGenericItem(defindex);
        if (generic.marketHashName) {
            return generic.marketHashName;
        }

        return `def=${defindex}`;
    }

    /**
     * Resolve image URL for an item
     * @param {Object} params - Parameters
     * @returns {string|null} Image URL
     */
    resolveImageUrl({ defindex, paintindex, sticker_id, is_sticker }) {
        const looksLikeSticker = is_sticker || (sticker_id && (!paintindex || paintindex === 0));

        if (looksLikeSticker && sticker_id) {
            const { imageUrl } = this.resolveSticker(sticker_id);
            return imageUrl || null;
        }

        const { imageUrl } = this.resolveWeaponPaint(defindex, paintindex);
        if (imageUrl) return imageUrl;

        const generic = this.resolveGenericItem(defindex);
        return generic.imageUrl || null;
    }
}
