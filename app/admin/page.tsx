'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CATEGORY_RU, ru } from '../lib/format';
import { settingDescription, settingLabel } from '../lib/settings-ru';

/** Map API error strings (English, stable contract) to Russian for display. */
function translateApiError(err: unknown): string {
  const raw = typeof err === 'string' ? err : '';
  if (/invalid credentials/i.test(raw)) return 'Неверный логин или пароль';
  if (/unauthorized/i.test(raw)) return 'Требуется вход в систему';
  if (/LIVE mode is locked/i.test(raw)) {
    return 'Режим LIVE заблокирован: доступны только DRY_RUN и FORWARD_TEST';
  }
  if (/no updates supplied/i.test(raw)) return 'Нет изменений для сохранения';
  return raw || 'Произошла ошибка';
}

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
      setLoginError(translateApiError(json.error));
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
      if (!json.ok) throw new Error(translateApiError(json.error));
      const errs = json.data.errors as Array<{ key: string; error: string }>;
      if (errs.length > 0) {
        setMessage({
          kind: 'error',
          text: `Применено: ${json.data.applied.length}. Отклонено: ${errs.map((e) => `${e.key} (${e.error})`).join('; ')}`,
        });
      } else {
        setMessage({
          kind: 'ok',
          text: `Сохранено настроек: ${json.data.applied.length}. Движок применит их на следующем цикле.`,
        });
      }
      await loadSettings();
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Не удалось сохранить' });
    } finally {
      setSaving(false);
    }
  };

  if (authed === null) return <div className="loading">Загрузка...</div>;

  if (!authed) {
    return (
      <div className="panel login-box">
        <h2>Вход в админку</h2>
        {loginError && <div className="alert alert-error">{loginError}</div>}
        <form onSubmit={login}>
          <div className="field">
            <label htmlFor="u">Логин</label>
            <input id="u" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </div>
          <div className="field">
            <label htmlFor="p">Пароль</label>
            <input
              id="p"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <button className="primary" type="submit" style={{ width: '100%' }}>
            Войти
          </button>
        </form>
        <p className="muted" style={{ fontSize: 11, marginTop: 12 }}>
          Учётная запись хранится в PostgreSQL (таблица <code>admin_users</code>). Переменные
          ADMIN_USER / ADMIN_PASSWORD используются <b>только при первичном создании</b> админа.
        </p>
        <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          Изменение <code>.env</code> <b>не меняет</b> уже существующий пароль в базе. Чтобы
          сменить пароль, выполните на сервере:{' '}
          <code>npm run admin:reset-password</code> — команда возьмёт новые значения из окружения,
          обновит запись в базе и завершит все активные сессии.
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
          <h1>Админка</h1>
          <p className="subtitle">
            Каждая настройка ниже реально читается движком из базы данных — декоративных
            параметров здесь нет.
          </p>
        </div>
        <button onClick={() => void logout()}>Выйти</button>
      </div>

      <div className="alert alert-info">
        <b>Режим LIVE заблокирован.</b> Параметр engine.trading_mode принимает только DRY_RUN или
        FORWARD_TEST. Значение LIVE отклоняется на уровне API, на уровне настроек и на уровне
        движка.
      </div>

      {message && (
        <div className={`alert ${message.kind === 'ok' ? 'alert-ok' : 'alert-error'}`}>
          {message.text}
        </div>
      )}

      <div className="tabs">
        {categories.map((c) => (
          <button key={c} className={tab === c ? 'active' : ''} onClick={() => setTab(c)}>
            {ru(CATEGORY_RU, c)}
          </button>
        ))}
      </div>

      <div className="panel">
        {visible.map((s) => (
          <div className="setting-row" key={s.key}>
            <div>
              <div className="setting-label">
                {settingLabel(s.key, s.label)}
                {!s.editable && (
                  <span className="pill pill-idle" style={{ marginLeft: 8 }}>
                    ЗАБЛОКИРОВАНО
                  </span>
                )}
                {s.key in draft && (
                  <span className="pill pill-warn" style={{ marginLeft: 8 }}>
                    ИЗМЕНЕНО
                  </span>
                )}
              </div>
              <div className="setting-key">{s.key}</div>
              <div className="setting-desc">{settingDescription(s.key, s.description)}</div>
              <details>
                <summary>где используется движком</summary>
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
                  диапазон {s.min ?? '−∞'} … {s.max ?? '∞'} · по умолчанию{' '}
                  {JSON.stringify(s.default)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="row">
        <button className="primary" disabled={dirtyKeys.length === 0 || saving} onClick={() => void save()}>
          {saving ? 'Сохранение...' : `Сохранить изменения (${dirtyKeys.length})`}
        </button>
        <button disabled={dirtyKeys.length === 0} onClick={() => setDraft({})}>
          Отменить
        </button>
      </div>
    </div>
  );
}
