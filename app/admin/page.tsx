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

      {/* Bulk helpers are secondary to the page-level «Сохранить». */}
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button
          type="button"
          className="btn-sm"
          disabled={disabled || selected.length === TIMEFRAME_OPTIONS.length}
          onClick={() => onChange(TIMEFRAME_OPTIONS.map((o) => o.value))}
        >
          Выбрать все
        </button>
        {/* "Сбросить" must never produce an empty selection, which the API
            rejects. It returns to the single 15м baseline instead. */}
        <button
          type="button"
          className="btn-sm"
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

/** Settings whose control is too wide for the narrow value column. */
const WIDE_SETTINGS = new Set(['engine.timeframes']);

interface StrategySubgroup {
  label: string;
  n: number;
  grossExpectancyR: number;
}

interface StrategyWindowResult {
  slice: string;
  window: string;
  n: number;
  tp1HitRatePct: number;
  tp2HitRatePct: number;
  stopDistancePctMedian: number;
  feeDragR: number;
  grossRPerTrade: number;
  netRPerTrade: number;
  netRPerTradeStress: number;
  profitFactor: number;
  maxDrawdownR: number;
  exTop1Pct: number;
  edgeRetainedPct: number;
  positiveRRatePct: number;
  byDirection: StrategySubgroup[];
  bySymbol: StrategySubgroup[];
  exits: Record<string, number>;
  verdict: string;
}

interface StrategyStatus {
  activeStrategy: string;
  engineEnabled: boolean;
  tradingMode: string;
  liveTradingEnabled: boolean;
  selectable: string[];
  researchOnlyStrategies: string[];
  v30: {
    frozen: boolean;
    driftedKeys: string[];
    params: { htfTimeframe: string; ltfTimeframe: string; symbols: string[] };
    frozenConstants: Record<string, number | string>;
    results: StrategyWindowResult[];
    caveats: string[];
    provenance: {
      researchModule: string;
      sha256: string;
      parityArtifact: string;
      parity: { status: string; window: string | null; generatedAt: string | null };
    };
    readiness: { symbol: string; executionBars: number; structureBars: number; tradeable: boolean; note: string }[];
    liveCounts: Record<string, number>;
  };
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
  const [strategy, setStrategy] = useState<StrategyStatus | null>(null);
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

  const loadStrategy = useCallback(async () => {
    const res = await fetch('/api/admin/strategy');
    if (!res.ok) return;
    const json = await res.json();
    if (json.ok) setStrategy(json.data as StrategyStatus);
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
    if (authed) {
      void loadSettings();
      void loadStrategy();
    }
  }, [authed, loadSettings, loadStrategy]);

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
      // Re-read the strategy card too, so switching strategies or changing a
      // V3.0 parameter updates the drift banner immediately.
      await loadStrategy();
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

      {strategy && <StrategyCard status={strategy} />}

      {/* Settings are grouped: Движок / Smart Money / Риск / Рынок / Итоги /
          Система, plus the separate protected «Безопасность» panel below. */}
      <div className="tabs" role="tablist" aria-label="Группы настроек">
        {categories.map((c) => (
          <button
            key={c}
            role="tab"
            aria-selected={tab === c}
            className={tab === c ? 'active' : ''}
            onClick={() => setTab(c)}
          >
            {ru(CATEGORY_RU, c)}
          </button>
        ))}
      </div>

      <div className="panel">
        <h2 className="panel-title">
          {ru(CATEGORY_RU, tab)}
          <span className="hint">
            {visible.length} настроек · изменения применяются на следующем цикле воркера
          </span>
        </h2>
        {/* Wide controls (the timeframe picker) get a full-width row so the
            label does not sit centred beside a tall stack of checkboxes. */}
        {visible.map((s) => (
          <div
            className={`setting-row${WIDE_SETTINGS.has(s.key) ? ' setting-row-wide' : ''}`}
            key={s.key}
          >
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

      {/* Save is the primary action; Cancel stays visually secondary. */}
      <div className="row" style={{ marginBottom: 10 }}>
        <button
          className="primary"
          disabled={dirtyKeys.length === 0 || saving}
          onClick={() => void save()}
        >
          {saving ? 'Сохранение...' : `Сохранить изменения (${dirtyKeys.length})`}
        </button>
        <button disabled={dirtyKeys.length === 0} onClick={() => setDraft({})}>
          Отменить
        </button>
        {dirtyKeys.length > 0 && (
          <span className="muted" style={{ fontSize: 11.5 }}>
            Несохранённых изменений: {dirtyKeys.length}
          </span>
        )}
      </div>

      <div className="panel" data-testid="security-panel" style={{ marginTop: 24 }}>
        <h2 className="panel-title">Безопасность</h2>
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

/**
 * Strategy card: what is running, whether the tested configuration is intact,
 * and what forward testing may and may not claim.
 *
 * The validated numbers are compiled in from the committed artifacts — the UI
 * never recomputes them and never lets them be edited. Subgroups with n < 100
 * are greyed out, and `ex-top-1 %` always sits beside the gross figure, per
 * docs/ADMIN_PANEL_SPEC.md §14.3–14.5.
 */
function StrategyCard({ status }: { status: StrategyStatus }): React.ReactElement {
  const v = status.v30;
  const isV30 = status.activeStrategy === 'V3_0';
  const sliceRu: Record<string, string> = {
    TRAIN: 'TRAIN / обучение',
    VALIDATION: 'VALIDATION / валидация',
  };
  const exitRu: Record<string, string> = {
    SL: 'Стоп',
    TP2: 'TP2',
    TP1_THEN_BE: 'TP1 → безубыток',
    TP1_THEN_SL: 'TP1 → стоп',
    TP1_THEN_TIMEOUT: 'TP1 → таймаут',
    TIMEOUT: 'Таймаут',
  };
  const nCell = (n: number): React.ReactElement => (
    <span style={{ color: n < 100 ? '#94a3b8' : undefined, fontWeight: n < 100 ? 400 : 600 }}>
      {n.toLocaleString('ru-RU')}
      {n < 100 ? ' · мало' : ''}
    </span>
  );
  const subgroupTable = (title: string, rows: StrategySubgroup[]): React.ReactElement => (
    <>
      <h4 style={{ margin: '12px 0 4px', fontSize: 13 }}>{title}</h4>
      <table className="table">
        <thead>
          <tr>
            <th>Группа</th>
            <th>n</th>
            <th>Gross R/сделку</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} style={{ opacity: r.n < 100 ? 0.55 : 1 }}>
              <td>{r.label}</td>
              <td>{nCell(r.n)}</td>
              <td style={{ color: r.grossExpectancyR >= 0 ? '#22c55e' : '#ef4444' }}>
                {r.grossExpectancyR >= 0 ? '+' : ''}
                {r.grossExpectancyR.toFixed(4)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 11, marginTop: 2 }}>
        Серые строки — меньше 100 сделок: статистического вывода по ним нет.
      </p>
    </>
  );

  return (
    <div className="panel">
      <h2 className="panel-title">
        Стратегия: {isV30 ? 'V3.0 — HTF Liquidation Trap' : status.activeStrategy}
        <span className="hint">
          {status.tradingMode} · движок {status.engineEnabled ? 'включён' : 'выключен'} · LIVE{' '}
          {status.liveTradingEnabled ? 'включён' : 'заблокирован'}
        </span>
      </h2>

      <p className="muted" style={{ fontSize: 12 }}>
        Выбираемые в этой сборке стратегии: <b>{status.selectable.join(' · ')}</b>. Кандидаты V2.x
        ({status.researchOnlyStrategies.join(', ')}) в сайте не реализованы — их числа получены
        отдельными исследовательскими скриптами, поэтому в селекторе их нет: выбрать стратегию,
        которая ничего не считает, было бы обманом.
      </p>

      {!isV30 && (
        <div className="alert alert-info">
          Сейчас работает исходный движок <b>V1_SMC</b>. Параметры <code>v30.*</code> и карточка
          V3.0 ниже остаются в силе, но ни на что не влияют, пока активная стратегия не V3_0.
        </div>
      )}

      {isV30 && v.frozen && (
        <div className="alert alert-ok">
          <b>Конфигурация совпадает с исследованной.</b> Параметры <code>v30.*</code> равны
          замороженным значениям, на которых получены числа ниже.{' '}
          {v.provenance.parity.status === 'PASS'
            ? 'Перенос в движок сайта проверен на реальных данных: каждая сделка совпала с исследовательским модулем (артефакт parity: PASS, только окно TRAIN).'
            : `Проверка переноса: ${v.provenance.parity.status}.`}{' '}
          Эта сборка годится для <b>форвард-теста на живом рынке (FORWARD_TEST)</b>. Она{' '}
          <b>не</b> объявляется готовой к реальной торговле: PRODUCTION_READY запрещено.
        </div>
      )}
      {isV30 && !v.frozen && (
        <div className="alert alert-error">
          <b>Конфигурация изменена после заморозки.</b> Отличия:{' '}
          {v.driftedKeys.join(', ') || '(значения недоступны)'}. Числа TRAIN/VALIDATION больше не
          описывают то, что исполняет движок: такой прогон нельзя выдавать за проверенный
          результат.
        </div>
      )}

      <h3 className="panel-title">Проверенные результаты</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Окно</th>
            <th>n</th>
            <th>TP1</th>
            <th>TP2</th>
            <th>R&gt;0</th>
            <th>Стоп, %</th>
            <th>Комиссия, R</th>
            <th>Gross R</th>
            <th>Без топ-1%, R</th>
            <th>Net R @2/5</th>
            <th>Net R @5/5</th>
            <th>PF</th>
            <th>MaxDD, R</th>
            <th>Вердикт</th>
          </tr>
        </thead>
        <tbody>
          {v.results.map((r) => (
            <tr key={r.slice}>
              <td>{sliceRu[r.slice] ?? r.slice}</td>
              <td>{r.n.toLocaleString('ru-RU')}</td>
              <td>{r.tp1HitRatePct.toFixed(2)}%</td>
              <td>{r.tp2HitRatePct.toFixed(2)}%</td>
              <td>{r.positiveRRatePct.toFixed(2)}%</td>
              <td>{r.stopDistancePctMedian.toFixed(4)}</td>
              <td>{r.feeDragR.toFixed(4)}</td>
              <td>{r.grossRPerTrade.toFixed(4)}</td>
              <td>
                {r.exTop1Pct.toFixed(4)}{' '}
                <span className="muted">({r.edgeRetainedPct.toFixed(1)}% осталось)</span>
              </td>
              <td>{r.netRPerTrade.toFixed(4)}</td>
              <td>{r.netRPerTradeStress.toFixed(4)}</td>
              <td>{r.profitFactor.toFixed(4)}</td>
              <td>{r.maxDrawdownR.toFixed(2)}</td>
              <td>{r.verdict}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: 11 }}>
        Gross R — до комиссий. Net R @2/5 — заголовочная цифра валидации: мейкер 2 bps на входе,
        тейкер 5 bps на КАЖДОМ выходе (их три плеча, потому что половина позиции закрывается на
        TP1). Net R @5/5 — стресс на дорогих комиссиях. «Без топ-1%» — средний gross без 1%
        лучших сделок: главный индикатор хрупкости.
      </p>

      {v.results.map((r) => (
        <div key={`sub-${r.slice}`}>
          {subgroupTable(
            `${sliceRu[r.slice] ?? r.slice} — по направлению (gross)`,
            r.byDirection,
          )}
          {subgroupTable(`${sliceRu[r.slice] ?? r.slice} — по монетам (gross)`, r.bySymbol)}
          <p className="muted" style={{ fontSize: 11 }}>
            Выходы: {Object.entries(r.exits)
              .map(([k, n]) => `${exitRu[k] ?? k} ${n}`)
              .join(' · ')}
          </p>
        </div>
      ))}

      <h3 className="panel-title" style={{ marginTop: 16 }}>
        Замороженные константы (только чтение)
      </h3>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
        <li>
          Коридор входа живёт <b>{String(v.frozenConstants.corridorExpiryBars)}</b> свечи — этот
          параметр не вынесен в настройки.
        </li>
        <li>Комиссии: {String(v.frozenConstants.feeModel)}.</li>
        <li>
          Свинги {String(v.frozenConstants.swingLookbackSetting)} ={' '}
          {String(v.frozenConstants.swingLookback)}, ATR {String(v.frozenConstants.atrPeriodSetting)}{' '}
          = {String(v.frozenConstants.atrPeriod)}, объём {String(v.frozenConstants.volumePeriodSetting)}{' '}
          = {String(v.frozenConstants.volumePeriod)}.
        </li>
        <li>Внутрибарные правила: {String(v.frozenConstants.intrabarRules)}.</li>
      </ul>

      <h3 className="panel-title" style={{ marginTop: 16 }}>
        Допущения и оговорки
      </h3>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
        {v.caveats.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>

      <h3 className="panel-title" style={{ marginTop: 16 }}>
        Провенанс
      </h3>
      <p className="muted" style={{ fontSize: 11 }}>
        Исследовательский модуль: <code>{v.provenance.researchModule}</code> · sha256{' '}
        <code>{v.provenance.sha256.slice(0, 16)}…</code>
        <br />
        Проверка переноса (каждая сделка сверена с модулем):{' '}
        <b>{v.provenance.parity.status}</b>
        {v.provenance.parity.window ? ` · ${v.provenance.parity.window}` : ''}
        {v.provenance.parity.generatedAt
          ? ` · ${new Date(v.provenance.parity.generatedAt).toISOString().slice(0, 16).replace('T', ' ')}Z`
          : ''}
        {' · '}
        <code>{v.provenance.parityArtifact}</code>
      </p>

      <h3 className="panel-title" style={{ marginTop: 16 }}>
        Готовность данных
      </h3>
      <table className="table">
        <thead>
          <tr>
            <th>Монета</th>
            <th>Свечей {v.params.ltfTimeframe}</th>
            <th>Свечей {v.params.htfTimeframe}</th>
            <th>Статус</th>
          </tr>
        </thead>
        <tbody>
          {v.readiness.map((r) => (
            <tr key={r.symbol}>
              <td>{r.symbol}</td>
              <td>{r.executionBars.toLocaleString('ru-RU')}</td>
              <td>{r.structureBars.toLocaleString('ru-RU')}</td>
              <td style={{ color: r.tradeable ? '#22c55e' : '#f59e0b' }}>{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="panel-title" style={{ marginTop: 16 }}>
        Открытые сигналы V3.0
      </h3>
      <p className="muted" style={{ fontSize: 12 }}>
        {Object.keys(v.liveCounts).length === 0
          ? 'Нет открытых сигналов.'
          : Object.entries(v.liveCounts)
              .map(([k, n]) => `${k}: ${n}`)
              .join(' · ')}
      </p>
    </div>
  );
}
