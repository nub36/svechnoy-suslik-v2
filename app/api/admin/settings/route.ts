import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { SETTINGS_BY_KEY, SETTINGS_REGISTRY, coerceSettingValue, loadSettings } from '@/core/settings';
import { requireAdmin, ok, fail, errorMessage } from '@/web/api-utils';
import { createLogger } from '@/core/logger';

export const dynamic = 'force-dynamic';

/** Read every setting (protected). */
export async function GET(): Promise<Response> {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  try {
    const db = getDb();
    const rows = await db.selectFrom('settings').selectAll().orderBy('key').execute();
    const byKey = new Map(rows.map((r) => [r.key, r]));

    // Present the registry (source of truth) merged with stored values.
    const settings = SETTINGS_REGISTRY.map((def) => {
      const row = byKey.get(def.key);
      return {
        key: def.key,
        value: row ? row.value : def.default,
        default: def.default,
        type: def.type,
        category: def.category,
        label: def.label,
        description: def.description,
        min: def.min ?? null,
        max: def.max ?? null,
        editable: def.editable ?? true,
        consumedBy: def.consumedBy,
        updatedAt: row?.updated_at ?? null,
      };
    });

    return ok({
      settings,
      categories: [...new Set(SETTINGS_REGISTRY.map((s) => s.category))],
      liveLocked: true,
      allowedModes: ['DRY_RUN', 'FORWARD_TEST'],
    });
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}

/**
 * Update settings (protected). Body: { updates: { key: value, ... } }
 * Every value is validated against the registry; LIVE is rejected.
 */
export async function PUT(req: Request): Promise<Response> {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  try {
    const body = (await req.json().catch(() => ({}))) as { updates?: Record<string, unknown> };
    const updates = body.updates ?? {};
    const keys = Object.keys(updates);
    if (keys.length === 0) return fail('No updates supplied', 400);

    const db = getDb();
    const applied: Array<{ key: string; value: unknown }> = [];
    const errors: Array<{ key: string; error: string }> = [];

    for (const key of keys) {
      const def = SETTINGS_BY_KEY.get(key);
      if (!def) {
        errors.push({ key, error: 'unknown setting' });
        continue;
      }
      if (def.editable === false) {
        errors.push({ key, error: 'setting is locked' });
        continue;
      }
      try {
        const value = coerceSettingValue(def, updates[key]);
        await db
          .insertInto('settings')
          .values({
            key,
            value: JSON.stringify(value),
            type: def.type,
            category: def.category,
            label: def.label,
            description: def.description,
            min_value: def.min ?? null,
            max_value: def.max ?? null,
            editable: def.editable ?? true,
            updated_at: new Date(),
          })
          .onConflict((oc) =>
            oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_at: new Date() }),
          )
          .execute();
        applied.push({ key, value });
      } catch (e) {
        errors.push({ key, error: errorMessage(e) });
      }
    }

    if (applied.length > 0) {
      createLogger('admin', db).info(
        `settings updated by ${auth.user.username}: ${applied.map((a) => a.key).join(', ')}`,
        { applied: applied.length },
      );
    }

    // Return the fresh snapshot so the caller can see the engine's new config.
    const fresh = await loadSettings(db);
    const payload = { applied, errors, effective: fresh.toObject() };

    // Nothing applied and at least one rejection => a client error (400).
    // Partial success stays 200 so the caller can see what did land.
    if (applied.length === 0 && errors.length > 0) {
      return NextResponse.json({ ok: false, error: errors[0]?.error ?? 'No settings applied', data: payload }, { status: 400 });
    }
    return ok(payload);
  } catch (err) {
    return fail(errorMessage(err), 500);
  }
}
