'use strict';
/**
 * Converts nested objects to MongoDB dot-notation $set paths.
 * Prevents $set from wiping sibling fields in nested objects.
 *
 * Example:
 *   { environments: { production: [...] } }
 *   becomes: { 'environments.production': [...] }
 *
 * This means $set only touches environments.production —
 * environments.staging is completely untouched.
 */
function flattenUpdates(obj, prefix = '') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        const dotPath = prefix ? `${prefix}.${key}` : key;
        // Don't flatten arrays, null, Date, or MongoDB Mixed — set them as-is
        if (
            value !== null &&
            value !== undefined &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            !(value instanceof Date)
        ) {
            Object.assign(result, flattenUpdates(value, dotPath));
        } else {
            result[dotPath] = value;
        }
    }
    return result;
}

module.exports = { flattenUpdates };
