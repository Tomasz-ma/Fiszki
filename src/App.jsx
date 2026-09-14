import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Volume2, X, Minus, Check, BarChart3, Layers, Settings as SettingsIcon, BookOpen, Flame, Plus, Trash2, RotateCcw, ArrowLeftRight } from 'lucide-react';
import { TOPICS, BUILTIN_WORDS, LEVELS } from './wordsData.js';

/* ---------------------------------------------------------------------- */
/* DANE / SŁOWNICTWO — patrz plik wordsData.js (955 słówek, 30 kategorii)  */
/* ---------------------------------------------------------------------- */

const CATEGORIES = TOPICS;

/* ---------------------------------------------------------------------- */
/* STAŁE ALGORYTMU SRS                                                     */
/* ---------------------------------------------------------------------- */

const STATUS = { NEW: 'NEW', LEARNING: 'LEARNING', REVIEW: 'REVIEW', MASTERED: 'MASTERED' };
const MASTER_THRESHOLD_DAYS = 21;
const MASTERED_SEQUENCE = [14, 30, 60, 90, 180];

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function progressKey(direction, wordId) {
  return `${direction}:${wordId}`;
}

function defaultProgress() {
  return {
    status: STATUS.NEW,
    easeFactor: 2.5,
    intervalDays: 0,
    repetitions: 0,
    lapses: 0,
    dueAt: null,
    masteredStep: 0,
  };
}

/** Rdzeń algorytmu — patrz specyfikacja, sekcja 3.2 / 3.3 */
function applyRating(progress, rating, now, settingsArg) {
  const p = { ...progress };

  if (rating === 'DONT_KNOW') {
    p.lapses += 1;
    p.repetitions = 0;
    p.easeFactor = Math.max(1.3, p.easeFactor - 0.2);
    if (p.status === STATUS.MASTERED) p.masteredStep = 0;
    p.status = STATUS.LEARNING;
    p.dueAt = now.toISOString();
    return { progress: p, reinsertOffset: settingsArg.dontKnowInterval, leavesSession: false };
  }

  if (rating === 'MEDIUM') {
    if (p.status === STATUS.MASTERED) {
      p.status = STATUS.REVIEW;
      p.masteredStep = 0;
      p.intervalDays = 6;
    } else {
      p.status = STATUS.LEARNING;
      p.intervalDays = 1;
    }
    p.dueAt = daysFromNow(p.intervalDays || 1);
    return { progress: p, reinsertOffset: settingsArg.mediumInterval, leavesSession: false };
  }

  // KNOW
  p.repetitions += 1;
  if (p.status === STATUS.MASTERED) {
    p.masteredStep = Math.min(p.masteredStep + 1, MASTERED_SEQUENCE.length - 1);
    p.intervalDays = MASTERED_SEQUENCE[p.masteredStep];
  } else {
    if (p.repetitions === 1) p.intervalDays = 1;
    else if (p.repetitions === 2) p.intervalDays = 6;
    else p.intervalDays = Math.round(p.intervalDays * p.easeFactor);
    p.easeFactor = Math.min(2.8, p.easeFactor + 0.1);

    if (p.intervalDays >= MASTER_THRESHOLD_DAYS) {
      p.status = STATUS.MASTERED;
      p.masteredStep = 0;
      p.intervalDays = MASTERED_SEQUENCE[0];
    } else {
      p.status = STATUS.REVIEW;
    }
  }
  p.dueAt = daysFromNow(p.intervalDays);
  return { progress: p, reinsertOffset: null, leavesSession: true };
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function speak(text, lang) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang;
  utter.rate = 0.92;
  window.speechSynthesis.speak(utter);
}

/* ---------------------------------------------------------------------- */
/* STORAGE HELPERS (persystencja między sesjami)                          */
/* ---------------------------------------------------------------------- */

const STORAGE_PREFIX = 'fiszki:';

async function loadKey(key, fallback) {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

async function saveKey(key, value) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch (e) {
    console.error('storage save failed', key, e);
  }
}

const DATA_VERSION = 2; // podbite przy dużej aktualizacji bazy słówek (reset wyboru kategorii/poziomów)

const DEFAULT_SETTINGS = {
  dailyGoal: 12,
  dontKnowInterval: 3,
  mediumInterval: 8,
  activeCategories: CATEGORIES.map((c) => c.id),
  activeLevels: [...LEVELS],
  directions: { enToPl: true, plToEn: false },
  streak: { count: 0, lastStudyDate: null },
  dataVersion: DATA_VERSION,
};

/* ---------------------------------------------------------------------- */
/* KOMPONENT GŁÓWNY                                                        */
/* ---------------------------------------------------------------------- */

export default function App() {
  const [loading, setLoading] = useState(true);
  const [customWords, setCustomWords] = useState([]);
  const [progress, setProgress] = useState({});
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [view, setView] = useState('study');

  const [queue, setQueue] = useState(null); // null = nie rozpoczęto
  const [backlog, setBacklog] = useState([]); // słówka czekające na wejście do kolejki (utrzymują stały rozmiar kolejki)
  const [screenState, setScreenState] = useState('question');
  const [sessionStats, setSessionStats] = useState({ reviewed: 0, dontKnow: 0, medium: 0, know: 0 });

  function buildPoolFor(wordsArg, settingsArg) {
    const active = wordsArg.filter(
      (w) => settingsArg.activeCategories.includes(w.category) && (!w.level || settingsArg.activeLevels.includes(w.level))
    );
    const pool = [];
    active.forEach((w) => {
      if (settingsArg.directions.enToPl) pool.push({ word: w, direction: 'enToPl' });
      if (settingsArg.directions.plToEn) pool.push({ word: w, direction: 'plToEn' });
    });
    return pool;
  }

  // Zwraca { queue, backlog }: queue to stała "wystawka" o rozmiarze dailyGoal,
  // backlog to reszta słówek czekających — gdy karta w queue zostaje oznaczona
  // jako "Znam" i opuszcza kolejkę, na jej miejsce wchodzi kolejna z backlogu,
  // dzięki czemu liczba kart w kolejce pozostaje stała aż do wyczerpania puli.
  function buildSessionFor(wordsArg, progressArg, settingsArg) {
    const now = new Date();
    const pool = buildPoolFor(wordsArg, settingsArg);

    const dueItems = [];
    const newItems = [];

    pool.forEach((item) => {
      const key = progressKey(item.direction, item.word.id);
      const p = progressArg[key];
      if (!p || p.status === STATUS.NEW) {
        newItems.push(item);
      } else if (new Date(p.dueAt) <= now) {
        dueItems.push({ ...item, dueAt: p.dueAt });
      }
    });

    dueItems.sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    const limitedNew = shuffle(newItems).slice(0, Math.max(settingsArg.dailyGoal * 3, settingsArg.dailyGoal));
    const fullList = interleave(dueItems, limitedNew, 3);

    return {
      queue: fullList.slice(0, settingsArg.dailyGoal),
      backlog: fullList.slice(settingsArg.dailyGoal),
    };
  }

  useEffect(() => {
    (async () => {
      const [cw, pr, stRaw] = await Promise.all([
        loadKey('custom-words', []),
        loadKey('progress-data', {}),
        loadKey('app-settings', DEFAULT_SETTINGS),
      ]);
      const st = { ...DEFAULT_SETTINGS, ...stRaw, directions: { ...DEFAULT_SETTINGS.directions, ...(stRaw.directions || {}) } };
      const migrated = !stRaw.dataVersion || stRaw.dataVersion < DATA_VERSION;
      if (migrated) {
        st.activeCategories = DEFAULT_SETTINGS.activeCategories;
        st.activeLevels = DEFAULT_SETTINGS.activeLevels;
        st.dataVersion = DATA_VERSION;
      }
      const wordsLocal = [...BUILTIN_WORDS, ...cw];

      // aktualizacja passy (streak) na starcie dnia
      const now = new Date();
      const today = now.toDateString();
      let streakChanged = false;
      if (st.streak.lastStudyDate !== today) {
        const last = st.streak.lastStudyDate ? new Date(st.streak.lastStudyDate) : null;
        const isYesterday = last && (now - last) / 86400000 <= 1.5 && (now - last) / 86400000 >= 0.5;
        st.streak = { count: isYesterday ? st.streak.count + 1 : 1, lastStudyDate: today };
        streakChanged = true;
      }
      if (migrated || streakChanged) {
        saveKey('app-settings', st);
      }

      const built = buildSessionFor(wordsLocal, pr, st);

      setCustomWords(cw);
      setProgress(pr);
      setSettings(st);
      setQueue(built.queue);
      setBacklog(built.backlog);
      setSessionStats({ reviewed: 0, dontKnow: 0, medium: 0, know: 0 });
      setScreenState(built.queue.length === 0 ? 'empty' : 'question');
      setLoading(false);
    })();
  }, []);

  const allWords = [...BUILTIN_WORDS, ...customWords];

  const startSession = useCallback(() => {
    const built = buildSessionFor(allWords, progress, settings);
    setQueue(built.queue);
    setBacklog(built.backlog);
    setSessionStats({ reviewed: 0, dontKnow: 0, medium: 0, know: 0 });
    setScreenState(built.queue.length === 0 ? 'empty' : 'question');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allWords, progress, settings]);

  const settingsBootRef = useRef(true);
  useEffect(() => {
    if (loading) return;
    if (settingsBootRef.current) {
      settingsBootRef.current = false;
      return;
    }
    // Punkt 3: zmiana kierunku nauki / kategorii / poziomu natychmiast przebudowuje kolejkę
    startSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    loading,
    settings.directions.enToPl,
    settings.directions.plToEn,
    settings.activeCategories.join(','),
    settings.activeLevels.join(','),
  ]);

  function onRate(rating) {
    const current = queue[0];
    const key = progressKey(current.direction, current.word.id);
    const p = progress[key] || defaultProgress();
    const now = new Date();

    const { progress: updated, reinsertOffset, leavesSession } = applyRating(p, rating, now, settings);
    const newProgress = { ...progress, [key]: updated };
    setProgress(newProgress);
    saveKey('progress-data', newProgress);

    let rest = queue.slice(1);
    let newBacklog = backlog;

    if (reinsertOffset !== null) {
      const pos = Math.min(reinsertOffset, rest.length);
      rest.splice(pos, 0, current);
    } else if (leavesSession && backlog.length > 0) {
      // punkt 2: karta odeszła (Znam) -> uzupełniamy kolejkę kolejną z backlogu,
      // żeby liczba kart w kolejce pozostała stała
      rest = [...rest, backlog[0]];
      newBacklog = backlog.slice(1);
    }

    const statKey = rating === 'DONT_KNOW' ? 'dontKnow' : rating === 'MEDIUM' ? 'medium' : 'know';
    setSessionStats((s) => ({ ...s, reviewed: s.reviewed + 1, [statKey]: s[statKey] + 1 }));

    setQueue(rest);
    setBacklog(newBacklog);
    setScreenState(rest.length === 0 ? 'summary' : 'question');
  }

  function addCustomWord(en, pl) {
    const word = { id: `custom-${Date.now()}`, en: en.trim(), pl: pl.trim(), category: 'wlasne' };
    const updated = [...customWords, word];
    setCustomWords(updated);
    saveKey('custom-words', updated);
  }

  function removeCustomWord(id) {
    const updated = customWords.filter((w) => w.id !== id);
    setCustomWords(updated);
    saveKey('custom-words', updated);
  }

  function updateSettings(patch) {
    const updated = { ...settings, ...patch };
    setSettings(updated);
    saveKey('app-settings', updated);
  }

  function toggleCategory(id) {
    const has = settings.activeCategories.includes(id);
    const next = has ? settings.activeCategories.filter((c) => c !== id) : [...settings.activeCategories, id];
    updateSettings({ activeCategories: next });
  }

  function toggleLevel(id) {
    const has = settings.activeLevels.includes(id);
    const next = has ? settings.activeLevels.filter((c) => c !== id) : [...settings.activeLevels, id];
    updateSettings({ activeLevels: next });
  }

  function setAllCategories(ids) {
    updateSettings({ activeCategories: ids });
  }

  const dueCount = allWords.reduce((acc, w) => {
    ['enToPl', 'plToEn'].forEach((dir) => {
      if (!settings.directions[dir]) return;
      const p = progress[progressKey(dir, w.id)];
      if (p && p.status !== STATUS.NEW && new Date(p.dueAt) <= new Date()) acc += 1;
    });
    return acc;
  }, 0);

  const statusCounts = { NEW: 0, LEARNING: 0, REVIEW: 0, MASTERED: 0 };
  const statusCountsByDirection = {
    enToPl: { NEW: 0, LEARNING: 0, REVIEW: 0, MASTERED: 0 },
    plToEn: { NEW: 0, LEARNING: 0, REVIEW: 0, MASTERED: 0 },
  };
  allWords.forEach((w) => {
    ['enToPl', 'plToEn'].forEach((dir) => {
      if (!settings.directions[dir]) return;
      const p = progress[progressKey(dir, w.id)];
      const status = p ? p.status : 'NEW';
      statusCounts[status] += 1;
      statusCountsByDirection[dir][status] += 1;
    });
  });

  if (loading) {
    return (
      <div style={styles.appShell}>
        <StyleBlock />
        <div style={{ padding: 40, textAlign: 'center', color: COLORS.inkMuted }}>Wczytywanie…</div>
      </div>
    );
  }

  return (
    <div style={styles.appShell}>
      <StyleBlock />
      <header style={styles.header}>
        <div style={styles.headerTitle}>Fiszki</div>
        <div style={styles.streakBadge}>
          <Flame size={15} color={COLORS.accentMedium} />
          <span>{settings.streak.count}</span>
        </div>
      </header>

      <main style={styles.main}>
        {view === 'study' && (
          <StudyView
            queue={queue}
            screenState={screenState}
            sessionStats={sessionStats}
            dueCount={dueCount}
            onCheck={() => setScreenState('answer')}
            onRate={onRate}
            onRestart={startSession}
          />
        )}
        {view === 'stats' && (
          <StatsView counts={statusCounts} streak={settings.streak} byDirection={statusCountsByDirection} directions={settings.directions} />
        )}
        {view === 'decks' && (
          <DecksView
            categories={CATEGORIES}
            active={settings.activeCategories}
            onToggle={toggleCategory}
            levels={LEVELS}
            activeLevels={settings.activeLevels}
            onToggleLevel={toggleLevel}
            customWords={customWords}
            onAdd={addCustomWord}
            onRemove={removeCustomWord}
            onSetAllCategories={setAllCategories}
          />
        )}
        {view === 'settings' && (
          <SettingsView settings={settings} onUpdate={updateSettings} />
        )}
      </main>

      <nav style={styles.nav}>
        <NavButton icon={<BookOpen size={20} />} label="Nauka" active={view === 'study'} onClick={() => setView('study')} />
        <NavButton icon={<BarChart3 size={20} />} label="Statystyki" active={view === 'stats'} onClick={() => setView('stats')} />
        <NavButton icon={<Layers size={20} />} label="Zestawy" active={view === 'decks'} onClick={() => setView('decks')} />
        <NavButton icon={<SettingsIcon size={20} />} label="Ustawienia" active={view === 'settings'} onClick={() => setView('settings')} />
      </nav>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* WIDOK: NAUKA                                                            */
/* ---------------------------------------------------------------------- */

function StudyView({ queue, screenState, sessionStats, dueCount, onCheck, onRate, onRestart }) {
  if (screenState === 'empty') {
    return (
      <div style={styles.emptyState}>
        <div style={styles.emptyIcon}>✓</div>
        <h2 style={styles.emptyTitle}>Brak kart na teraz</h2>
        <p style={styles.emptyText}>Wszystko powtórzone. Wróć później albo dodaj nowe słówka w Zestawach.</p>
      </div>
    );
  }

  if (screenState === 'summary') {
    return (
      <div style={styles.emptyState}>
        <div style={styles.emptyIcon}>🎉</div>
        <h2 style={styles.emptyTitle}>Sesja zakończona</h2>
        <div style={styles.summaryGrid}>
          <SummaryStat label="Powtórzono" value={sessionStats.reviewed} color={COLORS.ink} />
          <SummaryStat label="Nie znałem" value={sessionStats.dontKnow} color={COLORS.accentDontKnow} />
          <SummaryStat label="Średnio" value={sessionStats.medium} color={COLORS.accentMedium} />
          <SummaryStat label="Znałem" value={sessionStats.know} color={COLORS.accentKnow} />
        </div>
        <button style={styles.primaryButton} onClick={onRestart}>
          <RotateCcw size={16} style={{ marginRight: 8 }} />
          Rozpocznij nową sesję
        </button>
      </div>
    );
  }

  const current = queue[0];
  const isEnToPl = current.direction === 'enToPl';
  const questionText = isEnToPl ? current.word.en : current.word.pl;
  const answerText = isEnToPl ? current.word.pl : current.word.en;
  const questionLang = isEnToPl ? 'en-US' : 'pl-PL';
  const answerLang = isEnToPl ? 'pl-PL' : 'en-US';

  return (
    <div style={styles.studyWrap}>
      <div style={styles.progressLine}>
        <span>{dueCount > 0 ? `${dueCount} do powtórki` : 'Nowa runda'}</span>
        <span>{queue.length} w kolejce</span>
      </div>

      <div style={styles.cardStack}>
        <div style={styles.cardBehind2} />
        <div style={styles.cardBehind1} />
        <div style={styles.flashcard}>
          <div style={styles.cardRingRow}>
            <span style={styles.cardRing} />
            <span style={styles.cardRing} />
          </div>
          <div style={styles.cardDirection}>{isEnToPl ? 'EN → PL' : 'PL → EN'}</div>

          <div style={styles.cardWordRow}>
            <span style={styles.cardWord}>{questionText}</span>
            <button style={styles.speakerBtn} onClick={() => speak(questionText, questionLang)} aria-label="Odsłuchaj">
              <Volume2 size={20} color={COLORS.accentPrimary} />
            </button>
          </div>

          {screenState === 'answer' && (
            <div style={styles.answerBlock}>
              <div style={styles.answerDivider} />
              <div style={styles.cardWordRow}>
                <span style={styles.cardAnswer}>{answerText}</span>
                <button style={styles.speakerBtnSmall} onClick={() => speak(answerText, answerLang)} aria-label="Odsłuchaj tłumaczenie">
                  <Volume2 size={16} color={COLORS.inkMuted} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={styles.bottomBar}>
        {screenState === 'question' && (
          <button style={styles.checkButton} onClick={onCheck}>
            Sprawdź
          </button>
        )}
        {screenState === 'answer' && (
          <div style={styles.ratingRow}>
            <RatingButton icon={<X size={18} />} label="Nie znam" color={COLORS.accentDontKnow} onClick={() => onRate('DONT_KNOW')} />
            <RatingButton icon={<Minus size={18} />} label="Średnio znam" color={COLORS.accentMedium} onClick={() => onRate('MEDIUM')} />
            <RatingButton icon={<Check size={18} />} label="Znam" color={COLORS.accentKnow} onClick={() => onRate('KNOW')} />
          </div>
        )}
      </div>
    </div>
  );
}

function RatingButton({ icon, label, color, onClick }) {
  return (
    <button style={{ ...styles.ratingButton, borderColor: color, color }} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function SummaryStat({ label, value, color }) {
  return (
    <div style={styles.summaryStat}>
      <div style={{ ...styles.summaryValue, color }}>{value}</div>
      <div style={styles.summaryLabel}>{label}</div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* WIDOK: STATYSTYKI                                                       */
/* ---------------------------------------------------------------------- */

function StatsView({ counts, streak, byDirection, directions }) {
  const total = counts.NEW + counts.LEARNING + counts.REVIEW + counts.MASTERED || 1;
  const rows = [
    { key: 'NEW', label: 'Nowe', color: COLORS.inkMuted },
    { key: 'LEARNING', label: 'W trakcie nauki', color: COLORS.accentDontKnow },
    { key: 'REVIEW', label: 'Powtarzane', color: COLORS.accentMedium },
    { key: 'MASTERED', label: 'Opanowane', color: COLORS.accentKnow },
  ];

  const activeDirections = ['enToPl', 'plToEn'].filter((d) => directions[d]);
  const directionLabel = { enToPl: 'EN → PL', plToEn: 'PL → EN' };

  return (
    <div style={styles.sectionWrap}>
      <h2 style={styles.sectionTitle}>Statystyki</h2>

      <div style={styles.statHero}>
        <Flame size={28} color={COLORS.accentMedium} />
        <div>
          <div style={styles.statHeroValue}>{streak.count} {streak.count === 1 ? 'dzień' : 'dni'}</div>
          <div style={styles.statHeroLabel}>passa nauki z rzędu</div>
        </div>
      </div>

      <div style={styles.barChart}>
        {rows.map((r) => (
          <div key={r.key} style={styles.barRow}>
            <div style={styles.barLabelRow}>
              <span>{r.label}</span>
              <span>{counts[r.key]}</span>
            </div>
            <div style={styles.barTrack}>
              <div style={{ ...styles.barFill, width: `${(counts[r.key] / total) * 100}%`, background: r.color }} />
            </div>
          </div>
        ))}
      </div>

      {activeDirections.length > 1 && (
        <>
          <h3 style={styles.subheading}>Postęp osobno wg kierunku</h3>
          <p style={{ ...styles.sectionSubtitle, marginBottom: 14 }}>
            Znajomość słówka w jedną stronę nie wpływa na drugą — to dwa niezależne postępy.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {activeDirections.map((dir) => {
              const c = byDirection[dir];
              const dirTotal = c.NEW + c.LEARNING + c.REVIEW + c.MASTERED || 1;
              return (
                <div key={dir} style={styles.directionCard}>
                  <div style={styles.directionCardTitle}>{directionLabel[dir]}</div>
                  {rows.map((r) => (
                    <div key={r.key} style={styles.directionRow}>
                      <span>{r.label}</span>
                      <span>{c[r.key]} <span style={{ color: COLORS.inkMuted }}>({Math.round((c[r.key] / dirTotal) * 100)}%)</span></span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* WIDOK: ZESTAWY / SŁÓWKA                                                 */
/* ---------------------------------------------------------------------- */

function DecksView({ categories, active, onToggle, levels, activeLevels, onToggleLevel, customWords, onAdd, onRemove, onSetAllCategories }) {
  const [en, setEn] = useState('');
  const [pl, setPl] = useState('');

  const LEVEL_LABELS = {
    A1: 'A1 – Początkujący',
    A2: 'A2 – Podstawowy',
    B1: 'B1 – Średnio zaawansowany',
    B2: 'B2 – Wyżej średnio zaawansowany',
  };

  return (
    <div style={styles.sectionWrap}>
      <h2 style={styles.sectionTitle}>Zestawy</h2>
      <p style={styles.sectionSubtitle}>Wybierz poziom trudności oraz zestawy tematyczne, z których mają pochodzić słówka.</p>

      <h3 style={styles.subheading}>Poziom trudności</h3>
      <div style={{ ...styles.categoryList, marginBottom: 22 }}>
        {levels.map((lvl) => (
          <label key={lvl} style={styles.categoryRow}>
            <input
              type="checkbox"
              checked={activeLevels.includes(lvl)}
              onChange={() => onToggleLevel(lvl)}
              style={styles.checkbox}
            />
            <span>{LEVEL_LABELS[lvl] || lvl}</span>
          </label>
        ))}
      </div>

      <div style={styles.decksHeaderRow}>
        <h3 style={styles.subheading}>Zestawy tematyczne</h3>
        <div style={{ display: 'flex', gap: 10 }}>
          <button style={styles.linkButton} onClick={() => onSetAllCategories(categories.map((c) => c.id))}>
            Zaznacz wszystkie
          </button>
          <button style={styles.linkButton} onClick={() => onSetAllCategories([])}>
            Odznacz wszystkie
          </button>
        </div>
      </div>
      <div style={styles.categoryList}>
        {categories.map((c) => (
          <label key={c.id} style={styles.categoryRow}>
            <input
              type="checkbox"
              checked={active.includes(c.id)}
              onChange={() => onToggle(c.id)}
              style={styles.checkbox}
            />
            <span>{c.name}</span>
          </label>
        ))}
      </div>

      <h3 style={styles.subheading}>Dodaj własne słówko</h3>
      <div style={styles.addWordForm}>
        <input style={styles.textInput} placeholder="po angielsku" value={en} onChange={(e) => setEn(e.target.value)} />
        <input style={styles.textInput} placeholder="po polsku" value={pl} onChange={(e) => setPl(e.target.value)} />
        <button
          style={styles.addButton}
          onClick={() => {
            if (en.trim() && pl.trim()) {
              onAdd(en, pl);
              setEn('');
              setPl('');
            }
          }}
        >
          <Plus size={16} />
        </button>
      </div>

      {customWords.length > 0 && (
        <div style={styles.customWordList}>
          {customWords.map((w) => (
            <div key={w.id} style={styles.customWordRow}>
              <span>{w.en} — {w.pl}</span>
              <button style={styles.trashButton} onClick={() => onRemove(w.id)}>
                <Trash2 size={15} color={COLORS.accentDontKnow} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* WIDOK: USTAWIENIA                                                       */
/* ---------------------------------------------------------------------- */

function SettingsView({ settings, onUpdate }) {
  return (
    <div style={styles.sectionWrap}>
      <h2 style={styles.sectionTitle}>Ustawienia</h2>

      <div style={styles.settingBlock}>
        <label style={styles.settingLabel}>Liczba słówek w kolejce jednocześnie</label>
        <input
          type="number"
          min={1}
          max={100}
          value={settings.dailyGoal}
          onChange={(e) => onUpdate({ dailyGoal: Math.max(1, Number(e.target.value) || 1) })}
          style={styles.numberInput}
        />
        <p style={styles.fieldHint}>
          Gdy ocenisz słówko jako "Znam", od razu wskakuje kolejne, żeby w kolejce zawsze była ta sama liczba kart.
        </p>
      </div>

      <div style={styles.settingBlock}>
        <label style={styles.settingLabel}>Co ile kart powtarzać słówko, którego nie znasz</label>
        <input
          type="number"
          min={1}
          max={50}
          value={settings.dontKnowInterval}
          onChange={(e) => onUpdate({ dontKnowInterval: Math.max(1, Number(e.target.value) || 1) })}
          style={styles.numberInput}
        />
        <p style={styles.fieldHint}>Domyślnie 3 — słówko wraca bardzo szybko, w tej samej sesji.</p>
      </div>

      <div style={styles.settingBlock}>
        <label style={styles.settingLabel}>Co ile kart powtarzać słówko, które znasz średnio</label>
        <input
          type="number"
          min={1}
          max={50}
          value={settings.mediumInterval}
          onChange={(e) => onUpdate({ mediumInterval: Math.max(1, Number(e.target.value) || 1) })}
          style={styles.numberInput}
        />
        <p style={styles.fieldHint}>Domyślnie 8 — rzadziej niż "Nie znam", ale nadal w tej samej sesji.</p>
      </div>

      <div style={styles.settingBlock}>
        <label style={styles.settingLabel}>
          <ArrowLeftRight size={15} style={{ marginRight: 6, verticalAlign: 'middle' }} />
          Kierunki nauki
        </label>
        <label style={styles.categoryRow}>
          <input
            type="checkbox"
            checked={settings.directions.enToPl}
            onChange={(e) => onUpdate({ directions: { ...settings.directions, enToPl: e.target.checked } })}
            style={styles.checkbox}
          />
          <span>Angielski → Polski</span>
        </label>
        <label style={styles.categoryRow}>
          <input
            type="checkbox"
            checked={settings.directions.plToEn}
            onChange={(e) => onUpdate({ directions: { ...settings.directions, plToEn: e.target.checked } })}
            style={styles.checkbox}
          />
          <span>Polski → Angielski</span>
        </label>
      </div>

      <p style={styles.footnote}>
        Dane zapisują się automatycznie na tym urządzeniu i wracają przy kolejnej wizycie.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* DROBNE KOMPONENTY WSPÓLNE                                               */
/* ---------------------------------------------------------------------- */

function NavButton({ icon, label, active, onClick }) {
  return (
    <button onClick={onClick} style={{ ...styles.navButton, color: active ? COLORS.accentPrimary : COLORS.inkMuted }}>
      {icon}
      <span style={styles.navLabel}>{label}</span>
    </button>
  );
}

/* ---------------------------------------------------------------------- */
/* NARZĘDZIA                                                               */
/* ---------------------------------------------------------------------- */

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function interleave(priority, filler, ratio) {
  if (priority.length === 0) return filler;
  if (filler.length === 0) return priority;
  const result = [];
  let pi = 0, fi = 0;
  while (pi < priority.length || fi < filler.length) {
    for (let k = 0; k < ratio && pi < priority.length; k++) result.push(priority[pi++]);
    if (fi < filler.length) result.push(filler[fi++]);
  }
  return result;
}

/* ---------------------------------------------------------------------- */
/* DESIGN TOKENS + STYLE                                                   */
/* ---------------------------------------------------------------------- */

const COLORS = {
  paper: '#E9E5DC',
  paperCard: '#FBF9F4',
  ink: '#26282B',
  inkMuted: '#767268',
  accentPrimary: '#2F5D8A',
  accentKnow: '#3F7D5C',
  accentMedium: '#B4842E',
  accentDontKnow: '#AE4B3E',
  border: '#D6D0C2',
  ringMetal: '#B9B2A1',
};

const styles = {
  appShell: {
    fontFamily: "'Iowan Old Style', Georgia, 'Times New Roman', serif",
    background: COLORS.paper,
    minHeight: '600px',
    maxWidth: 480,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    color: COLORS.ink,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '18px 20px 14px',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: 600,
    letterSpacing: '0.01em',
  },
  streakBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    fontFamily: "-apple-system, 'Segoe UI', sans-serif",
    fontSize: 13,
    fontWeight: 600,
    background: COLORS.paperCard,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 20,
    padding: '4px 10px',
  },
  main: {
    flex: 1,
    padding: '4px 20px 12px',
    overflowY: 'auto',
  },
  studyWrap: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 460,
  },
  progressLine: {
    display: 'flex',
    justifyContent: 'space-between',
    fontFamily: "-apple-system, 'Segoe UI', sans-serif",
    fontSize: 12,
    color: COLORS.inkMuted,
    padding: '2px 4px 14px',
  },
  cardStack: {
    position: 'relative',
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 20,
  },
  cardBehind2: {
    position: 'absolute',
    width: '86%',
    height: '78%',
    background: COLORS.paperCard,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 4,
    transform: 'rotate(4deg) translateY(6px)',
    opacity: 0.55,
  },
  cardBehind1: {
    position: 'absolute',
    width: '90%',
    height: '80%',
    background: COLORS.paperCard,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 4,
    transform: 'rotate(-2.5deg) translateY(3px)',
    opacity: 0.8,
  },
  flashcard: {
    position: 'relative',
    width: '94%',
    minHeight: 260,
    background: COLORS.paperCard,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 4,
    boxShadow: '0 10px 24px rgba(38,40,43,0.10)',
    padding: '18px 26px 30px',
    display: 'flex',
    flexDirection: 'column',
  },
  cardRingRow: {
    display: 'flex',
    gap: 10,
    marginBottom: 14,
  },
  cardRing: {
    width: 12,
    height: 12,
    borderRadius: '50%',
    background: COLORS.paper,
    border: `1.5px solid ${COLORS.ringMetal}`,
  },
  cardDirection: {
    fontFamily: "-apple-system, 'Segoe UI', sans-serif",
    fontSize: 11,
    letterSpacing: '0.08em',
    color: COLORS.inkMuted,
    marginBottom: 22,
  },
  cardWordRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  cardWord: {
    fontSize: 32,
    lineHeight: 1.2,
    fontWeight: 500,
  },
  cardAnswer: {
    fontSize: 24,
    color: COLORS.accentPrimary,
    fontWeight: 500,
  },
  speakerBtn: {
    flexShrink: 0,
    width: 40,
    height: 40,
    borderRadius: '50%',
    border: `1px solid ${COLORS.border}`,
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  speakerBtnSmall: {
    flexShrink: 0,
    width: 30,
    height: 30,
    borderRadius: '50%',
    border: 'none',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  answerBlock: {
    marginTop: 26,
  },
  answerDivider: {
    borderTop: `1px dashed ${COLORS.border}`,
    marginBottom: 22,
  },
  bottomBar: {
    paddingTop: 4,
  },
  checkButton: {
    width: '100%',
    padding: '15px 0',
    background: COLORS.ink,
    color: COLORS.paperCard,
    border: 'none',
    borderRadius: 4,
    fontSize: 16,
    fontFamily: "-apple-system, 'Segoe UI', sans-serif",
    fontWeight: 600,
    cursor: 'pointer',
  },
  ratingRow: {
    display: 'flex',
    gap: 8,
  },
  ratingButton: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    padding: '10px 4px',
    background: COLORS.paperCard,
    border: '1.5px solid',
    borderRadius: 4,
    fontFamily: "-apple-system, 'Segoe UI', sans-serif",
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    minHeight: 420,
    padding: '0 16px',
  },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { fontSize: 20, marginBottom: 8, fontWeight: 600 },
  emptyText: {
    fontFamily: "-apple-system, 'Segoe UI', sans-serif",
    fontSize: 14,
    color: COLORS.inkMuted,
    lineHeight: 1.5,
  },
  summaryGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12,
    margin: '20px 0 26px',
    width: '100%',
  },
  summaryStat: {
    background: COLORS.paperCard,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 4,
    padding: '14px 10px',
  },
  summaryValue: { fontSize: 26, fontWeight: 600 },
  summaryLabel: {
    fontFamily: "-apple-system, 'Segoe UI', sans-serif",
    fontSize: 12,
    color: COLORS.inkMuted,
    marginTop: 2,
  },
  primaryButton: {
    display: 'flex',
    alignItems: 'center',
    padding: '12px 22px',
    background: COLORS.accentPrimary,
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    fontFamily: "-apple-system, 'Segoe UI', sans-serif",
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  nav: {
    display: 'flex',
    borderTop: `1px solid ${COLORS.border}`,
    background: COLORS.paperCard,
  },
  navButton: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 3,
    padding: '10px 0 12px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
  },
  navLabel: {
    fontFamily: "-apple-system, 'Segoe UI', sans-serif",
    fontSize: 10.5,
  },
  sectionWrap: {
    fontFamily: "-apple-system, 'Segoe UI', sans-serif",
  },
  sectionTitle: {
    fontFamily: "'Iowan Old Style', Georgia, serif",
    fontSize: 22,
    fontWeight: 600,
    marginBottom: 6,
  },
  sectionSubtitle: {
    fontSize: 13,
    color: COLORS.inkMuted,
    marginBottom: 18,
    lineHeight: 1.5,
  },
  statHero: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    background: COLORS.paperCard,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 4,
    padding: '16px 18px',
    marginBottom: 22,
  },
  statHeroValue: { fontSize: 20, fontWeight: 700 },
  statHeroLabel: { fontSize: 12, color: COLORS.inkMuted },
  barChart: { display: 'flex', flexDirection: 'column', gap: 16 },
  barRow: {},
  barLabelRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: 13,
    marginBottom: 6,
  },
  barTrack: {
    height: 8,
    background: COLORS.paperCard,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 20,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 20 },
  directionCard: {
    flex: '1 1 140px',
    background: COLORS.paperCard,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 4,
    padding: '12px 14px',
  },
  directionCardTitle: { fontWeight: 700, fontSize: 13, marginBottom: 8 },
  directionRow: { display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0' },
  categoryList: { display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 },
  categoryRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontSize: 14,
    cursor: 'pointer',
  },
  checkbox: { width: 16, height: 16, accentColor: COLORS.accentPrimary },
  subheading: { fontSize: 15, fontWeight: 700, marginBottom: 10, fontFamily: "-apple-system, 'Segoe UI', sans-serif" },
  decksHeaderRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  linkButton: {
    background: 'transparent',
    border: 'none',
    color: COLORS.accentPrimary,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    padding: 0,
  },
  addWordForm: { display: 'flex', gap: 8, marginBottom: 14 },
  textInput: {
    flex: 1,
    padding: '9px 10px',
    border: `1px solid ${COLORS.border}`,
    borderRadius: 4,
    fontSize: 13,
    background: COLORS.paperCard,
  },
  addButton: {
    width: 38,
    background: COLORS.ink,
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  customWordList: { display: 'flex', flexDirection: 'column', gap: 6 },
  customWordRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: 13,
    background: COLORS.paperCard,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 4,
    padding: '8px 10px',
  },
  trashButton: { background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex' },
  settingBlock: { marginBottom: 24 },
  settingLabel: { display: 'block', fontSize: 13, fontWeight: 700, marginBottom: 10 },
  fieldHint: { fontSize: 12, color: COLORS.inkMuted, marginTop: 6, lineHeight: 1.4 },
  numberInput: {
    width: 80,
    padding: '8px 10px',
    border: `1px solid ${COLORS.border}`,
    borderRadius: 4,
    fontSize: 14,
    background: COLORS.paperCard,
  },
  footnote: { fontSize: 12, color: COLORS.inkMuted, lineHeight: 1.5 },
};

function StyleBlock() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      button:focus-visible, input:focus-visible { outline: 2px solid ${COLORS.accentPrimary}; outline-offset: 2px; }
    `}</style>
  );
}
