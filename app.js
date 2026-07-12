function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
const {
  useState,
  useMemo,
  useEffect
} = React;
const {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine
} = Recharts;
const C = {
  bg: "#0B0B16",
  card: "#131323",
  card2: "#1B1B2F",
  border: "#262640",
  text: "#EEF0FF",
  sub: "#8890C0",
  muted: "#4A5080",
  accent: "#10D4A0",
  blue: "#5060FF",
  warn: "#FF5060",
  gold: "#FFB020"
};
const est1RM = (load, reps) => +(load * (1 + reps / 30)).toFixed(1);
// Load-velocity relationship: v = 0.15 + 1.0 × (1 − load/1RM), floored at 0.15 m/s
const estVelocity = (load, oneRM) => +Math.max(0.15, 0.15 + 1.0 * (1 - load / Math.max(oneRM, load))).toFixed(2);
const calcPower = (load, vel) => Math.round(load * 9.81 * vel); // Watts (mean per rep)

// Injury Index: % increase in load vs previous session for the same exercise.
// Decreases/deloads are clamped to 0 (they don't add injury risk).
// Bigger positive jumps => steeper slope => higher injury risk.
// Acute:Chronic Workload Ratio
// acute  = session volume (load × reps) for current session
// chronic = average session volume over previous 4 sessions with this exercise
// Safe zone: 0.8–1.3 | Caution: 1.3–1.5 | High risk: >1.5
const calcACWR = (sessions, exName, currentIndex) => {
  // Compute volume per session for this exercise
  const vols = sessions.map(s => {
    const entries = s.entries.filter(e => e.ex === exName);
    return entries.reduce((sum, e) => sum + e.load * e.reps, 0);
  });
  const acute = vols[currentIndex];
  if (!acute) return null;
  // Chronic: mean of up to 4 previous sessions that had volume > 0
  const prev = vols.slice(Math.max(0, currentIndex - 4), currentIndex).filter(v => v > 0);
  if (!prev.length) return null;
  const chronic = prev.reduce((a, b) => a + b, 0) / prev.length;
  return chronic > 0 ? +(acute / chronic).toFixed(2) : null;
};
const acwrZone = v => {
  if (v == null) return {
    label: "–",
    color: C.muted
  };
  if (v > 1.5) return {
    label: "High risk",
    color: C.warn
  };
  if (v > 1.3) return {
    label: "Caution",
    color: "#FFB020"
  };
  if (v >= 0.8) return {
    label: "Optimal",
    color: "#10D4A0"
  };
  return {
    label: "Low load",
    color: C.blue
  };
};

// ─── Training Quality Indices (all 0–100) ────────────────────────────────────

// Hypertrophy Index: volume in optimal rep range relative to max strength
// Peaks at 6–12 reps, moderate-high intensity (65–85% 1RM)
// Training Density = total volume moved per unit of total session time (work + rest),
// expressed in kg/min. This is the metric that actually uses recorded rest periods —
// shorter rest at equal volume = higher density = a genuinely different training stimulus.
// Estimate seconds of actual work for one set (TUT for dynamic sets, hold×reps for iso)
const estSetWorkSecs = (e, exDef) => {
  if (e.holdDuration) return e.holdDuration * (e.reps || 1);
  const ecc = e.eccSecs || exDef?.eccSecs || 2;
  const con = e.conSecs || exDef?.conSecs || 1;
  return (e.reps || 1) * (ecc + con);
};
const calcDensity = (totalVol, totalTimeSecs) => {
  if (!totalTimeSecs || totalTimeSecs <= 0) return null;
  return +(totalVol / (totalTimeSecs / 60)).toFixed(1);
};
const calcHypIndex = (totalVol, oneRM, avgReps, avgTUT) => {
  const repFactor = avgReps >= 6 && avgReps <= 12 ? 1.0 : avgReps > 12 && avgReps <= 20 ? 0.8 : avgReps > 3 && avgReps < 6 ? 0.5 : 0.2;
  // TUT factor: optimal hypertrophy TUT = 40–70 s per set
  let tutFactor = 1.0; // default (no tempo data)
  if (avgTUT != null && avgTUT > 0) {
    if (avgTUT >= 40 && avgTUT <= 70) tutFactor = 1.0;else if (avgTUT < 40) tutFactor = Math.max(0.4, avgTUT / 40);else tutFactor = Math.max(0.6, 70 / avgTUT);
  }
  return Math.min(100, Math.round(totalVol / oneRM * repFactor * tutFactor * 10));
};

// Max Strength Index: % of estimated 1RM used (90%+ = true max strength zone)
const calcMSI = (maxLoad, oneRM) => Math.min(100, Math.round(maxLoad / Math.max(oneRM, maxLoad) * 100));

// Strength Endurance Index: volume × high-rep factor (rewards 15+ reps at load)
const calcSEI = (totalVol, oneRM, avgReps) => {
  const repFactor = Math.max(0, Math.min(1, (avgReps - 8) / 14)); // 0 at 8, 1 at 22 reps
  return Math.min(100, Math.round(totalVol / oneRM * repFactor * 8));
};

// Power Index: watts relative to strength ceiling (explosive efficiency)
// Higher = moving loads more explosively relative to what they can lift
// If concentric seconds known, derive velocity: v ≈ ROM(0.45m) / conSecs
const velFromConSecs = conSecs => conSecs > 0 ? +(0.45 / conSecs).toFixed(2) : null;
const calcPowerIndex = (power, oneRM) => Math.round(Math.min(100, power / Math.max(oneRM, 1) * 10));

// Zone descriptors for Training Indices
const trainingZone = (key, val) => {
  if (val == null) return {
    label: "–",
    color: C.muted
  };
  if (key === "Hyp Index") {
    if (val >= 70) return {
      label: "High stimulus",
      color: "#10D4A0"
    };
    if (val >= 40) return {
      label: "Moderate",
      color: "#FFB020"
    };
    return {
      label: "Low stimulus",
      color: C.blue
    };
  }
  if (key === "Max Str Index") {
    if (val >= 90) return {
      label: "Peaking",
      color: C.warn
    };
    if (val >= 80) return {
      label: "Max strength",
      color: "#FF8020"
    };
    if (val >= 65) return {
      label: "Strength zone",
      color: "#FFB020"
    };
    return {
      label: "Sub-maximal",
      color: C.blue
    };
  }
  if (key === "Str End Index") {
    if (val >= 60) return {
      label: "High endurance",
      color: "#10D4A0"
    };
    if (val >= 30) return {
      label: "Moderate",
      color: "#FFB020"
    };
    return {
      label: "Low",
      color: C.blue
    };
  }
  if (key === "Power Index") {
    if (val >= 60) return {
      label: "Highly explosive",
      color: "#AA44FF"
    };
    if (val >= 30) return {
      label: "Good power",
      color: "#FFB020"
    };
    return {
      label: "Low power",
      color: C.blue
    };
  }
  return {
    label: "–",
    color: C.muted
  };
};
const injuryIndex = (curr, prev) => {
  if (prev == null || curr == null || prev === 0) return 0;
  const pct = (curr - prev) / prev * 100;
  return pct > 0 ? +pct.toFixed(1) : 0;
};
const initials = name => name.trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
const AV_COLS = [C.accent, C.blue, "#AA44FF", C.gold, "#FF5060", "#FF8020", "#44AAFF", "#FF44AA"];
const avCol = idx => AV_COLS[idx % AV_COLS.length];

// Isometric helpers
const isIsoType = t => ["Ovrc Iso-Ballistic", "Ovrc Iso-Max", "Yielding Iso-Holds", "Yielding Iso-GPP"].includes(t);
const isOvrcIso = t => t === "Ovrc Iso-Ballistic" || t === "Ovrc Iso-Max";
const isYieldIso = t => t === "Yielding Iso-Holds" || t === "Yielding Iso-GPP";
const isClusterSet = t => t === "Cluster Set";

// Band strength → kg load ranges (increments of 1kg)
const BAND_RANGES = {
  "Extra Light": [1, 2],
  "Light": [2, 5],
  "Medium": [6, 10],
  "Heavy": [11, 20],
  "Extra Heavy": [21, 35]
};
// Rest period dropdown options: 20s to 900s in 5s increments
const REST_OPTIONS = Array.from({
  length: (900 - 20) / 5 + 1
}, (_, i) => 20 + i * 5);

// Increment magnitude options for incremental rest: fine steps early, coarser further out
const INCREMENT_OPTIONS = [...Array.from({
  length: 13
}, (_, i) => i * 5),
// 0,5,10...60 (5s steps)
...Array.from({
  length: 23
}, (_, i) => 70 + i * 10),
// 70,80...300 (10s steps)
...Array.from({
  length: 20
}, (_, i) => 330 + i * 30),
// 330,360...900 (30s steps)
...Array.from({
  length: 45
}, (_, i) => 960 + i * 60) // 960,1020...3600 (60s steps, up to 1hr)
];

// Compute rest before the next set, given base rest + incremental progression.
// completedSetNo = the set number just logged (rest applies before the following set).
// Rest calc with optional pyramid (trend switch partway through the set sequence).
// Phase 1 runs from set 1 to the turn point; phase 2 takes over after that,
// continuing from wherever phase 1 left off (so the curve is continuous, not reset).
// Rest calc with unlimited trend switches ("wave" pattern). `turns` is an array
// of {afterSet, dir, amt} — each says "from this set number onward, switch to
// this new trend/increment". Sorted internally so add order doesn't matter.
function calcIncrementalRest(baseSecs, dir0, amt0, completedSetNo, turns) {
  if (!baseSecs) return null;
  const clamp = v => Math.min(900, Math.max(10, v));
  const n = Math.max(1, completedSetNo || 1);
  const phases = [{
    start: 1,
    dir: dir0,
    amt: amt0
  }, ...(turns || []).filter(t => t && t.afterSet).map(t => ({
    start: +t.afterSet,
    dir: t.dir,
    amt: +t.amt || 0
  }))].sort((a, b) => a.start - b.start);
  let rest = baseSecs;
  for (let s = 2; s <= n; s++) {
    let active = phases[0];
    for (const p of phases) {
      if (p.start <= s - 1) active = p;
    }
    rest = clamp(rest + (active.amt || 0) * (active.dir === "-" ? -1 : 1));
  }
  return clamp(rest);
}
const TURN_OPTIONS = Array.from({
  length: 19
}, (_, i) => i + 2);
const fmtRest = s => s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min` : `${s}s`;
const bandRangeOptions = strength => {
  const r = BAND_RANGES[strength];
  if (!r) return [];
  const [lo, hi] = r;
  return Array.from({
    length: hi - lo + 1
  }, (_, i) => lo + i);
};
const ISO_META = {
  "Ovrc Iso-Ballistic": {
    color: "#FF5060",
    icon: "⚡",
    label: "Overcoming Iso — Ballistic",
    desc: "0.5–1s rapid maximal bursts. Max nervous system stimulation. No external load.",
    holdTarget: "0.5–1s",
    setsReps: "6–10 reps"
  },
  "Ovrc Iso-Max": {
    color: "#FF8020",
    icon: "💪",
    label: "Overcoming Iso — Maximal Force",
    desc: "3s sustained maximal push. High stimulus, recoverable. No external load.",
    holdTarget: "3s",
    setsReps: "4 sets × 3 reps"
  },
  "Yielding Iso-Holds": {
    color: "#5060FF",
    icon: "🏋",
    label: "Yielding Iso — Iso Holds",
    desc: "Hold against gravity. Targets weaker tendon regions. Ideal for tendinopathy rehab.",
    holdTarget: "30–45s",
    setsReps: "3 sets × 60–85% MVIC"
  },
  "Yielding Iso-GPP": {
    color: "#00C896",
    icon: "🏃",
    label: "Yielding Iso — GPP (General Physical Preparedness)",
    desc: "Extended iso holds for general physical conditioning. Builds postural endurance and full-body resilience.",
    holdTarget: "60–180s",
    setsReps: "2–3 sets × 60–85% MVIC"
  }
};

// ─── Responsive width hook ────────────────────────────────────────────────────
function useWindowWidth() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 600);
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return w;
}

// ─── Custom X-axis tick: session ID + date ────────────────────────────────────
function SessionXTick({
  x,
  y,
  payload,
  dateMap
}) {
  const date = dateMap?.[payload?.value] || "";
  return /*#__PURE__*/React.createElement("g", {
    transform: `translate(${x},${y})`
  }, /*#__PURE__*/React.createElement("text", {
    textAnchor: "middle",
    fill: C.muted,
    fontSize: 10,
    dy: 12,
    fontFamily: "inherit"
  }, payload?.value), date && /*#__PURE__*/React.createElement("text", {
    textAnchor: "middle",
    fill: C.muted,
    fontSize: 8,
    dy: 23,
    fontFamily: "inherit"
  }, date));
}
const CATEGORIES = ["Strength", "Power", "Stability", "Mobility"];
const PROG_TYPES = ["General Strength", "Hypertrophy", "Endurance Strength", "Max Strength", "Power", "Muscular Endurance", "Hybrid"];
const SET_TYPES = ["Normal", "Warm-up", "Top Set", "Back-off", "Drop Set", "Negative", "Cluster Set", "Ovrc Iso-Ballistic", "Ovrc Iso-Max", "Yielding Iso-Holds", "Yielding Iso-GPP"];
const EQUIP_LIST = ["Barbell", "Dumbbell", "Cable machine", "Bodyweight", "Kettlebell", "Long band", "Short band", "Medicine ball", "Trap(Hex) bar"];
const LAT_LIST = ["Bilateral", "Unilateral - Left", "Unilateral - Right", "Alternating", "Contralateral"];
const RPE_DESC = {
  4: "Minimal Effort",
  5: "Light",
  6: "Moderate",
  7: "Hard",
  8: "Very Hard",
  9: "Near Maximal",
  10: "Maximal"
};
const EX_LIST = ["Chest Press", "Shoulder Press", "Fly", "Lateral raise", "Row", "Chinups", "Reverse fly", "Bicep curls", "Tricep dips", "Squat", "Deadlift", "Forward lunge", "Reverse lunge"];

// One-time migration: merge any previously-stored (additions-only) list with
// the new full default list, so existing users don't lose defaults that used
// to be hardcoded separately. Runs once per key, then behaves like a normal
// localStorage-backed list from then on.
function migrateList(key, defaults) {
  try {
    const migKey = key + '_v2mig';
    if (localStorage.getItem(migKey)) {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : defaults;
    }
    const v = localStorage.getItem(key);
    const stored = v ? JSON.parse(v) : [];
    const merged = Array.from(new Set([...defaults, ...stored]));
    localStorage.setItem(key, JSON.stringify(merged));
    localStorage.setItem(migKey, '1');
    return merged;
  } catch {
    return defaults;
  }
}
const SEED_EX = [{
  name: "Squat",
  eq: "Barbell",
  lat: "Bilateral",
  pattern: "Squat",
  firstLoad: 100,
  lastLoad: 122,
  eccSecs: 3,
  conSecs: 1
}, {
  name: "Chest Press",
  eq: "Dumbbell",
  lat: "Bilateral",
  pattern: "Vertical Push",
  firstLoad: 60,
  lastLoad: 85,
  eccSecs: 3,
  conSecs: 1
}, {
  name: "Row",
  eq: "Cable machine",
  lat: "Bilateral",
  pattern: "Horiz. Pull",
  firstLoad: 17,
  lastLoad: 32,
  eccSecs: 2,
  conSecs: 1
}, {
  name: "Forward lunge",
  eq: "Dumbbell",
  lat: "Alternating",
  pattern: "Lunge",
  firstLoad: 20,
  lastLoad: 30,
  eccSecs: 3,
  conSecs: 1
}];
const SEED_SESSIONS = [{
  id: "S1",
  date: "19 Jan",
  entries: [{
    ex: "Squat",
    reps: 8,
    set: 1,
    type: "Normal",
    load: 100,
    rir: 2,
    rpe: 7
  }, {
    ex: "Chest Press",
    reps: 10,
    set: 1,
    type: "Normal",
    load: 60,
    rir: 2,
    rpe: 7
  }, {
    ex: "Forward lunge",
    reps: 10,
    set: 1,
    type: "Normal",
    load: 20,
    rir: 4,
    rpe: 8
  }, {
    ex: "Row",
    reps: 10,
    set: 1,
    type: "Normal",
    load: 17,
    rir: 2,
    rpe: 8
  }]
}, {
  id: "S2",
  date: "26 Jan",
  entries: [{
    ex: "Squat",
    reps: 9,
    set: 2,
    type: "Normal",
    load: 110,
    rir: 2,
    rpe: 8
  }, {
    ex: "Chest Press",
    reps: 10,
    set: 2,
    type: "Normal",
    load: 70,
    rir: 2,
    rpe: 8
  }, {
    ex: "Forward lunge",
    reps: 10,
    set: 2,
    type: "Normal",
    load: 24,
    rir: 4,
    rpe: 9
  }, {
    ex: "Row",
    reps: 11,
    set: 2,
    type: "Normal",
    load: 22,
    rir: 2,
    rpe: 9
  }]
}, {
  id: "S3",
  date: "03 Feb",
  entries: [{
    ex: "Squat",
    reps: 8,
    set: 1,
    type: "Normal",
    load: 112,
    rir: 1,
    rpe: 8
  }, {
    ex: "Chest Press",
    reps: 9,
    set: 1,
    type: "Normal",
    load: 75,
    rir: 1,
    rpe: 6
  }, {
    ex: "Forward lunge",
    reps: 9,
    set: 1,
    type: "Normal",
    load: 25,
    rir: 2,
    rpe: 8
  }, {
    ex: "Row",
    reps: 10,
    set: 1,
    type: "Normal",
    load: 24,
    rir: 1,
    rpe: 8
  }]
}, {
  id: "S4",
  date: "10 Feb",
  entries: [{
    ex: "Squat",
    reps: 9,
    set: 1,
    type: "Normal",
    load: 120,
    rir: 2,
    rpe: 9
  }, {
    ex: "Chest Press",
    reps: 9,
    set: 1,
    type: "Normal",
    load: 80,
    rir: 2,
    rpe: 7
  }, {
    ex: "Forward lunge",
    reps: 11,
    set: 1,
    type: "Normal",
    load: 27,
    rir: 1,
    rpe: 10
  }, {
    ex: "Row",
    reps: 8,
    set: 1,
    type: "Normal",
    load: 26,
    rir: 2,
    rpe: 7
  }]
}, {
  id: "S5",
  date: "11 Aug",
  entries: [{
    ex: "Squat",
    reps: 9,
    set: 1,
    type: "Normal",
    load: 122,
    rir: 2,
    rpe: 6
  }, {
    ex: "Chest Press",
    reps: 9,
    set: 1,
    type: "Normal",
    load: 85,
    rir: 2,
    rpe: 7
  }, {
    ex: "Forward lunge",
    reps: 9,
    set: 1,
    type: "Normal",
    load: 30,
    rir: 2,
    rpe: 8
  }, {
    ex: "Row",
    reps: 9,
    set: 1,
    type: "Normal",
    load: 32,
    rir: 2,
    rpe: 8
  }]
}];
const INIT_CLIENTS = [{
  id: "c1",
  name: "Colin White",
  bw: 78,
  height: 1.69,
  email: "colwhi@mweb.co.za",
  programs: [{
    id: "p1",
    name: "General Strength",
    category: "Strength",
    type: "General Strength",
    exercises: SEED_EX,
    sessions: SEED_SESSIONS
  }],
  archived: false,
  activeProgramId: "p1"
}, {
  id: "c2",
  name: "Angela Campbell",
  bw: null,
  height: null,
  email: "",
  archived: false,
  programs: [],
  activeProgramId: null
}, {
  id: "c3",
  name: "Attie Kok",
  bw: null,
  height: null,
  email: "",
  archived: false,
  programs: [],
  activeProgramId: null
}, {
  id: "c4",
  name: "Kate Savage",
  bw: null,
  height: null,
  email: "",
  archived: false,
  programs: [],
  activeProgramId: null
}, {
  id: "c5",
  name: "Jeanne Coetzee",
  bw: null,
  height: null,
  email: "",
  archived: false,
  programs: [],
  activeProgramId: null
}, {
  id: "c6",
  name: "David Dobson",
  bw: null,
  height: null,
  email: "",
  archived: false,
  programs: [],
  activeProgramId: null
}, {
  id: "c7",
  name: "Sarah Treherne",
  bw: null,
  height: null,
  email: "",
  archived: false,
  programs: [],
  activeProgramId: null
}];

// ─── Shared ───────────────────────────────────────────────────────────────────

const ss = {
  width: "100%",
  background: C.card2,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: "11px 12px",
  color: C.text,
  fontSize: 14,
  outline: "none",
  boxSizing: "border-box"
};
const Lbl = ({
  t
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 10,
    color: C.muted,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    marginBottom: 5,
    fontWeight: 700
  }
}, t);
const SecLabel = ({
  text
}) => /*#__PURE__*/React.createElement("div", {
  style: {
    fontSize: 10,
    color: C.muted,
    letterSpacing: 2,
    textTransform: "uppercase",
    marginBottom: 10,
    fontWeight: 700
  }
}, text);
function Tag({
  text,
  color = C.accent
}) {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      background: color + "22",
      color,
      border: `1px solid ${color}44`,
      borderRadius: 5,
      padding: "2px 8px",
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.4,
      whiteSpace: "nowrap"
    }
  }, text);
}
function StatCard({
  label,
  value,
  unit,
  color = C.accent
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card2,
      borderRadius: 10,
      padding: "10px 12px",
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      letterSpacing: 1.5,
      textTransform: "uppercase",
      marginBottom: 3,
      fontWeight: 700
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 26,
      lineHeight: 1,
      color,
      letterSpacing: 1
    }
  }, value, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      marginLeft: 2,
      opacity: 0.7
    }
  }, unit)));
}
function Avatar({
  name,
  idx,
  size = 44
}) {
  const col = avCol(idx);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: size,
      height: size,
      borderRadius: "50%",
      background: col + "22",
      border: `2px solid ${col}55`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: size * 0.38,
      letterSpacing: 1,
      color: col,
      flexShrink: 0
    }
  }, initials(name));
}

// ─── AddableSelect ────────────────────────────────────────────────────────────

function AddableSelect({
  value,
  onChange,
  options,
  onAddOption,
  addLabel = "Add new...",
  onEditOption,
  onDeleteOption
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [editItem, setEditItem] = useState(null);
  const [editVal, setEditVal] = useState("");
  const confirm = () => {
    const v = draft.trim();
    if (!v) return;
    onAddOption(v);
    onChange(v);
    setDraft("");
    setAdding(false);
  };
  const saveEdit = old => {
    const v = editVal.trim();
    if (v && v !== old && onEditOption) {
      onEditOption(old, v);
      if (value === old) onChange(v);
    }
    setEditItem(null);
    setEditVal("");
  };
  const selectItem = v => {
    onChange(v);
    setOpen(false);
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setOpen(o => !o),
    style: {
      ...ss,
      width: "100%",
      textAlign: "left",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      cursor: "pointer",
      background: C.card2,
      border: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: value ? C.text : C.muted
    }
  }, value || "Select…"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.muted,
      fontSize: 12
    }
  }, open ? "▲" : "▼")), open && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: "calc(100% + 4px)",
      left: 0,
      right: 0,
      zIndex: 200,
      background: C.card,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      maxHeight: 280,
      overflowY: "auto"
    }
  }, options.filter(o => o).map(o => /*#__PURE__*/React.createElement("div", {
    key: o,
    style: {
      borderBottom: `1px solid ${C.border}`
    }
  }, editItem === o ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      padding: "6px 10px",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("input", {
    autoFocus: true,
    value: editVal,
    onChange: e => setEditVal(e.target.value),
    onKeyDown: e => {
      if (e.key === "Enter") saveEdit(o);
      if (e.key === "Escape") setEditItem(null);
    },
    style: {
      ...ss,
      flex: 1,
      padding: "5px 8px",
      fontSize: 12
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => saveEdit(o),
    style: {
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 6,
      padding: "5px 10px",
      cursor: "pointer",
      fontSize: 11,
      fontWeight: 700,
      flexShrink: 0
    }
  }, "✓"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setEditItem(null),
    style: {
      background: "none",
      color: C.sub,
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: "5px 8px",
      cursor: "pointer",
      fontSize: 12,
      flexShrink: 0
    }
  }, "✕")) : /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => selectItem(o),
    style: {
      flex: 1,
      padding: "10px 14px",
      cursor: "pointer",
      fontSize: 13,
      background: value === o ? C.accent + "22" : "transparent",
      color: value === o ? C.accent : C.text
    }
  }, o), onEditOption && /*#__PURE__*/React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      setEditItem(o);
      setEditVal(o);
    },
    style: {
      background: "none",
      border: "none",
      padding: "10px 8px",
      cursor: "pointer",
      color: C.muted,
      fontSize: 14
    }
  }, "✎"), onDeleteOption && /*#__PURE__*/React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      if (window.confirm(`Delete "${o}"?`)) {
        onDeleteOption(o);
        if (value === o) onChange(options.find(x => x !== o) || "");
      }
    },
    style: {
      background: "none",
      border: "none",
      padding: "10px 8px",
      cursor: "pointer",
      color: C.warn,
      fontSize: 14
    }
  }, "🗑")))), adding ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      padding: "8px 10px",
      alignItems: "center",
      borderTop: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("input", {
    autoFocus: true,
    value: draft,
    onChange: e => setDraft(e.target.value),
    onKeyDown: e => {
      if (e.key === "Enter") confirm();
      if (e.key === "Escape") {
        setAdding(false);
        setDraft("");
      }
    },
    placeholder: "Type & press Enter",
    style: {
      ...ss,
      flex: 1,
      padding: "5px 8px",
      fontSize: 12
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: confirm,
    style: {
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 6,
      padding: "5px 10px",
      cursor: "pointer",
      fontWeight: 700,
      fontSize: 12,
      flexShrink: 0
    }
  }, "Add"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setAdding(false);
      setDraft("");
    },
    style: {
      background: "none",
      color: C.sub,
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: "5px 8px",
      cursor: "pointer",
      fontSize: 14,
      flexShrink: 0
    }
  }, "✕")) : /*#__PURE__*/React.createElement("button", {
    onClick: () => setAdding(true),
    style: {
      width: "100%",
      background: "none",
      border: "none",
      borderTop: `1px solid ${C.border}`,
      padding: "10px 14px",
      cursor: "pointer",
      color: C.accent,
      fontSize: 13,
      fontWeight: 700,
      textAlign: "left"
    }
  }, "＋ ", addLabel)));
}

// ─── Sheet ────────────────────────────────────────────────────────────────────

function Sheet({
  title,
  onClose,
  children
}) {
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.72)",
      zIndex: 99
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "fixed",
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 100,
      background: C.card,
      borderRadius: "20px 20px 0 0",
      border: `1px solid ${C.border}`,
      maxHeight: "90vh",
      overflowY: "auto"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "16px 18px 12px",
      borderBottom: `1px solid ${C.border}`,
      position: "sticky",
      top: 0,
      background: C.card,
      zIndex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 20,
      letterSpacing: 2.5,
      color: C.accent
    }
  }, title), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: {
      background: "none",
      border: "none",
      color: C.sub,
      fontSize: 22,
      cursor: "pointer",
      padding: 4
    }
  }, "✕")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "16px 18px 32px"
    }
  }, children)));
}

// ─── Exercise Builder (shared by Add & Edit program modals) ───────────────────

function ExerciseBuilder({
  exercises,
  setExercises,
  exList,
  equipList,
  latList,
  onAddEx,
  onAddEquip,
  onAddLat,
  customExercises = [],
  onEditEx,
  onDeleteEx,
  customEquipment = [],
  onEditEquip,
  onDeleteEquip,
  customLaterality = [],
  onEditLat,
  onDeleteLat
}) {
  const [exForm, setExForm] = useState({
    name: "",
    eq: "Barbell",
    lat: "Bilateral",
    eccSecs: "",
    conSecs: "",
    restSecs: "",
    restIncrementDir: "+",
    restIncrementAmt: "0",
    restTurns: [],
    restBetweenNext: "",
    instructions: "",
    generalInstructions: ""
  });
  const [editIdx, setEditIdx] = useState(null); // index being edited inline
  const updEx = (k, v) => setExForm(f => ({
    ...f,
    [k]: v
  }));
  const addEx = () => {
    if (!exForm.name) return;
    setExercises(es => [...es, {
      ...exForm,
      firstLoad: 0,
      lastLoad: 0
    }]);
    setExForm({
      name: "",
      eq: "Barbell",
      lat: "Bilateral",
      eccSecs: "",
      conSecs: "",
      restSecs: "",
      restIncrementDir: "+",
      restIncrementAmt: "0",
      restTurns: [],
      restBetweenNext: "",
      instructions: "",
      generalInstructions: ""
    });
  };
  const removeEx = i => {
    setExercises(es => es.filter((_, j) => j !== i));
    if (editIdx === i) setEditIdx(null);
  };
  const saveEdit = (i, updated) => {
    setExercises(es => es.map((e, j) => j === i ? {
      ...e,
      ...updated
    } : e));
    setEditIdx(null);
  };
  return /*#__PURE__*/React.createElement(React.Fragment, null, exercises.map((ex, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      background: C.card2,
      borderRadius: 10,
      marginBottom: 8,
      border: `1px solid ${C.border}`,
      overflow: "hidden"
    }
  }, editIdx === i ?
  /*#__PURE__*/
  // ── inline edit row ──
  React.createElement("div", {
    style: {
      padding: "10px 12px"
    }
  }, /*#__PURE__*/React.createElement(ExRowEdit, {
    ex: ex,
    exList: exList,
    equipList: equipList,
    latList: latList,
    onAddEx: onAddEx,
    onAddEquip: onAddEquip,
    onAddLat: onAddLat,
    customExercises: customExercises,
    onEditEx: onEditEx,
    onDeleteEx: onDeleteEx,
    customEquipment: customEquipment,
    onEditEquip: onEditEquip,
    onDeleteEquip: onDeleteEquip,
    customLaterality: customLaterality,
    onEditLat: onEditLat,
    onDeleteLat: onDeleteLat,
    onSave: upd => saveEdit(i, upd),
    onCancel: () => setEditIdx(null)
  })) :
  /*#__PURE__*/
  // ── display row ──
  React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      padding: "10px 12px",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 700
    }
  }, ex.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub,
      marginTop: 2
    }
  }, ex.eq, " · ", ex.lat, (ex.eccSecs || ex.conSecs) && /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.accent,
      fontWeight: 700
    }
  }, " · ⏱ ", ex.eccSecs || "?", "/", ex.conSecs || "?", "s"), ex.restSecs && /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.gold,
      fontWeight: 700
    }
  }, " ", "· 💤 ", fmtRest(+ex.restSecs), +(ex.restIncrementAmt || 0) > 0 ? (ex.restTurns || []).length > 0 ? ` (🌊 wave, ${ex.restTurns.length} turn${ex.restTurns.length !== 1 ? "s" : ""})` : ` (${ex.restIncrementDir}${fmtRest(+ex.restIncrementAmt)}/set)` : ""), ex.restBetweenNext && /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.blue,
      fontWeight: 700
    }
  }, " · →", fmtRest(+ex.restBetweenNext)))), /*#__PURE__*/React.createElement("button", {
    onClick: () => setEditIdx(i),
    style: {
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 7,
      color: C.sub,
      cursor: "pointer",
      fontSize: 13,
      padding: "5px 10px",
      fontWeight: 600
    }
  }, "✎ Edit"), /*#__PURE__*/React.createElement("button", {
    onClick: () => removeEx(i),
    style: {
      background: "none",
      border: "none",
      color: C.warn,
      cursor: "pointer",
      fontSize: 20,
      padding: "4px 6px"
    }
  }, "✕")))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card2,
      borderRadius: 10,
      padding: "12px",
      border: `1px dashed ${C.accent + "44"}`,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.accent,
      fontWeight: 700,
      marginBottom: 10,
      letterSpacing: 1
    }
  }, "ADD EXERCISE"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Exercise"
  }), /*#__PURE__*/React.createElement(AddableSelect, {
    value: exForm.name,
    onChange: v => updEx("name", v),
    options: ["", ...exList].filter((v, i, a) => a.indexOf(v) === i),
    onAddOption: onAddEx,
    addLabel: "Add new exercise",
    onEditOption: onEditEx,
    onDeleteOption: onDeleteEx
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Equipment"
  }), /*#__PURE__*/React.createElement(AddableSelect, {
    value: exForm.eq,
    onChange: v => updEx("eq", v),
    options: equipList,
    onAddOption: onAddEquip,
    addLabel: "Add equipment",
    onEditOption: onEditEquip,
    onDeleteOption: onDeleteEquip
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Laterality"
  }), /*#__PURE__*/React.createElement(AddableSelect, {
    value: exForm.lat,
    onChange: v => updEx("lat", v),
    options: latList,
    onAddOption: onAddLat,
    addLabel: "Add laterality",
    onEditOption: onEditLat,
    onDeleteOption: onDeleteLat
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Eccentric (s)"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0.5",
    step: "0.5",
    placeholder: "e.g. 3",
    value: exForm.eccSecs,
    onChange: e => updEx("eccSecs", e.target.value),
    style: ss
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Concentric (s)"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0.5",
    step: "0.5",
    placeholder: "e.g. 1",
    value: exForm.conSecs,
    onChange: e => updEx("conSecs", e.target.value),
    style: ss
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      marginBottom: 8,
      lineHeight: 1.4
    }
  }, "Prescribed tempo — sets the TUT target for hypertrophy. Optional."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Rest between sets"
  }), /*#__PURE__*/React.createElement("select", {
    value: exForm.restSecs,
    onChange: e => updEx("restSecs", e.target.value),
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select…"), REST_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, fmtRest(v))))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Rest to next exercise"
  }), /*#__PURE__*/React.createElement("select", {
    value: exForm.restBetweenNext,
    onChange: e => updEx("restBetweenNext", e.target.value),
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select…"), REST_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, fmtRest(v)))))), exForm.restSecs && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 70
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Trend"
  }), /*#__PURE__*/React.createElement("select", {
    value: exForm.restIncrementDir,
    onChange: e => updEx("restIncrementDir", e.target.value),
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: "+"
  }, "+"), /*#__PURE__*/React.createElement("option", {
    value: "-"
  }, "−"))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Increment per set"
  }), /*#__PURE__*/React.createElement("select", {
    value: exForm.restIncrementAmt,
    onChange: e => updEx("restIncrementAmt", e.target.value),
    style: ss
  }, INCREMENT_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v === 0 ? "None (flat rest)" : fmtRest(v)))))), +exForm.restIncrementAmt > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, exForm.restTurns.map((t, ti) => /*#__PURE__*/React.createElement("div", {
    key: ti,
    style: {
      background: C.card,
      borderRadius: 8,
      padding: "10px",
      marginBottom: 8,
      border: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: C.gold,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase"
    }
  }, "🌊 Turn ", ti + 1), /*#__PURE__*/React.createElement("button", {
    onClick: () => updEx("restTurns", exForm.restTurns.filter((_, i) => i !== ti)),
    style: {
      background: "none",
      border: "none",
      color: C.warn,
      cursor: "pointer",
      fontSize: 12
    }
  }, "🗑 Remove")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Switch trend after set #"
  }), /*#__PURE__*/React.createElement("select", {
    value: t.afterSet,
    onChange: e => {
      const nt = [...exForm.restTurns];
      nt[ti] = {
        ...nt[ti],
        afterSet: +e.target.value
      };
      updEx("restTurns", nt);
    },
    style: ss
  }, TURN_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, "Set ", v)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 70
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "New trend"
  }), /*#__PURE__*/React.createElement("select", {
    value: t.dir,
    onChange: e => {
      const nt = [...exForm.restTurns];
      nt[ti] = {
        ...nt[ti],
        dir: e.target.value
      };
      updEx("restTurns", nt);
    },
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: "+"
  }, "+"), /*#__PURE__*/React.createElement("option", {
    value: "-"
  }, "−"))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "New increment"
  }), /*#__PURE__*/React.createElement("select", {
    value: t.amt,
    onChange: e => {
      const nt = [...exForm.restTurns];
      nt[ti] = {
        ...nt[ti],
        amt: +e.target.value
      };
      updEx("restTurns", nt);
    },
    style: ss
  }, INCREMENT_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v === 0 ? "None (flat)" : fmtRest(v)))))))), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const lastSet = exForm.restTurns.length ? exForm.restTurns[exForm.restTurns.length - 1].afterSet : 3;
      updEx("restTurns", [...exForm.restTurns, {
        afterSet: Math.min(20, lastSet + 2),
        dir: "+",
        amt: 0
      }]);
    },
    style: {
      width: "100%",
      background: "none",
      border: `1px dashed ${C.gold}55`,
      borderRadius: 8,
      padding: "8px",
      cursor: "pointer",
      color: C.gold,
      fontSize: 12,
      fontWeight: 700,
      marginBottom: 8
    }
  }, "🌊 + Add trend change")), +exForm.restIncrementAmt > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.gold,
      marginBottom: 8,
      fontWeight: 600,
      lineHeight: 1.6
    }
  }, "Preview: ", [1, 2, 3, 4, 5, 6, 7, 8].map(n => `Set${n}→${n + 1} ${fmtRest(calcIncrementalRest(+exForm.restSecs, exForm.restIncrementDir, +exForm.restIncrementAmt, n, exForm.restTurns))}`).join(" · "))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      marginBottom: 8,
      lineHeight: 1.4
    }
  }, "Rest between sets of this exercise (with optional per-set increment/decrement), and transition rest before moving to the next exercise. All optional."), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "General instructions (optional)"
  }), /*#__PURE__*/React.createElement("textarea", {
    rows: 3,
    placeholder: "e.g. Keep chest tall, control the descent, drive through heels...",
    value: exForm.generalInstructions,
    onChange: e => updEx("generalInstructions", e.target.value),
    style: {
      ...ss,
      resize: "vertical",
      minHeight: 72,
      lineHeight: 1.5
    }
  })), /*#__PURE__*/React.createElement("button", {
    onClick: addEx,
    disabled: !exForm.name,
    style: {
      width: "100%",
      background: "none",
      border: `1px solid ${exForm.name ? C.accent : C.border}`,
      borderRadius: 8,
      padding: "10px",
      color: exForm.name ? C.accent : C.muted,
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "+ Add to program")));
}

// Inline edit form for an existing exercise row
function ExRowEdit({
  ex,
  exList,
  equipList,
  latList,
  onAddEx,
  onAddEquip,
  onAddLat,
  onSave,
  onCancel,
  customExercises = [],
  onEditEx,
  onDeleteEx,
  customEquipment = [],
  onEditEquip,
  onDeleteEquip,
  customLaterality = [],
  onEditLat,
  onDeleteLat
}) {
  const [form, setForm] = useState({
    name: ex.name,
    eq: ex.eq,
    lat: ex.lat,
    eccSecs: ex.eccSecs || "",
    conSecs: ex.conSecs || "",
    restSecs: ex.restSecs || "",
    restIncrementDir: ex.restIncrementDir || "+",
    restIncrementAmt: ex.restIncrementAmt || "0",
    // Migrate old single-pyramid fields into the new turns array if present
    restTurns: ex.restTurns || (ex.restPyramidOn ? [{
      afterSet: +ex.restPyramidTurn || 3,
      dir: ex.restIncrementDir2 || "+",
      amt: +ex.restIncrementAmt2 || 0
    }] : []),
    restBetweenNext: ex.restBetweenNext || "",
    instructions: ex.instructions || "",
    generalInstructions: ex.generalInstructions || ""
  });
  const upd = (k, v) => setForm(f => ({
    ...f,
    [k]: v
  }));
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Exercise"
  }), /*#__PURE__*/React.createElement(AddableSelect, {
    value: form.name,
    onChange: v => upd("name", v),
    options: ["", ...exList].filter((v, i, a) => a.indexOf(v) === i),
    onAddOption: onAddEx,
    addLabel: "Add new exercise",
    onEditOption: onEditEx,
    onDeleteOption: onDeleteEx
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Equipment"
  }), /*#__PURE__*/React.createElement(AddableSelect, {
    value: form.eq,
    onChange: v => upd("eq", v),
    options: equipList,
    onAddOption: onAddEquip,
    addLabel: "Add equipment",
    onEditOption: onEditEquip,
    onDeleteOption: onDeleteEquip
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Laterality"
  }), /*#__PURE__*/React.createElement(AddableSelect, {
    value: form.lat,
    onChange: v => upd("lat", v),
    options: latList,
    onAddOption: onAddLat,
    addLabel: "Add laterality",
    onEditOption: onEditLat,
    onDeleteOption: onDeleteLat
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Eccentric (s)"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0.5",
    step: "0.5",
    placeholder: "e.g. 3",
    value: form.eccSecs,
    onChange: e => upd("eccSecs", e.target.value),
    style: ss
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Concentric (s)"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0.5",
    step: "0.5",
    placeholder: "e.g. 1",
    value: form.conSecs,
    onChange: e => upd("conSecs", e.target.value),
    style: ss
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      marginBottom: 10
    }
  }, "Prescribed tempo for hypertrophy TUT"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Rest between sets"
  }), /*#__PURE__*/React.createElement("select", {
    value: form.restSecs,
    onChange: e => upd("restSecs", e.target.value),
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select…"), REST_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, fmtRest(v))))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Rest to next exercise"
  }), /*#__PURE__*/React.createElement("select", {
    value: form.restBetweenNext,
    onChange: e => upd("restBetweenNext", e.target.value),
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select…"), REST_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, fmtRest(v)))))), form.restSecs && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 70
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Trend"
  }), /*#__PURE__*/React.createElement("select", {
    value: form.restIncrementDir,
    onChange: e => upd("restIncrementDir", e.target.value),
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: "+"
  }, "+"), /*#__PURE__*/React.createElement("option", {
    value: "-"
  }, "−"))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Increment per set"
  }), /*#__PURE__*/React.createElement("select", {
    value: form.restIncrementAmt,
    onChange: e => upd("restIncrementAmt", e.target.value),
    style: ss
  }, INCREMENT_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v === 0 ? "None (flat rest)" : fmtRest(v)))))), +form.restIncrementAmt > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, form.restTurns.map((t, ti) => /*#__PURE__*/React.createElement("div", {
    key: ti,
    style: {
      background: C.card,
      borderRadius: 8,
      padding: "10px",
      marginBottom: 8,
      border: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: C.gold,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase"
    }
  }, "🌊 Turn ", ti + 1), /*#__PURE__*/React.createElement("button", {
    onClick: () => upd("restTurns", form.restTurns.filter((_, i) => i !== ti)),
    style: {
      background: "none",
      border: "none",
      color: C.warn,
      cursor: "pointer",
      fontSize: 12
    }
  }, "🗑 Remove")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Switch trend after set #"
  }), /*#__PURE__*/React.createElement("select", {
    value: t.afterSet,
    onChange: e => {
      const nt = [...form.restTurns];
      nt[ti] = {
        ...nt[ti],
        afterSet: +e.target.value
      };
      upd("restTurns", nt);
    },
    style: ss
  }, TURN_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, "Set ", v)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 70
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "New trend"
  }), /*#__PURE__*/React.createElement("select", {
    value: t.dir,
    onChange: e => {
      const nt = [...form.restTurns];
      nt[ti] = {
        ...nt[ti],
        dir: e.target.value
      };
      upd("restTurns", nt);
    },
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: "+"
  }, "+"), /*#__PURE__*/React.createElement("option", {
    value: "-"
  }, "−"))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "New increment"
  }), /*#__PURE__*/React.createElement("select", {
    value: t.amt,
    onChange: e => {
      const nt = [...form.restTurns];
      nt[ti] = {
        ...nt[ti],
        amt: +e.target.value
      };
      upd("restTurns", nt);
    },
    style: ss
  }, INCREMENT_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v === 0 ? "None (flat)" : fmtRest(v)))))))), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const lastSet = form.restTurns.length ? form.restTurns[form.restTurns.length - 1].afterSet : 3;
      upd("restTurns", [...form.restTurns, {
        afterSet: Math.min(20, lastSet + 2),
        dir: "+",
        amt: 0
      }]);
    },
    style: {
      width: "100%",
      background: "none",
      border: `1px dashed ${C.gold}55`,
      borderRadius: 8,
      padding: "8px",
      cursor: "pointer",
      color: C.gold,
      fontSize: 12,
      fontWeight: 700,
      marginBottom: 8
    }
  }, "🌊 + Add trend change")), +form.restIncrementAmt > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.gold,
      marginBottom: 8,
      fontWeight: 600,
      lineHeight: 1.6
    }
  }, "Preview: ", [1, 2, 3, 4, 5, 6, 7, 8].map(n => `Set${n}→${n + 1} ${fmtRest(calcIncrementalRest(+form.restSecs, form.restIncrementDir, +form.restIncrementAmt, n, form.restTurns))}`).join(" · "))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      marginBottom: 10
    }
  }, "Rest between sets (with optional per-set increment/decrement), and transition rest before the next exercise. All optional."), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "General instructions (optional)"
  }), /*#__PURE__*/React.createElement("textarea", {
    rows: 3,
    placeholder: "e.g. Keep chest tall, control the descent...",
    value: form.generalInstructions,
    onChange: e => upd("generalInstructions", e.target.value),
    style: {
      ...ss,
      resize: "vertical",
      minHeight: 72,
      lineHeight: 1.5
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    style: {
      flex: 1,
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: "9px",
      color: C.sub,
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onSave(form),
    style: {
      flex: 2,
      background: C.blue,
      color: "#fff",
      border: "none",
      borderRadius: 8,
      padding: "9px",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 18,
      letterSpacing: 2,
      cursor: "pointer"
    }
  }, "SAVE")));
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function parseSessionDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.trim().split(/\s+/);
  const day = parseInt(parts[0]);
  const month = MONTHS_SHORT.indexOf(parts[1]);
  const year = parts[2] ? parseInt(parts[2]) : new Date().getFullYear();
  if (isNaN(day) || month === -1) return null;
  return new Date(year, month, day);
}

// ─── Edit Client Modal ────────────────────────────────────────────────────────

function EditClientModal({
  client,
  onSave,
  onClose
}) {
  const [form, setForm] = useState({
    name: client.name,
    bw: client.bw || "",
    height: client.height || "",
    email: client.email || ""
  });
  const upd = (k, v) => setForm(f => ({
    ...f,
    [k]: v
  }));
  const submit = () => {
    if (!form.name.trim()) return;
    onSave({
      ...client,
      name: form.name.trim(),
      bw: form.bw ? +form.bw : null,
      height: form.height ? +form.height : null,
      email: form.email
    });
    onClose();
  };
  return /*#__PURE__*/React.createElement(Sheet, {
    title: "EDIT PROFILE",
    onClose: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Full name"
  }), /*#__PURE__*/React.createElement("input", {
    value: form.name,
    onChange: e => upd("name", e.target.value),
    style: ss
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Bodyweight (kg)"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: form.bw,
    onChange: e => upd("bw", e.target.value),
    placeholder: "75",
    style: ss
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Height (m)"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    step: "0.01",
    value: form.height,
    onChange: e => upd("height", e.target.value),
    placeholder: "1.70",
    style: ss
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 22
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Email"
  }), /*#__PURE__*/React.createElement("input", {
    type: "email",
    value: form.email,
    onChange: e => upd("email", e.target.value),
    placeholder: "client@email.com",
    style: ss
  })), /*#__PURE__*/React.createElement("button", {
    onClick: submit,
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 10,
      padding: "14px",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 20,
      letterSpacing: 2,
      cursor: "pointer"
    }
  }, "SAVE CHANGES"));
}

// ─── Calendar Tab ─────────────────────────────────────────────────────────────

function CalendarTab({
  client,
  onDeleteSession
}) {
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [selDay, setSelDay] = useState(null);
  const [detailSess, setDetailSess] = useState(null);
  const allSessions = useMemo(() => {
    if (!client) return [];
    return (client.programs || []).flatMap(p => p.sessions.map(s => ({
      ...s,
      programName: p.name,
      programId: p.id
    })));
  }, [client]);

  // Map "YYYY-M-D" → sessions
  const sessionMap = useMemo(() => {
    const map = {};
    allSessions.forEach(s => {
      const d = parseSessionDate(s.date);
      if (!d) return;
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (!map[key]) map[key] = [];
      map[key].push(s);
    });
    return map;
  }, [allSessions]);
  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(y => y - 1);
    } else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(y => y + 1);
    } else setViewMonth(m => m + 1);
  };

  // Build calendar grid (Monday-first)
  const grid = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1);
    const total = new Date(viewYear, viewMonth + 1, 0).getDate();
    const start = (first.getDay() + 6) % 7; // 0=Mon
    const cells = [];
    for (let i = 0; i < start; i++) cells.push(null);
    for (let d = 1; d <= total; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [viewYear, viewMonth]);
  const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const selKey = selDay ? `${viewYear}-${viewMonth}-${selDay}` : null;
  const selSessions = selKey ? sessionMap[selKey] || [] : [];
  if (!client) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "48px 24px",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 42,
      marginBottom: 14
    }
  }, "📅"), /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.sub,
      fontSize: 14
    }
  }, "No client selected."));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "16px 14px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: prevMonth,
    style: {
      background: C.card2,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: "8px 14px",
      color: C.text,
      cursor: "pointer",
      fontSize: 16
    }
  }, "‹"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 22,
      letterSpacing: 2,
      color: C.text
    }
  }, MONTHS_FULL[viewMonth], " ", viewYear), /*#__PURE__*/React.createElement("button", {
    onClick: nextMonth,
    style: {
      background: C.card2,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: "8px 14px",
      color: C.text,
      cursor: "pointer",
      fontSize: 16
    }
  }, "›")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(7,1fr)",
      marginBottom: 6
    }
  }, ["M", "T", "W", "T", "F", "S", "S"].map((d, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      textAlign: "center",
      fontSize: 11,
      color: C.muted,
      fontWeight: 700,
      padding: "4px 0",
      letterSpacing: 1
    }
  }, d))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(7,1fr)",
      gap: 3,
      marginBottom: 16
    }
  }, grid.map((day, i) => {
    if (!day) return /*#__PURE__*/React.createElement("div", {
      key: i
    });
    const key = `${viewYear}-${viewMonth}-${day}`;
    const hasSes = !!sessionMap[key];
    const isToday = key === todayKey;
    const isSel = day === selDay;
    return /*#__PURE__*/React.createElement("button", {
      key: i,
      onClick: () => setSelDay(isSel ? null : day),
      style: {
        aspectRatio: "1",
        borderRadius: 8,
        border: `1.5px solid ${isSel ? C.accent : hasSes ? C.accent + "44" : C.border}`,
        background: isSel ? C.accent : hasSes ? C.accent + "18" : isToday ? C.card2 : "transparent",
        color: isSel ? "#001A12" : isToday ? C.accent : C.text,
        fontWeight: hasSes || isToday ? 700 : 400,
        fontSize: 13,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 2
      }
    }, day, hasSes && !isSel && /*#__PURE__*/React.createElement("span", {
      style: {
        width: 5,
        height: 5,
        borderRadius: "50%",
        background: isSel ? "#001A12" : C.accent,
        display: "block"
      }
    }));
  })), selDay && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(SecLabel, {
    text: `${selDay} ${MONTHS_FULL[viewMonth]} ${viewYear}`
  }), selSessions.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      borderRadius: 12,
      padding: "20px",
      textAlign: "center",
      border: `1px solid ${C.border}`,
      color: C.sub,
      fontSize: 13
    }
  }, "No training session on this day.") : selSessions.map((s, si) => /*#__PURE__*/React.createElement("div", {
    key: si,
    onClick: () => setDetailSess(s),
    style: {
      background: C.card,
      borderRadius: 12,
      padding: "14px",
      border: `1px solid ${C.accent + "44"}`,
      marginBottom: 10,
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 14
    }
  }, s.programName), /*#__PURE__*/React.createElement(Tag, {
    text: `${s.entries.length} sets`,
    color: C.blue
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: C.sub
    }
  }, [...new Set(s.entries.map(e => e.ex))].join(" · ")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.accent,
      marginTop: 6,
      fontWeight: 700
    }
  }, "Tap to view full session →"))), detailSess && /*#__PURE__*/React.createElement(SessionDetailSheet, {
    session: detailSess,
    onClose: () => setDetailSess(null),
    onDelete: s => onDeleteSession(s.programId, s.id)
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card2,
      borderRadius: 12,
      padding: "12px 16px",
      border: `1px solid ${C.border}`,
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.muted,
      letterSpacing: 1.5,
      textTransform: "uppercase",
      marginBottom: 6,
      fontWeight: 700
    }
  }, "This month"), (() => {
    const count = Object.keys(sessionMap).filter(k => {
      const [y, m] = k.split("-").map(Number);
      return y === viewYear && m === viewMonth;
    }).length;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Bebas Neue',cursive",
        fontSize: 28,
        color: C.accent
      }
    }, count, " ", /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 14,
        opacity: 0.7
      }
    }, "session", count !== 1 ? "s" : "", " logged"));
  })()));
}

// ─── Data Sync Sheet ──────────────────────────────────────────────────────────

function DataSyncSheet({
  clients,
  customData,
  onImport,
  onClose
}) {
  const [imported, setImported] = useState(false);
  const [error, setError] = useState("");
  const exportData = () => {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      clients,
      customData
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `forge-backup-${new Date().toLocaleDateString("en-ZA").replace(/\//g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const handleFile = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data.clients || !Array.isArray(data.clients)) throw new Error("Invalid file");
        onImport(data);
        setImported(true);
        setError("");
      } catch {
        setError("Invalid backup file. Please use a file exported from Forge Training.");
      }
    };
    reader.readAsText(file);
  };
  return /*#__PURE__*/React.createElement(Sheet, {
    title: "DATA & SYNC",
    onClose: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: C.sub,
      marginBottom: 20,
      lineHeight: 1.6
    }
  }, "To sync between your phone and tablet: export on one device, transfer the file, then import on the other."), /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card2,
      borderRadius: 12,
      padding: "16px",
      marginBottom: 12,
      border: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 14,
      marginBottom: 4
    }
  }, "📤 Export Backup"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: C.sub,
      marginBottom: 12
    }
  }, "Downloads all your clients, programs and session data as a JSON file."), /*#__PURE__*/React.createElement("button", {
    onClick: exportData,
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 10,
      padding: "13px",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 18,
      letterSpacing: 2,
      cursor: "pointer"
    }
  }, "EXPORT DATA")), /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card2,
      borderRadius: 12,
      padding: "16px",
      border: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 14,
      marginBottom: 4
    }
  }, "📥 Import Backup"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: C.sub,
      marginBottom: 12
    }
  }, "Loads a previously exported backup file. This will replace all current data."), imported ? /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.accent + "22",
      border: `1px solid ${C.accent}44`,
      borderRadius: 8,
      padding: "12px",
      textAlign: "center",
      color: C.accent,
      fontWeight: 700,
      fontSize: 14
    }
  }, "✓ Data imported successfully!") : /*#__PURE__*/React.createElement("label", {
    style: {
      display: "block",
      width: "100%",
      background: C.card,
      border: `1.5px dashed ${C.border}`,
      borderRadius: 10,
      padding: "14px",
      textAlign: "center",
      cursor: "pointer",
      color: C.sub,
      fontSize: 13,
      fontWeight: 700
    }
  }, "📁 Choose backup file", /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: ".json",
    onChange: handleFile,
    style: {
      display: "none"
    }
  })), error && /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.warn,
      fontSize: 12,
      marginTop: 8,
      textAlign: "center"
    }
  }, error)), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      padding: "12px 14px",
      background: C.card2,
      borderRadius: 10,
      border: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.muted,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 6
    }
  }, "Sync steps"), ["1. Tap Export on Device A — saves a .json file", "2. Send the file to Device B (email, WhatsApp, etc.)", "3. Open Forge Training on Device B", "4. Tap Import and choose the file"].map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      fontSize: 12,
      color: C.sub,
      marginBottom: 4
    }
  }, s))));
}

// ─── Session Detail Sheet ─────────────────────────────────────────────────────

function SessionDetailSheet({
  session,
  onClose,
  onDelete
}) {
  const [confirmDel, setConfirmDel] = useState(false);
  const exGroups = session.entries.reduce((acc, e) => {
    if (!acc[e.ex]) acc[e.ex] = [];
    acc[e.ex].push(e);
    return acc;
  }, {});
  const totalVol = session.entries.reduce((s, e) => s + (e.load * e.reps || 0), 0);
  const avgRPE = session.entries.length ? (session.entries.reduce((s, e) => s + (e.rpe || 0), 0) / session.entries.length).toFixed(1) : "–";
  return /*#__PURE__*/React.createElement(Sheet, {
    title: `SESSION · ${session.date}`,
    onClose: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement(StatCard, {
    label: "Total Volume",
    value: totalVol,
    unit: " kg",
    color: C.blue
  }), /*#__PURE__*/React.createElement(StatCard, {
    label: "Avg RPE",
    value: avgRPE,
    unit: "",
    color: C.warn
  })), Object.entries(exGroups).map(([exName, entries]) => /*#__PURE__*/React.createElement("div", {
    key: exName,
    style: {
      background: C.card2,
      borderRadius: 12,
      padding: "12px 14px",
      marginBottom: 10,
      border: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 14,
      marginBottom: 8,
      color: C.accent
    }
  }, exName), entries.map((e, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "6px 0",
      borderBottom: i < entries.length - 1 ? `1px solid ${C.border}` : "none"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.muted,
      fontSize: 11,
      marginRight: 6
    }
  }, "Set ", e.set), e.reps, " reps · ", e.type, /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.sub,
      fontSize: 11
    }
  }, " · RPE ", e.rpe, " · RIR ", e.rir)), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 20,
      color: C.accent,
      lineHeight: 1
    }
  }, e.load, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      opacity: 0.6
    }
  }, " kg")), e.power && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.gold
    }
  }, e.power, " W"), e.repTime && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#AA44FF"
    }
  }, e.repTime, "s/rep"), e.holdDuration && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#5060FF"
    }
  }, "⏱ ", e.holdDuration, "s hold"), e.mvic && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#5060FF"
    }
  }, e.mvic, "% MVIC"), e.force && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.gold
    }
  }, "⚡ ", e.force, " N (", (e.force / 9.81).toFixed(1), " kgf)"), e.bandStrength && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.warn
    }
  }, "🔴 ", e.bandLength, " ", e.bandStrength, " (", e.bandLoadKg ? `${e.bandLoadKg}kg ` : "", e.bandUsage, ")", e.rawLoad != null && e.bandLoadKg ? ` — ${e.rawLoad}kg plate ${e.bandUsage === "assisted" ? "−" : "+"} ${e.bandLoadKg}kg band = ${e.load}kg effective` : ""), e.clusterReps && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.gold
    }
  }, "⏱ ", e.clusterCount, "×", e.clusterReps, " clusters", e.clusterRest ? ` (${e.clusterRest}s rest)` : ""), e.restApplied && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.blue
    }
  }, "💤 ", e.restApplied >= 60 ? `${Math.floor(e.restApplied / 60)}:${String(e.restApplied % 60).padStart(2, "0")} min` : `${e.restApplied}s`, " rest"), (e.equipUsed || e.latUsed) && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub
    }
  }, "🔧 ", e.equipUsed || "", e.equipUsed && e.latUsed ? ", " : "", e.latUsed || "", " (session)"), e.comment && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.muted,
      fontStyle: "italic",
      marginTop: 4
    }
  }, "💬 ", e.comment)))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 18,
      paddingTop: 14,
      borderTop: `1px solid ${C.border}`
    }
  }, !confirmDel ? /*#__PURE__*/React.createElement("button", {
    onClick: () => setConfirmDel(true),
    style: {
      width: "100%",
      background: "none",
      border: `1px solid ${C.warn}55`,
      borderRadius: 10,
      padding: "12px",
      color: C.warn,
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "🗑 Delete this session") : /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.warn + "15",
      border: `1px solid ${C.warn}55`,
      borderRadius: 10,
      padding: "14px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: C.text,
      marginBottom: 12,
      lineHeight: 1.5
    }
  }, "Delete this session permanently? This cannot be undone."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setConfirmDel(false),
    style: {
      flex: 1,
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: "10px",
      color: C.sub,
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      onDelete(session);
      onClose();
    },
    style: {
      flex: 1,
      background: C.warn,
      border: "none",
      borderRadius: 8,
      padding: "10px",
      color: "#fff",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "Delete")))));
}

// ─── Client Switcher ──────────────────────────────────────────────────────────

function ClientSwitcher({
  clients,
  activeId,
  onSwitch,
  onClose,
  onAddClient,
  onArchive,
  onReinstate,
  onEditClient
}) {
  const [showArchived, setShowArchived] = useState(false);
  const active = clients.filter(c => !c.archived);
  const archived = clients.filter(c => c.archived);
  return /*#__PURE__*/React.createElement(Sheet, {
    title: "CLIENTS",
    onClose: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 10
    }
  }, active.map((c, i) => /*#__PURE__*/React.createElement("div", {
    key: c.id,
    style: {
      background: c.id === activeId ? C.accent + "18" : C.card2,
      borderRadius: 14,
      border: `1.5px solid ${c.id === activeId ? C.accent + "66" : C.border}`,
      marginBottom: 8,
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => {
      onSwitch(c.id);
      onClose();
    },
    style: {
      display: "flex",
      alignItems: "center",
      gap: 14,
      padding: "12px 14px",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: c.name,
    idx: clients.indexOf(c),
    size: 46
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 15
    }
  }, c.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: C.sub,
      marginTop: 2
    }
  }, c.programs.length, " program", c.programs.length !== 1 ? "s" : "", c.bw ? ` · ${c.bw} kg` : "")), c.id === activeId && /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.accent,
      fontSize: 20,
      fontWeight: 700
    }
  }, "✓")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      borderTop: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      onEditClient(c);
      onClose();
    },
    style: {
      flex: 1,
      background: "none",
      border: "none",
      borderRight: `1px solid ${C.border}`,
      padding: "8px",
      color: C.sub,
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 700
    }
  }, "✎ Edit Profile"), /*#__PURE__*/React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      onArchive(c.id);
      if (c.id === activeId) onClose();
    },
    style: {
      flex: 1,
      background: "none",
      border: "none",
      padding: "8px",
      color: C.warn,
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 700
    }
  }, "📦 Archive"))))), /*#__PURE__*/React.createElement("button", {
    onClick: onAddClient,
    style: {
      width: "100%",
      background: "none",
      border: `1px dashed ${C.accent + "55"}`,
      borderRadius: 12,
      padding: "12px",
      color: C.accent,
      cursor: "pointer",
      fontSize: 14,
      fontWeight: 700,
      marginBottom: 10
    }
  }, "+ Add New Client"), archived.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowArchived(s => !s),
    style: {
      width: "100%",
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: "10px",
      color: C.muted,
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 700,
      marginBottom: 8
    }
  }, showArchived ? "▲" : "▼", " Archived clients (", archived.length, ")"), showArchived && archived.map((c, i) => /*#__PURE__*/React.createElement("div", {
    key: c.id,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "10px 14px",
      background: C.card2,
      borderRadius: 12,
      border: `1px solid ${C.border}`,
      marginBottom: 6,
      opacity: 0.7
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: c.name,
    idx: clients.indexOf(c),
    size: 38
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 14
    }
  }, c.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub
    }
  }, "Archived")), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      onReinstate(c.id);
      onSwitch(c.id);
      onClose();
    },
    style: {
      background: C.accent + "22",
      border: `1px solid ${C.accent}44`,
      borderRadius: 8,
      padding: "6px 12px",
      color: C.accent,
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 700
    }
  }, "Reinstate")))));
}

// ─── Add Client ───────────────────────────────────────────────────────────────

function AddClientModal({
  onAdd,
  onClose
}) {
  const [form, setForm] = useState({
    name: "",
    bw: "",
    height: "",
    email: ""
  });
  const upd = (k, v) => setForm(f => ({
    ...f,
    [k]: v
  }));
  const submit = () => {
    if (!form.name.trim()) return;
    onAdd({
      name: form.name.trim(),
      bw: form.bw ? +form.bw : null,
      height: form.height ? +form.height : null,
      email: form.email
    });
    onClose();
  };
  return /*#__PURE__*/React.createElement(Sheet, {
    title: "NEW CLIENT",
    onClose: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Full name *"
  }), /*#__PURE__*/React.createElement("input", {
    value: form.name,
    onChange: e => upd("name", e.target.value),
    placeholder: "e.g. Jane Smith",
    style: ss
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Bodyweight (kg)"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: form.bw,
    onChange: e => upd("bw", e.target.value),
    placeholder: "75",
    style: ss
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Height (m)"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    step: "0.01",
    value: form.height,
    onChange: e => upd("height", e.target.value),
    placeholder: "1.70",
    style: ss
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 22
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Email (optional)"
  }), /*#__PURE__*/React.createElement("input", {
    type: "email",
    value: form.email,
    onChange: e => upd("email", e.target.value),
    placeholder: "jane@email.com",
    style: ss
  })), /*#__PURE__*/React.createElement("button", {
    onClick: submit,
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 10,
      padding: "14px",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 20,
      letterSpacing: 2,
      cursor: "pointer"
    }
  }, "CREATE CLIENT"));
}

// ─── Add Program Modal ────────────────────────────────────────────────────────

function AddProgramModal({
  onAdd,
  onClose,
  exList,
  equipList,
  latList,
  categoryList,
  progTypeList,
  onAddEx,
  onAddEquip,
  onAddLat,
  onAddCategory,
  onAddProgType,
  customExercises,
  onEditEx,
  onDeleteEx,
  customEquipment,
  onEditEquip,
  onDeleteEquip,
  customLaterality,
  onEditLat,
  onDeleteLat
}) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    name: "",
    category: "Strength",
    type: "General Strength"
  });
  const [exercises, setExercises] = useState([]);
  const upd = (k, v) => setForm(f => ({
    ...f,
    [k]: v
  }));
  const submit = () => {
    if (!form.name.trim()) return;
    onAdd({
      ...form,
      exercises,
      sessions: []
    });
    onClose();
  };
  return /*#__PURE__*/React.createElement(Sheet, {
    title: step === 1 ? "NEW PROGRAM" : "EXERCISES",
    onClose: onClose
  }, step === 1 ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Program name *"
  }), /*#__PURE__*/React.createElement("input", {
    value: form.name,
    onChange: e => upd("name", e.target.value),
    placeholder: "e.g. Summer Strength Block",
    style: ss
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Category"
  }), /*#__PURE__*/React.createElement(AddableSelect, {
    value: form.category,
    onChange: v => upd("category", v),
    options: categoryList,
    onAddOption: onAddCategory,
    addLabel: "Add category"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Program type"
  }), /*#__PURE__*/React.createElement(AddableSelect, {
    value: form.type,
    onChange: v => upd("type", v),
    options: progTypeList,
    onAddOption: onAddProgType,
    addLabel: "Add program type"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: {
      flex: 1,
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: "13px",
      color: C.sub,
      cursor: "pointer",
      fontSize: 14,
      fontWeight: 700
    }
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    onClick: () => form.name.trim() && setStep(2),
    style: {
      flex: 2,
      background: C.blue,
      color: "#fff",
      border: "none",
      borderRadius: 10,
      padding: "13px",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 20,
      letterSpacing: 2,
      cursor: "pointer"
    }
  }, "NEXT →"))) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: C.sub,
      marginBottom: 14
    }
  }, "Add exercises to ", /*#__PURE__*/React.createElement("strong", {
    style: {
      color: C.text
    }
  }, form.name), ". You can also add more later while logging."), /*#__PURE__*/React.createElement(ExerciseBuilder, {
    exercises: exercises,
    setExercises: setExercises,
    exList: exList,
    equipList: equipList,
    latList: latList,
    onAddEx: onAddEx,
    onAddEquip: onAddEquip,
    onAddLat: onAddLat,
    customExercises: customExercises || [],
    onEditEx: onEditEx,
    onDeleteEx: onDeleteEx,
    customEquipment: customEquipment || [],
    onEditEquip: onEditEquip,
    onDeleteEquip: onDeleteEquip,
    customLaterality: customLaterality || [],
    onEditLat: onEditLat,
    onDeleteLat: onDeleteLat
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginTop: 18
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setStep(1),
    style: {
      flex: 1,
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: "13px",
      color: C.sub,
      cursor: "pointer",
      fontSize: 14,
      fontWeight: 700
    }
  }, "← Back"), /*#__PURE__*/React.createElement("button", {
    onClick: submit,
    style: {
      flex: 2,
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 10,
      padding: "13px",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 20,
      letterSpacing: 2,
      cursor: "pointer"
    }
  }, "CREATE PROGRAM"))));
}

// ─── Edit Program Modal ───────────────────────────────────────────────────────

function EditProgramModal({
  program,
  onSave,
  onClose,
  exList,
  equipList,
  latList,
  categoryList,
  progTypeList,
  onAddEx,
  onAddEquip,
  onAddLat,
  onAddCategory,
  onAddProgType,
  onDelete,
  customExercises,
  onEditEx,
  onDeleteEx,
  customEquipment,
  onEditEquip,
  onDeleteEquip,
  customLaterality,
  onEditLat,
  onDeleteLat
}) {
  const [form, setForm] = useState({
    name: program.name,
    category: program.category,
    type: program.type
  });
  const [exercises, setExercises] = useState(program.exercises.map(e => ({
    ...e
  })));
  const upd = (k, v) => setForm(f => ({
    ...f,
    [k]: v
  }));
  const submit = () => {
    if (!form.name.trim()) return;
    onSave({
      ...program,
      ...form,
      exercises
    });
    onClose();
  };
  return /*#__PURE__*/React.createElement(Sheet, {
    title: "EDIT PROGRAM",
    onClose: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Program name"
  }), /*#__PURE__*/React.createElement("input", {
    value: form.name,
    onChange: e => upd("name", e.target.value),
    style: ss
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Category"
  }), /*#__PURE__*/React.createElement(AddableSelect, {
    value: form.category,
    onChange: v => upd("category", v),
    options: categoryList,
    onAddOption: onAddCategory,
    addLabel: "Add category"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Program type"
  }), /*#__PURE__*/React.createElement(AddableSelect, {
    value: form.type,
    onChange: v => upd("type", v),
    options: progTypeList,
    onAddOption: onAddProgType,
    addLabel: "Add program type"
  })), /*#__PURE__*/React.createElement(SecLabel, {
    text: "Exercises"
  }), /*#__PURE__*/React.createElement(ExerciseBuilder, {
    exercises: exercises,
    setExercises: setExercises,
    exList: exList,
    equipList: equipList,
    latList: latList,
    onAddEx: onAddEx,
    onAddEquip: onAddEquip,
    onAddLat: onAddLat,
    customExercises: customExercises || [],
    onEditEx: onEditEx,
    onDeleteEx: onDeleteEx,
    customEquipment: customEquipment || [],
    onEditEquip: onEditEquip,
    onDeleteEquip: onDeleteEquip,
    customLaterality: customLaterality || [],
    onEditLat: onEditLat,
    onDeleteLat: onDeleteLat
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginTop: 18,
      flexDirection: "column"
    }
  }, onDelete && /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      if (window.confirm(`Delete program "${form.name}"? This cannot be undone.`)) {
        onDelete(program.id);
      }
    },
    style: {
      width: "100%",
      background: "none",
      border: `1px solid ${C.warn}55`,
      borderRadius: 10,
      padding: "11px",
      color: C.warn,
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "🗑 Delete this program"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: {
      flex: 1,
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: "13px",
      color: C.sub,
      cursor: "pointer",
      fontSize: 14,
      fontWeight: 700
    }
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    onClick: submit,
    style: {
      flex: 2,
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 10,
      padding: "13px",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 20,
      letterSpacing: 2,
      cursor: "pointer"
    }
  }, "SAVE CHANGES"))));
}

// ─── Programs Tab ─────────────────────────────────────────────────────────────

function ProgramsTab({
  client,
  clientIdx,
  activeProgramId,
  onSetActive,
  onAddProgram,
  onEditProgram,
  onDeleteProgram,
  exList,
  equipList,
  latList,
  categoryList,
  progTypeList,
  onAddEx,
  onAddEquip,
  onAddLat,
  onAddCategory,
  onAddProgType,
  customExercises = [],
  onEditEx,
  onDeleteEx,
  customEquipment = [],
  onEditEquip,
  onDeleteEquip,
  customLaterality = [],
  onEditLat,
  onDeleteLat
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [editProg, setEditProg] = useState(null);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "16px 14px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card2,
      borderRadius: 16,
      padding: "16px 18px",
      marginBottom: 18,
      border: `1px solid ${C.border}`,
      display: "flex",
      alignItems: "center",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: client.name,
    idx: clientIdx,
    size: 54
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 26,
      letterSpacing: 2.5
    }
  }, client.name), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      flexWrap: "wrap",
      marginTop: 5
    }
  }, client.bw && /*#__PURE__*/React.createElement(Tag, {
    text: `${client.bw} kg BW`,
    color: C.blue
  }), client.height && /*#__PURE__*/React.createElement(Tag, {
    text: `${client.height} m`,
    color: C.gold
  }), /*#__PURE__*/React.createElement(Tag, {
    text: `${client.programs.length} program${client.programs.length !== 1 ? "s" : ""}`,
    color: C.sub
  })))), /*#__PURE__*/React.createElement(SecLabel, {
    text: "Programs"
  }), client.programs.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      borderRadius: 14,
      padding: "28px 20px",
      textAlign: "center",
      border: `1px dashed ${C.border}`,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 36,
      marginBottom: 10
    }
  }, "🏋️"), /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.sub,
      fontSize: 14
    }
  }, "No programs yet.", /*#__PURE__*/React.createElement("br", null), "Create the first one below.")), client.programs.map(prog => {
    const active = prog.id === activeProgramId;
    return /*#__PURE__*/React.createElement("div", {
      key: prog.id,
      style: {
        background: C.card,
        borderRadius: 14,
        padding: "14px 16px",
        marginBottom: 10,
        border: `2px solid ${active ? C.accent : C.border}`,
        position: "relative",
        cursor: "pointer"
      },
      onClick: () => onSetActive(prog.id)
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 4
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontWeight: 700,
        fontSize: 16,
        paddingRight: 8,
        flex: 1
      }
    }, prog.name), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 6
      }
    }, active && /*#__PURE__*/React.createElement("span", {
      style: {
        background: C.accent + "20",
        border: `1px solid ${C.accent + "55"}`,
        borderRadius: 20,
        padding: "2px 10px",
        fontSize: 10,
        color: C.accent,
        fontWeight: 700,
        letterSpacing: 1
      }
    }, "ACTIVE"), /*#__PURE__*/React.createElement("button", {
      onClick: e => {
        e.stopPropagation();
        setEditProg(prog);
      },
      style: {
        background: C.card2,
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        color: C.sub,
        cursor: "pointer",
        fontSize: 13,
        padding: "5px 11px",
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        gap: 5
      }
    }, "✎ Edit"))), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: C.sub,
        marginBottom: 8
      }
    }, prog.category, " · ", prog.type), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 6,
        flexWrap: "wrap"
      }
    }, /*#__PURE__*/React.createElement(Tag, {
      text: `${prog.exercises.length} exercise${prog.exercises.length !== 1 ? "s" : ""}`,
      color: C.blue
    }), /*#__PURE__*/React.createElement(Tag, {
      text: `${prog.sessions.length} session${prog.sessions.length !== 1 ? "s" : ""}`,
      color: active ? C.accent : C.sub
    })), prog.exercises.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 10,
        paddingTop: 8,
        borderTop: `1px solid ${C.border}`
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: C.muted
      }
    }, prog.exercises.map(e => e.name).join(" · "))));
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowAdd(true),
    style: {
      width: "100%",
      background: "none",
      border: `1px dashed ${C.accent + "55"}`,
      borderRadius: 12,
      padding: "14px",
      color: C.accent,
      cursor: "pointer",
      fontSize: 14,
      fontWeight: 700,
      marginTop: 4
    }
  }, "+ New Program"), showAdd && /*#__PURE__*/React.createElement(AddProgramModal, {
    onAdd: p => {
      onAddProgram(p);
      setShowAdd(false);
    },
    onClose: () => setShowAdd(false),
    exList: exList,
    equipList: equipList,
    latList: latList,
    categoryList: categoryList,
    progTypeList: progTypeList,
    onAddEx: onAddEx,
    onAddEquip: onAddEquip,
    onAddLat: onAddLat,
    onAddCategory: onAddCategory,
    onAddProgType: onAddProgType,
    customExercises: customExercises,
    onEditEx: onEditEx,
    onDeleteEx: onDeleteEx,
    customEquipment: customEquipment,
    onEditEquip: onEditEquip,
    onDeleteEquip: onDeleteEquip,
    customLaterality: customLaterality,
    onEditLat: onEditLat,
    onDeleteLat: onDeleteLat
  }), editProg && /*#__PURE__*/React.createElement(EditProgramModal, {
    program: editProg,
    onSave: p => {
      onEditProgram(p);
      setEditProg(null);
    },
    onDelete: pid => {
      onDeleteProgram(pid);
      setEditProg(null);
    },
    onClose: () => setEditProg(null),
    customExercises: customExercises,
    onEditEx: onEditEx,
    onDeleteEx: onDeleteEx,
    customEquipment: customEquipment,
    onEditEquip: onEditEquip,
    onDeleteEquip: onDeleteEquip,
    customLaterality: customLaterality,
    onEditLat: onEditLat,
    onDeleteLat: onDeleteLat,
    exList: exList,
    equipList: equipList,
    latList: latList,
    categoryList: categoryList,
    progTypeList: progTypeList,
    onAddEx: onAddEx,
    onAddEquip: onAddEquip,
    onAddLat: onAddLat,
    onAddCategory: onAddCategory,
    onAddProgType: onAddProgType
  }));
}

// ─── Log Tab ──────────────────────────────────────────────────────────────────

function LogTab({
  program,
  onAddEntry,
  exList,
  onAddEx,
  setTypeList,
  onAddSetType,
  clientBW,
  onUpdateExercise,
  equipList,
  latList
}) {
  const today = new Date().toLocaleDateString("en-ZA", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
  const progExNames = program ? program.exercises.map(e => e.name) : [];
  // All available exercises: program's first, then global list (deduped)
  const allEx = [...new Set([...progExNames, ...exList])];
  const [activeEx, setActiveEx] = useState(progExNames[0] || allEx[0] || "");
  const [form, setForm] = useState({
    reps: "",
    setNo: "1",
    type: "Normal",
    load: "",
    rir: 2,
    rpe: 7,
    velocity: "",
    repTime: "",
    holdDuration: "",
    mvic: "",
    force: "",
    bandLength: "",
    bandStrength: "",
    bandUsage: "resisted",
    bandLoadKg: "",
    comment: "",
    clusterReps: "",
    clusterCount: "",
    clusterRest: ""
  });
  const [showBand, setShowBand] = useState(false);
  const [editingInstr, setEditingInstr] = useState(false);
  const [instrDraft, setInstrDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [showSupersetInfo, setShowSupersetInfo] = useState(false);
  const [tempoOverride, setTempoOverride] = useState({
    eccSecs: "",
    conSecs: ""
  }); // session-only override
  const [editingTempo, setEditingTempo] = useState(false);
  const [restTimerOn, setRestTimerOn] = useState(false);
  const [restOverride, setRestOverride] = useState("");
  const [editingRest, setEditingRest] = useState(false);
  const [restNextOverride, setRestNextOverride] = useState("");
  const [equipOverride, setEquipOverride] = useState("");
  const [latOverride, setLatOverride] = useState("");
  const [editingEquipLat, setEditingEquipLat] = useState(false);
  const [editingRestNext, setEditingRestNext] = useState(false);
  const [restRemaining, setRestRemaining] = useState(0);
  const [restRunning, setRestRunning] = useState(false);
  const [restTotal, setRestTotal] = useState(0);
  const upd = (k, v) => setForm(f => ({
    ...f,
    [k]: v
  }));

  // Rest timer countdown
  useEffect(() => {
    if (!restRunning || restRemaining <= 0) return;
    const t = setTimeout(() => setRestRemaining(r => r - 1), 1000);
    return () => clearTimeout(t);
  }, [restRunning, restRemaining]);

  // Alert when rest hits zero
  useEffect(() => {
    if (restRunning && restRemaining === 0) {
      setRestRunning(false);
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [0, 0.15, 0.3].forEach(t => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.connect(g);
          g.connect(ctx.destination);
          o.frequency.value = 880;
          g.gain.value = 0.15;
          o.start(ctx.currentTime + t);
          o.stop(ctx.currentTime + t + 0.12);
        });
      } catch {}
      try {
        navigator.vibrate && navigator.vibrate([200, 100, 200]);
      } catch {}
    }
  }, [restRemaining, restRunning]);
  const startRestTimer = secs => {
    if (!secs || secs <= 0) return;
    setRestTotal(secs);
    setRestRemaining(secs);
    setRestRunning(true);
  };

  // When program changes, reset to first exercise
  useEffect(() => {
    const first = program?.exercises[0]?.name || exList[0] || "";
    setActiveEx(first);
    setForm({
      reps: "",
      setNo: "1",
      type: "Normal",
      load: "",
      rir: 2,
      rpe: 7,
      velocity: "",
      repTime: "",
      holdDuration: "",
      mvic: "",
      force: "",
      bandLength: "",
      bandStrength: "",
      bandUsage: "resisted",
      bandLoadKg: "",
      comment: "",
      clusterReps: "",
      clusterCount: "",
      clusterRest: ""
    });
    setShowBand(false);
    setTempoOverride({
      eccSecs: "",
      conSecs: ""
    });
    setEditingTempo(false);
  }, [program?.id]);

  // When switching exercise, clear reps/load but keep set type & rpe/rir
  const switchEx = name => {
    setActiveEx(name);
    setForm(f => ({
      ...f,
      reps: "",
      load: "",
      velocity: "",
      repTime: "",
      holdDuration: "",
      mvic: "",
      force: "",
      bandLength: "",
      bandStrength: "",
      bandUsage: "resisted",
      bandLoadKg: "",
      comment: "",
      clusterReps: "",
      clusterCount: "",
      clusterRest: ""
    }));
    setShowBand(false);
    setTempoOverride({
      eccSecs: "",
      conSecs: ""
    });
    setEditingTempo(false);
    setEditingInstr(false);
    setSaved(false);
    setRestOverride("");
    setEditingRest(false);
    setRestNextOverride("");
    setEditingRestNext(false);
    setEquipOverride("");
    setLatOverride("");
    setEditingEquipLat(false);
  };
  const bandKgLive = showBand && form.bandLoadKg ? +form.bandLoadKg : 0;
  const bandSignedLive = bandKgLive ? form.bandUsage === "assisted" ? -bandKgLive : bandKgLive : 0;
  const effLoadLive = Math.max(0, (form.load ? +form.load : 0) + bandSignedLive);
  const vol = form.reps && effLoadLive ? +form.reps * effLoadLive : 0;
  const sessions = program?.sessions || [];
  // Group recent history by session (last 5 sessions that have this exercise)
  const recentSessions = sessions.filter(s => s.entries.some(e => e.ex === activeEx)).slice(-5).reverse().map(s => ({
    sid: s.id,
    date: s.date,
    sets: s.entries.filter(e => e.ex === activeEx)
  }));
  const submit = () => {
    if (!form.reps || !program) return;
    const rawLoad = form.load ? +form.load : 0;
    const bandKg = showBand && form.bandLoadKg ? +form.bandLoadKg : 0;
    const bandSigned = bandKg ? form.bandUsage === "assisted" ? -bandKg : bandKg : 0;
    const effLoad = Math.max(0, rawLoad + bandSigned);
    if (!effLoad && !isOvrcIso(form.type)) return; // need some load unless overcoming iso
    const oneRM = est1RM(effLoad, +form.reps);
    const velFromRepT_ = form.repTime ? +(0.45 / +form.repTime).toFixed(2) : null;
    const vel = form.velocity ? +form.velocity : velFromRepT_ ? velFromRepT_ : estVelocity(effLoad, oneRM);
    const power = calcPower(effLoad, vel);
    // Effective tempo: session override > program-prescribed default
    const exDefSub = program?.exercises.find(e => e.name === activeEx);
    const eccUsed = tempoOverride.eccSecs !== "" ? +tempoOverride.eccSecs : exDefSub?.eccSecs || null;
    const conUsed = tempoOverride.conSecs !== "" ? +tempoOverride.conSecs : exDefSub?.conSecs || null;
    // Rest applied to this set: session override > exercise default (recorded regardless of timer toggle)
    const restApplied = restOverride !== "" ? +restOverride : calcIncrementalRest(exDefSub?.restSecs, exDefSub?.restIncrementDir, exDefSub?.restIncrementAmt, +form.setNo, exDefSub?.restTurns);
    onAddEntry({
      ex: activeEx,
      ...form,
      reps: +form.reps,
      setNo: +form.setNo,
      load: isOvrcIso(form.type) ? 0 : effLoad,
      rawLoad: isOvrcIso(form.type) ? null : rawLoad,
      velocity: isOvrcIso(form.type) ? 0 : +vel.toFixed(2),
      power: isOvrcIso(form.type) ? 0 : power,
      repTime: form.repTime ? +form.repTime : null,
      eccSecs: eccUsed,
      conSecs: conUsed,
      holdDuration: form.holdDuration ? +form.holdDuration : null,
      mvic: form.mvic ? +form.mvic : null,
      force: form.force ? +form.force : null,
      bandLength: showBand && form.bandLength ? form.bandLength : null,
      bandStrength: showBand && form.bandStrength ? form.bandStrength : null,
      bandUsage: showBand ? form.bandUsage : null,
      bandLoadKg: bandKg || null,
      comment: form.comment || null,
      clusterReps: isClusterSet(form.type) && form.clusterReps ? +form.clusterReps : null,
      clusterCount: isClusterSet(form.type) && form.clusterCount ? +form.clusterCount : null,
      clusterRest: isClusterSet(form.type) && form.clusterRest ? +form.clusterRest : null,
      restApplied: restApplied || null,
      equipUsed: equipOverride || null,
      latUsed: latOverride || null,
      date: today
    });
    setForm(f => ({
      ...f,
      reps: "",
      load: "",
      velocity: "",
      repTime: "",
      holdDuration: "",
      mvic: "",
      force: "",
      bandLength: "",
      bandStrength: "",
      bandUsage: "resisted",
      bandLoadKg: "",
      comment: "",
      clusterReps: "",
      clusterCount: "",
      clusterRest: ""
    }));
    setShowBand(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    // Auto-start countdown only when the Rest Timer toggle is on — the value is
    // still recorded above regardless, so history always reflects the rest used.
    if (restTimerOn && restApplied) startRestTimer(restApplied);
  };
  if (!program) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "48px 24px",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 42,
      marginBottom: 14
    }
  }, "📋"), /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.sub,
      fontSize: 14,
      lineHeight: 1.6
    }
  }, "No active program.", /*#__PURE__*/React.createElement("br", null), "Go to Programs to create or select one."));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "16px 14px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(SecLabel, {
    text: "Exercise — tap to switch"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 7,
      overflowX: "auto",
      paddingBottom: 6,
      scrollbarWidth: "none",
      msOverflowStyle: "none"
    }
  }, progExNames.map(name => {
    const isActive = name === activeEx;
    // count today's sets already logged for this exercise
    const todaySets = sessions.at(-1)?.date === today ? sessions.at(-1).entries.filter(e => e.ex === name).length : 0;
    return /*#__PURE__*/React.createElement("button", {
      key: name,
      onClick: () => switchEx(name),
      style: {
        background: isActive ? C.accent : C.card2,
        color: isActive ? "#001A12" : C.sub,
        border: `1.5px solid ${isActive ? C.accent : C.border}`,
        borderRadius: 22,
        padding: "8px 14px",
        fontSize: 12,
        fontWeight: 700,
        cursor: "pointer",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        minWidth: 80,
        position: "relative"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12
      }
    }, name), todaySets > 0 && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        opacity: 0.8
      }
    }, todaySets, " set", todaySets !== 1 ? "s" : ""));
  }), progExNames.length > 1 && /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowSupersetInfo(true),
    style: {
      background: C.gold + "15",
      border: `1px dashed ${C.gold + "55"}`,
      borderRadius: 22,
      padding: "8px 12px",
      fontSize: 11,
      color: C.gold,
      flexShrink: 0,
      display: "flex",
      alignItems: "center",
      gap: 4,
      cursor: "pointer"
    }
  }, "⚡ Complex sets"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      background: C.card,
      borderRadius: 12,
      padding: "10px 14px",
      marginBottom: 12,
      border: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13
    }
  }, "⏱"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: C.sub,
      fontWeight: 600
    }
  }, "Rest Timer"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: C.muted
    }
  }, "(auto-start after LOG SET)")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setRestTimerOn(o => !o),
    style: {
      width: 44,
      height: 24,
      borderRadius: 12,
      border: "none",
      cursor: "pointer",
      background: restTimerOn ? C.accent : C.border,
      position: "relative",
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 18,
      height: 18,
      borderRadius: "50%",
      background: "#fff",
      position: "absolute",
      top: 3,
      left: restTimerOn ? 23 : 3,
      transition: "left 0.15s"
    }
  }))), (restRunning || restRemaining > 0) && /*#__PURE__*/React.createElement("div", {
    style: {
      background: restRemaining === 0 ? C.accent + "22" : C.card2,
      borderRadius: 14,
      padding: "16px",
      marginBottom: 12,
      border: `1px solid ${restRemaining === 0 ? C.accent : C.border}`,
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      letterSpacing: 1.5,
      textTransform: "uppercase",
      fontWeight: 700,
      marginBottom: 6
    }
  }, restRemaining === 0 ? "Rest complete!" : "Resting…"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 48,
      letterSpacing: 2,
      color: restRemaining === 0 ? C.accent : C.text,
      lineHeight: 1
    }
  }, Math.floor(restRemaining / 60), ":", String(restRemaining % 60).padStart(2, "0")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      justifyContent: "center",
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setRestRemaining(r => Math.max(0, r - 10)),
    style: {
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: "6px 12px",
      color: C.sub,
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 700
    }
  }, "−10s"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setRestRunning(r => !r),
    style: {
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 8,
      padding: "6px 16px",
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 700
    }
  }, restRunning ? "Pause" : restRemaining > 0 ? "Resume" : "Dismiss"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setRestRemaining(r => r + 10),
    style: {
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: "6px 12px",
      color: C.sub,
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 700
    }
  }, "+10s"), restRemaining === 0 && /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setRestRemaining(0);
      setRestRunning(false);
    },
    style: {
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: "6px 12px",
      color: C.muted,
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 700
    }
  }, "✕"))), (() => {
    const exDefR = program?.exercises.find(e => e.name === activeEx);
    const baseRest = exDefR?.restSecs;
    const calcRest = calcIncrementalRest(baseRest, exDefR?.restIncrementDir, exDefR?.restIncrementAmt, +form.setNo, exDefR?.restTurns);
    const hasIncrement = +(exDefR?.restIncrementAmt || 0) > 0;
    if (!baseRest && restOverride === "" && !editingRest) return null;
    return editingRest ? /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8,
        alignItems: "center",
        marginBottom: 12,
        background: C.card2,
        borderRadius: 10,
        padding: "10px 12px",
        border: `1px solid ${C.border}`
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: C.sub,
        flexShrink: 0
      }
    }, "Rest:"), /*#__PURE__*/React.createElement("select", {
      autoFocus: true,
      value: restOverride !== "" ? restOverride : calcRest || "",
      onChange: e => setRestOverride(e.target.value),
      style: {
        ...ss,
        flex: 1,
        padding: "6px 8px"
      }
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "Select…"), REST_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, fmtRest(v)))), /*#__PURE__*/React.createElement("button", {
      onClick: () => setEditingRest(false),
      style: {
        background: C.accent,
        color: "#001A12",
        border: "none",
        borderRadius: 6,
        padding: "6px 12px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 700
      }
    }, "✓")) : /*#__PURE__*/React.createElement("div", {
      onClick: () => setEditingRest(true),
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 12,
        background: C.card2,
        borderRadius: 10,
        padding: "8px 12px",
        border: `1px dashed ${C.border}`,
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: C.sub
      }
    }, "Rest after Set ", form.setNo, ": ", /*#__PURE__*/React.createElement("strong", {
      style: {
        color: C.text
      }
    }, fmtRest(+(restOverride !== "" ? restOverride : calcRest))), restOverride !== "" ? " (session override)" : hasIncrement ? (exDefR.restTurns || []).length > 0 ? ` (🌊 wave, ${exDefR.restTurns.length} turn${exDefR.restTurns.length !== 1 ? "s" : ""})` : ` (${exDefR.restIncrementDir}${fmtRest(+exDefR.restIncrementAmt)}/set)` : " (default)"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: C.accent
      }
    }, "✎ adjust"));
  })(), (() => {
    const exDefN = program?.exercises.find(e => e.name === activeEx);
    const baseNext = exDefN?.restBetweenNext;
    if (!baseNext && restNextOverride === "" && !editingRestNext) return null;
    const activeVal = restNextOverride !== "" ? restNextOverride : baseNext;
    return editingRestNext ? /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8,
        alignItems: "center",
        marginBottom: 12,
        background: C.card2,
        borderRadius: 10,
        padding: "10px 12px",
        border: `1px solid ${C.border}`
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: C.sub,
        flexShrink: 0
      }
    }, "→ Next ex:"), /*#__PURE__*/React.createElement("select", {
      autoFocus: true,
      value: activeVal || "",
      onChange: e => setRestNextOverride(e.target.value),
      style: {
        ...ss,
        flex: 1,
        padding: "6px 8px"
      }
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "Select…"), REST_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, fmtRest(v)))), /*#__PURE__*/React.createElement("button", {
      onClick: () => setEditingRestNext(false),
      style: {
        background: C.accent,
        color: "#001A12",
        border: "none",
        borderRadius: 6,
        padding: "6px 12px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 700
      }
    }, "✓")) : /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 12,
        background: C.card2,
        borderRadius: 10,
        padding: "8px 12px",
        border: `1px dashed ${C.blue}44`
      }
    }, /*#__PURE__*/React.createElement("div", {
      onClick: () => setEditingRestNext(true),
      style: {
        cursor: "pointer",
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: C.sub
      }
    }, "→ Next exercise: ", /*#__PURE__*/React.createElement("strong", {
      style: {
        color: C.text
      }
    }, fmtRest(+activeVal)), restNextOverride !== "" ? " (session)" : " (default)")), /*#__PURE__*/React.createElement("button", {
      onClick: () => startRestTimer(+activeVal),
      style: {
        background: C.blue + "22",
        border: `1px solid ${C.blue}55`,
        borderRadius: 6,
        padding: "5px 10px",
        color: C.blue,
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 700,
        marginRight: 8
      }
    }, "▶ Start"), /*#__PURE__*/React.createElement("span", {
      onClick: () => setEditingRestNext(true),
      style: {
        fontSize: 11,
        color: C.blue,
        cursor: "pointer"
      }
    }, "✎"));
  })(), showSupersetInfo && /*#__PURE__*/React.createElement(Sheet, {
    title: "⚡ COMPLEX SETS GUIDE",
    onClose: () => setShowSupersetInfo(false)
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: C.sub,
      lineHeight: 1.7,
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("strong", {
    style: {
      color: C.text
    }
  }, "Complex sets"), " means performing two or more exercises back-to-back with little or no rest between them, then resting before repeating. They save time, increase training density and metabolic demand."), /*#__PURE__*/React.createElement(SecLabel, {
    text: "Types of complex sets"
  }), [{
    icon: "2️⃣",
    name: "Superset",
    def: "2 exercises back-to-back",
    ex: "Squat → Chest Press, rest, repeat.",
    tip: "Most common. Can target same muscle (intensity) or opposing muscles (efficiency)."
  }, {
    icon: "3️⃣",
    name: "Tri-set",
    def: "3 exercises back-to-back",
    ex: "Squat → Chest Press → Row, rest, repeat.",
    tip: "Higher density. Great for time-efficient full-body or hypertrophy blocks."
  }, {
    icon: "4️⃣",
    name: "Giant set",
    def: "4 or more exercises back-to-back",
    ex: "Squat → Chest Press → Row → Lunge, rest, repeat.",
    tip: "Maximum density. Challenging metabolically — use with moderate loads and experienced clients."
  }].map(t => /*#__PURE__*/React.createElement("div", {
    key: t.name,
    style: {
      background: C.card2,
      borderRadius: 12,
      padding: "12px 14px",
      border: `1px solid ${C.border}`,
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 20
    }
  }, t.icon), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 14,
      color: C.text
    }
  }, t.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.muted
    }
  }, t.def))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: C.sub,
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("strong", {
    style: {
      color: C.text
    }
  }, "Example:"), " ", t.ex), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: C.sub,
      fontStyle: "italic"
    }
  }, t.tip))), /*#__PURE__*/React.createElement(SecLabel, {
    text: "How to log in Forge"
  }), [{
    n: "1",
    t: "Log Exercise A",
    d: `Tap ${progExNames[0] || "Exercise A"} in the pill bar, enter reps/load and tap LOG SET.`
  }, {
    n: "2",
    t: "Switch immediately",
    d: `Tap the next exercise pill — the form switches instantly. No rest between exercises.`
  }, {
    n: "3",
    t: "Log Exercise B (and C, D…)",
    d: "Enter reps/load and tap LOG SET. Continue through all exercises in the complex."
  }, {
    n: "4",
    t: "Rest, then repeat",
    d: "Rest as prescribed, then go back to step 1 for the next round."
  }].map(s => /*#__PURE__*/React.createElement("div", {
    key: s.n,
    style: {
      display: "flex",
      gap: 12,
      marginBottom: 10,
      background: C.card2,
      borderRadius: 12,
      padding: "12px 14px",
      border: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 26,
      height: 26,
      borderRadius: "50%",
      background: C.gold,
      color: "#001A12",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 16,
      flexShrink: 0
    }
  }, s.n), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 13,
      marginBottom: 3
    }
  }, s.t), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: C.sub,
      lineHeight: 1.5
    }
  }, s.d)))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.gold + "15",
      border: `1px solid ${C.gold + "44"}`,
      borderRadius: 10,
      padding: "12px 14px",
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.gold,
      fontWeight: 700,
      marginBottom: 4
    }
  }, "💡 Your program"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: C.sub,
      lineHeight: 1.5
    }
  }, "You have ", /*#__PURE__*/React.createElement("strong", {
    style: {
      color: C.text
    }
  }, progExNames.length, " exercises"), " available — enough for a ", progExNames.length === 2 ? "superset" : progExNames.length === 3 ? "tri-set" : "giant set", ". Chain any combination using the pill bar above."))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      borderRadius: 16,
      padding: "16px",
      marginBottom: 16,
      border: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 22,
      letterSpacing: 2,
      color: C.accent
    }
  }, activeEx), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub
    }
  }, today, " · ", program.name)), /*#__PURE__*/React.createElement(Tag, {
    text: program.name,
    color: C.blue
  })), (() => {
    const exDefEL = program?.exercises.find(e => e.name === activeEx);
    if (!exDefEL) return null;
    const eq = equipOverride || exDefEL.eq;
    const lat = latOverride || exDefEL.lat;
    if (!eq && !lat) return null;
    return editingEquipLat ? /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8,
        alignItems: "center",
        marginBottom: 12,
        background: C.card2,
        borderRadius: 10,
        padding: "10px 12px",
        border: `1px solid ${C.border}`
      }
    }, /*#__PURE__*/React.createElement("select", {
      value: eq,
      onChange: e => setEquipOverride(e.target.value),
      style: {
        ...ss,
        flex: 1,
        padding: "6px 8px"
      }
    }, (equipList || []).map(o => /*#__PURE__*/React.createElement("option", {
      key: o,
      value: o
    }, o))), /*#__PURE__*/React.createElement("select", {
      value: lat,
      onChange: e => setLatOverride(e.target.value),
      style: {
        ...ss,
        flex: 1,
        padding: "6px 8px"
      }
    }, (latList || []).map(o => /*#__PURE__*/React.createElement("option", {
      key: o,
      value: o
    }, o))), /*#__PURE__*/React.createElement("button", {
      onClick: () => setEditingEquipLat(false),
      style: {
        background: C.accent,
        color: "#001A12",
        border: "none",
        borderRadius: 6,
        padding: "6px 12px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 700,
        flexShrink: 0
      }
    }, "✓")) : /*#__PURE__*/React.createElement("div", {
      onClick: () => setEditingEquipLat(true),
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 12,
        background: C.card2,
        borderRadius: 10,
        padding: "8px 12px",
        border: `1px dashed ${C.border}`,
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        color: C.sub
      }
    }, "🔧 ", /*#__PURE__*/React.createElement("strong", {
      style: {
        color: C.text
      }
    }, eq), ", ", lat, equipOverride || latOverride ? " (session)" : ""), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: C.accent
      }
    }, "✎ adjust"));
  })(), isIsoType(form.type) && (() => {
    const m = ISO_META[form.type];
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "10px 12px",
        background: m.color + "18",
        borderRadius: 10,
        border: `1px solid ${m.color + "44"}`,
        marginBottom: 12
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 20
      }
    }, m.icon), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        fontWeight: 700,
        color: m.color,
        marginBottom: 2
      }
    }, m.label), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: C.sub,
        lineHeight: 1.5
      }
    }, m.desc), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: m.color,
        marginTop: 4,
        fontWeight: 700
      }
    }, "Target: ", m.holdTarget, " hold · ", m.setsReps)));
  })(), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: isIsoType(form.type) ? "Contractions" : isClusterSet(form.type) ? "Total Reps (auto)" : "Reps"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "1",
    placeholder: isOvrcIso(form.type) ? "3" : isYieldIso(form.type) ? "1" : "8",
    value: form.reps,
    onChange: e => upd("reps", e.target.value),
    readOnly: isClusterSet(form.type),
    style: {
      ...ss,
      ...(isClusterSet(form.type) ? {
        background: C.card2,
        color: C.sub
      } : {})
    }
  })), isOvrcIso(form.type) ? /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Hold Duration (s)"
  }), /*#__PURE__*/React.createElement("select", {
    value: form.holdDuration,
    onChange: e => upd("holdDuration", e.target.value),
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select…"), form.type === "Ovrc Iso-Ballistic" ? [0.5, 1].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, "s")) : [3].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, "s")))) : /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Load (kg)"
  }), clientBW && /*#__PURE__*/React.createElement("button", {
    onClick: () => upd("load", clientBW),
    style: {
      background: C.accent + "22",
      border: `1px solid ${C.accent + "44"}`,
      borderRadius: 6,
      padding: "2px 8px",
      fontSize: 10,
      color: C.accent,
      fontWeight: 700,
      cursor: "pointer",
      lineHeight: 1.6
    }
  }, "= BW (", clientBW, " kg)")), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0",
    step: "0.5",
    placeholder: "100",
    value: form.load,
    onChange: e => upd("load", e.target.value),
    style: ss
  }))), isClusterSet(form.type) && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#FFB02015",
      borderRadius: 10,
      padding: "12px 14px",
      border: `1px solid #FFB02033`,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.gold,
      fontWeight: 700,
      letterSpacing: 1.5,
      textTransform: "uppercase",
      marginBottom: 10
    }
  }, "⏱ Cluster Set breakdown"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Reps per cluster"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "1",
    placeholder: "2",
    value: form.clusterReps,
    onChange: e => {
      const cr = e.target.value;
      upd("clusterReps", cr);
      const cc = form.clusterCount;
      if (cr && cc) upd("reps", String(+cr * +cc));
    },
    style: ss
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Number of clusters"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "1",
    placeholder: "3",
    value: form.clusterCount,
    onChange: e => {
      const cc = e.target.value;
      upd("clusterCount", cc);
      const cr = form.clusterReps;
      if (cr && cc) upd("reps", String(+cr * +cc));
    },
    style: ss
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Intra-cluster rest (s)"
  }), /*#__PURE__*/React.createElement("select", {
    value: form.clusterRest,
    onChange: e => upd("clusterRest", e.target.value),
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select…"), [5, 10, 15, 20, 25, 30].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, "s (", v === 5 ? "rest-pause" : "cluster", ")")))), form.clusterReps && form.clusterCount && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.gold,
      marginTop: 8,
      fontWeight: 600
    }
  }, form.clusterCount, " clusters × ", form.clusterReps, " reps", form.clusterRest ? ` (${form.clusterRest}s rest between)` : "", " = ", /*#__PURE__*/React.createElement("strong", null, +form.clusterReps * +form.clusterCount, " total reps"))), isIsoType(form.type) && /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card2,
      borderRadius: 10,
      padding: "12px 14px",
      border: `1px solid ${C.border}`,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      letterSpacing: 1.5,
      textTransform: "uppercase",
      fontWeight: 700,
      marginBottom: 10
    }
  }, "⚡ Force measurement", /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.muted + "88",
      fontWeight: 400,
      textTransform: "none",
      letterSpacing: 0
    }
  }, " — optional, requires a device")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Force (N)"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0",
    step: "1",
    placeholder: "e.g. 450",
    value: form.force,
    onChange: e => upd("force", e.target.value),
    style: ss
  })), form.force && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "= kgf"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      padding: "10px 12px",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 22,
      color: C.accent,
      letterSpacing: 1
    }
  }, (+form.force / 9.81).toFixed(1), " kgf"))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.muted,
      lineHeight: 1.5
    }
  }, "Enter peak force from a force plate, dynamometer or load cell.", isYieldIso(form.type) && form.mvic && form.force ? ` Estimated 100% MVIC ≈ ${(+form.force / (+form.mvic / 100)).toFixed(0)} N (${(+form.force / (+form.mvic / 100) / 9.81).toFixed(1)} kgf).` : "")), isYieldIso(form.type) && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Hold Duration (s)"
  }), /*#__PURE__*/React.createElement("select", {
    value: form.holdDuration,
    onChange: e => upd("holdDuration", e.target.value),
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select…"), form.type === "Yielding Iso-GPP" ? Array.from({
    length: 13
  }, (_, i) => 60 + i * 10).map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, "s (", Math.floor(v / 60), ":", String(v % 60).padStart(2, "0"), " min)")) : [30, 35, 40, 45].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, "s")))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "% MVIC"
  }), /*#__PURE__*/React.createElement("select", {
    value: form.mvic,
    onChange: e => upd("mvic", e.target.value),
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select…"), Array.from({
    length: 26
  }, (_, i) => 60 + i).map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, "%"))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: C.muted,
      marginTop: 2
    }
  }, "% max voluntary contraction"))), /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.blue + "15",
      borderRadius: 10,
      padding: "12px 14px",
      border: `1px solid ${C.blue + "33"}`,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      color: C.blue,
      marginBottom: 6
    }
  }, "What is MVIC?"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub,
      lineHeight: 1.6,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("strong", {
    style: {
      color: C.text
    }
  }, "MVIC = Maximum Voluntary Isometric Contraction"), " — the absolute maximum force a muscle can produce in a static (non-moving) contraction. Essentially your ceiling for isometric strength. When you prescribe 60–85% MVIC you are telling the client to hold at that percentage of their maximum possible isometric effort for that position."), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub,
      lineHeight: 1.8
    }
  }, /*#__PURE__*/React.createElement("div", null, "🔵 ", /*#__PURE__*/React.createElement("strong", {
    style: {
      color: C.text
    }
  }, "60% MVIC"), " — moderate effort, sustainable for longer holds, good for beginners or acute tendinopathy"), /*#__PURE__*/React.createElement("div", null, "🟡 ", /*#__PURE__*/React.createElement("strong", {
    style: {
      color: C.text
    }
  }, "70–75% MVIC"), " — typical sweet spot for tendon adaptation"), /*#__PURE__*/React.createElement("div", null, "🔴 ", /*#__PURE__*/React.createElement("strong", {
    style: {
      color: C.text
    }
  }, "85% MVIC"), " — near-maximal, shorter sustainable duration, more advanced")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      marginTop: 8,
      fontStyle: "italic"
    }
  }, "Estimated subjectively (similar to RPE) unless you have force measurement equipment. Guide: 60% = moderately challenging · 75% = hard but holdable · 85% = very difficult."))), !isOvrcIso(form.type) && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowBand(b => !b),
    style: {
      background: showBand ? C.warn + "18" : "none",
      border: `1px ${showBand ? "solid" : "dashed"} ${C.warn + (showBand ? "55" : "33")}`,
      borderRadius: 8,
      padding: "7px 14px",
      fontSize: 12,
      color: C.warn,
      fontWeight: 700,
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", null, "🔴"), " ", showBand ? "Remove band" : "+ Add band"), showBand && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      padding: "12px 14px",
      background: C.card2,
      borderRadius: 10,
      border: `1px solid ${C.warn + "33"}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.warn,
      letterSpacing: 1.5,
      textTransform: "uppercase",
      fontWeight: 700,
      marginBottom: 10
    }
  }, "Band details"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Length"
  }), /*#__PURE__*/React.createElement("select", {
    value: form.bandLength,
    onChange: e => upd("bandLength", e.target.value),
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select…"), ["Short (Mini)", "Long", "Thera Band"].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v)))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Strength"
  }), /*#__PURE__*/React.createElement("select", {
    value: form.bandStrength,
    onChange: e => {
      upd("bandStrength", e.target.value);
      upd("bandLoadKg", "");
    },
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select…"), ["Extra Light", "Light", "Medium", "Heavy", "Extra Heavy"].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v))))), form.bandStrength && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: `Band load (kg) — ${BAND_RANGES[form.bandStrength][0]}–${BAND_RANGES[form.bandStrength][1]}kg range`
  }), /*#__PURE__*/React.createElement("select", {
    value: form.bandLoadKg,
    onChange: e => upd("bandLoadKg", e.target.value),
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select…"), bandRangeOptions(form.bandStrength).map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, " kg"))), form.bandLoadKg && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.warn,
      marginTop: 6,
      fontWeight: 600
    }
  }, form.load || 0, "kg plate ", form.bandUsage === "assisted" ? "−" : "+", " ", form.bandLoadKg, "kg band", " = ", /*#__PURE__*/React.createElement("strong", null, Math.max(0, (form.load ? +form.load : 0) + (form.bandUsage === "assisted" ? -+form.bandLoadKg : +form.bandLoadKg)), "kg effective load"))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Lbl, {
    t: "Usage"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 4
    }
  }, [["resisted", "🔴 Resisted", "adds load"], ["assisted", "🟢 Assisted", "reduces load"]].map(([val, label, sub]) => /*#__PURE__*/React.createElement("button", {
    key: val,
    onClick: () => upd("bandUsage", val),
    style: {
      flex: 1,
      background: form.bandUsage === val ? C.card : C.card2,
      border: `1.5px solid ${form.bandUsage === val ? C.warn : C.border}`,
      borderRadius: 8,
      padding: "8px 6px",
      cursor: "pointer",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      fontWeight: 700,
      color: form.bandUsage === val ? C.warn : C.text
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted
    }
  }, sub))))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Set #"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "1",
    value: form.setNo,
    onChange: e => upd("setNo", e.target.value),
    style: ss
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 2
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Set type"
  }), /*#__PURE__*/React.createElement(AddableSelect, {
    value: form.type,
    onChange: v => upd("type", v),
    options: setTypeList,
    onAddOption: onAddSetType,
    addLabel: "Add set type"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginBottom: 12
    }
  }, !isOvrcIso(form.type) && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "RIR"
  }), /*#__PURE__*/React.createElement("select", {
    value: form.rir,
    onChange: e => upd("rir", +e.target.value),
    style: ss
  }, [0, 1, 2, 3, 4].map(r => /*#__PURE__*/React.createElement("option", {
    key: r
  }, r)))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "RPE"
  }), /*#__PURE__*/React.createElement("select", {
    value: form.rpe,
    onChange: e => upd("rpe", +e.target.value),
    style: ss
  }, [4, 5, 6, 7, 8, 9, 10].map(r => /*#__PURE__*/React.createElement("option", {
    key: r,
    value: r
  }, r, " – ", RPE_DESC[r]))))), (() => {
    const exDef2 = program?.exercises.find(e => e.name === activeEx);
    const genInstr = exDef2?.generalInstructions;
    const exInstr = exDef2?.instructions;

    // Shared general instructions header (always shown if exists)
    const GenHeader = () => genInstr ? /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 10,
        paddingBottom: 10,
        borderBottom: `1px solid #FF802033`
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13,
        color: "#FF8020",
        fontWeight: 700,
        letterSpacing: 1,
        textTransform: "uppercase",
        marginBottom: 6
      }
    }, "General instructions"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: "#FF8020CC",
        lineHeight: 1.6
      }
    }, genInstr)) : null;
    if (!exInstr && !editingInstr) return /*#__PURE__*/React.createElement("div", {
      style: {
        background: "#5060FF12",
        border: `1px dashed #5060FF44`,
        borderRadius: 10,
        padding: "12px 14px",
        marginBottom: 12
      }
    }, /*#__PURE__*/React.createElement(GenHeader, null), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setInstrDraft("");
        setEditingInstr(true);
      },
      style: {
        width: "100%",
        background: "none",
        border: `1px dashed #5060FF44`,
        borderRadius: 8,
        padding: "7px 12px",
        cursor: "pointer",
        color: "#5060FF",
        fontSize: 11,
        fontWeight: 700,
        textAlign: "left"
      }
    }, "📋 + Add set instructions"));
    if (editingInstr) return /*#__PURE__*/React.createElement("div", {
      style: {
        background: "#5060FF12",
        border: `1px solid #5060FF44`,
        borderRadius: 10,
        padding: "12px 14px",
        marginBottom: 12
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: "#5060FF",
        fontWeight: 700,
        letterSpacing: 1.5,
        textTransform: "uppercase"
      }
    }, "📋 Set instructions"), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        // Count existing stamps for this set number to auto-number
        const setPattern = `Set${form.setNo}.`;
        const count = (instrDraft.match(new RegExp(setPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        const stamp = `#${count + 1}   Set${form.setNo}.${today}:\n`;
        setInstrDraft(d => stamp + (d ? '\n' + d : ''));
      },
      style: {
        background: "#5060FF22",
        border: `1px solid #5060FF44`,
        borderRadius: 6,
        padding: "3px 10px",
        fontSize: 11,
        color: "#5060FF",
        fontWeight: 700,
        cursor: "pointer"
      }
    }, "+ #", (instrDraft.match(new RegExp(`Set${form.setNo}.`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length + 1, "   Set", form.setNo, ".", today)), /*#__PURE__*/React.createElement(GenHeader, null), /*#__PURE__*/React.createElement("textarea", {
      rows: 5,
      value: instrDraft,
      onChange: e => setInstrDraft(e.target.value),
      placeholder: "e.g. Keep chest tall, control the descent, drive through heels...",
      style: {
        ...ss,
        resize: "vertical",
        minHeight: 100,
        lineHeight: 1.6,
        marginBottom: 10
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setEditingInstr(false),
      style: {
        flex: 1,
        background: "none",
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: "8px",
        color: C.sub,
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 700
      }
    }, "Cancel"), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        if (onUpdateExercise) onUpdateExercise(activeEx, {
          instructions: instrDraft.trim() || null
        });
        setEditingInstr(false);
      },
      style: {
        flex: 2,
        background: "#5060FF",
        color: "#fff",
        border: "none",
        borderRadius: 8,
        padding: "8px",
        cursor: "pointer",
        fontFamily: "'Bebas Neue',cursive",
        fontSize: 18,
        letterSpacing: 2
      }
    }, "SAVE")));
    return /*#__PURE__*/React.createElement("div", {
      onClick: () => {
        setInstrDraft(exInstr);
        setEditingInstr(true);
      },
      style: {
        background: "#5060FF18",
        border: `1px solid #5060FF33`,
        borderRadius: 10,
        padding: "10px 14px",
        marginBottom: 12,
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement(GenHeader, null), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 6
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: "#5060FF",
        fontWeight: 700,
        letterSpacing: 1.5,
        textTransform: "uppercase"
      }
    }, "📋 Set instructions"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11,
        color: "#5060FF"
      }
    }, "✎ edit")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        lineHeight: 1.8,
        whiteSpace: "pre-wrap"
      }
    }, exInstr.split('\n').map((line, li) => {
      const isStamp = /^#\d+\s+Set\d+\./.test(line.trim());
      return /*#__PURE__*/React.createElement("div", {
        key: li,
        style: {
          fontWeight: isStamp ? 700 : 400,
          fontStyle: isStamp ? "normal" : "italic",
          color: isStamp ? "#5060FF" : "#EEF0FF",
          fontSize: isStamp ? 11 : 11,
          opacity: isStamp ? 1 : 0.7,
          paddingLeft: isStamp ? 0 : 10,
          borderLeft: isStamp ? "none" : `2px solid #5060FF33`
        }
      }, line || '\u00A0');
    })));
  })(), (() => {
    const exDef = program?.exercises.find(e => e.name === activeEx);
    const hasTempo = exDef?.eccSecs || exDef?.conSecs;
    // Effective tempo: session override (if set) > program default
    const effEcc = tempoOverride.eccSecs !== "" ? +tempoOverride.eccSecs : exDef?.eccSecs || null;
    const effCon = tempoOverride.conSecs !== "" ? +tempoOverride.conSecs : exDef?.conSecs || null;
    const isOverridden = tempoOverride.eccSecs !== "" || tempoOverride.conSecs !== "";
    return /*#__PURE__*/React.createElement("div", {
      style: {
        background: C.card2 + "88",
        borderRadius: 10,
        padding: "10px 12px",
        border: `1px dashed ${C.border}`,
        marginBottom: 12
      }
    }, hasTempo && !editingTempo && /*#__PURE__*/React.createElement("div", {
      onClick: () => {
        setTempoOverride({
          eccSecs: effEcc ?? "",
          conSecs: effCon ?? ""
        });
        setEditingTempo(true);
      },
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 10,
        padding: "6px 10px",
        background: C.accent + "15",
        borderRadius: 8,
        border: `1px solid ${C.accent + "33"}`,
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 16
      }
    }, "⏱"), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.muted,
        fontWeight: 700,
        letterSpacing: 1,
        textTransform: "uppercase"
      }
    }, isOverridden ? "Tempo (adjusted this session)" : "Prescribed Tempo", " ", /*#__PURE__*/React.createElement("span", {
      style: {
        opacity: 0.6,
        fontWeight: 400
      }
    }, "· tap to adjust")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13,
        color: C.accent,
        fontWeight: 700
      }
    }, effEcc || "?", "s eccentric / ", effCon || "?", "s concentric", /*#__PURE__*/React.createElement("span", {
      style: {
        color: C.sub,
        fontWeight: 400
      }
    }, " — target TUT: ", form.reps ? Math.round(+form.reps * ((effEcc || 2) + (effCon || 1))) : "–", form.reps ? "s" : ""))), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 14,
        color: C.muted
      }
    }, "✎")), hasTempo && editingTempo && /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 10,
        padding: "10px 12px",
        background: C.accent + "10",
        borderRadius: 8,
        border: `1px solid ${C.accent + "33"}`
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.muted,
        fontWeight: 700,
        letterSpacing: 1,
        textTransform: "uppercase",
        marginBottom: 8
      }
    }, "Adjust tempo for this session"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8,
        marginBottom: 8
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: "Eccentric (s)"
    }), /*#__PURE__*/React.createElement("input", {
      type: "number",
      min: "0.5",
      step: "0.5",
      value: tempoOverride.eccSecs,
      onChange: e => setTempoOverride(t => ({
        ...t,
        eccSecs: e.target.value
      })),
      style: ss
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: "Concentric (s)"
    }), /*#__PURE__*/React.createElement("input", {
      type: "number",
      min: "0.5",
      step: "0.5",
      value: tempoOverride.conSecs,
      onChange: e => setTempoOverride(t => ({
        ...t,
        conSecs: e.target.value
      })),
      style: ss
    }))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setTempoOverride({
          eccSecs: "",
          conSecs: ""
        });
        setEditingTempo(false);
      },
      style: {
        flex: 1,
        background: "none",
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        padding: "8px",
        color: C.sub,
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 700
      }
    }, "Reset to default (", exDef.eccSecs || "?", "/", exDef.conSecs || "?", "s)"), /*#__PURE__*/React.createElement("button", {
      onClick: () => setEditingTempo(false),
      style: {
        flex: 1,
        background: C.accent,
        border: "none",
        borderRadius: 8,
        padding: "8px",
        color: "#001A12",
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 700
      }
    }, "Done"))), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: hasTempo ? 10 : 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.muted,
        letterSpacing: 1.5,
        textTransform: "uppercase",
        fontWeight: 700,
        marginBottom: 8
      }
    }, "Power measurement"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 10,
        marginBottom: 6
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: "Rep time (s)"
    }), /*#__PURE__*/React.createElement("input", {
      type: "number",
      min: "0.1",
      step: "0.1",
      placeholder: "e.g. 0.5",
      value: form.repTime,
      onChange: e => upd("repTime", e.target.value),
      style: ss
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.muted,
        marginTop: 3
      }
    }, "⏱ Manual — stopwatch")), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: "Bar speed (m/s)"
    }), /*#__PURE__*/React.createElement("input", {
      type: "number",
      min: "0.1",
      step: "0.01",
      placeholder: "e.g. 0.85",
      value: form.velocity,
      onChange: e => upd("velocity", e.target.value),
      style: ss
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.muted,
        marginTop: 3
      }
    }, "📡 Device — overrides rep time"))), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.muted,
        lineHeight: 1.4
      }
    }, "Enter one or neither. Device reading takes priority over rep time.")));
  })(), vol > 0 && (() => {
    const oneRM = est1RM(effLoadLive, +form.reps);
    // velocity: measured > derived from conSecs > estimated from load/1RM
    // Velocity: measured > from rep time > estimated
    const velFromRepT = form.repTime ? +(0.45 / +form.repTime).toFixed(2) : null;
    const vel = form.velocity ? +form.velocity : velFromRepT ? velFromRepT : estVelocity(effLoadLive, oneRM);
    const power = calcPower(effLoadLive, vel);
    const velLabel = form.velocity ? "m/s (measured)" : velFromRepT ? "m/s (from rep time)" : "m/s (estimated)";
    // TUT from effective tempo (session override > prescribed default)
    const exDef2 = program?.exercises.find(e => e.name === activeEx);
    const eccS = tempoOverride.eccSecs !== "" ? +tempoOverride.eccSecs : exDef2?.eccSecs || null;
    const conS = tempoOverride.conSecs !== "" ? +tempoOverride.conSecs : exDef2?.conSecs || null;
    // For isometrics, TUT = holdDuration × reps
    const tut = isIsoType(form.type) && form.holdDuration && form.reps ? Math.round(+form.holdDuration * +form.reps) : (eccS || conS) && form.reps ? Math.round(+form.reps * ((eccS || 2) + (conS || 1))) : null;
    const tutZone = !tut ? null : tut >= 40 && tut <= 70 ? {
      label: "Optimal TUT ✓",
      color: C.accent
    } : tut < 40 ? {
      label: "Below optimal",
      color: "#FFB020"
    } : {
      label: "Extended TUT",
      color: C.blue
    };
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8,
        marginBottom: 8
      }
    }, /*#__PURE__*/React.createElement(StatCard, {
      label: "Volume",
      value: vol,
      unit: " kg",
      color: C.blue
    }), /*#__PURE__*/React.createElement(StatCard, {
      label: "Est. 1RM",
      value: oneRM,
      unit: " kg",
      color: C.accent
    })), !isIsoType(form.type) && /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8,
        marginBottom: tut ? 8 : 14
      }
    }, /*#__PURE__*/React.createElement(StatCard, {
      label: "Power",
      value: power,
      unit: " W",
      color: C.gold
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        background: C.card2,
        borderRadius: 10,
        padding: "10px 12px",
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.muted,
        letterSpacing: 1.5,
        textTransform: "uppercase",
        marginBottom: 3,
        fontWeight: 700
      }
    }, "Velocity"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 22,
        fontFamily: "'Bebas Neue',cursive",
        letterSpacing: 1,
        color: C.gold,
        lineHeight: 1.2
      }
    }, vel.toFixed(2)), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.muted,
        marginTop: 1
      }
    }, velLabel))), tut && /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8,
        marginBottom: 14
      }
    }, /*#__PURE__*/React.createElement(StatCard, {
      label: "TUT this set",
      value: tut,
      unit: "s",
      color: tutZone.color
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        background: C.card2,
        borderRadius: 10,
        padding: "10px 12px",
        flex: 1,
        display: "flex",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.muted,
        letterSpacing: 1.5,
        textTransform: "uppercase",
        marginBottom: 3,
        fontWeight: 700
      }
    }, "Hypertrophy"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 14,
        fontWeight: 700,
        color: tutZone.color
      }
    }, tutZone.label), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.muted,
        marginTop: 1
      }
    }, "Target: 40–70s")))));
  })(), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Set comment (optional)"
  }), /*#__PURE__*/React.createElement("textarea", {
    rows: 2,
    placeholder: "e.g. Form broke down on rep 6, reduce load next set...",
    value: form.comment,
    onChange: e => upd("comment", e.target.value),
    style: {
      ...ss,
      resize: "vertical",
      minHeight: 60,
      lineHeight: 1.5
    }
  })), /*#__PURE__*/React.createElement("button", {
    onClick: submit,
    style: {
      width: "100%",
      background: saved ? C.accent + "CC" : C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 10,
      padding: "14px",
      cursor: "pointer",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 20,
      letterSpacing: 2
    }
  }, saved ? `✓  ${activeEx.toUpperCase()} LOGGED!` : "LOG SET")), sessions.at(-1)?.date === today && sessions.at(-1).entries.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(SecLabel, {
    text: "Today's session"
  }), progExNames.map(name => {
    const todayEntries = sessions.at(-1).entries.filter(e => e.ex === name);
    if (!todayEntries.length) return null;
    return /*#__PURE__*/React.createElement("div", {
      key: name,
      style: {
        background: C.card,
        borderRadius: 10,
        padding: "10px 14px",
        marginBottom: 8,
        border: `1px solid ${name === activeEx ? C.accent + "44" : C.border}`
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontWeight: 700,
        fontSize: 13,
        marginBottom: 6,
        color: name === activeEx ? C.accent : C.text
      }
    }, name), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexWrap: "wrap",
        gap: 6
      }
    }, todayEntries.map((e, i) => /*#__PURE__*/React.createElement("span", {
      key: i,
      style: {
        background: C.card2,
        borderRadius: 6,
        padding: "4px 10px",
        fontSize: 12,
        border: `1px solid ${C.border}`
      }
    }, "Set ", e.set, ": ", e.reps, "×", e.load, "kg"))));
  })), recentSessions.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(SecLabel, {
    text: `History — ${activeEx}`
  }), recentSessions.map((s, si) => /*#__PURE__*/React.createElement("div", {
    key: si,
    style: {
      background: C.card,
      borderRadius: 12,
      padding: "12px 14px",
      marginBottom: 10,
      border: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(Tag, {
    text: s.sid,
    color: C.blue
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: C.sub
    }
  }, s.date)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.muted
    }
  }, s.sets.length, " set", s.sets.length !== 1 ? "s" : "")), s.sets.map((e, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "7px 0",
      borderTop: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: C.muted,
      marginRight: 8
    }
  }, "Set ", e.set), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13
    }
  }, e.reps, " reps"), e.holdDuration && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "#5060FF"
    }
  }, " · ⏱ ", e.holdDuration, "s"), e.mvic && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "#5060FF"
    }
  }, " · ", e.mvic, "% MVIC"), e.force && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: C.gold
    }
  }, " · ", e.force, "N"), e.bandStrength && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: C.warn
    }
  }, " · 🔴 ", e.bandLength, " ", e.bandStrength, " ", e.bandLoadKg ? `${e.bandLoadKg}kg ` : "", "(", e.bandUsage, ")"), e.clusterReps && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: C.gold
    }
  }, " · ⏱ ", e.clusterCount, "×", e.clusterReps, " clusters"), e.restApplied && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: C.blue
    }
  }, " · 💤 ", e.restApplied >= 60 ? `${Math.floor(e.restApplied / 60)}:${String(e.restApplied % 60).padStart(2, "0")}` : `${e.restApplied}s`, " rest"), (e.equipUsed || e.latUsed) && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: C.sub
    }
  }, " · 🔧 ", e.equipUsed || "", e.equipUsed && e.latUsed ? ", " : "", e.latUsed || ""), e.comment && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.muted,
      fontStyle: "italic",
      marginTop: 4,
      padding: "4px 8px",
      background: C.card2,
      borderRadius: 6,
      border: `1px solid ${C.border}`
    }
  }, "💬 ", e.comment), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: C.muted
    }
  }, " · ", e.type), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: C.sub
    }
  }, " · RPE ", e.rpe, !isOvrcIso(e.type) ? ` · RIR ${e.rir}` : "")), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right",
      flexShrink: 0
    }
  }, !isOvrcIso(e.type) ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 22,
      color: C.accent,
      lineHeight: 1
    }
  }, e.load, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      opacity: 0.6
    }
  }, " kg")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.sub
    }
  }, "~", est1RM(e.load, e.reps), " 1RM")) : /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.warn,
      fontWeight: 700
    }
  }, "Max effort"))))))));
}

// ─── Progress Tab ─────────────────────────────────────────────────────────────

function ProgressTab({
  program
}) {
  const exercises = program?.exercises || [];
  const sessions = program?.sessions || [];
  const [sel, setSel] = useState(exercises[0]?.name || "");
  useEffect(() => {
    if (exercises.length > 0 && !exercises.find(e => e.name === sel)) setSel(exercises[0].name);
  }, [program?.id]);
  const [metric, setMetric] = useState("Load"); // Load | Est 1RM | Power
  const dateMap = useMemo(() => Object.fromEntries((sessions || []).map(s => [s.id, s.date])), [sessions]);
  const chartData = useMemo(() => {
    if (!sel) return [];
    return sessions.map(s => {
      const ee = s.entries.filter(e => e.ex === sel);
      if (!ee.length) return null;
      const maxLoad = Math.max(...ee.map(e => e.load));
      const top = ee.find(e => e.load === maxLoad);
      const oneRM = est1RM(maxLoad, top.reps);
      const vel = top.velocity || estVelocity(maxLoad, oneRM);
      const power = top.power || calcPower(maxLoad, vel);
      // Max reps across all sets this session for this exercise
      const maxReps = Math.max(...ee.map(e => e.reps));
      const totalVol = ee.reduce((sum, e) => sum + e.load * e.reps, 0);
      const avgReps = ee.reduce((sum, e) => sum + e.reps, 0) / ee.length;
      // TUT: prefer actual logged tempo per entry (session adjustment), else program default
      const exDef = sessions.length ? program?.exercises?.find(e => e.name === sel) : null;
      const loggedTempo = ee.filter(e => e.eccSecs || e.conSecs);
      const avgTUT = loggedTempo.length ? ee.reduce((sum, e) => sum + e.reps * ((e.eccSecs || exDef?.eccSecs || 2) + (e.conSecs || exDef?.conSecs || 1)), 0) / ee.length : exDef?.eccSecs || exDef?.conSecs ? top.reps * ((exDef.eccSecs || 2) + (exDef.conSecs || 1)) : null;
      const totalRestSecs = ee.reduce((sum, e) => sum + (e.restApplied || 0), 0);
      const totalWorkSecs = ee.reduce((sum, e) => sum + estSetWorkSecs(e, exDef), 0);
      return {
        session: s.id,
        date: s.date,
        "Load": maxLoad,
        "Est 1RM": oneRM,
        "Power": power,
        "Reps": maxReps,
        "Hyp Index": calcHypIndex(totalVol, oneRM, avgReps, avgTUT),
        "Max Str Index": calcMSI(maxLoad, oneRM),
        "Str End Index": calcSEI(totalVol, oneRM, avgReps),
        "Power Index": calcPowerIndex(power, oneRM),
        "Density": calcDensity(totalVol, totalWorkSecs + totalRestSecs)
      };
    }).filter(Boolean).map((d, i, arr) => ({
      ...d,
      "Injury Index": injuryIndex(d.Load, i > 0 ? arr[i - 1].Load : null)
    })).map((d, i, arr) => {
      // ACWR: need original session index in full sessions array
      const sessIdx = sessions.findIndex(s => s.id === d.session);
      return {
        ...d,
        "ACWR": calcACWR(sessions, sel, sessIdx)
      };
    });
  }, [sessions, sel]);
  const first = chartData[0]?.[metric],
    last = chartData.at(-1)?.[metric];
  const bestPower = chartData.length ? Math.max(...chartData.map(d => d["Power"] || 0)) : 0;
  const best1RM = chartData.length ? Math.max(...chartData.map(d => d["Est 1RM"] || 0)) : 0;
  const bestReps = chartData.length ? Math.max(...chartData.map(d => d["Reps"] || 0)) : 0;
  const peakInjury = chartData.length ? Math.max(...chartData.map(d => d["Injury Index"] || 0)) : 0;
  const pct = first && last ? ((last - first) / first * 100).toFixed(1) : 0;
  const METRIC_OPTS = [{
    key: "Load",
    label: "Load",
    unit: "kg",
    color: C.accent
  }, {
    key: "Est 1RM",
    label: "Est 1RM",
    unit: "kg",
    color: C.blue
  }, {
    key: "Power",
    label: "Power",
    unit: "W",
    color: C.gold
  }, {
    key: "Reps",
    label: "Reps",
    unit: " reps",
    color: "#FF8020"
  }, {
    key: "Injury Index",
    label: "Injury Index",
    unit: "%",
    color: C.warn
  }, {
    key: "ACWR",
    label: "ACWR",
    unit: "×",
    color: "#AA44FF"
  }, {
    key: "Hyp Index",
    label: "Hyp Index",
    unit: "",
    color: "#10D4A0"
  }, {
    key: "Max Str Index",
    label: "Max Str",
    unit: "%",
    color: "#FF8020"
  }, {
    key: "Str End Index",
    label: "Str End",
    unit: "",
    color: "#5060FF"
  }, {
    key: "Power Index",
    label: "Power Index",
    unit: "",
    color: "#AA44FF"
  }, {
    key: "Density",
    label: "Density",
    unit: " kg/min",
    color: "#00C896"
  }];
  if (!program) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "48px 24px",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 42,
      marginBottom: 14
    }
  }, "📈"), /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.sub,
      fontSize: 14
    }
  }, "No active program selected."));
  if (!exercises.length || !sessions.length) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "48px 24px",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 42,
      marginBottom: 14
    }
  }, "📈"), /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.sub,
      fontSize: 14
    }
  }, "No session data yet.", /*#__PURE__*/React.createElement("br", null), "Start logging in the Log tab."));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "16px 14px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(SecLabel, {
    text: "Select exercise"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 7,
      flexWrap: "wrap"
    }
  }, exercises.map(ex => /*#__PURE__*/React.createElement("button", {
    key: ex.name,
    onClick: () => setSel(ex.name),
    style: {
      background: sel === ex.name ? C.accent : C.card2,
      color: sel === ex.name ? "#001A12" : C.sub,
      border: `1px solid ${sel === ex.name ? C.accent : C.border}`,
      borderRadius: 20,
      padding: "7px 14px",
      fontSize: 12,
      fontWeight: 700,
      cursor: "pointer"
    }
  }, ex.name)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(StatCard, {
    label: "Current",
    value: last ?? "–",
    unit: ` ${METRIC_OPTS.find(m => m.key === metric)?.unit}`,
    color: C.accent
  }), /*#__PURE__*/React.createElement(StatCard, {
    label: "Best 1RM",
    value: best1RM || "–",
    unit: " kg",
    color: C.blue
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(StatCard, {
    label: "Peak Power",
    value: bestPower || "–",
    unit: " W",
    color: C.gold
  }), metric === "ACWR" || ["Hyp Index", "Max Str Index", "Str End Index", "Power Index"].includes(metric) ? /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card2,
      borderRadius: 10,
      padding: "10px 12px",
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      letterSpacing: 1.5,
      textTransform: "uppercase",
      marginBottom: 3,
      fontWeight: 700
    }
  }, "Zone"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 700,
      color: metric === "ACWR" ? acwrZone(last).color : trainingZone(metric, last).color
    }
  }, metric === "ACWR" ? acwrZone(last).label : trainingZone(metric, last).label)) : /*#__PURE__*/React.createElement(StatCard, {
    label: metric === "Reps" ? "Best Reps" : metric === "Injury Index" ? "Peak Risk" : "Total gain",
    value: metric === "Reps" ? bestReps || "–" : metric === "Injury Index" ? peakInjury : first && last ? `+${pct}` : "–",
    unit: metric === "Reps" ? " reps" : metric === "Injury Index" ? "%" : first && last ? "%" : "",
    color: "#FF8020"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 7,
      marginBottom: 14
    }
  }, METRIC_OPTS.map(m => /*#__PURE__*/React.createElement("button", {
    key: m.key,
    onClick: () => setMetric(m.key),
    style: {
      background: metric === m.key ? m.color : C.card2,
      color: metric === m.key ? "#001A12" : C.sub,
      border: `1px solid ${metric === m.key ? m.color : C.border}`,
      borderRadius: 20,
      padding: "6px 14px",
      fontSize: 12,
      fontWeight: 700,
      cursor: "pointer"
    }
  }, m.label))), chartData.length > 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      borderRadius: 16,
      padding: "16px 6px 12px",
      border: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      paddingLeft: 12,
      marginBottom: 12
    }
  }, sel, " — ", metric, " progression"), /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: 200
  }, /*#__PURE__*/React.createElement(LineChart, {
    data: chartData,
    margin: {
      top: 4,
      right: 14,
      bottom: 4,
      left: 0
    }
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    stroke: C.border,
    strokeDasharray: "3 3"
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "session",
    axisLine: false,
    tickLine: false,
    height: 34,
    tick: props => /*#__PURE__*/React.createElement(SessionXTick, {
      ...props,
      dateMap: dateMap
    })
  }), /*#__PURE__*/React.createElement(YAxis, {
    tick: {
      fill: C.muted,
      fontSize: 11
    },
    axisLine: false,
    tickLine: false,
    width: 42,
    unit: METRIC_OPTS.find(m => m.key === metric)?.unit
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: C.card2,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      color: C.text,
      fontSize: 12
    }
  }), metric === "Injury Index" && /*#__PURE__*/React.createElement(ReferenceLine, {
    y: 10,
    stroke: C.warn,
    strokeDasharray: "4 3",
    strokeOpacity: 0.6,
    label: {
      value: "High risk >10%",
      position: "insideTopRight",
      fill: C.warn,
      fontSize: 10
    }
  }), metric === "ACWR" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(ReferenceLine, {
    y: 0.8,
    stroke: C.blue,
    strokeDasharray: "4 3",
    strokeOpacity: 0.6,
    label: {
      value: "0.8 Low",
      position: "insideBottomRight",
      fill: C.blue,
      fontSize: 9
    }
  }), /*#__PURE__*/React.createElement(ReferenceLine, {
    y: 1.3,
    stroke: "#FFB020",
    strokeDasharray: "4 3",
    strokeOpacity: 0.6,
    label: {
      value: "1.3 Caution",
      position: "insideTopRight",
      fill: "#FFB020",
      fontSize: 9
    }
  }), /*#__PURE__*/React.createElement(ReferenceLine, {
    y: 1.5,
    stroke: C.warn,
    strokeDasharray: "4 3",
    strokeOpacity: 0.6,
    label: {
      value: "1.5 High risk",
      position: "insideTopRight",
      fill: C.warn,
      fontSize: 9
    }
  })), metric === "Max Str Index" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(ReferenceLine, {
    y: 65,
    stroke: C.blue,
    strokeDasharray: "4 3",
    strokeOpacity: 0.6,
    label: {
      value: "65% Strength zone",
      position: "insideTopRight",
      fill: C.blue,
      fontSize: 9
    }
  }), /*#__PURE__*/React.createElement(ReferenceLine, {
    y: 80,
    stroke: "#FF8020",
    strokeDasharray: "4 3",
    strokeOpacity: 0.6,
    label: {
      value: "80% Max strength",
      position: "insideTopRight",
      fill: "#FF8020",
      fontSize: 9
    }
  }), /*#__PURE__*/React.createElement(ReferenceLine, {
    y: 90,
    stroke: C.warn,
    strokeDasharray: "4 3",
    strokeOpacity: 0.6,
    label: {
      value: "90% Peaking",
      position: "insideTopRight",
      fill: C.warn,
      fontSize: 9
    }
  })), /*#__PURE__*/React.createElement(Line, {
    type: "monotone",
    dataKey: metric,
    stroke: METRIC_OPTS.find(m => m.key === metric)?.color,
    strokeWidth: 2.5,
    dot: {
      fill: METRIC_OPTS.find(m => m.key === metric)?.color,
      r: 4,
      strokeWidth: 0
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "center",
      gap: 18,
      marginTop: 8
    }
  }, METRIC_OPTS.map(m => /*#__PURE__*/React.createElement("div", {
    key: m.key,
    onClick: () => setMetric(m.key),
    style: {
      display: "flex",
      alignItems: "center",
      gap: 5,
      fontSize: 11,
      color: metric === m.key ? m.color : C.muted,
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 14,
      height: 3,
      background: m.color,
      display: "inline-block",
      borderRadius: 2
    }
  }), m.label)))));
}

// ─── Print Preview Overlay ────────────────────────────────────────────────────

function PrintPreview({
  client,
  program,
  bests,
  sessionData,
  fb,
  hasBW,
  exColors,
  onClose
}) {
  const today = new Date().toLocaleDateString("en-ZA", {
    day: "2-digit",
    month: "long",
    year: "numeric"
  });
  const exercises = program.exercises || [];
  const hasSessions = sessionData.length > 1;

  // Inject print styles once mounted, remove on unmount
  useEffect(() => {
    const style = document.createElement("style");
    style.id = "forge-print-style";
    style.textContent = `
      @media print {
        body * { visibility: hidden !important; }
        #forge-print-root, #forge-print-root * { visibility: visible !important; }
        #forge-print-root {
          position: absolute !important; left: 0 !important; top: 0 !important;
          width: 100% !important; background: white !important; color: black !important;
          font-family: sans-serif !important;
        }
        #forge-print-root .no-print { display: none !important; visibility: hidden !important; }
        @page { margin: 1.5cm; }
      }
    `;
    document.head.appendChild(style);
    return () => {
      try {
        document.head.removeChild(style);
      } catch {}
    };
  }, []);
  const pRow = (label, value, color = "#111827") => /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      padding: "8px 0",
      borderBottom: "1px solid #f3f4f6",
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#6b7280",
      fontWeight: 600
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      color
    }
  }, value));
  const SvgChartPrint = ({
    data,
    keys,
    colors,
    names,
    unit = ""
  }) => {
    if (!data.length || !keys.length) return null;
    const allVals = keys.flatMap(k => data.map(d => d[k]).filter(v => v != null));
    if (!allVals.length) return null;
    const minV = Math.min(...allVals),
      maxV = Math.max(...allVals),
      range = maxV - minV || 1;
    const pL = 48,
      pR = 16,
      pT = 16,
      pB = 28,
      w = 500,
      h = 150;
    const cw = w - pL - pR,
      ch = h - pT - pB;
    const cx = (i, n) => pL + (n <= 1 ? cw / 2 : i / (n - 1) * cw);
    const cy = v => pT + ch - (v - minV) / range * ch;
    const n = data.length;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 24
      }
    }, /*#__PURE__*/React.createElement("svg", {
      width: "100%",
      viewBox: `0 0 ${w} ${h}`,
      style: {
        display: "block",
        overflow: "visible"
      }
    }, [0, 0.25, 0.5, 0.75, 1].map(f => {
      const yy = pT + ch * (1 - f);
      return /*#__PURE__*/React.createElement("g", {
        key: f
      }, /*#__PURE__*/React.createElement("line", {
        x1: pL,
        y1: yy,
        x2: w - pR,
        y2: yy,
        stroke: "#e5e7eb",
        strokeWidth: "1"
      }), /*#__PURE__*/React.createElement("text", {
        x: pL - 5,
        y: yy + 4,
        textAnchor: "end",
        fontSize: "10",
        fill: "#9ca3af"
      }, (minV + f * range).toFixed(1), unit));
    }), data.map((d, i) => /*#__PURE__*/React.createElement("text", {
      key: i,
      x: cx(i, n),
      y: h - 6,
      textAnchor: "middle",
      fontSize: "10",
      fill: "#9ca3af"
    }, d.session)), keys.map((k, ki) => {
      const pts = data.map((d, i) => ({
        x: cx(i, n),
        y: d[k] != null ? cy(d[k]) : null
      })).filter(p => p.y != null);
      if (!pts.length) return null;
      const path = pts.map((p, pi) => `${pi === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
      return /*#__PURE__*/React.createElement("g", {
        key: k
      }, /*#__PURE__*/React.createElement("path", {
        d: path,
        fill: "none",
        stroke: colors[ki],
        strokeWidth: "2.5",
        strokeLinecap: "round",
        strokeLinejoin: "round"
      }), pts.map((p, pi) => /*#__PURE__*/React.createElement("circle", {
        key: pi,
        cx: p.x,
        cy: p.y,
        r: "3.5",
        fill: colors[ki],
        stroke: "white",
        strokeWidth: "1.5"
      })));
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        paddingLeft: pL,
        marginTop: 6
      }
    }, keys.map((k, ki) => /*#__PURE__*/React.createElement("div", {
      key: k,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        color: "#374151"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 14,
        height: 3,
        background: colors[ki],
        display: "inline-block",
        borderRadius: 2
      }
    }), names[ki]))));
  };
  const secH = t => /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: 2,
      color: "#9ca3af",
      borderBottom: "1px solid #f3f4f6",
      paddingBottom: 6,
      marginBottom: 12,
      marginTop: 28
    }
  }, t);

  // ── Generate PDF with jsPDF (tables + charts) ────────────────────────────
  const buildPDF = () => {
    const {
      jsPDF
    } = window.jspdf;
    const doc = new jsPDF({
      orientation: "p",
      unit: "mm",
      format: "a4"
    });
    const W = doc.internal.pageSize.getWidth(); // 210mm
    const H = doc.internal.pageSize.getHeight(); // 297mm
    const M = 15,
      CW = W - M * 2; // 180mm content width
    let y = M;
    const newPage = () => {
      doc.addPage();
      y = M;
    };
    const guard = need => {
      if (y + need > H - 18) newPage();
    };
    const BLK = [17, 24, 39],
      GRY = [107, 114, 128],
      GRN = [5, 150, 105],
      BLU = [37, 99, 235],
      GLD = [180, 120, 0];

    // Parse hex → [r,g,b]
    const rgb = hex => {
      const h = hex.replace("#", "");
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    };

    // Table row
    const drawRow = (cells, widths, isHdr, colCols) => {
      if (isHdr) {
        doc.setFillColor(249, 250, 251);
        doc.rect(M, y, CW, 7, "F");
      }
      let x = M;
      cells.forEach((c, i) => {
        const text = String(c ?? "–");
        doc.setFontSize(isHdr ? 7 : 9.5);
        doc.setFont("helvetica", isHdr ? "bold" : "normal");
        doc.setTextColor(...(colCols?.[i] || (isHdr ? GRY : BLK)));
        const fitted = doc.splitTextToSize(text, widths[i] - 2)[0] || text.slice(0, 12);
        doc.text(fitted, x + 1, y + (isHdr ? 4.5 : 5.5));
        x += widths[i];
      });
      doc.setDrawColor(229, 231, 235);
      doc.setLineWidth(0.2);
      doc.line(M, y + 7, M + CW, y + 7);
      y += 8;
    };

    // Section heading
    const secHead = t => {
      guard(14);
      y += 3;
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...GRY);
      doc.text(t, M, y);
      y += 2;
      doc.setDrawColor(209, 213, 219);
      doc.setLineWidth(0.3);
      doc.line(M, y, M + CW, y);
      y += 5;
    };

    // Line chart drawer
    const drawChart = (data, keys, colors, names, unit, title) => {
      const allVals = keys.flatMap(k => data.map(d => d[k]).filter(v => v != null && !isNaN(v)));
      if (!allVals.length) return;
      const CH = 58,
        padL = 20,
        padR = 4,
        padT = 6,
        padB = 20;
      const plotW = CW - padL - padR;
      const plotH = CH - padT - padB;
      guard(CH + 10);
      y += 3;
      doc.setFontSize(7.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(...GRY);
      doc.text(title, M, y);
      y += 3;
      const ox = M + padL; // plot origin x
      const oy = y + padT; // plot origin y
      const n = data.length;
      const minV = Math.min(...allVals);
      const maxV = Math.max(...allVals);
      const range = maxV - minV || 1;
      const px_ = i => ox + (n <= 1 ? plotW / 2 : i / (n - 1) * plotW);
      const py_ = v => oy + plotH - (v - minV) / range * plotH;

      // Grid lines + Y labels
      doc.setLineWidth(0.15);
      [0, 0.25, 0.5, 0.75, 1].forEach(f => {
        const gy = oy + plotH * (1 - f);
        doc.setDrawColor(229, 231, 235);
        doc.line(ox, gy, ox + plotW, gy);
        const val = minV + f * range;
        doc.setFontSize(5.5);
        doc.setTextColor(...GRY);
        doc.text((val >= 100 ? val.toFixed(0) : val.toFixed(1)) + unit, ox - 2, gy + 1.5, {
          align: "right"
        });
      });

      // X axis session labels + date
      data.forEach((d, i) => {
        doc.setFontSize(5.5);
        doc.setTextColor(...GRY);
        doc.text(d.session || "", px_(i), oy + plotH + 5, {
          align: "center"
        });
        if (d.date) doc.text(d.date, px_(i), oy + plotH + 9.5, {
          align: "center"
        });
      });

      // Draw each series
      keys.forEach((k, ki) => {
        const col = rgb(colors[ki]);
        doc.setDrawColor(...col);
        doc.setLineWidth(0.55);
        doc.setFillColor(...col);
        const pts = data.map((d, i) => {
          const v = d[k];
          return v != null ? {
            x: px_(i),
            y: py_(v)
          } : null;
        });

        // Line segments
        for (let i = 1; i < pts.length; i++) {
          if (pts[i - 1] && pts[i]) doc.line(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
        }
        // Dots
        pts.forEach(p => {
          if (p) doc.circle(p.x, p.y, 0.9, "F");
        });
      });

      // Legend
      let lx = ox;
      const ly = y + CH - 4;
      keys.forEach((k, ki) => {
        doc.setFillColor(...rgb(colors[ki]));
        doc.rect(lx, ly - 1.5, 7, 1.5, "F");
        doc.setFontSize(6);
        doc.setTextColor(...GRY);
        doc.text(names[ki], lx + 8, ly);
        lx += 8 + doc.getTextWidth(names[ki]) + 5;
      });
      y += CH + 2;
    };

    // ── Page header ──────────────────────────────────────────────────────────
    doc.setFontSize(24);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...BLK);
    doc.text(client.name, M, y);
    y += 8;
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(...GRY);
    doc.text(`${program.name} · ${program.type}`, M, y);
    y += 5;
    doc.text(`Generated: ${today}  ·  ${program.sessions.length} sessions${client.bw ? " · " + client.bw + " kg BW" : ""}`, M, y);
    y += 4;
    doc.setDrawColor(...BLK);
    doc.setLineWidth(0.5);
    doc.line(M, y, M + CW, y);
    y += 8;

    // ── Best lifts table ──────────────────────────────────────────────────────
    if (bests.length > 0) {
      secHead("BEST LIFTS SUMMARY");
      const hdr = ["Exercise", "Best Load", "Est 1RM", "Peak Power", "Rel Str", "First", "Last", "Change"];
      const ws = [42, 24, 22, 26, 18, 16, 16, 16]; // = 180mm
      drawRow(hdr, ws, true);
      bests.forEach(b => {
        guard(9);
        drawRow([b.name, `${b.bestLoad}kg`, `${b.b1RM}kg`, `${b.bPow}W`, `${b.rel}×`, `${b.first}kg`, `${b.last}kg`, `+${b.pct}%`], ws, false, [BLK, GRN, BLU, GLD, GLD, GRY, BLK, GRN]);
      });
      y += 4;
    }

    // ── Session history table ──────────────────────────────────────────────────
    if (sessionData.length > 0) {
      secHead("SESSION HISTORY");
      const exNames = exercises.map(e => e.name);
      const exCols = Math.min(exNames.length, 4);
      const ew = Math.floor((CW - 55) / Math.max(exCols, 1));
      const shownEx = exNames.slice(0, exCols);
      const hdr = ["Session", "Date", "Avg RPE", ...shownEx.map(n => n.length > 10 ? n.slice(0, 10) + "…" : n)];
      const ws = [18, 22, 15, ...shownEx.map(() => ew)];
      drawRow(hdr, ws, true);
      sessionData.forEach(s => {
        guard(9);
        drawRow([s.session, s.date || "", s.avgRPE ? s.avgRPE.toFixed(1) : "–", ...shownEx.map(n => s[`load_${n}`] ? `${s[`load_${n}`]}kg` : "–")], ws, false);
      });
      y += 4;
    }

    // ── Charts ────────────────────────────────────────────────────────────────
    if (sessionData.length > 1 && exercises.length > 0) {
      const exNames = exercises.map(e => e.name);
      const exCols_ = exColors; // hex colour per exercise from parent scope

      secHead("PROGRESSION CHARTS");

      // 1. Load progression
      drawChart(sessionData, exNames.map(n => `load_${n}`), exCols_, exNames, "kg", "1. LOAD PROGRESSION");

      // 2. Estimated 1RM progression
      drawChart(sessionData, exNames.map(n => `onerm_${n}`), exCols_, exNames, "kg", "2. ESTIMATED 1RM PROGRESSION");

      // 3. Power progression
      drawChart(sessionData, exNames.map(n => `power_${n}`), exCols_, exNames, "W", "3. POWER PROGRESSION");

      // 4. Reps progression
      drawChart(sessionData, exNames.map(n => `reps_${n}`), exCols_, exNames, " reps", "4. REPS PROGRESSION (MAX REPS PER SESSION)");

      // 5. Injury index progression
      drawChart(sessionData, exNames.map(n => `injury_${n}`), exCols_, exNames, "%", "5. INJURY INDEX (% LOAD INCREASE VS PREVIOUS SESSION)");

      // 6. ACWR
      drawChart(sessionData, exNames.map(n => `acwr_${n}`), exCols_, exNames, "×", "6. ACWR - ACUTE:CHRONIC WORKLOAD RATIO (SWEET SPOT: 0.8-1.3)");

      // 7–10. Training quality indices (one chart per exercise)
      exNames.forEach((n, ni) => {
        drawChart(sessionData, [`hyp_${n}`, `msi_${n}`, `sei_${n}`, `pi_${n}`], ["#10D4A0", "#FF8020", "#5060FF", "#AA44FF"], ["Hyp Index", "Max Str", "Str End", "Power Index"], "", `TRAINING QUALITY INDICES — ${n.toUpperCase()}`);
      });

      // Relative strength (only if BW recorded)
      if (hasBW) {
        drawChart(sessionData, exNames.map(n => `rel_${n}`), exCols_, exNames, "×", "RELATIVE STRENGTH PROGRESSION");
      }

      // Session intensity trend
      drawChart(sessionData, ["avgRPE"], [C.warn], ["Avg RPE"], "", "SESSION INTENSITY TREND (AVG RPE)");
    }

    // ── Trainer's feedback ────────────────────────────────────────────────────
    const fbItems = [{
      k: "strength",
      l: "Strength Progress"
    }, {
      k: "relative",
      l: "Relative Strength"
    }, {
      k: "technique",
      l: "Technique Notes"
    }, {
      k: "fatigue",
      l: "Workload / Fatigue"
    }, {
      k: "focus",
      l: "Next Focus"
    }].filter(({
      k
    }) => fb[k]);
    if (fbItems.length > 0) {
      secHead("TRAINER'S FEEDBACK");
      fbItems.forEach(({
        k,
        l
      }) => {
        guard(20);
        doc.setFontSize(7.5);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(...GRY);
        doc.text(l.toUpperCase(), M, y);
        y += 5;
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(...BLK);
        const lines = doc.splitTextToSize(fb[k], CW);
        lines.forEach(line => {
          guard(6);
          doc.text(line, M, y);
          y += 5;
        });
        y += 4;
      });
    }

    // ── Footer on every page ──────────────────────────────────────────────────
    const pages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFontSize(8);
      doc.setTextColor(...GRY);
      doc.text(`Forge Training · ${client.name}`, M, H - 8);
      doc.text(`${i} / ${pages}`, W - M, H - 8, {
        align: "right"
      });
    }
    return doc;
  };
  const pdfName = () => `${client.name.replace(/\s+/g, "-")}-report.pdf`;

  // ── Email PDF ─────────────────────────────────────────────────────────────
  const handleEmail = async () => {
    try {
      const doc = buildPDF();
      const pdfBlob = doc.output("blob");
      const file = new File([pdfBlob], pdfName(), {
        type: "application/pdf"
      });
      // Try Web Share API (Android Chrome)
      if (navigator.share && navigator.canShare?.({
        files: [file]
      })) {
        await navigator.share({
          title: `Training Report – ${client.name}`,
          files: [file]
        });
      } else {
        // Fallback: download then open email
        const url = URL.createObjectURL(pdfBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = pdfName();
        a.click();
        URL.revokeObjectURL(url);
        if (client.email) {
          setTimeout(() => {
            window.location.href = `mailto:${client.email}?subject=${encodeURIComponent("Training Report – " + program.name)}&body=${encodeURIComponent("Hi " + client.name.split(" ")[0] + ",\n\nPlease find your training report attached.\n\nRegards")}`;
          }, 800);
        }
      }
    } catch (e) {
      console.error("Email PDF error:", e);
    }
  };

  // ── Print / Save PDF ──────────────────────────────────────────────────────
  const handlePrint = () => {
    try {
      buildPDF().save(pdfName());
    } catch (e) {
      console.error("Save PDF error:", e);
    }
  };
  return /*#__PURE__*/React.createElement("div", {
    id: "forge-print-root",
    style: {
      position: "fixed",
      inset: 0,
      zIndex: 200,
      background: "white",
      overflowY: "auto",
      color: "#111827",
      fontFamily: "'Plus Jakarta Sans',system-ui,sans-serif"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "no-print",
    style: {
      position: "sticky",
      top: 0,
      zIndex: 10,
      background: "#f0fdf4",
      borderBottom: "2px solid #bbf7d0",
      padding: "12px 18px",
      display: "flex",
      alignItems: "center",
      gap: 10,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: {
      background: "none",
      border: "1px solid #d1fae5",
      borderRadius: 8,
      padding: "8px 14px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700,
      color: "#166534"
    }
  }, "← Back"), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontSize: 13,
      color: "#166534",
      fontWeight: 600,
      minWidth: 120
    }
  }, "Report preview"), client.email && /*#__PURE__*/React.createElement("button", {
    onClick: handleEmail,
    style: {
      background: "#059669",
      color: "#fff",
      border: "none",
      borderRadius: 8,
      padding: "9px 16px",
      fontSize: 13,
      fontWeight: 700,
      cursor: "pointer",
      whiteSpace: "nowrap"
    }
  }, "✉ Email PDF"), /*#__PURE__*/React.createElement("button", {
    onClick: handlePrint,
    style: {
      background: "#1d4ed8",
      color: "#fff",
      border: "none",
      borderRadius: 8,
      padding: "9px 16px",
      fontSize: 13,
      fontWeight: 700,
      cursor: "pointer",
      whiteSpace: "nowrap"
    }
  }, "🖨 Print / Save PDF")), /*#__PURE__*/React.createElement("div", {
    "data-report-body": "1",
    style: {
      maxWidth: 720,
      margin: "0 auto",
      padding: "32px 24px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
      borderBottom: "2px solid #111827",
      paddingBottom: 20,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      textTransform: "uppercase",
      letterSpacing: 2,
      color: "#9ca3af",
      marginBottom: 4
    }
  }, "Training Report"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 34,
      fontWeight: 700,
      letterSpacing: -0.5
    }
  }, client.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "#6b7280",
      marginTop: 4
    }
  }, program.name, " · ", program.type, " · ", program.category)), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#9ca3af"
    }
  }, "Generated"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 600,
      marginTop: 2
    }
  }, today), client.bw && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#6b7280",
      marginTop: 6
    }
  }, client.bw, " kg BW", client.height ? ` · ${client.height} m` : ""), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "#6b7280",
      marginTop: 2
    }
  }, program.sessions.length, " sessions"))), bests.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, secH("Best lifts summary"), /*#__PURE__*/React.createElement("table", {
    style: {
      width: "100%",
      borderCollapse: "collapse",
      fontSize: 13,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", {
    style: {
      background: "#f9fafb"
    }
  }, ["Exercise", "Best Load", "Est 1RM", "Peak Power", "Rel", "First", "Last", "Change"].map(h => /*#__PURE__*/React.createElement("th", {
    key: h,
    style: {
      padding: "7px 10px",
      fontSize: 10,
      textTransform: "uppercase",
      letterSpacing: 1,
      color: "#6b7280",
      textAlign: "left",
      fontWeight: 700,
      borderBottom: "1px solid #e5e7eb"
    }
  }, h)))), /*#__PURE__*/React.createElement("tbody", null, bests.map((b, i) => /*#__PURE__*/React.createElement("tr", {
    key: b.name,
    style: {
      borderBottom: "1px solid #f3f4f6"
    }
  }, /*#__PURE__*/React.createElement("td", {
    style: {
      padding: "8px 10px",
      fontWeight: 700
    }
  }, b.name), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: "8px 10px",
      fontWeight: 700,
      color: "#059669"
    }
  }, b.bestLoad, " kg"), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: "8px 10px",
      color: "#2563eb"
    }
  }, b.b1RM, " kg"), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: "8px 10px",
      color: "#d97706"
    }
  }, b.bPow, " W"), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: "8px 10px",
      color: "#d97706"
    }
  }, b.rel, "×"), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: "8px 10px",
      color: "#6b7280"
    }
  }, b.first, " kg"), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: "8px 10px"
    }
  }, b.last, " kg"), /*#__PURE__*/React.createElement("td", {
    style: {
      padding: "8px 10px",
      fontWeight: 700,
      color: "#059669"
    }
  }, "+", b.pct, "%")))))), hasSessions && /*#__PURE__*/React.createElement(React.Fragment, null, secH("Load progression"), /*#__PURE__*/React.createElement(SvgChartPrint, {
    data: sessionData,
    keys: exercises.map(e => `load_${e.name}`),
    colors: exColors,
    names: exercises.map(e => e.name),
    unit: "kg"
  }), secH("Estimated 1RM progression"), /*#__PURE__*/React.createElement(SvgChartPrint, {
    data: sessionData,
    keys: exercises.map(e => `onerm_${e.name}`),
    colors: exColors,
    names: exercises.map(e => e.name),
    unit: "kg"
  }), secH("Power progression"), /*#__PURE__*/React.createElement(SvgChartPrint, {
    data: sessionData,
    keys: exercises.map(e => `power_${e.name}`),
    colors: exColors,
    names: exercises.map(e => e.name),
    unit: "W"
  }), secH("Reps progression (max reps per session)"), /*#__PURE__*/React.createElement(SvgChartPrint, {
    data: sessionData,
    keys: exercises.map(e => `reps_${e.name}`),
    colors: exColors,
    names: exercises.map(e => e.name),
    unit: " reps"
  }), secH("Injury index (% load increase vs previous session)"), /*#__PURE__*/React.createElement(SvgChartPrint, {
    data: sessionData,
    keys: exercises.map(e => `injury_${e.name}`),
    colors: exColors,
    names: exercises.map(e => e.name),
    unit: "%"
  }), secH("ACWR — Acute:Chronic Workload Ratio (sweet spot 0.8–1.3)"), /*#__PURE__*/React.createElement(SvgChartPrint, {
    data: sessionData,
    keys: exercises.map(e => `acwr_${e.name}`),
    colors: exColors,
    names: exercises.map(e => e.name),
    unit: "×"
  }), exercises.map((ex, i) => /*#__PURE__*/React.createElement("div", {
    key: ex.name,
    style: {
      marginBottom: 8
    }
  }, secH(`Training quality indices — ${ex.name}`), /*#__PURE__*/React.createElement(SvgChartPrint, {
    data: sessionData,
    keys: [`hyp_${ex.name}`, `msi_${ex.name}`, `sei_${ex.name}`, `pi_${ex.name}`],
    colors: ["#10D4A0", "#FF8020", "#5060FF", "#AA44FF"],
    names: ["Hyp Index", "Max Str", "Str End", "Power Index"],
    unit: ""
  }))), hasBW && /*#__PURE__*/React.createElement(React.Fragment, null, secH("Relative strength progression (est 1RM ÷ BW)"), /*#__PURE__*/React.createElement(SvgChartPrint, {
    data: sessionData,
    keys: exercises.map(e => `rel_${e.name}`),
    colors: exColors,
    names: exercises.map(e => e.name),
    unit: "×"
  })), secH("Session intensity trend (avg RPE)"), /*#__PURE__*/React.createElement(SvgChartPrint, {
    data: sessionData,
    keys: ["avgRPE"],
    colors: ["#FF5060"],
    names: ["Avg RPE"]
  })), ["strength", "relative", "technique", "fatigue", "focus"].some(k => fb[k]) && /*#__PURE__*/React.createElement(React.Fragment, null, secH("Trainer's feedback"), [{
    k: "strength",
    l: "Strength progress"
  }, {
    k: "relative",
    l: "Relative strength"
  }, {
    k: "technique",
    l: "Technique notes"
  }, {
    k: "fatigue",
    l: "Workload / Fatigue"
  }, {
    k: "focus",
    l: "Next focus"
  }].filter(({
    k
  }) => fb[k]).map(({
    k,
    l
  }) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: 1,
      color: "#6b7280",
      marginBottom: 5
    }
  }, l), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      lineHeight: 1.6,
      padding: "10px 12px",
      background: "#f9fafb",
      borderRadius: 8,
      border: "1px solid #f3f4f6"
    }
  }, fb[k])))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 40,
      paddingTop: 14,
      borderTop: "1px solid #f3f4f6",
      display: "flex",
      justifyContent: "space-between",
      fontSize: 11,
      color: "#9ca3af"
    }
  }, /*#__PURE__*/React.createElement("span", null, "Forge Training · ", client.name), /*#__PURE__*/React.createElement("span", null, today))));
}

// ─── Report Tab ───────────────────────────────────────────────────────────────

function ReportTab({
  client,
  program
}) {
  const [fb, setFb] = useState({
    strength: "",
    relative: "",
    technique: "",
    fatigue: "",
    focus: ""
  });
  const updFb = (k, v) => setFb(f => ({
    ...f,
    [k]: v
  }));
  const sessions = program?.sessions || [];
  const exercises = program?.exercises || [];

  // Per-session chart data
  const sessionData = useMemo(() => {
    const rows = sessions.map(s => {
      const row = {
        session: s.id,
        date: s.date
      };
      const allRPE = s.entries.filter(e => e.rpe).map(e => e.rpe);
      if (allRPE.length) row.avgRPE = +(allRPE.reduce((a, b) => a + b, 0) / allRPE.length).toFixed(1);
      exercises.forEach(ex => {
        const ee = s.entries.filter(e => e.ex === ex.name);
        if (!ee.length) return;
        const maxLoad = Math.max(...ee.map(e => e.load));
        const top = ee.find(e => e.load === maxLoad) || ee[0];
        const oneRM = est1RM(maxLoad, top.reps);
        const vel = top.velocity || estVelocity(maxLoad, oneRM);
        row[`load_${ex.name}`] = maxLoad;
        row[`onerm_${ex.name}`] = oneRM;
        row[`power_${ex.name}`] = top.power || calcPower(maxLoad, vel);
        const totalVol = ee.reduce((sum, e) => sum + e.load * e.reps, 0);
        const avgReps = ee.reduce((sum, e) => sum + e.reps, 0) / ee.length;
        // TUT: prefer actual logged tempo per entry, else program-prescribed default
        const prescEx = (program?.exercises || []).find(e => e.name === ex.name);
        const loggedT = ee.filter(e => e.eccSecs || e.conSecs);
        // TUT: for iso sets use holdDuration×reps; else use tempo
        const isoEntries = ee.filter(e => e.holdDuration);
        const avgTUT = isoEntries.length ? isoEntries.reduce((sum, e) => sum + e.holdDuration * e.reps, 0) / isoEntries.length : loggedT.length ? ee.reduce((sum, e) => sum + e.reps * ((e.eccSecs || prescEx?.eccSecs || 2) + (e.conSecs || prescEx?.conSecs || 1)), 0) / ee.length : prescEx?.eccSecs || prescEx?.conSecs ? Math.max(...ee.map(e => e.reps)) * ((prescEx.eccSecs || 2) + (prescEx.conSecs || 1)) : null;
        row[`reps_${ex.name}`] = Math.max(...ee.map(e => e.reps));
        row[`hyp_${ex.name}`] = calcHypIndex(totalVol, oneRM, avgReps, avgTUT);
        row[`msi_${ex.name}`] = calcMSI(maxLoad, oneRM);
        row[`sei_${ex.name}`] = calcSEI(totalVol, oneRM, avgReps);
        row[`pi_${ex.name}`] = calcPowerIndex(top.power || calcPower(maxLoad, vel), oneRM);
        const totalRestSecs = ee.reduce((sum, e) => sum + (e.restApplied || 0), 0);
        const totalWorkSecs = ee.reduce((sum, e) => sum + estSetWorkSecs(e, prescEx), 0);
        row[`density_${ex.name}`] = calcDensity(totalVol, totalWorkSecs + totalRestSecs);
        if (client.bw) row[`rel_${ex.name}`] = +(oneRM / client.bw).toFixed(2);
      });
      return row;
    });
    // Second pass: injury index per exercise
    exercises.forEach(ex => {
      rows.forEach((row, i) => {
        const prevLoad = i > 0 ? rows[i - 1][`load_${ex.name}`] : null;
        row[`injury_${ex.name}`] = injuryIndex(row[`load_${ex.name}`], prevLoad);
      });
    });
    // Third pass: ACWR per exercise
    exercises.forEach(ex => {
      rows.forEach((row, i) => {
        row[`acwr_${ex.name}`] = calcACWR(sessions, ex.name, i);
      });
    });
    return rows;
  }, [sessions, exercises, client.bw]);

  // Best lifts summary
  const bests = useMemo(() => exercises.map(p => {
    const all = sessions.flatMap(s => s.entries.filter(e => e.ex === p.name));
    const bestLoad = all.length ? Math.max(...all.map(e => e.load)) : p.lastLoad || 0;
    const top = all.find(e => e.load === bestLoad) || {
      reps: 9
    };
    const b1RM = est1RM(bestLoad, top.reps);
    const vel = top.velocity || estVelocity(bestLoad, b1RM);
    const bPow = top.power || calcPower(bestLoad, vel);
    const rel = client.bw ? (b1RM / client.bw).toFixed(2) : "–";
    const first = p.firstLoad || (all.length ? Math.min(...all.map(e => e.load)) : 0);
    const pct = first ? Math.round((bestLoad - first) / first * 100) : 0;
    return {
      name: p.name,
      bestLoad,
      b1RM,
      bPow,
      rel,
      first,
      last: bestLoad,
      pct
    };
  }), [exercises, sessions, client.bw]);
  const [showPreview, setShowPreview] = useState(false);
  if (!program) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "48px 24px",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 42,
      marginBottom: 14
    }
  }, "📊"), /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.sub,
      fontSize: 14
    }
  }, "No active program selected."));
  const ta = {
    width: "100%",
    background: C.card2,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: "10px 12px",
    color: C.text,
    fontSize: 13,
    outline: "none",
    resize: "vertical",
    minHeight: 54,
    fontFamily: "inherit",
    boxSizing: "border-box"
  };
  const GH = ({
    cols,
    headers
  }) => /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: cols,
      background: C.card2,
      borderBottom: `1px solid ${C.border}`
    }
  }, headers.map(h => /*#__PURE__*/React.createElement("div", {
    key: h,
    style: {
      fontSize: 10,
      color: C.muted,
      letterSpacing: 1.5,
      textTransform: "uppercase",
      padding: "7px 10px",
      fontWeight: 700
    }
  }, h)));

  // Chart colours per exercise
  const exColors = exercises.map((_, i) => AV_COLS[i % AV_COLS.length]);
  const ChartLegend = () => /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: 10,
      padding: "8px 12px 4px"
    }
  }, exercises.map((ex, i) => /*#__PURE__*/React.createElement("div", {
    key: ex.name,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 5,
      fontSize: 11,
      color: C.sub
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 14,
      height: 3,
      background: exColors[i],
      display: "inline-block",
      borderRadius: 2
    }
  }), ex.name)));
  const ChartCard = ({
    title,
    children
  }) => /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      borderRadius: 14,
      border: `1px solid ${C.border}`,
      overflow: "hidden",
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "12px 14px 4px"
    }
  }, /*#__PURE__*/React.createElement(SecLabel, {
    text: title
  })), children, exercises.length > 1 && /*#__PURE__*/React.createElement(ChartLegend, null));
  const hasSessions = sessionData.length > 1;
  const hasBW = !!client.bw;
  const dateMap = useMemo(() => Object.fromEntries(sessionData.map(d => [d.session, d.date])), [sessionData]);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "16px 14px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card2,
      borderRadius: 16,
      padding: "16px 18px",
      marginBottom: 18,
      border: `1px solid ${C.border}`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      letterSpacing: 2,
      textTransform: "uppercase"
    }
  }, "Client report"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 26,
      letterSpacing: 2.5,
      marginTop: 4
    }
  }, client.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: C.sub,
      marginTop: 2
    }
  }, program.name, " · ", program.type)), /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowPreview(true),
    style: {
      background: C.blue,
      color: "#fff",
      border: "none",
      borderRadius: 10,
      padding: "10px 14px",
      cursor: "pointer",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 3,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 18
    }
  }, "📧"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 0.5
    }
  }, "PDF / EMAIL")))), bests.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(SecLabel, {
    text: "Best lifts"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      borderRadius: 12,
      border: `1px solid ${C.border}`,
      overflow: "hidden",
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement(GH, {
    cols: "1fr 62px 62px 52px 52px",
    headers: ["Exercise", "Best", "Est 1RM", "Power", "Rel"]
  }), bests.map((b, i) => /*#__PURE__*/React.createElement("div", {
    key: b.name,
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 62px 62px 52px 52px",
      borderBottom: i < bests.length - 1 ? `1px solid ${C.border}` : "none",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "10px",
      fontSize: 13,
      fontWeight: 700
    }
  }, b.name), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "8px 10px",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 17,
      color: C.accent
    }
  }, b.bestLoad, "kg"), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "8px 10px",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 17,
      color: C.blue
    }
  }, b.b1RM), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "8px 10px",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 17,
      color: C.gold
    }
  }, b.bPow, "W"), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "10px",
      fontSize: 13,
      color: C.gold
    }
  }, b.rel, "×"))))), hasSessions ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(ChartCard, {
    title: "Load progression"
  }, /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: 200
  }, /*#__PURE__*/React.createElement(LineChart, {
    data: sessionData,
    margin: {
      top: 4,
      right: 14,
      bottom: 4,
      left: 0
    }
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    stroke: C.border,
    strokeDasharray: "3 3"
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "session",
    axisLine: false,
    tickLine: false,
    height: 34,
    tick: props => /*#__PURE__*/React.createElement(SessionXTick, {
      ...props,
      dateMap: dateMap
    })
  }), /*#__PURE__*/React.createElement(YAxis, {
    tick: {
      fill: C.muted,
      fontSize: 11
    },
    axisLine: false,
    tickLine: false,
    width: 34,
    unit: "kg"
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: C.card2,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      color: C.text,
      fontSize: 12
    }
  }), exercises.map((ex, i) => /*#__PURE__*/React.createElement(Line, {
    key: ex.name,
    type: "monotone",
    dataKey: `load_${ex.name}`,
    name: ex.name,
    stroke: exColors[i],
    strokeWidth: 2.5,
    dot: {
      fill: exColors[i],
      r: 3,
      strokeWidth: 0
    },
    connectNulls: true
  }))))), /*#__PURE__*/React.createElement(ChartCard, {
    title: "Estimated 1RM progression"
  }, /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: 200
  }, /*#__PURE__*/React.createElement(LineChart, {
    data: sessionData,
    margin: {
      top: 4,
      right: 14,
      bottom: 4,
      left: 0
    }
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    stroke: C.border,
    strokeDasharray: "3 3"
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "session",
    axisLine: false,
    tickLine: false,
    height: 34,
    tick: props => /*#__PURE__*/React.createElement(SessionXTick, {
      ...props,
      dateMap: dateMap
    })
  }), /*#__PURE__*/React.createElement(YAxis, {
    tick: {
      fill: C.muted,
      fontSize: 11
    },
    axisLine: false,
    tickLine: false,
    width: 34,
    unit: "kg"
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: C.card2,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      color: C.text,
      fontSize: 12
    }
  }), exercises.map((ex, i) => /*#__PURE__*/React.createElement(Line, {
    key: ex.name,
    type: "monotone",
    dataKey: `onerm_${ex.name}`,
    name: ex.name,
    stroke: exColors[i],
    strokeWidth: 2.5,
    strokeDasharray: "5 3",
    dot: {
      fill: exColors[i],
      r: 3,
      strokeWidth: 0
    },
    connectNulls: true
  }))))), /*#__PURE__*/React.createElement(ChartCard, {
    title: "Power progression (W)"
  }, /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: 200
  }, /*#__PURE__*/React.createElement(LineChart, {
    data: sessionData,
    margin: {
      top: 4,
      right: 14,
      bottom: 4,
      left: 0
    }
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    stroke: C.border,
    strokeDasharray: "3 3"
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "session",
    axisLine: false,
    tickLine: false,
    height: 34,
    tick: props => /*#__PURE__*/React.createElement(SessionXTick, {
      ...props,
      dateMap: dateMap
    })
  }), /*#__PURE__*/React.createElement(YAxis, {
    tick: {
      fill: C.muted,
      fontSize: 11
    },
    axisLine: false,
    tickLine: false,
    width: 42,
    unit: "W"
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: C.card2,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      color: C.text,
      fontSize: 12
    }
  }), exercises.map((ex, i) => /*#__PURE__*/React.createElement(Line, {
    key: ex.name,
    type: "monotone",
    dataKey: `power_${ex.name}`,
    name: ex.name,
    stroke: exColors[i],
    strokeWidth: 2.5,
    dot: {
      fill: exColors[i],
      r: 3,
      strokeWidth: 0
    },
    connectNulls: true
  }))))), /*#__PURE__*/React.createElement(ChartCard, {
    title: "Reps progression (max reps per session)"
  }, /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: 200
  }, /*#__PURE__*/React.createElement(LineChart, {
    data: sessionData,
    margin: {
      top: 4,
      right: 14,
      bottom: 4,
      left: 0
    }
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    stroke: C.border,
    strokeDasharray: "3 3"
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "session",
    axisLine: false,
    tickLine: false,
    height: 34,
    tick: props => /*#__PURE__*/React.createElement(SessionXTick, {
      ...props,
      dateMap: dateMap
    })
  }), /*#__PURE__*/React.createElement(YAxis, {
    tick: {
      fill: C.muted,
      fontSize: 11
    },
    axisLine: false,
    tickLine: false,
    width: 34,
    unit: " reps"
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: C.card2,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      color: C.text,
      fontSize: 12
    }
  }), exercises.map((ex, i) => /*#__PURE__*/React.createElement(Line, {
    key: ex.name,
    type: "monotone",
    dataKey: `reps_${ex.name}`,
    name: ex.name,
    stroke: exColors[i],
    strokeWidth: 2.5,
    strokeDasharray: "4 2",
    dot: {
      fill: exColors[i],
      r: 3,
      strokeWidth: 0
    },
    connectNulls: true
  }))))), /*#__PURE__*/React.createElement(ChartCard, {
    title: "Injury index (% load increase vs previous session)"
  }, /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: 200
  }, /*#__PURE__*/React.createElement(LineChart, {
    data: sessionData,
    margin: {
      top: 4,
      right: 14,
      bottom: 4,
      left: 0
    }
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    stroke: C.border,
    strokeDasharray: "3 3"
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "session",
    axisLine: false,
    tickLine: false,
    height: 34,
    tick: props => /*#__PURE__*/React.createElement(SessionXTick, {
      ...props,
      dateMap: dateMap
    })
  }), /*#__PURE__*/React.createElement(YAxis, {
    tick: {
      fill: C.muted,
      fontSize: 11
    },
    axisLine: false,
    tickLine: false,
    width: 34,
    unit: "%"
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: C.card2,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      color: C.text,
      fontSize: 12
    }
  }), /*#__PURE__*/React.createElement(ReferenceLine, {
    y: 10,
    stroke: C.warn,
    strokeDasharray: "4 3",
    strokeOpacity: 0.6,
    label: {
      value: "High risk >10%",
      position: "insideTopRight",
      fill: C.warn,
      fontSize: 10
    }
  }), exercises.map((ex, i) => /*#__PURE__*/React.createElement(Line, {
    key: ex.name,
    type: "monotone",
    dataKey: `injury_${ex.name}`,
    name: ex.name,
    stroke: exColors[i],
    strokeWidth: 2.5,
    dot: {
      fill: exColors[i],
      r: 3,
      strokeWidth: 0
    },
    connectNulls: true
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 14px 12px",
      fontSize: 11,
      color: C.sub,
      lineHeight: 1.5
    }
  }, "Steeper upward slopes indicate larger week-to-week load jumps and higher injury risk. Values above the dashed 10% line warrant caution.")), /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      borderRadius: 14,
      border: `1px solid ${C.border}`,
      overflow: "hidden",
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "12px 14px 4px"
    }
  }, /*#__PURE__*/React.createElement(SecLabel, {
    text: "ACWR — Acute:Chronic Workload Ratio"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub,
      marginBottom: 6,
      lineHeight: 1.5
    }
  }, "Acute (last session volume) ÷ Chronic (avg of previous 4 sessions). Sweet spot: ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#10D4A0",
      fontWeight: 700
    }
  }, "0.8–1.3"), " · Caution: ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#FFB020",
      fontWeight: 700
    }
  }, "1.3–1.5"), " · High risk: ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.warn,
      fontWeight: 700
    }
  }, ">1.5"))), /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: 210
  }, /*#__PURE__*/React.createElement(LineChart, {
    data: sessionData,
    margin: {
      top: 4,
      right: 14,
      bottom: 4,
      left: 0
    }
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    stroke: C.border,
    strokeDasharray: "3 3"
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "session",
    axisLine: false,
    tickLine: false,
    height: 34,
    tick: props => /*#__PURE__*/React.createElement(SessionXTick, {
      ...props,
      dateMap: dateMap
    })
  }), /*#__PURE__*/React.createElement(YAxis, {
    tick: {
      fill: C.muted,
      fontSize: 11
    },
    axisLine: false,
    tickLine: false,
    width: 34,
    unit: "×",
    domain: [0, "auto"]
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: C.card2,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      color: C.text,
      fontSize: 12
    }
  }), /*#__PURE__*/React.createElement(ReferenceLine, {
    y: 0.8,
    stroke: C.blue,
    strokeDasharray: "4 3",
    strokeOpacity: 0.5,
    label: {
      value: "0.8 Low",
      position: "insideBottomRight",
      fill: C.blue,
      fontSize: 9
    }
  }), /*#__PURE__*/React.createElement(ReferenceLine, {
    y: 1.3,
    stroke: "#FFB020",
    strokeDasharray: "4 3",
    strokeOpacity: 0.5,
    label: {
      value: "1.3 Caution",
      position: "insideTopRight",
      fill: "#FFB020",
      fontSize: 9
    }
  }), /*#__PURE__*/React.createElement(ReferenceLine, {
    y: 1.5,
    stroke: C.warn,
    strokeDasharray: "4 3",
    strokeOpacity: 0.5,
    label: {
      value: "1.5 High risk",
      position: "insideTopRight",
      fill: C.warn,
      fontSize: 9
    }
  }), exercises.map((ex, i) => /*#__PURE__*/React.createElement(Line, {
    key: ex.name,
    type: "monotone",
    dataKey: `acwr_${ex.name}`,
    name: ex.name,
    stroke: exColors[i],
    strokeWidth: 2.5,
    dot: {
      fill: exColors[i],
      r: 3,
      strokeWidth: 0
    },
    connectNulls: true
  })))), exercises.length > 1 && /*#__PURE__*/React.createElement(ChartLegend, null)), /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      borderRadius: 14,
      border: `1px solid ${C.border}`,
      overflow: "hidden",
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "12px 14px 4px"
    }
  }, /*#__PURE__*/React.createElement(SecLabel, {
    text: "Training quality indices (0–100 scale)"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub,
      marginBottom: 6,
      lineHeight: 1.5
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#10D4A0",
      fontWeight: 700
    }
  }, "Hyp"), "=Hypertrophy · ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#FF8020",
      fontWeight: 700
    }
  }, "Max Str"), "=Max Strength · ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#5060FF",
      fontWeight: 700
    }
  }, "Str End"), "=Strength Endurance · ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#AA44FF",
      fontWeight: 700
    }
  }, "Power"), "=Power Index")), exercises.map((ex, i) => /*#__PURE__*/React.createElement("div", {
    key: ex.name,
    style: {
      padding: "0 14px 12px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub,
      fontWeight: 700,
      marginBottom: 4
    }
  }, ex.name), /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: 160
  }, /*#__PURE__*/React.createElement(LineChart, {
    data: sessionData,
    margin: {
      top: 4,
      right: 14,
      bottom: 4,
      left: 0
    }
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    stroke: C.border,
    strokeDasharray: "3 3"
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "session",
    axisLine: false,
    tickLine: false,
    height: 34,
    tick: props => /*#__PURE__*/React.createElement(SessionXTick, {
      ...props,
      dateMap: dateMap
    })
  }), /*#__PURE__*/React.createElement(YAxis, {
    domain: [0, 100],
    tick: {
      fill: C.muted,
      fontSize: 10
    },
    axisLine: false,
    tickLine: false,
    width: 28
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: C.card2,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      color: C.text,
      fontSize: 11
    }
  }), /*#__PURE__*/React.createElement(Line, {
    type: "monotone",
    dataKey: `hyp_${ex.name}`,
    name: "Hyp Index",
    stroke: "#10D4A0",
    strokeWidth: 2,
    dot: {
      fill: "#10D4A0",
      r: 3,
      strokeWidth: 0
    },
    connectNulls: true
  }), /*#__PURE__*/React.createElement(Line, {
    type: "monotone",
    dataKey: `msi_${ex.name}`,
    name: "Max Str",
    stroke: "#FF8020",
    strokeWidth: 2,
    dot: {
      fill: "#FF8020",
      r: 3,
      strokeWidth: 0
    },
    connectNulls: true
  }), /*#__PURE__*/React.createElement(Line, {
    type: "monotone",
    dataKey: `sei_${ex.name}`,
    name: "Str End",
    stroke: "#5060FF",
    strokeWidth: 2,
    dot: {
      fill: "#5060FF",
      r: 3,
      strokeWidth: 0
    },
    connectNulls: true
  }), /*#__PURE__*/React.createElement(Line, {
    type: "monotone",
    dataKey: `pi_${ex.name}`,
    name: "Power Index",
    stroke: "#AA44FF",
    strokeWidth: 2,
    dot: {
      fill: "#AA44FF",
      r: 3,
      strokeWidth: 0
    },
    connectNulls: true
  }))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 14,
      flexWrap: "wrap",
      padding: "0 14px 12px"
    }
  }, [["Hyp Index", "#10D4A0"], ["Max Str", "#FF8020"], ["Str End", "#5060FF"], ["Power Index", "#AA44FF"]].map(([l, c]) => /*#__PURE__*/React.createElement("div", {
    key: l,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 5,
      fontSize: 11,
      color: C.sub
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 14,
      height: 3,
      background: c,
      display: "inline-block",
      borderRadius: 2
    }
  }), l)))), hasBW && /*#__PURE__*/React.createElement(ChartCard, {
    title: "Relative strength progression (est 1RM ÷ BW)"
  }, /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: 200
  }, /*#__PURE__*/React.createElement(LineChart, {
    data: sessionData,
    margin: {
      top: 4,
      right: 14,
      bottom: 4,
      left: 0
    }
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    stroke: C.border,
    strokeDasharray: "3 3"
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "session",
    axisLine: false,
    tickLine: false,
    height: 34,
    tick: props => /*#__PURE__*/React.createElement(SessionXTick, {
      ...props,
      dateMap: dateMap
    })
  }), /*#__PURE__*/React.createElement(YAxis, {
    tick: {
      fill: C.muted,
      fontSize: 11
    },
    axisLine: false,
    tickLine: false,
    width: 34,
    unit: "×"
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: C.card2,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      color: C.text,
      fontSize: 12
    },
    formatter: (v, name) => [`${v}×`, name]
  }), exercises.map((ex, i) => /*#__PURE__*/React.createElement(Line, {
    key: ex.name,
    type: "monotone",
    dataKey: `rel_${ex.name}`,
    name: ex.name,
    stroke: exColors[i],
    strokeWidth: 2.5,
    dot: {
      fill: exColors[i],
      r: 3,
      strokeWidth: 0
    },
    connectNulls: true
  }))))), /*#__PURE__*/React.createElement(ChartCard, {
    title: "Training density (volume ÷ total time, kg/min)"
  }, /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: 200
  }, /*#__PURE__*/React.createElement(LineChart, {
    data: sessionData,
    margin: {
      top: 4,
      right: 14,
      bottom: 4,
      left: 0
    }
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    stroke: C.border,
    strokeDasharray: "3 3"
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "session",
    axisLine: false,
    tickLine: false,
    height: 34,
    tick: props => /*#__PURE__*/React.createElement(SessionXTick, {
      ...props,
      dateMap: dateMap
    })
  }), /*#__PURE__*/React.createElement(YAxis, {
    tick: {
      fill: C.muted,
      fontSize: 11
    },
    axisLine: false,
    tickLine: false,
    width: 34
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: C.card2,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      color: C.text,
      fontSize: 12
    },
    formatter: (v, name) => [`${v} kg/min`, name]
  }), exercises.map((ex, i) => /*#__PURE__*/React.createElement(Line, {
    key: ex.name,
    type: "monotone",
    dataKey: `density_${ex.name}`,
    name: ex.name,
    stroke: exColors[i],
    strokeWidth: 2.5,
    dot: {
      fill: exColors[i],
      r: 3,
      strokeWidth: 0
    },
    connectNulls: true
  })))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 14px 12px",
      fontSize: 11,
      color: C.muted,
      lineHeight: 1.5
    }
  }, "Volume moved per minute of total session time (work + rest). Shorter rest at equal volume raises density — a genuinely different training stimulus even when load and reps stay the same.")), /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      borderRadius: 14,
      border: `1px solid ${C.border}`,
      overflow: "hidden",
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "12px 14px 4px"
    }
  }, /*#__PURE__*/React.createElement(SecLabel, {
    text: "Session intensity trend (avg RPE)"
  })), /*#__PURE__*/React.createElement(ResponsiveContainer, {
    width: "100%",
    height: 180
  }, /*#__PURE__*/React.createElement(LineChart, {
    data: sessionData,
    margin: {
      top: 4,
      right: 14,
      bottom: 4,
      left: 0
    }
  }, /*#__PURE__*/React.createElement(CartesianGrid, {
    stroke: C.border,
    strokeDasharray: "3 3"
  }), /*#__PURE__*/React.createElement(XAxis, {
    dataKey: "session",
    axisLine: false,
    tickLine: false,
    height: 34,
    tick: props => /*#__PURE__*/React.createElement(SessionXTick, {
      ...props,
      dateMap: dateMap
    })
  }), /*#__PURE__*/React.createElement(YAxis, {
    domain: [4, 10],
    tick: {
      fill: C.muted,
      fontSize: 11
    },
    axisLine: false,
    tickLine: false,
    width: 28
  }), /*#__PURE__*/React.createElement(Tooltip, {
    contentStyle: {
      background: C.card2,
      border: `1px solid ${C.border}`,
      borderRadius: 8,
      color: C.text,
      fontSize: 12
    }
  }), /*#__PURE__*/React.createElement(Line, {
    type: "monotone",
    dataKey: "avgRPE",
    name: "Avg RPE",
    stroke: C.warn,
    strokeWidth: 2.5,
    dot: {
      fill: C.warn,
      r: 4,
      strokeWidth: 0
    },
    connectNulls: true
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 5,
      padding: "4px 14px 10px",
      fontSize: 11,
      color: C.sub
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 14,
      height: 3,
      background: C.warn,
      display: "inline-block",
      borderRadius: 2
    }
  }), "Average RPE per session"))) : sessions.length <= 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      borderRadius: 12,
      border: `1px solid ${C.border}`,
      padding: "20px",
      textAlign: "center",
      marginBottom: 16,
      color: C.sub,
      fontSize: 13
    }
  }, "Log at least 2 sessions to see progression charts."), /*#__PURE__*/React.createElement(SecLabel, {
    text: "Trainer's feedback"
  }), [{
    k: "strength",
    l: "Strength progress"
  }, {
    k: "relative",
    l: "Relative strength"
  }, {
    k: "technique",
    l: "Technique notes"
  }, {
    k: "fatigue",
    l: "Workload / Fatigue"
  }, {
    k: "focus",
    l: "Next focus"
  }].map(({
    k,
    l
  }) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: C.sub,
      fontWeight: 600,
      marginBottom: 4
    }
  }, l), /*#__PURE__*/React.createElement("textarea", {
    value: fb[k],
    onChange: e => updFb(k, e.target.value),
    placeholder: `${l}...`,
    style: ta
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 24
    }
  }), showPreview && /*#__PURE__*/React.createElement(PrintPreview, {
    client: client,
    program: program,
    bests: bests,
    sessionData: sessionData,
    fb: fb,
    hasBW: hasBW,
    exColors: exColors,
    onClose: () => setShowPreview(false)
  }));
}

// ─── App Shell ────────────────────────────────────────────────────────────────

const TABS = [{
  id: "programs",
  icon: "📋",
  label: "Programs"
}, {
  id: "log",
  icon: "✏️",
  label: "Log"
}, {
  id: "progress",
  icon: "📈",
  label: "Progress"
}, {
  id: "report",
  icon: "📊",
  label: "Report"
}, {
  id: "calendar",
  icon: "📅",
  label: "Calendar"
}];
function App() {
  const [clients, setClients] = useState(() => lsGet('forge_clients', INIT_CLIENTS));
  const [activeClientId, setActiveClientId] = useState(() => lsGet('forge_activeClient', 'c1'));
  const [tab, setTab] = useState("programs");
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showAddClient, setShowAddClient] = useState(false);
  const [showDataSync, setShowDataSync] = useState(false);
  const [editClientTarget, setEditClientTarget] = useState(null);
  const [customExercises, setCustomExercises] = useState(() => migrateList('forge_customEx', EX_LIST));
  const [customEquipment, setCustomEquipment] = useState(() => migrateList('forge_customEquip', EQUIP_LIST));
  const [customLaterality, setCustomLaterality] = useState(() => migrateList('forge_customLat', LAT_LIST));
  const [customCategories, setCustomCategories] = useState(() => lsGet('forge_customCats', []));
  const [customProgTypes, setCustomProgTypes] = useState(() => lsGet('forge_customPT', []));
  const [customSetTypes, setCustomSetTypes] = useState(() => lsGet('forge_customST', []));
  const exList = customExercises;
  const equipList = customEquipment;
  const latList = customLaterality;
  const categoryList = useMemo(() => [...CATEGORIES, ...customCategories], [customCategories]);
  const progTypeList = useMemo(() => [...PROG_TYPES, ...customProgTypes], [customProgTypes]);
  const setTypeList = useMemo(() => [...SET_TYPES, ...customSetTypes], [customSetTypes]);
  const onAddEx = name => setCustomExercises(l => [...l, name]);
  const onAddEquip = name => setCustomEquipment(l => [...l, name]);
  const onAddLat = name => setCustomLaterality(l => [...l, name]);
  const onAddCategory = name => setCustomCategories(l => [...l, name]);
  const onAddProgType = name => setCustomProgTypes(l => [...l, name]);
  const onAddSetType = name => setCustomSetTypes(l => [...l, name]);

  // Edit/delete custom list items
  const onEditEx = (o, n) => setCustomExercises(l => l.map(x => x === o ? n : x));
  const onDeleteEx = v => setCustomExercises(l => l.filter(x => x !== v));
  const onEditEquip = (o, n) => setCustomEquipment(l => l.map(x => x === o ? n : x));
  const onDeleteEquip = v => setCustomEquipment(l => l.filter(x => x !== v));
  const onEditLat = (o, n) => setCustomLaterality(l => l.map(x => x === o ? n : x));
  const onDeleteLat = v => setCustomLaterality(l => l.filter(x => x !== v));

  // Delete program
  const deleteProgram = pid => {
    updClient(activeClientId, c => ({
      ...c,
      programs: c.programs.filter(p => p.id !== pid),
      activeProgramId: c.activeProgramId === pid ? c.programs.find(p => p.id !== pid)?.id || null : c.activeProgramId
    }));
  };
  useEffect(() => {
    try {
      localStorage.setItem('forge_clients', JSON.stringify(clients));
    } catch {}
  }, [clients]);
  useEffect(() => {
    try {
      localStorage.setItem('forge_activeClient', JSON.stringify(activeClientId));
    } catch {}
  }, [activeClientId]);
  useEffect(() => {
    try {
      localStorage.setItem('forge_customEx', JSON.stringify(customExercises));
    } catch {}
  }, [customExercises]);
  useEffect(() => {
    try {
      localStorage.setItem('forge_customEquip', JSON.stringify(customEquipment));
    } catch {}
  }, [customEquipment]);
  useEffect(() => {
    try {
      localStorage.setItem('forge_customLat', JSON.stringify(customLaterality));
    } catch {}
  }, [customLaterality]);
  useEffect(() => {
    try {
      localStorage.setItem('forge_customCats', JSON.stringify(customCategories));
    } catch {}
  }, [customCategories]);
  useEffect(() => {
    try {
      localStorage.setItem('forge_customPT', JSON.stringify(customProgTypes));
    } catch {}
  }, [customProgTypes]);
  useEffect(() => {
    try {
      localStorage.setItem('forge_customST', JSON.stringify(customSetTypes));
    } catch {}
  }, [customSetTypes]);
  const clientIdx = clients.findIndex(c => c.id === activeClientId);
  const activeClient = clients[clientIdx];
  const activeProgram = activeClient?.programs.find(p => p.id === activeClient.activeProgramId) || null;
  const updClient = (id, fn) => setClients(cs => cs.map(c => c.id === id ? fn(c) : c));
  const switchClient = id => {
    setActiveClientId(id);
    setTab("programs");
  };
  const addClient = ({
    name,
    bw,
    height,
    email
  }) => {
    const id = `c${Date.now()}`;
    setClients(cs => [...cs, {
      id,
      name,
      bw,
      height,
      email,
      archived: false,
      programs: [],
      activeProgramId: null
    }]);
    switchClient(id);
  };
  const archiveClient = id => updClient(id, c => ({
    ...c,
    archived: true
  }));
  const reinstateClient = id => updClient(id, c => ({
    ...c,
    archived: false
  }));
  const editClientProfile = updated => updClient(updated.id, () => updated);
  const importData = data => {
    if (data.clients) setClients(data.clients);
    if (data.customData) {
      if (data.customData.exercises) setCustomExercises(data.customData.exercises);
      if (data.customData.equipment) setCustomEquipment(data.customData.equipment);
      if (data.customData.laterality) setCustomLaterality(data.customData.laterality);
      if (data.customData.categories) setCustomCategories(data.customData.categories);
      if (data.customData.progTypes) setCustomProgTypes(data.customData.progTypes);
      if (data.customData.setTypes) setCustomSetTypes(data.customData.setTypes);
    }
  };
  const setActiveProgram = pid => updClient(activeClientId, c => ({
    ...c,
    activeProgramId: pid
  }));
  const addProgram = prog => {
    const id = `p${Date.now()}`;
    updClient(activeClientId, c => ({
      ...c,
      programs: [...c.programs, {
        ...prog,
        id
      }],
      activeProgramId: c.activeProgramId || id
    }));
  };
  const deleteSession = (programId, sessionId) => {
    updClient(activeClientId, c => ({
      ...c,
      programs: c.programs.map(p => {
        if (p.id !== programId) return p;
        return {
          ...p,
          sessions: p.sessions.filter(s => s.id !== sessionId)
        };
      })
    }));
  };
  const editProgram = updated => {
    updClient(activeClientId, c => ({
      ...c,
      programs: c.programs.map(p => p.id === updated.id ? updated : p)
    }));
  };
  const addEntry = ({
    ex,
    reps,
    setNo,
    type,
    load,
    rawLoad,
    rir,
    rpe,
    velocity,
    power,
    repTime,
    eccSecs,
    conSecs,
    holdDuration,
    mvic,
    force,
    bandLength,
    bandStrength,
    bandUsage,
    bandLoadKg,
    comment,
    clusterReps,
    clusterCount,
    clusterRest,
    restApplied,
    equipUsed,
    latUsed,
    date
  }) => {
    if (!activeProgram) return;
    const entry = {
      ex,
      reps,
      set: setNo,
      type,
      load,
      rawLoad,
      rir,
      rpe,
      velocity,
      power,
      repTime,
      eccSecs,
      conSecs,
      holdDuration,
      mvic,
      force,
      bandLength,
      bandStrength,
      bandUsage,
      bandLoadKg,
      comment,
      clusterReps,
      clusterCount,
      clusterRest,
      restApplied,
      equipUsed,
      latUsed
    };
    updClient(activeClientId, c => ({
      ...c,
      programs: c.programs.map(p => {
        if (p.id !== c.activeProgramId) return p;
        const last = p.sessions[p.sessions.length - 1];
        const newSessions = last && last.date === date ? p.sessions.map((s, i) => i === p.sessions.length - 1 ? {
          ...s,
          entries: [...s.entries, entry]
        } : s) : [...p.sessions, {
          id: `S${p.sessions.length + 1}`,
          date,
          entries: [entry]
        }];
        const newEx = p.exercises.map(e => e.name === ex ? {
          ...e,
          lastLoad: load
        } : e);
        return {
          ...p,
          sessions: newSessions,
          exercises: newEx
        };
      })
    }));
  };
  const screenW = useWindowWidth();
  const isTablet = screenW >= 640;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.bg,
      color: C.text,
      height: "100dvh",
      width: "100%",
      maxWidth: isTablet ? "100%" : 520,
      margin: "0 auto",
      fontFamily: "'Plus Jakarta Sans',system-ui,sans-serif",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      padding: "12px 16px",
      borderBottom: `1px solid ${C.border}`,
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      position: "sticky",
      top: 0,
      zIndex: 50
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "baseline",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 20,
      letterSpacing: 4,
      color: C.accent
    }
  }, "FORGE TRAINING"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: C.muted,
      fontWeight: 700,
      letterSpacing: 1
    }
  }, "v58.0.1")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowDataSync(true),
    style: {
      background: "none",
      border: "none",
      color: C.muted,
      cursor: "pointer",
      fontSize: 18,
      padding: "2px 4px"
    },
    title: "Data & Sync"
  }, "⚙️")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowSwitcher(true),
    style: {
      background: C.card2,
      border: `1px solid ${C.border}`,
      borderRadius: 22,
      padding: "7px 12px 7px 8px",
      color: C.text,
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 13,
      fontWeight: 700
    }
  }, activeClient && /*#__PURE__*/React.createElement(Avatar, {
    name: activeClient.name,
    idx: clientIdx,
    size: 24
  }), /*#__PURE__*/React.createElement("span", null, activeClient?.name.split(" ")[0]), /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.muted,
      fontSize: 11
    }
  }, "▾"))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: "auto",
      paddingBottom: 70
    }
  }, tab === "programs" && activeClient && /*#__PURE__*/React.createElement(ProgramsTab, {
    client: activeClient,
    clientIdx: clientIdx,
    activeProgramId: activeClient.activeProgramId,
    onSetActive: setActiveProgram,
    onAddProgram: addProgram,
    onEditProgram: editProgram,
    onDeleteProgram: deleteProgram,
    exList: exList,
    equipList: equipList,
    latList: latList,
    categoryList: categoryList,
    progTypeList: progTypeList,
    onAddEx: onAddEx,
    onAddEquip: onAddEquip,
    onAddLat: onAddLat,
    onAddCategory: onAddCategory,
    onAddProgType: onAddProgType,
    customExercises: customExercises,
    onEditEx: onEditEx,
    onDeleteEx: onDeleteEx,
    customEquipment: customEquipment,
    onEditEquip: onEditEquip,
    onDeleteEquip: onDeleteEquip,
    customLaterality: customLaterality,
    onEditLat: onEditLat,
    onDeleteLat: onDeleteLat
  }), tab === "log" && /*#__PURE__*/React.createElement(LogTab, {
    program: activeProgram,
    onAddEntry: addEntry,
    exList: exList,
    onAddEx: onAddEx,
    setTypeList: setTypeList,
    onAddSetType: onAddSetType,
    clientBW: activeClient?.bw,
    equipList: equipList,
    latList: latList,
    onUpdateExercise: (exName, fields) => {
      if (!activeProgram) return;
      editProgram({
        ...activeProgram,
        exercises: activeProgram.exercises.map(e => e.name === exName ? {
          ...e,
          ...fields
        } : e)
      });
    }
  }), tab === "progress" && /*#__PURE__*/React.createElement(ProgressTab, {
    program: activeProgram
  }), tab === "report" && activeClient && /*#__PURE__*/React.createElement(ReportTab, {
    client: activeClient,
    program: activeProgram
  }), tab === "calendar" && /*#__PURE__*/React.createElement(CalendarTab, {
    client: activeClient,
    onDeleteSession: deleteSession
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      borderTop: `1px solid ${C.border}`,
      display: "flex",
      position: "sticky",
      bottom: 0,
      zIndex: 50
    }
  }, TABS.map(t => /*#__PURE__*/React.createElement("button", {
    key: t.id,
    onClick: () => setTab(t.id),
    style: {
      flex: 1,
      border: "none",
      background: "transparent",
      padding: "8px 0 5px",
      cursor: "pointer",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 2
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 20
    }
  }, t.icon), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      fontWeight: 700,
      color: tab === t.id ? C.accent : C.muted,
      letterSpacing: 0.5
    }
  }, t.label.toUpperCase()), tab === t.id && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 22,
      height: 2.5,
      background: C.accent,
      borderRadius: 2
    }
  })))), showSwitcher && !showAddClient && /*#__PURE__*/React.createElement(ClientSwitcher, {
    clients: clients,
    activeId: activeClientId,
    onSwitch: switchClient,
    onClose: () => setShowSwitcher(false),
    onAddClient: () => {
      setShowSwitcher(false);
      setShowAddClient(true);
    },
    onArchive: id => {
      archiveClient(id);
      if (id === activeClientId) {
        const first = clients.find(c => !c.archived && c.id !== id);
        if (first) switchClient(first.id);
      }
    },
    onReinstate: reinstateClient,
    onEditClient: c => {
      setEditClientTarget(c);
      setShowSwitcher(false);
    }
  }), showAddClient && /*#__PURE__*/React.createElement(AddClientModal, {
    onAdd: c => {
      addClient(c);
      setShowAddClient(false);
    },
    onClose: () => setShowAddClient(false)
  }), editClientTarget && /*#__PURE__*/React.createElement(EditClientModal, {
    client: editClientTarget,
    onSave: editClientProfile,
    onClose: () => setEditClientTarget(null)
  }), showDataSync && /*#__PURE__*/React.createElement(DataSyncSheet, {
    clients: clients,
    customData: {
      exercises: customExercises,
      equipment: customEquipment,
      laterality: customLaterality,
      categories: customCategories,
      progTypes: customProgTypes,
      setTypes: customSetTypes
    },
    onImport: importData,
    onClose: () => setShowDataSync(false)
  }));
}
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
