'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

interface Setting {
  key: string;
  value: unknown;
  default: unknown;
  type: 'number' | 'boolean' | 'string' | 'json';
  category: string;
  label: string;
  description: string;
  min: number | null;
  max: number | null;
  editable: boolean;
  consumedBy: string[];
}

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);

  const [settings, setSettings] = useState<Setting[]>([]);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [tab, setTab] = useState('engine');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const checkSession = useCallback(async () => {
    const res = await fetch('/api/admin/session');
    const json = await res.json();
    setAuthed(Boolean(json.ok && json.data.authenticated));
  }, []);

  const loadSettings = useCallback(async () => {
    const res = await fetch('/api/admin/settings');
    if (res.status === 401) {
      setAuthed(false);
      return;
    }
    const json = await res.json();
    if (json.ok) {
      setSettings(json.data.settings);
      setDraft({});
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  useEffect(() => {
    if (authed) void loadSettings();
  }, [authed, loadSettings]);

  const login = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLoginError(null);
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const json = await res.json();
    if (json.ok) {
      setAuthed(true);
      setPassword('');
    } else {
      setLoginError(json.error ?? 'Login failed');
    }
  };

  const logout = async (): Promise<void> => {
    await fetch('/api/admin/logout', { method: 'POST' });
    setAuthed(false);
    setSettings([]);
  };

  const categories = useMemo(
    () => [...new Set(settings.map((s) => s.category))],
    [settings],
  );
  const visible = useMemo(() => settings.filter((s) => s.category === tab), [settings, tab]);
  const dirtyKeys = Object.keys(draft);

  const save = async (): Promise<void> => {
    if (dirtyKeys.length === 0) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updates: draft }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? 'Save failed');
      const errs = json.data.errors as Array<{ key: string; error: string }>;
      if (errs.length > 0) {
        setMessage({
          kind: 'error',
          text: `Applied ${json.data.applied.length}. Rejected: ${errs.map((e) => `${e.key} (${e.error})`).join('; ')}`,
        });
      } else {
        setMessage({
          kind: 'ok',
          text: `Saved ${json.data.applied.length} setting(s). The engine picks these up on its next loop.`,
        });
      }
      await loadSettings();
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  if (authed === null) return <div className="loading">Checking session…</div>;

  if (!authed) {
    return (
      <div className="panel login-box">
        <h2>Admin login</h2>
        {loginError && <div className="alert alert-error">{loginError}</div>}
        <form onSubmit={login}>
          <div className="field">
            <label htmlFor="u">Username</label>
            <input id="u" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </div>
          <div className="field">
            <label htmlFor="p">Password</label>
            <input
              id="p"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <button className="primary" type="submit" style={{ width: '100%' }}>
            Sign in
          </button>
        </form>
        <p className="muted" style={{ fontSize: 11, marginTop: 12 }}>
          Default credentials come from ADMIN_USER / ADMIN_PASSWORD at seed time. Change them in
          production.
        </p>
      </div>
    );
  }

  const current = (s: Setting): unknown => (s.key in draft ? draft[s.key] : s.value);
  const setValue = (key: string, v: unknown): void => setDraft((d) => ({ ...d, [key]: v }));

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Admin</h1>
          <p className="subtitle">
            Every setting below is read by the engine from the database — none are decorative.
          </p>
        </div>
        <button onClick={() => void logout()}>Sign out</button>
      </div>

      <div className="alert alert-info">
        <b>LIVE is locked.</b> engine.trading_mode accepts only DRY_RUN or FORWARD_TEST; a LIVE
        value is rejected at the API, at the settings layer and at the engine.
      </div>

      {message && (
        <div className={`alert ${message.kind === 'ok' ? 'alert-ok' : 'alert-error'}`}>
          {message.text}
        </div>
      )}

      <div className="tabs">
        {categories.map((c) => (
          <button key={c} className={tab === c ? 'active' : ''} onClick={() => setTab(c)}>
            {c}
          </button>
        ))}
      </div>

      <div className="panel">
        {visible.map((s) => (
          <div className="setting-row" key={s.key}>
            <div>
              <div className="setting-label">
                {s.label}
                {!s.editable && (
                  <span className="pill pill-idle" style={{ marginLeft: 8 }}>
                    LOCKED
                  </span>
                )}
                {s.key in draft && (
                  <span className="pill pill-warn" style={{ marginLeft: 8 }}>
                    MODIFIED
                  </span>
                )}
              </div>
              <div className="setting-key">{s.key}</div>
              <div className="setting-desc">{s.description}</div>
              <details>
                <summary>engine consumer</summary>
                <div className="setting-key">{s.consumedBy.join(', ')}</div>
              </details>
            </div>
            <div>
              {s.key === 'engine.trading_mode' ? (
                <select
                  value={String(current(s))}
                  disabled={!s.editable}
                  onChange={(e) => setValue(s.key, e.target.value)}
                >
                  <option value="DRY_RUN">DRY_RUN</option>
                  <option value="FORWARD_TEST">FORWARD_TEST</option>
                </select>
              ) : s.type === 'boolean' ? (
                <select
                  value={String(current(s))}
                  disabled={!s.editable}
                  onChange={(e) => setValue(s.key, e.target.value === 'true')}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : s.type === 'number' ? (
                <input
                  type="number"
                  value={String(current(s) ?? '')}
                  disabled={!s.editable}
                  min={s.min ?? undefined}
                  max={s.max ?? undefined}
                  step="any"
                  onChange={(e) => setValue(s.key, e.target.value === '' ? '' : Number(e.target.value))}
                />
              ) : s.type === 'json' ? (
                <input
                  className="mono"
                  value={
                    typeof current(s) === 'string'
                      ? String(current(s))
                      : JSON.stringify(current(s))
                  }
                  disabled={!s.editable}
                  onChange={(e) => setValue(s.key, e.target.value)}
                />
              ) : (
                <input
                  value={String(current(s) ?? '')}
                  disabled={!s.editable}
                  onChange={(e) => setValue(s.key, e.target.value)}
                />
              )}
              {(s.min !== null || s.max !== null) && (
                <div className="muted" style={{ fontSize: 10, marginTop: 3 }}>
                  range {s.min ?? '−∞'} … {s.max ?? '∞'} · default {JSON.stringify(s.default)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="row">
        <button className="primary" disabled={dirtyKeys.length === 0 || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : `Save ${dirtyKeys.length} change(s)`}
        </button>
        <button disabled={dirtyKeys.length === 0} onClick={() => setDraft({})}>
          Discard
        </button>
      </div>
    </div>
  );
}
