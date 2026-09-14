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

/**
 * Timeframe multi-select for `engine.timeframes`.
 *
 * This is the ONLY timeframe setting: it is the single source of truth for
 * which timeframes the strategy scans. Russian labels are presentation only —
 * the persisted values stay the canonical '1m'...'1w' identifiers.
 */
const TIMEFRAME_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '1m', label: '1м' },
  { value: '5m', label: '5м' },
  { value: '15m', label: '15м' },
  { value: '30m', label: '30м' },
  { value: '1h', label: '1ч' },
  { value: '4h', label: '4ч' },
  { value: '1d', label: '1д' },
  { value: '1w', label: '1н' },
];

/** Canonical chronological order, so the saved array is stable. */
function canonicalTimeframes(selected: readonly string[]): string[] {
  const set = new Set(selected);
  return TIMEFRAME_OPTIONS.filter((o) => set.has(o.value)).map((o) => o.value);
}

function TimeframePicker({
  selected,
  disabled,
  onChange,
}: {
  selected: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const toggle = (tf: string): void => {
    const has = selected.includes(tf);
    // Refuse to clear the last one: an empty selection would stop the engine,
    // and the API rejects it anyway. Better to block it here than to let the
    // admin build an invalid state and fail at save time.
    if (has && selected.length === 1) return;
    const next = has ? selected.filter((t) => t !== tf) : [...selected, tf];
    onChange(canonicalTimeframes(next));
  };

  const empty = selected.length === 0;

  return (
    <div data-testid="timeframe-picker">
      <div style={{ marginBottom: 6 }}>
        <b style={{ fontSize: 12 }}>Таймфреймы стратегии</b>
        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
          Определяет, на каких таймфреймах стратегия ищет новые сигналы. Графики
          продолжают получать данные для всех поддерживаемых таймфреймов.
        </div>
      </div>
      <div className="tf-grid">
        {TIMEFRAME_OPTIONS.map((o) => {
          const on = selected.includes(o.value);
          const lastOne = on && selected.length === 1;
          return (
            <label
              key={o.value}
              className={`tf-option${on ? ' tf-option-on' : ''}`}
              title={lastOne ? 'Должен остаться хотя бы один таймфрейм' : undefined}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={disabled || lastOne}
                onChange={() => toggle(o.value)}
                aria-label={o.label}
              />
              <span>{o.label}</span>
            </label>
          );
        })}
      </div>

      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button
          type="button"
          disabled={disabled || selected.length === TIMEFRAME_OPTIONS.length}
          onClick={() => onChange(TIMEFRAME_OPTIONS.map((o) => o.value))}
        >
          Выбрать все
        </button>
        {/* "Сбросить" must never produce an empty selection, which the API
            rejects. It returns to the single 15м baseline instead. */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(['15m'])}
          title="Вернуться к базовому выбору: только 15м (пустой выбор недопустим)"
        >
          Сбросить
        </button>
      </div>

      {empty ? (
        <div className="alert alert-error" style={{ marginTop: 8 }}>
          Выберите хотя бы один таймфрейм для стратегии.
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
          <b>Сканируется стратегией:</b> {selected.join(', ')} — {selected.length} ТФ x
          TOP-10 символов = {selected.length * 10} комбинаций.
        </div>
      )}

      {/* Ingestion is independent of this selection: the market worker always
          collects all supported timeframes so charts never go stale. */}
      <div className="alert alert-info" style={{ marginTop: 8, fontSize: 11 }}>
        <b>Доступно для графика:</b> все 8 таймфреймов продолжают получать
        свежие свечи независимо от этого выбора — графики никогда не устаревают.
        Настройка выше влияет только на поиск новых сигналов.
        История по отключённому таймфрейму не удаляется, а недостающие свечи
        никогда не дорисовываются. При повторном включении движок
        последовательно догоняет пропущенные закрытые свечи и не создаёт
        ложный сигнал.
      </div>
    </div>
  );
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

  // --- Безопасность: смена пароля текущего администратора ---
  const [curPwd, setCurPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdMessage, setPwdMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(
    null,
  );

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

  const changePassword = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setPwdMessage(null);

    // Cheap client-side checks purely for responsiveness. The server repeats
    // every one of them — this is never the actual enforcement point.
    if (newPwd !== confirmPwd) {
      setPwdMessage({ kind: 'error', text: 'Новый пароль и подтверждение не совпадают' });
      return;
    }
    if (newPwd.length < 12) {
      setPwdMessage({ kind: 'error', text: 'Новый пароль слишком короткий (минимум 12 символов)' });
      return;
    }

    setPwdBusy(true);
    try {
      const res = await fetch('/api/admin/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          currentPassword: curPwd,
          newPassword: newPwd,
          confirmPassword: confirmPwd,
        }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        data?: { message?: string };
      };
      if (!json.ok) {
        setPwdMessage({ kind: 'error', text: json.error ?? 'Не удалось изменить пароль' });
        return;
      }
      setPwdMessage({ kind: 'ok', text: json.data?.message ?? 'Пароль изменён' });
      // Clear the inputs so the plaintext does not linger in the DOM.
      setCurPwd('');
      setNewPwd('');
      setConfirmPwd('');
    } catch {
      setPwdMessage({ kind: 'error', text: 'Сеть недоступна' });
    } finally {
      setPwdBusy(false);
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
        {/* The public login page must not disclose operational detail:
            no table names, no env-var names, no recovery commands. */}
        <p className="muted" style={{ fontSize: 11, marginTop: 12 }}>
          Для восстановления доступа обратитесь к администратору сервера.
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
              ) : s.key === 'engine.timeframes' ? (
                <TimeframePicker
                  selected={
                    Array.isArray(current(s)) ? (current(s) as string[]).map(String) : []
                  }
                  disabled={!s.editable}
                  onChange={(next) => setValue(s.key, next)}
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

      <div className="panel" data-testid="security-panel" style={{ marginTop: 24 }}>
        <h2>Безопасность</h2>
        <p className="subtitle">
          Смена пароля текущего администратора. Остальные активные сеансы будут завершены,
          текущий сеанс сохранится.
        </p>

        {pwdMessage && (
          <div className={`alert ${pwdMessage.kind === 'ok' ? 'alert-ok' : 'alert-error'}`}>
            {pwdMessage.text}
          </div>
        )}

        <form onSubmit={(e) => void changePassword(e)} style={{ maxWidth: 420 }}>
          <div className="field">
            <label htmlFor="cur-pwd">Текущий пароль</label>
            <input
              id="cur-pwd"
              type="password"
              value={curPwd}
              onChange={(e) => setCurPwd(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="field">
            <label htmlFor="new-pwd">Новый пароль</label>
            <input
              id="new-pwd"
              type="password"
              value={newPwd}
              onChange={(e) => setNewPwd(e.target.value)}
              autoComplete="new-password"
            />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Минимум 12 символов.
            </div>
          </div>
          <div className="field">
            <label htmlFor="confirm-pwd">Повторите новый пароль</label>
            <input
              id="confirm-pwd"
              type="password"
              value={confirmPwd}
              onChange={(e) => setConfirmPwd(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <button
            className="primary"
            type="submit"
            disabled={pwdBusy || !curPwd || !newPwd || !confirmPwd}
          >
            {pwdBusy ? 'Сохранение...' : 'Изменить пароль'}
          </button>
        </form>
      </div>
    </div>
  );
}
