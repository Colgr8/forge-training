function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function sessGet(key, fallback) {
  try {
    const v = sessionStorage.getItem(key);
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

// For a Drop Set entry, e.reps is the COMBINED total across the main set AND
// every drop — pairing that with e.load (the main set's load) would badly
// inflate any 1RM/RPE-based estimate, since those reps were NOT all performed
// at that load. effReps() returns the reps ACTUALLY performed at e.load (the
// main set's own reps for Drop Sets and Ascending Sets, e.reps unchanged for
// everything else) — use this instead of e.reps anywhere a load+reps pair
// feeds a 1RM, velocity, power, or average-reps calculation.
const effReps = e => {
  if (e.dropSetMainReps != null && e.dropSetMainReps > 0) return e.dropSetMainReps;
  if (e.ascSetMainReps != null && e.ascSetMainReps > 0) return e.ascSetMainReps;
  if (e.pyrMainReps != null && e.pyrMainReps > 0) return e.pyrMainReps;
  return e.reps;
};

// Total volume load (Σ load×reps) for a single entry, correctly accounting
// for multiple different loads within one set — main/starting load × its own
// reps, PLUS each further stage's own load × its own reps — rather than
// naively multiplying the full combined rep count by just one load, which
// would misstate volume by attributing every rep to a single weight.
const effVolume = e => {
  if (e.dropSetLoads?.length) {
    const mainVol = e.load * effReps(e);
    const dropVol = e.dropSetLoads.reduce((s, l, i) => s + l * (+e.dropSetReps?.[i] || 0), 0);
    return mainVol + dropVol;
  }
  if (e.ascSetLoads?.length) {
    const mainVol = e.load * effReps(e);
    const upVol = e.ascSetLoads.reduce((s, l, i) => s + l * (+e.ascSetReps?.[i] || 0), 0);
    return mainVol + upVol;
  }
  if (e.pyrLoads?.length) {
    const mainVol = e.load * effReps(e);
    const stageVol = e.pyrLoads.reduce((s, l, i) => s + l * (+e.pyrReps?.[i] || 0), 0);
    return mainVol + stageVol;
  }
  return e.load * e.reps;
};

// For 1RM estimation specifically: a Drop Set's stored e.load is already its
// HEAVIEST stage (the top/main set), so effReps() paired with e.load is the
// right basis. An Ascending Set is the opposite — e.load is its LIGHTEST
// (starting) stage; the true peak effort is whichever "Up" stage was
// heaviest, stored separately in ascSetLoads/ascSetReps. A Pyramid Set's
// peak is likewise NOT its last stage (that's a descending/drop stage) — the
// peak is specifically the LAST ascending stage, at index pyrUpCount-1.
// effPeakLoad/effPeakReps return the load+reps pair that best represents an
// entry's actual peak effort, for anywhere a "best/heaviest set" 1RM is
// estimated.
const effPeakLoad = e => {
  if (e.ascSetLoads?.length) return e.ascSetLoads[e.ascSetLoads.length - 1];
  if (e.pyrLoads?.length && e.pyrUpCount > 0) return e.pyrLoads[e.pyrUpCount - 1];
  return e.load;
};
const effPeakReps = e => {
  if (e.ascSetLoads?.length) return +e.ascSetReps?.[e.ascSetReps.length - 1] || 0;
  if (e.pyrLoads?.length && e.pyrUpCount > 0) return +e.pyrReps?.[e.pyrUpCount - 1] || 0;
  return effReps(e);
};

// Manually-built date string (e.g. "11 Aug 2026") — deliberately NOT using
// toLocaleDateString(), since its output depends on the browser's compiled ICU
// locale data, which can be incomplete on some mobile browsers/Android WebViews
// and silently drop options like the year. This guarantees identical output
// on every device regardless of locale support. Uses the same MONTHS_SHORT
// array that parseSessionDate() already relies on to read dates back.
const fmtDateDMY = d => `${String(d.getDate()).padStart(2, "0")} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
// Load-velocity relationship: v = 0.15 + 1.0 × (1 − load/1RM), floored at 0.15 m/s
const estVelocity = (load, oneRM) => +Math.max(0.15, 0.15 + 1.0 * (1 - load / Math.max(oneRM, load))).toFixed(2);
const calcPower = (load, vel) => Math.round(load * 9.81 * vel); // Watts (mean per rep)

// ── Recommended next load ────────────────────────────────────────────────────
// Base increment comes from last session's average RPE (autoregulation), then
// scaled by weekly training frequency for that exercise (higher frequency =
// smaller jumps, since fatigue compounds across the week), with a small bonus
// if the load has plateaued for 3+ sessions without RPE climbing.
// ── Zone target load ─────────────────────────────────────────────────────────
// A completely separate system from calcRecommendedLoad above. That one
// autoregulates SESSION-TO-SESSION within whatever zone the client is already
// training. This one estimates a STARTING target the moment a program's Type
// changes (e.g. General Strength → Max Strength) — using standard %1RM
// guidelines against the client's best known Est 1RM for that exercise,
// since there's no history yet in the new zone to autoregulate from.
const ZONE_PCT_1RM = {
  "Hypertrophy": 70,
  "Endurance Strength": 60,
  "Max Strength": 87,
  "Power": 75,
  "Muscular Endurance": 55,
  "Hybrid": 70
};
// Standard target RIR per zone — how much "reps in reserve" to leave at the
// target load. Lower RIR (closer to failure) for Hypertrophy; more reserve
// for Power/Endurance where fatigue management or bar speed matters more.
const ZONE_RIR_TARGET = {
  "Hypertrophy": 2,
  "Endurance Strength": 3,
  "Max Strength": 2,
  "Power": 3,
  "Muscular Endurance": 3,
  "Hybrid": 2
};
// Best-ever Est 1RM for an exercise across whatever sessions are passed in.
function getBest1RM(sessions, exName) {
  let best1RM = 0;
  sessions.forEach(s => {
    s.entries.forEach(e => {
      if (e.ex === exName && e.load > 0 && e.reps > 0 && !isOvrcIso(e.type)) {
        const rm = est1RM(effPeakLoad(e), effPeakReps(e));
        if (rm > best1RM) best1RM = rm;
      }
    });
  });
  return best1RM;
}
function calcZoneTarget(sessions, exName, progType) {
  // General Strength and Activation Strength are baseline-discovery phases —
  // the load is found through direct trial/feel, not derived from an existing
  // 1RM. A formula-based target here would be circular (you'd need a real 1RM
  // to compute a target, but that's exactly what these phases haven't
  // established yet). Once real sessions exist, the separate within-block
  // progression box (calcRecommendedLoad) takes over instead.
  if (progType === "General Strength" || progType === "Activation Strength") return null;
  const pct = ZONE_PCT_1RM[progType];
  if (!pct) return null;
  const best1RM = getBest1RM(sessions, exName);
  if (best1RM <= 0) return null;
  const target = Math.round(best1RM * pct / 100);

  // Inverse Epley: given the target load and best 1RM, estimate the max reps
  // achievable at that load with 0 RIR (i.e. "this load is roughly an N-rep max").
  const maxReps = Math.max(1, Math.round(30 * (best1RM / target - 1)));
  const targetRIR = ZONE_RIR_TARGET[progType] ?? 2;
  const recommendedReps = Math.max(1, maxReps - targetRIR);
  return {
    target,
    best1RM,
    pct,
    progType,
    maxReps,
    targetRIR,
    recommendedReps
  };
}

// Manual Rep Max Calculator — trainer picks ANY rep-max/RIR combo directly
// (e.g. "2RM with 1 RIR"), rather than being locked into the automated
// Program-Type suggestion. Uses the same inverse-Epley math as everywhere
// else in the app, for consistency.
function calcManualRM(sessions, exName, repMax, rir) {
  const best1RM = getBest1RM(sessions, exName);
  if (best1RM <= 0) return null;
  const n = Math.max(1, +repMax || 1);
  const pct = 30 / (30 + n) * 100;
  const load = Math.round(best1RM * pct / 100);
  const repsToExecute = Math.max(1, n - Math.max(0, +rir || 0));
  return {
    best1RM,
    pct: +pct.toFixed(1),
    load,
    repMax: n,
    rir: Math.max(0, +rir || 0),
    repsToExecute
  };
}
function calcRecommendedLoad(sessions, exName) {
  const relevant = sessions.filter(s => s.entries.some(e => e.ex === exName && e.load > 0 && !isOvrcIso(e.type))).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  if (relevant.length === 0) return null;
  const lastSession = relevant[relevant.length - 1];
  const lastEntries = lastSession.entries.filter(e => e.ex === exName && e.load > 0 && !isOvrcIso(e.type));
  if (lastEntries.length === 0) return null;
  const lastLoad = Math.max(...lastEntries.map(e => e.load));
  const avgRPE = lastEntries.reduce((s, e) => s + (e.rpe || 7), 0) / lastEntries.length;
  const avgReps = lastEntries.reduce((s, e) => s + (effReps(e) || 8), 0) / lastEntries.length;

  // Base % increment from RPE (autoregulation)
  let basePct;
  if (avgRPE <= 7) basePct = 5;else if (avgRPE < 8.5) basePct = 2.5;else if (avgRPE < 9.5) basePct = 0;else basePct = 0; // RPE 10 — hold, flag for review

  // Rep-range scaling: heavier/lower-rep work (Max Strength 1-6 reps, and Power —
  // which is also low-rep/explosive by nature) gets smaller jumps, since there's
  // less margin for error near-maximal, and for Power specifically, overloading
  // too fast degrades bar speed, defeating the point of that zone. Higher-rep
  // work has more margin, so slightly bigger jumps are reasonable there.
  const repRangeScale = avgReps <= 6 ? 0.6 : avgReps <= 12 ? 1.0 : 1.15;
  const repRangeLabel = avgReps <= 6 ? "low-rep/strength-power zone" : avgReps <= 12 ? "moderate-rep zone" : "high-rep zone";

  // Weekly frequency: sessions with this exercise in the last 7 days (from last session's date)
  const lastDate = new Date(lastSession.date);
  const weekStart = new Date(lastDate);
  weekStart.setDate(weekStart.getDate() - 6);
  const freq = relevant.filter(s => {
    const d = new Date(s.date);
    return d >= weekStart && d <= lastDate;
  }).length;
  const freqScale = freq <= 1 ? 1.25 : freq === 2 ? 1.0 : freq === 3 ? 0.5 : 0.35;
  let pct = basePct * freqScale * repRangeScale;

  // Plateau bonus: same load (±1kg) for the last 3+ sessions with RPE not climbing
  const last3 = relevant.slice(-3);
  let plateauBonus = 0;
  if (last3.length === 3) {
    const loads3 = last3.map(s => {
      const ee = s.entries.filter(e => e.ex === exName && e.load > 0 && !isOvrcIso(e.type));
      return ee.length ? Math.max(...ee.map(e => e.load)) : null;
    });
    const rpes3 = last3.map(s => {
      const ee = s.entries.filter(e => e.ex === exName && e.load > 0 && !isOvrcIso(e.type));
      return ee.length ? ee.reduce((sum, e) => sum + (e.rpe || 7), 0) / ee.length : null;
    });
    const samePlateau = loads3.every(l => l != null && Math.abs(l - loads3[0]) <= 1);
    const rpeNotClimbing = rpes3.every(r => r != null && r <= 8.5);
    if (samePlateau && rpeNotClimbing && basePct === 0) {
      plateauBonus = 2.5 * repRangeScale;
      pct += plateauBonus;
    }
  }
  if (pct === 0 && plateauBonus === 0) {
    const timeline = avgRPE >= 9.5 ? "Hold — near-maximal effort. Retry at this load for 1-2 more sessions before reassessing." : "Hold — retry at this load next session; expect to progress once RPE drops below 8.5.";
    const repTarget = Math.max(1, Math.round(avgReps));
    return {
      newLoad: lastLoad,
      lastLoad,
      avgRPE: +avgRPE.toFixed(1),
      freq,
      pct: 0,
      est1RM: est1RM(lastLoad, avgReps),
      repRangeLo: Math.max(1, repTarget - 1),
      repRangeHi: repTarget + 3,
      suggestedRIR: Math.min(2, Math.max(0, Math.round(10 - avgRPE))),
      reason: `RPE ${avgRPE.toFixed(1)} avg — ${timeline}`
    };
  }
  const rawNew = lastLoad * (1 + pct / 100);
  const newLoad = Math.round(rawNew); // nearest 1kg
  if (newLoad <= lastLoad) {
    const repTarget = Math.max(1, Math.round(avgReps));
    return {
      newLoad: lastLoad,
      lastLoad,
      avgRPE: +avgRPE.toFixed(1),
      freq,
      pct: 0,
      est1RM: est1RM(lastLoad, avgReps),
      repRangeLo: Math.max(1, repTarget - 1),
      repRangeHi: repTarget + 3,
      suggestedRIR: Math.min(2, Math.max(0, Math.round(10 - avgRPE))),
      reason: `RPE ${avgRPE.toFixed(1)} avg — hold at current load`
    };
  }

  // If this zone (this active program) still has limited session history,
  // flag that the recommendation will sharpen as more data comes in.
  const buildingNote = relevant.length < 3 ? ` (${relevant.length} session${relevant.length !== 1 ? "s" : ""} in this program so far — recommendation will refine with more data)` : "";
  const repTarget = Math.max(1, Math.round(avgReps));
  return {
    newLoad,
    lastLoad,
    avgRPE: +avgRPE.toFixed(1),
    freq,
    pct: +pct.toFixed(1),
    est1RM: est1RM(lastLoad, avgReps),
    // based on actual last performance, not a hypothetical projection at the new load
    repRangeLo: Math.max(1, repTarget - 1),
    repRangeHi: repTarget + 3,
    suggestedRIR: Math.min(2, Math.max(0, Math.round(10 - avgRPE))),
    reason: `RPE ${avgRPE.toFixed(1)} avg, ${freq}x/week, ${repRangeLabel}${plateauBonus ? ", plateau bonus" : ""} → +${pct.toFixed(1)}%${buildingNote}`
  };
}

// Activation Strength graduation check — a beginner is considered ready to
// move to a proper General Strength program once:
//  1. 6+ logged sessions for this exercise (accumulated practice matters more
//     than elapsed calendar time for motor learning)
//  2. Load has increased at least twice across those sessions (the movement
//     pattern is solidifying, not just being maintained)
//  3. Average RPE over the last 3 sessions is <=7 (handling the current load
//     comfortably, with room to spare — the ceiling on Activation-level
//     loading has been reached)
//
// General Strength -> Max Strength uses stricter criteria (12 sessions, 3
// load increases, 8 weeks minimum elapsed) — this transition genuinely needs
// more than just practice reps: tendon and connective tissue adapt far slower
// than muscle (commonly cited at 8-12+ weeks of consistent loading before
// they're robust enough for regular near-maximal work), and the technical
// margin for error shrinks dramatically near 1RM, so a sustained trend matters
// more than a couple of good sessions.
function calcGraduationReadiness(sessions, exName, {
  minSessions,
  minIncreases,
  maxAvgRPE,
  minWeeksElapsed = 0
}) {
  const relevant = sessions.filter(s => s.entries.some(e => e.ex === exName && e.load > 0 && !isOvrcIso(e.type))).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  if (relevant.length < minSessions) return {
    ready: false,
    sessionCount: relevant.length
  };

  // Best load logged per session, in chronological order
  const loadsPerSession = relevant.map(s => {
    const entries = s.entries.filter(e => e.ex === exName && e.load > 0 && !isOvrcIso(e.type));
    return Math.max(...entries.map(e => e.load));
  });
  let increases = 0;
  for (let i = 1; i < loadsPerSession.length; i++) {
    if (loadsPerSession[i] > loadsPerSession[i - 1]) increases++;
  }
  const last3 = relevant.slice(-3);
  const last3Entries = last3.flatMap(s => s.entries.filter(e => e.ex === exName && e.load > 0 && !isOvrcIso(e.type)));
  const avgRPE3 = last3Entries.length ? last3Entries.reduce((s, e) => s + (e.rpe || 7), 0) / last3Entries.length : 7;
  const daySpan = (parseSessionDate(relevant[relevant.length - 1].date) - parseSessionDate(relevant[0].date)) / 86400000;
  const weeksElapsed = daySpan / 7;
  const weeks = Math.max(1, weeksElapsed);
  const freqPerWeek = +(relevant.length / weeks).toFixed(1);
  const ready = increases >= minIncreases && avgRPE3 <= maxAvgRPE && weeksElapsed >= minWeeksElapsed;
  return {
    ready,
    sessionCount: relevant.length,
    increases,
    avgRPE3: +avgRPE3.toFixed(1),
    freqPerWeek,
    weeksElapsed: +weeksElapsed.toFixed(1)
  };
}
function calcActivationGraduation(sessions, exName) {
  return calcGraduationReadiness(sessions, exName, {
    minSessions: 6,
    minIncreases: 2,
    maxAvgRPE: 7
  });
}
function calcGeneralStrengthGraduation(sessions, exName) {
  return calcGraduationReadiness(sessions, exName, {
    minSessions: 12,
    minIncreases: 3,
    maxAvgRPE: 7,
    minWeeksElapsed: 8
  });
}

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
    return entries.reduce((sum, e) => sum + effVolume(e), 0);
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

// Complex (superset/tri-set/giant set) — auto-labeled by member count, auto-coloured.
const COMPLEX_COLORS = ["#FF8020", "#44AAFF", "#AA44FF", "#00C896", "#FF44AA", "#FFB020"];
const complexLabel = n => n <= 2 ? "SS" : n === 3 ? "TS" : "GS";
const complexColorFor = idx => COMPLEX_COLORS[idx % COMPLEX_COLORS.length];
// Numbered label for a complex within a list of complexes — e.g. "SS1"/"SS2" if
// there are two supersets, but just "SS" if there's only one (numbering only
// appears when it's actually needed to disambiguate). Numbering is scoped PER
// TYPE: two supersets and one tri-set gives "SS1", "TS", "SS2", not "1,2,3".
// `complexesArr` is the full list this complex belongs to; `idx` is its
// position within that same array.
function complexLabelNumbered(complexesArr, idx) {
  const type = complexLabel(complexesArr[idx].exerciseNames.length);
  const sameTypeIndices = complexesArr.map((c, i) => ({
    i,
    type: complexLabel(c.exerciseNames.length)
  })).filter(x => x.type === type).map(x => x.i);
  if (sameTypeIndices.length <= 1) return type;
  return `${type}${sameTypeIndices.indexOf(idx) + 1}`;
}
// Display text for a complex's rest config, matching the individual-exercise pattern
// e.g. "💤 1:30 (+10s/round)" or "💤 90s (🌊 2 turns)" or flat "💤 90s".
function fmtComplexRest(cx) {
  if (cx.restSecs == null) return fmtRest(cx.restBetweenRounds); // legacy complexes
  const base = fmtRest(cx.restSecs);
  if (!cx.restIncrementAmt) return base;
  if ((cx.restTurns || []).length > 0) return `${base} (🌊 wave, ${cx.restTurns.length} turn${cx.restTurns.length !== 1 ? "s" : ""})`;
  return `${base} (${cx.restIncrementDir}${fmtRest(cx.restIncrementAmt)}/round)`;
}
const avCol = idx => AV_COLS[idx % AV_COLS.length];

// Isometric helpers
const isIsoType = t => ["Ovrc Iso-Ballistic", "Ovrc Iso-Max", "Ovrc Iso-Endurance", "Ovrc Iso-Sustained", "Ovrc Iso-Strength+Hypertrophy", "Yielding Iso-Holds", "Yielding Iso-GPP"].includes(t);
const isOvrcIso = t => t === "Ovrc Iso-Ballistic" || t === "Ovrc Iso-Max" || t === "Ovrc Iso-Endurance" || t === "Ovrc Iso-Sustained" || t === "Ovrc Iso-Strength+Hypertrophy";
const isYieldIso = t => t === "Yielding Iso-Holds" || t === "Yielding Iso-GPP";
// The combo type is structurally different from the other Ovrc types — a
// genuine two-phase sequence (max-effort rounds, then an extended submaximal
// hold) rather than a single duration/effort parameter — so it needs its own
// dedicated breakdown UI, similar in spirit to how Cluster/Drop Set work.
const isComboIso = t => t === "Ovrc Iso-Strength+Hypertrophy";
const isClusterSet = t => t === "Cluster Set";
const isDropSet = t => t === "Drop Set";
const isAscendingSet = t => t === "Ascending Set";
const isPyramidSet = t => t === "Pyramid Set (continuous)";
const isNegativeSet = t => t === "Negative";

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
// Intra-cluster rest starts lower than normal set rest (5s rest-pause is common),
// so its own base-rest dropdown starts at 5s instead of 20s, same 5s steps.
// Intra-cluster base rest: 5s-60s range (rest-pause style, much shorter than
// normal set rest), in 1s steps for fine-grained control.
const CLUSTER_REST_OPTIONS = Array.from({
  length: 60 - 5 + 1
}, (_, i) => 5 + i);
// Intra-cluster increment per gap: 1s-30s range, 1s steps — much finer than
// the 5s+ steps used for normal rest-between-sets increments.
const CLUSTER_INCREMENT_OPTIONS = [0, ...Array.from({
  length: 30
}, (_, i) => i + 1)];

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
  let rest = +baseSecs;
  for (let s = 2; s <= n; s++) {
    let active = phases[0];
    for (const p of phases) {
      if (p.start <= s - 1) active = p;
    }
    rest = clamp(rest + (active.amt || 0) * (active.dir === "-" ? -1 : 1));
  }
  return clamp(rest);
}
// Same wave logic as calcIncrementalRest, but for intra-cluster gaps specifically —
// deliberately a much lower floor (1s vs 10s), since rest-pause style cluster
// training legitimately uses very short gaps (5s and below), which the normal
// rest-between-sets floor would otherwise incorrectly clamp upward.
function calcClusterGapRest(baseSecs, dir0, amt0, gapNo, turns) {
  if (!baseSecs) return null;
  const clamp = v => Math.min(900, Math.max(1, v));
  const n = Math.max(1, gapNo || 1);
  const phases = [{
    start: 1,
    dir: dir0,
    amt: amt0
  }, ...(turns || []).filter(t => t && t.afterSet).map(t => ({
    start: +t.afterSet,
    dir: t.dir,
    amt: +t.amt || 0
  }))].sort((a, b) => a.start - b.start);
  let rest = +baseSecs;
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

// Same wave logic as calcClusterGapRest, but for the drop PERCENTAGE itself —
// clamped to a 1-60% range (percentages, not seconds). "dropNo" is which
// transition this is (1 = Drop1→Drop2, 2 = Drop2→Drop3, etc.).
function calcDropPct(basePct, dir0, amt0, dropNo, turns) {
  if (!basePct) return null;
  const clamp = v => Math.min(60, Math.max(1, v));
  const n = Math.max(1, dropNo || 1);
  const phases = [{
    start: 1,
    dir: dir0,
    amt: amt0
  }, ...(turns || []).filter(t => t && t.afterSet).map(t => ({
    start: +t.afterSet,
    dir: t.dir,
    amt: +t.amt || 0
  }))].sort((a, b) => a.start - b.start);
  let pct = +basePct;
  for (let s = 2; s <= n; s++) {
    let active = phases[0];
    for (const p of phases) {
      if (p.start <= s - 1) active = p;
    }
    pct = clamp(pct + (active.amt || 0) * (active.dir === "-" ? -1 : 1));
  }
  return clamp(pct);
}

// Drop Set load sequence — the MAIN/top set (mainLoad) is the client's regular
// working set, logged normally via the main Load/Reps fields; it is NOT itself
// counted as "Drop 1". Drop 1 is the FIRST reduction after the top set, Drop 2
// reduces from Drop 1, and so on — using a PER-TRANSITION percentage from the
// wave above (so the drop % can escalate/de-escalate across the sequence).
// 20-25% is the well-established standard starting point: enough reduction to
// keep training productively despite accumulated fatigue, without dropping so
// much the set becomes trivial. Rounded to the nearest 2.5kg since plates and
// most dumbbells come in fixed increments, not arbitrary decimals. Returns an
// array of exactly `numDrops` loads (the drops only, main load excluded).
function calcDropSetLoads(mainLoad, basePct, dir, incAmt, turns, numDrops) {
  if (!mainLoad || numDrops <= 0) return [];
  const loads = [];
  let load = mainLoad;
  for (let i = 0; i < numDrops; i++) {
    const pct = calcDropPct(basePct, dir, incAmt, i + 1, turns) ?? 20;
    load = load * (1 - pct / 100);
    loads.push(Math.round(load / 2.5) * 2.5);
  }
  return loads;
}

// Ascending Set ("Run the Rack") — the mirror image of a Drop Set: the MAIN
// set is the STARTING (lightest) load, logged normally via the main
// Load/Reps fields; it is NOT itself counted as "Up 1". Up 1 is the FIRST
// increase after the starting set, Up 2 increases from Up 1, and so on —
// reusing the exact same wave-percentage engine as Drop Set (calcDropPct),
// just applied as a load INCREASE rather than a reduction. Unlike a drop
// set, fatigue and load both climb together here, so this is a considerably
// more demanding technique — each stage gets harder from two compounding
// directions at once, not one offsetting the other. Returns an array of
// exactly `numUps` loads (the increases only, main/starting load excluded).
function calcAscSetLoads(mainLoad, basePct, dir, incAmt, turns, numUps) {
  if (!mainLoad || numUps <= 0) return [];
  const loads = [];
  let load = mainLoad;
  for (let i = 0; i < numUps; i++) {
    const pct = calcDropPct(basePct, dir, incAmt, i + 1, turns) ?? 5;
    load = load * (1 + pct / 100);
    loads.push(Math.round(load / 2.5) * 2.5);
  }
  return loads;
}

// Suggests a STARTING load for an Ascending Set such that the FINAL (heaviest)
// stage lands at or below a safe ceiling of Est 1RM (85% by default) — since
// picking a starting load too close to 1RM makes the configured increases
// mathematically push past what's actually liftable by the last stage.
// Works backwards from the ceiling: computes the compounded multiplier the
// wave % config produces by the final stage, then divides the ceiling load by
// that multiplier to find a starting point that keeps the whole sequence
// feasible. Also enforces a practical rep cap (10 by default) on the STARTING
// stage — the pure ceiling formula alone can suggest a load light enough to
// imply an unrealistically high rep count (e.g. 13+) for what's meant to be a
// strength-focused technique, so whichever constraint calls for the HEAVIER
// load wins. This means the final stage can end up slightly above the 85%
// ceiling when the rep cap is the binding constraint — an intentional
// trade-off in favor of a sensible starting rep count over a hard ceiling.
// Rounded to the nearest 2.5kg, matching calcAscSetLoads.
function calcAscSetSuggestedMainLoad(est1RM, basePct, dir, incAmt, turns, numUps, ceilingPct = 85, repCap = 10) {
  if (!est1RM || numUps <= 0) return null;
  let multiplier = 1;
  for (let i = 0; i < numUps; i++) {
    const pct = calcDropPct(basePct, dir, incAmt, i + 1, turns) ?? 5;
    multiplier *= 1 + pct / 100;
  }
  const ceilingLoad = est1RM * (ceilingPct / 100) / multiplier;
  const repCapLoad = est1RM / (1 + repCap / 30);
  const suggested = Math.max(ceilingLoad, repCapLoad);
  return Math.round(suggested / 2.5) * 2.5;
}

// Companion rep suggestion for the suggested starting load above — inverts
// the same Epley formula used by est1RM() elsewhere (1RM = load×(1+reps/30))
// to find how many reps at THAT specific load would produce the known Est
// 1RM, rather than relying on a generic rep-range midpoint that isn't tied to
// this particular load. Capped at the same repCap as the load suggestion
// above, so rounding can never push the displayed rep count past it.
function calcAscSetSuggestedMainReps(est1RM, suggestedLoad, repCap = 10) {
  if (!est1RM || !suggestedLoad) return null;
  const reps = 30 * (est1RM / suggestedLoad - 1);
  return Math.max(1, Math.min(repCap, Math.round(reps)));
}
const bandRangeOptions = strength => {
  const r = BAND_RANGES[strength];
  if (!r) return [];
  const [lo, hi] = r;
  return Array.from({
    length: hi - lo + 1
  }, (_, i) => lo + i);
};

// Rest between contractions, scaled to each protocol's own intensity/duration
// — a brief explosive burst (Ballistic) only needs a short CNS reset, while a
// longer, more fatiguing bout (Sustained, or the tendon-loading Yielding
// holds) needs meaningfully more recovery before repeating. Max mirrors the
// same "3s work, 5s rest" already used in Strength+Hypertrophy's Phase 1.
const ISO_REST_SECS = {
  "Ovrc Iso-Ballistic": 5,
  "Ovrc Iso-Max": 5,
  "Ovrc Iso-Endurance": 12,
  "Ovrc Iso-Sustained": 25,
  "Yielding Iso-Holds": 45,
  "Yielding Iso-GPP": 45
};

// Selectable range per protocol — the default above sits within each range,
// but the trainer can dial it in tighter or longer as needed.
const ISO_REST_RANGES = {
  "Ovrc Iso-Ballistic": [2, 3, 4, 5],
  "Ovrc Iso-Max": [3, 4, 5, 6, 7],
  "Ovrc Iso-Endurance": [8, 10, 12, 15, 18],
  "Ovrc Iso-Sustained": [15, 20, 25, 30, 35],
  "Yielding Iso-Holds": [30, 35, 40, 45, 50, 55, 60],
  "Yielding Iso-GPP": [20, 30, 40, 45, 50, 60]
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
  "Ovrc Iso-Endurance": {
    color: "#D4A017",
    icon: "🔥",
    label: "Overcoming Iso — Endurance",
    desc: "6–10s sustained near-maximal push, past peak force into short-duration capacity. No external load.",
    holdTarget: "6–10s",
    setsReps: "3–4 sets × 6–10s"
  },
  "Ovrc Iso-Sustained": {
    color: "#C2410C",
    icon: "🌋",
    label: "Overcoming Iso — Sustained",
    desc: "Maximal-effort push held from the start through 15–20s, accepting the natural decline in force as fatigue sets in — a further extension of Endurance into short-duration fatigue tolerance. No external load.",
    holdTarget: "15–20s",
    setsReps: "2–3 sets × 15–20s"
  },
  "Ovrc Iso-Strength+Hypertrophy": {
    color: "#E8398A",
    icon: "💥",
    label: "Overcoming Iso — Strength + Hypertrophy",
    desc: "Two-phase combo: 5 rounds of 3s max-effort contractions (5s rest between), immediately followed by a 30–60s hold at ~50% effort. The max-effort phase primes the nervous system (post-activation potentiation); the extended submaximal hold that follows adds a hypertrophy-focused metabolic stimulus in an already-fatigued state. Train at longer muscle lengths for a stronger stimulus. No external load.",
    holdTarget: "5×3s + 30–60s",
    setsReps: "1 combo protocol"
  },
  "Yielding Iso-Holds": {
    color: "#5060FF",
    icon: "🏋",
    label: "Yielding Iso — Iso Holds",
    desc: "Hold against gravity. Targets weaker tendon regions. Ideal for tendinopathy rehab. Standard duration is 45s (the well-established Cook/Rio-style protocol); shorter durations down to 15s are available as a gentler entry point for early-stage or highly irritable presentations.",
    holdTarget: "15–45s",
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
const PROG_TYPES = ["Activation Strength", "General Strength", "Hypertrophy", "Endurance Strength", "Max Strength", "Power", "Muscular Endurance", "Hybrid"];
const SET_TYPES = ["Normal", "Warm-up", "Top Set", "Back-off", "Drop Set", "Ascending Set", "Pyramid Set (continuous)", "Negative", "Cluster Set", "Ovrc Iso-Ballistic", "Ovrc Iso-Max", "Ovrc Iso-Endurance", "Ovrc Iso-Sustained", "Ovrc Iso-Strength+Hypertrophy", "Yielding Iso-Holds", "Yielding Iso-GPP"];
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
  const [confirmDeleteItem, setConfirmDeleteItem] = useState(null); // item name pending delete confirmation

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
  }, "✕")) : confirmDeleteItem === o ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      padding: "6px 10px",
      alignItems: "center",
      background: C.warn + "12"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontSize: 12,
      color: C.warn
    }
  }, "Delete \"", o, "\"?"), /*#__PURE__*/React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      onDeleteOption(o);
      if (value === o) onChange(options.find(x => x !== o) || "");
      setConfirmDeleteItem(null);
    },
    style: {
      background: C.warn,
      color: "#fff",
      border: "none",
      borderRadius: 6,
      padding: "5px 10px",
      cursor: "pointer",
      fontSize: 11,
      fontWeight: 700,
      flexShrink: 0
    }
  }, "Delete"), /*#__PURE__*/React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      setConfirmDeleteItem(null);
    },
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
      setConfirmDeleteItem(o);
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
  const totalVol = session.entries.reduce((s, e) => s + (effVolume(e) || 0), 0);
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
  }, "🔴 ", e.bandLength, " ", e.bandStrength, " (", e.bandLoadKg ? `${e.bandLoadKg}kg ` : "", e.bandUsage, ")", e.rawLoad != null && e.bandLoadKg ? ` — ${e.rawLoad}kg plate ${e.bandUsage === "assisted" ? "−" : "+"} ${e.bandLoadKg}kg band = ${e.load}kg effective` : ""), (e.clusterRepsArr?.length || e.clusterReps) && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.gold
    }
  }, "⏱ ", e.clusterRepsArr?.length ? e.clusterRepsArr.join("+") + " reps" : `${e.clusterCount}×${e.clusterReps}`, " clusters", e.clusterGaps?.length ? ` (${e.clusterGaps.map(g => fmtRest(g)).join(" → ")} rest)` : e.clusterRest ? ` (${e.clusterRest}s rest)` : ""), e.dropSetLoads?.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#A855F7'
    }
  }, "📉 ", e.load, "kg×", e.dropSetMainReps ?? "?", ", ", e.dropSetLoads.map((l, i) => `${l}kg×${e.dropSetReps?.[i] ?? "?"}`).join(", ")), e.ascSetLoads?.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#22C55E'
    }
  }, "📈 ", e.load, "kg×", e.ascSetMainReps ?? "?", ", ", e.ascSetLoads.map((l, i) => `${l}kg×${e.ascSetReps?.[i] ?? "?"}`).join(", ")), e.pyrLoads?.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#A855F7'
    }
  }, "🔺 ", e.load, "kg×", e.pyrMainReps ?? "?", ", ", e.pyrLoads.map((l, i) => `${l}kg×${e.pyrReps?.[i] ?? "?"}`).join(", ")), isNegativeSet(e.type) && (e.eccSecs || e.conSecs) && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#38BDF8'
    }
  }, "⬇ ", e.eccSecs || "?", "s ecc / ", e.conSecs || "?", "s con"), e.restApplied && /*#__PURE__*/React.createElement("div", {
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

function ComplexEditorModal({
  exerciseNames,
  complex,
  colorIdx,
  onSave,
  onDelete,
  onClose,
  isOverrideMode
}) {
  const [picked, setPicked] = useState(complex?.exerciseNames || []);
  const [restSecs, setRestSecs] = useState(complex?.restSecs ? String(complex.restSecs) : complex?.restBetweenRounds ? String(complex.restBetweenRounds) : "90");
  const [restIncrementDir, setRestIncrementDir] = useState(complex?.restIncrementDir || "+");
  const [restIncrementAmt, setRestIncrementAmt] = useState(complex?.restIncrementAmt != null ? String(complex.restIncrementAmt) : "0");
  const [restTurns, setRestTurns] = useState(complex?.restTurns || []);
  const [confirmingDelete, setConfirmingDelete] = useState(!!complex?._startDeleteConfirm);
  const toggle = name => setPicked(p => p.includes(name) ? p.filter(x => x !== name) : [...p, name]);
  const label = complexLabel(picked.length);
  const color = complexColorFor(colorIdx);
  if (confirmingDelete) {
    return /*#__PURE__*/React.createElement(Sheet, {
      title: isOverrideMode ? "↺ REVERT TO ORIGINAL?" : "🗑 DELETE COMPLEX?",
      onClose: () => setConfirmingDelete(false)
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 14,
        color: C.text,
        lineHeight: 1.6,
        marginBottom: 20,
        textAlign: "center"
      }
    }, isOverrideMode ? /*#__PURE__*/React.createElement(React.Fragment, null, "Clear your session adjustment?", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        color: C.muted
      }
    }, "Reverts back to the program's original complex for the rest of this session. Nothing permanent is affected.")) : /*#__PURE__*/React.createElement(React.Fragment, null, "Delete this complex?", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        color: C.muted
      }
    }, "The exercises themselves are unaffected — only the grouping is removed."))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 10
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setConfirmingDelete(false),
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
      onClick: onDelete,
      style: {
        flex: 1,
        background: isOverrideMode ? C.gold : C.warn,
        color: isOverrideMode ? "#1A1200" : "#fff",
        border: "none",
        borderRadius: 10,
        padding: "13px",
        fontFamily: "'Bebas Neue',cursive",
        fontSize: 18,
        letterSpacing: 2,
        cursor: "pointer"
      }
    }, isOverrideMode ? "REVERT" : "DELETE")));
  }
  return /*#__PURE__*/React.createElement(Sheet, {
    title: isOverrideMode ? "✎ ADJUST FOR TODAY" : complex ? "✎ EDIT COMPLEX" : "🔗 NEW COMPLEX",
    onClose: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: C.sub,
      lineHeight: 1.6,
      marginBottom: 16
    }
  }, "Select 2 or more exercises to link into a superset/tri-set/giant set. No rest between exercises within a round — the rest you set here applies once, after completing the last exercise, before the round repeats."), picked.length >= 2 && /*#__PURE__*/React.createElement("div", {
    style: {
      background: color + "18",
      border: `1px solid ${color}55`,
      borderRadius: 10,
      padding: "8px 12px",
      marginBottom: 14,
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 18,
      letterSpacing: 1,
      color
    }
  }, label, " · ", picked.length, " exercises")), /*#__PURE__*/React.createElement(Lbl, {
    t: "Exercises in this complex (in order)"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      maxHeight: 280,
      overflowY: "auto",
      marginTop: 4,
      marginBottom: 16
    }
  }, exerciseNames.map(name => {
    const isPicked = picked.includes(name);
    const orderNum = picked.indexOf(name) + 1;
    return /*#__PURE__*/React.createElement("div", {
      key: name,
      onClick: () => toggle(name),
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        background: isPicked ? C.card2 : "transparent",
        borderRadius: 10,
        marginBottom: 6,
        border: `1px solid ${isPicked ? color + "77" : C.border}`,
        cursor: "pointer"
      }
    }, isPicked && /*#__PURE__*/React.createElement("div", {
      style: {
        width: 22,
        height: 22,
        borderRadius: "50%",
        background: color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 11,
        color: "#1A0800",
        fontWeight: 700,
        flexShrink: 0
      }
    }, orderNum), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        fontSize: 14,
        fontWeight: 600,
        color: C.text
      }
    }, name), !isPicked && /*#__PURE__*/React.createElement("div", {
      style: {
        width: 22,
        height: 22,
        borderRadius: 6,
        border: `1.5px solid ${C.border}`
      }
    }));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Rest between rounds (base)"
  }), /*#__PURE__*/React.createElement("select", {
    value: restSecs,
    onChange: e => setRestSecs(e.target.value),
    style: ss
  }, REST_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, fmtRest(v))))), /*#__PURE__*/React.createElement("div", {
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
    value: restIncrementDir,
    onChange: e => setRestIncrementDir(e.target.value),
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
    t: "Increment per round"
  }), /*#__PURE__*/React.createElement("select", {
    value: restIncrementAmt,
    onChange: e => setRestIncrementAmt(e.target.value),
    style: ss
  }, INCREMENT_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v === 0 ? "None (flat rest)" : fmtRest(v)))))), +restIncrementAmt > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, restTurns.map((t, ti) => /*#__PURE__*/React.createElement("div", {
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
      color,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase"
    }
  }, "🌊 Turn ", ti + 1), /*#__PURE__*/React.createElement("button", {
    onClick: () => setRestTurns(rt => rt.filter((_, i) => i !== ti)),
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
    t: "Switch trend after round #"
  }), /*#__PURE__*/React.createElement("select", {
    value: t.afterSet,
    onChange: e => {
      const nt = [...restTurns];
      nt[ti] = {
        ...nt[ti],
        afterSet: +e.target.value
      };
      setRestTurns(nt);
    },
    style: ss
  }, TURN_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, "Round ", v)))), /*#__PURE__*/React.createElement("div", {
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
      const nt = [...restTurns];
      nt[ti] = {
        ...nt[ti],
        dir: e.target.value
      };
      setRestTurns(nt);
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
      const nt = [...restTurns];
      nt[ti] = {
        ...nt[ti],
        amt: +e.target.value
      };
      setRestTurns(nt);
    },
    style: ss
  }, INCREMENT_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v === 0 ? "None (flat)" : fmtRest(v)))))))), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const lastRound = restTurns.length ? restTurns[restTurns.length - 1].afterSet : 3;
      setRestTurns(rt => [...rt, {
        afterSet: Math.min(20, lastRound + 2),
        dir: "+",
        amt: 0
      }]);
    },
    style: {
      width: "100%",
      background: "none",
      border: `1px dashed ${color}55`,
      borderRadius: 8,
      padding: "8px",
      cursor: "pointer",
      color,
      fontSize: 12,
      fontWeight: 700,
      marginBottom: 8
    }
  }, "🌊 + Add trend change")), +restIncrementAmt > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color,
      marginBottom: 16,
      fontWeight: 600,
      lineHeight: 1.6
    }
  }, "Preview: ", [1, 2, 3, 4, 5, 6].map(n => `Rd${n}→${n + 1} ${fmtRest(calcIncrementalRest(+restSecs, restIncrementDir, +restIncrementAmt, n, restTurns))}`).join(" · ")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10
    }
  }, complex && /*#__PURE__*/React.createElement("button", {
    onClick: () => setConfirmingDelete(true),
    style: {
      flex: 1,
      background: "none",
      border: `1px solid ${isOverrideMode ? C.gold : C.warn}55`,
      borderRadius: 10,
      padding: "12px",
      color: isOverrideMode ? C.gold : C.warn,
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, isOverrideMode ? "↺ Revert to Original" : "🗑 Delete"), /*#__PURE__*/React.createElement("button", {
    disabled: picked.length < 2,
    onClick: () => onSave({
      exerciseNames: picked,
      restSecs: +restSecs,
      restIncrementDir,
      restIncrementAmt: +restIncrementAmt,
      restTurns
    }),
    style: {
      flex: 2,
      background: picked.length < 2 ? C.border : color,
      color: "#1A0800",
      border: "none",
      borderRadius: 10,
      padding: "13px",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 20,
      letterSpacing: 2,
      cursor: picked.length < 2 ? "default" : "pointer"
    }
  }, "SAVE COMPLEX")));
}
function GroupEditorModal({
  clients,
  group,
  colors,
  onSave,
  onDelete,
  onClose
}) {
  const [name, setName] = useState(group?.name || "");
  const [color, setColor] = useState(group?.color || colors[0]);
  const [picked, setPicked] = useState(group?.clientIds || []);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const active = clients.filter(c => !c.archived);
  const toggle = id => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  if (confirmingDelete) {
    return /*#__PURE__*/React.createElement(Sheet, {
      title: "🗑 DELETE GROUP?",
      onClose: () => setConfirmingDelete(false)
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 14,
        color: C.text,
        lineHeight: 1.6,
        marginBottom: 20,
        textAlign: "center"
      }
    }, "Delete ", /*#__PURE__*/React.createElement("strong", null, "\"", group.name, "\""), "?", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        color: C.muted
      }
    }, "This only removes the saved group — it does not affect any client data. This cannot be undone.")), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 10
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setConfirmingDelete(false),
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
      onClick: () => onDelete(group.id),
      style: {
        flex: 1,
        background: C.warn,
        color: "#fff",
        border: "none",
        borderRadius: 10,
        padding: "13px",
        fontFamily: "'Bebas Neue',cursive",
        fontSize: 18,
        letterSpacing: 2,
        cursor: "pointer"
      }
    }, "DELETE")));
  }
  return /*#__PURE__*/React.createElement(Sheet, {
    title: group ? "✎ EDIT GROUP (PERMANENT)" : "＋ NEW GROUP (PERMANENT)",
    onClose: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Group name"
  }), /*#__PURE__*/React.createElement("input", {
    autoFocus: true,
    value: name,
    onChange: e => setName(e.target.value),
    placeholder: "e.g. Tuesday Morning Trio",
    style: ss
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Colour"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      flexWrap: "wrap",
      marginTop: 4
    }
  }, colors.map(c => /*#__PURE__*/React.createElement("button", {
    key: c,
    onClick: () => setColor(c),
    style: {
      width: 32,
      height: 32,
      borderRadius: "50%",
      background: c,
      cursor: "pointer",
      border: color === c ? "3px solid #fff" : "3px solid transparent",
      boxShadow: color === c ? `0 0 0 2px ${c}` : "none"
    }
  })))), /*#__PURE__*/React.createElement(Lbl, {
    t: "Members"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      maxHeight: 280,
      overflowY: "auto",
      marginTop: 4,
      marginBottom: 16
    }
  }, active.map(c => {
    const idx = clients.findIndex(x => x.id === c.id);
    const isPicked = picked.includes(c.id);
    return /*#__PURE__*/React.createElement("div", {
      key: c.id,
      onClick: () => toggle(c.id),
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        background: isPicked ? C.card2 : "transparent",
        borderRadius: 10,
        marginBottom: 6,
        border: `1px solid ${isPicked ? color + "77" : C.border}`,
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement(Avatar, {
      name: c.name,
      idx: idx,
      size: 30
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        fontSize: 14,
        fontWeight: 600,
        color: C.text
      }
    }, c.name), /*#__PURE__*/React.createElement("div", {
      style: {
        width: 22,
        height: 22,
        borderRadius: 6,
        border: `1.5px solid ${isPicked ? color : C.border}`,
        background: isPicked ? color : "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        color: "#001A12",
        fontWeight: 700
      }
    }, isPicked ? "✓" : ""));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10
    }
  }, group && /*#__PURE__*/React.createElement("button", {
    onClick: () => setConfirmingDelete(true),
    style: {
      flex: 1,
      background: "none",
      border: `1px solid ${C.warn}55`,
      borderRadius: 10,
      padding: "12px",
      color: C.warn,
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "🗑 Delete"), /*#__PURE__*/React.createElement("button", {
    disabled: !name.trim() || picked.length === 0,
    onClick: () => onSave({
      name: name.trim(),
      color,
      clientIds: picked
    }),
    style: {
      flex: 2,
      background: !name.trim() || picked.length === 0 ? C.border : C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 10,
      padding: "13px",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 20,
      letterSpacing: 2,
      cursor: !name.trim() || picked.length === 0 ? "default" : "pointer"
    }
  }, "SAVE GROUP")));
}
function SessionGroupModal({
  clients,
  selected,
  onSave,
  onClose
}) {
  const [picked, setPicked] = useState(selected);
  const active = clients.filter(c => !c.archived);
  const toggle = id => setPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  const groupWord = picked.length === 0 ? "" : picked.length === 1 ? "Solo" : picked.length === 2 ? "Duo" : picked.length === 3 ? "Trio" : `Group of ${picked.length}`;
  return /*#__PURE__*/React.createElement(Sheet, {
    title: "👥 GROUP (TEMPORARY)",
    onClose: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: C.sub,
      lineHeight: 1.6,
      marginBottom: 16
    }
  }, "Select who you're training together this session. They'll always show as quick-switch pills below the header — no need to visit each one first for them to appear."), picked.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.accent + "15",
      border: `1px solid ${C.accent}44`,
      borderRadius: 10,
      padding: "8px 12px",
      marginBottom: 14,
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 18,
      letterSpacing: 1,
      color: C.accent
    }
  }, groupWord)), /*#__PURE__*/React.createElement("div", {
    style: {
      maxHeight: 340,
      overflowY: "auto",
      marginBottom: 16
    }
  }, active.map(c => {
    const idx = clients.findIndex(x => x.id === c.id);
    const isPicked = picked.includes(c.id);
    return /*#__PURE__*/React.createElement("div", {
      key: c.id,
      onClick: () => toggle(c.id),
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 12px",
        background: isPicked ? C.card2 : "transparent",
        borderRadius: 10,
        marginBottom: 6,
        border: `1px solid ${isPicked ? C.accent + "55" : C.border}`,
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement(Avatar, {
      name: c.name,
      idx: idx,
      size: 32
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        fontSize: 14,
        fontWeight: 600,
        color: C.text
      }
    }, c.name), /*#__PURE__*/React.createElement("div", {
      style: {
        width: 22,
        height: 22,
        borderRadius: 6,
        border: `1.5px solid ${isPicked ? C.accent : C.border}`,
        background: isPicked ? C.accent : "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        color: "#001A12",
        fontWeight: 700
      }
    }, isPicked ? "✓" : ""));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10
    }
  }, selected.length > 0 && /*#__PURE__*/React.createElement("button", {
    onClick: () => onSave([]),
    style: {
      flex: 1,
      background: "none",
      border: `1px solid ${C.warn}55`,
      borderRadius: 10,
      padding: "12px",
      color: C.warn,
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "End Group"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onSave(picked),
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
  }, picked.length > 0 ? `SAVE (${picked.length})` : "SAVE")));
}
function ClientSwitcher({
  clients,
  activeId,
  onSwitch,
  onClose,
  onAddClient,
  onArchive,
  onReinstate,
  onEditClient,
  savedGroups = [],
  onEditGroup
}) {
  const [showArchived, setShowArchived] = useState(false);
  const active = clients.filter(c => !c.archived);
  const archived = clients.filter(c => c.archived);

  // How many of this client's Activation Strength exercises have met the
  // graduation criteria (see calcActivationGraduation) — surfaced as a badge
  // so it's visible without needing to open Log and check each exercise.
  const graduationReadyExercises = c => {
    const items = []; // {name, target}
    c.programs.forEach(p => {
      if (p.type === "Activation Strength") {
        [...new Set(p.exercises.map(e => e.name))].forEach(name => {
          if (calcActivationGraduation(p.sessions || [], name).ready) items.push({
            name,
            target: "General Strength"
          });
        });
      } else if (p.type === "General Strength") {
        [...new Set(p.exercises.map(e => e.name))].forEach(name => {
          if (calcGeneralStrengthGraduation(p.sessions || [], name).ready) items.push({
            name,
            target: "Max Strength"
          });
        });
      }
    });
    return items;
  };
  return /*#__PURE__*/React.createElement(Sheet, {
    title: "CLIENTS",
    onClose: onClose
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 10
    }
  }, active.map((c, i) => {
    const gradReady = graduationReadyExercises(c);
    return /*#__PURE__*/React.createElement("div", {
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
    }, c.programs.length, " program", c.programs.length !== 1 ? "s" : "", c.bw ? ` · ${c.bw} kg` : ""), gradReady.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexWrap: "wrap",
        gap: 5,
        marginTop: 5
      }
    }, [...new Set(gradReady.map(g => g.target))].map(target => {
      const count = gradReady.filter(g => g.target === target).length;
      return /*#__PURE__*/React.createElement("div", {
        key: target,
        style: {
          display: "inline-block",
          background: C.accent + "22",
          border: `1px solid ${C.accent}55`,
          borderRadius: 10,
          padding: "2px 8px",
          color: C.accent,
          fontSize: 10,
          fontWeight: 700
        }
      }, "✅ Ready for ", target, " (", count, ")");
    })), savedGroups.filter(g => g.clientIds.includes(c.id)).length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 5,
        flexWrap: "wrap",
        marginTop: 5
      }
    }, savedGroups.filter(g => g.clientIds.includes(c.id)).map(g => /*#__PURE__*/React.createElement("button", {
      key: g.id,
      onClick: e => {
        e.stopPropagation();
        onEditGroup(g);
      },
      style: {
        background: g.color + "22",
        border: `1px solid ${g.color}55`,
        borderRadius: 10,
        padding: "2px 8px",
        cursor: "pointer",
        color: g.color,
        fontSize: 10,
        fontWeight: 700
      }
    }, g.name)))), c.id === activeId && /*#__PURE__*/React.createElement("span", {
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
    }, "📦 Archive")));
  })), /*#__PURE__*/React.createElement("button", {
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
  onEditCategory,
  onDeleteCategory,
  onEditProgType,
  onDeleteProgType,
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
    addLabel: "Add category",
    onEditOption: onEditCategory,
    onDeleteOption: onDeleteCategory
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
    addLabel: "Add program type",
    onEditOption: onEditProgType,
    onDeleteOption: onDeleteProgType
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
  onEditCategory,
  onDeleteCategory,
  onEditProgType,
  onDeleteProgType,
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
  const [complexes, setComplexes] = useState(program.complexes ? program.complexes.map(c => ({
    ...c
  })) : []);
  const [editingComplex, setEditingComplex] = useState(undefined); // undefined=closed, null=new, {..}=edit
  const [confirmDeleteProgram, setConfirmDeleteProgram] = useState(false);
  const upd = (k, v) => setForm(f => ({
    ...f,
    [k]: v
  }));
  const submit = () => {
    if (!form.name.trim()) return;
    onSave({
      ...program,
      ...form,
      exercises,
      complexes
    });
    onClose();
  };
  if (confirmDeleteProgram) {
    return /*#__PURE__*/React.createElement(Sheet, {
      title: "🗑 DELETE PROGRAM?",
      onClose: () => setConfirmDeleteProgram(false)
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 14,
        color: C.text,
        lineHeight: 1.6,
        marginBottom: 20,
        textAlign: "center"
      }
    }, "Delete ", /*#__PURE__*/React.createElement("strong", null, "\"", form.name, "\""), "?", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12,
        color: C.muted
      }
    }, "All exercises and session history for this program will be lost. This cannot be undone.")), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 10
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setConfirmDeleteProgram(false),
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
      onClick: () => onDelete(program.id),
      style: {
        flex: 1,
        background: C.warn,
        color: "#fff",
        border: "none",
        borderRadius: 10,
        padding: "13px",
        fontFamily: "'Bebas Neue',cursive",
        fontSize: 18,
        letterSpacing: 2,
        cursor: "pointer"
      }
    }, "DELETE")));
  }
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
    addLabel: "Add category",
    onEditOption: onEditCategory,
    onDeleteOption: onDeleteCategory
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
    addLabel: "Add program type",
    onEditOption: onEditProgType,
    onDeleteOption: onDeleteProgType
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
      justifyContent: "space-between",
      alignItems: "center",
      marginTop: 18,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(SecLabel, {
    text: "Complexes (Permanent)"
  }), exercises.length >= 2 && /*#__PURE__*/React.createElement("button", {
    onClick: () => setEditingComplex(null),
    style: {
      background: "none",
      border: `1px dashed ${C.border}`,
      borderRadius: 8,
      padding: "5px 10px",
      cursor: "pointer",
      color: C.gold,
      fontSize: 11,
      fontWeight: 700
    }
  }, "🔗 New Complex")), exercises.length < 2 ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.muted,
      marginBottom: 8
    }
  }, "Add at least 2 exercises above to create a complex.") : complexes.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      borderRadius: 12,
      padding: "14px",
      textAlign: "center",
      border: `1px dashed ${C.border}`,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.muted
    }
  }, "No permanent complexes yet — this program logs each exercise independently.")) : complexes.map((cx, idx) => {
    const color = complexColorFor(idx);
    return /*#__PURE__*/React.createElement("div", {
      key: idx,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: C.card,
        borderRadius: 12,
        padding: "10px 12px",
        marginBottom: 8,
        border: `1px solid ${color}44`
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "'Bebas Neue',cursive",
        fontSize: 16,
        color,
        letterSpacing: 1,
        flexShrink: 0
      }
    }, complexLabelNumbered(complexes, idx)), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: C.text
      }
    }, cx.exerciseNames.join(" → ")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: C.muted
      }
    }, "💤 ", fmtComplexRest(cx))), /*#__PURE__*/React.createElement("button", {
      onClick: () => setEditingComplex({
        ...cx,
        _idx: idx
      }),
      style: {
        background: "none",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        cursor: "pointer",
        color: C.sub,
        fontSize: 12,
        flexShrink: 0
      }
    }, "✎"), /*#__PURE__*/React.createElement("button", {
      onClick: () => setEditingComplex({
        ...cx,
        _idx: idx,
        _startDeleteConfirm: true
      }),
      style: {
        background: "none",
        border: `1px solid ${C.warn}44`,
        borderRadius: 6,
        padding: "6px 10px",
        cursor: "pointer",
        color: C.warn,
        fontSize: 12,
        flexShrink: 0
      }
    }, "🗑"));
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginTop: 18,
      flexDirection: "column"
    }
  }, onDelete && /*#__PURE__*/React.createElement("button", {
    onClick: () => setConfirmDeleteProgram(true),
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
  }, "SAVE CHANGES"))), editingComplex !== undefined && /*#__PURE__*/React.createElement(ComplexEditorModal, {
    exerciseNames: exercises.map(e => e.name),
    complex: editingComplex,
    colorIdx: editingComplex ? editingComplex._idx : complexes.length,
    onSave: fields => {
      if (editingComplex) setComplexes(cs => cs.map((c, i) => i === editingComplex._idx ? fields : c));else setComplexes(cs => [...cs, fields]);
      setEditingComplex(undefined);
    },
    onDelete: () => {
      setComplexes(cs => cs.filter((_, i) => i !== editingComplex._idx));
      setEditingComplex(undefined);
    },
    onClose: () => setEditingComplex(undefined)
  }));
}

// ─── Programs Tab ─────────────────────────────────────────────────────────────

function ProgramsTab({
  client,
  clientIdx,
  allClients = [],
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
  onEditCategory,
  onDeleteCategory,
  onEditProgType,
  onDeleteProgType,
  customExercises = [],
  onEditEx,
  onDeleteEx,
  customEquipment = [],
  onEditEquip,
  onDeleteEquip,
  customLaterality = [],
  onEditLat,
  onDeleteLat,
  savedGroups = [],
  onStartGroup,
  onNewGroup,
  onEditGroup,
  activeSavedGroupId,
  onStopGroup,
  sessionGroup = [],
  onOpenSessionPicker,
  onRemoveFromSession
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [groupView, setGroupView] = useState("permanent"); // "permanent" | "temporary"
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
    text: "Groups"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setGroupView("permanent"),
    style: {
      flex: 1,
      background: groupView === "permanent" ? C.accent + "18" : C.card,
      border: `1px solid ${groupView === "permanent" ? C.accent + "55" : C.border}`,
      borderRadius: 10,
      padding: "8px",
      cursor: "pointer",
      color: groupView === "permanent" ? C.accent : C.sub,
      fontSize: 12,
      fontWeight: 700
    }
  }, "Group (Permanent)"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setGroupView("temporary"),
    style: {
      flex: 1,
      background: groupView === "temporary" ? C.gold + "18" : C.card,
      border: `1px solid ${groupView === "temporary" ? C.gold + "55" : C.border}`,
      borderRadius: 10,
      padding: "8px",
      cursor: "pointer",
      color: groupView === "temporary" ? C.gold : C.sub,
      fontSize: 12,
      fontWeight: 700
    }
  }, "Group (Temporary)")), groupView === "permanent" ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end",
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onNewGroup,
    style: {
      background: "none",
      border: `1px dashed ${C.border}`,
      borderRadius: 8,
      padding: "5px 10px",
      cursor: "pointer",
      color: C.accent,
      fontSize: 11,
      fontWeight: 700
    }
  }, "＋ New Group")), savedGroups.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      borderRadius: 12,
      padding: "14px",
      textAlign: "center",
      border: `1px dashed ${C.border}`,
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.muted
    }
  }, "No groups yet. Create one for regular duos/trios you train.")) : /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 18
    }
  }, savedGroups.map(g => /*#__PURE__*/React.createElement("div", {
    key: g.id,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      background: C.card,
      borderRadius: 12,
      padding: "10px 12px",
      marginBottom: 8,
      border: `1px solid ${g.color}44`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 12,
      height: 12,
      borderRadius: "50%",
      background: g.color,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 13,
      color: C.text,
      marginBottom: 4
    }
  }, g.name), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      flexWrap: "wrap",
      rowGap: 4
    }
  }, g.clientIds.map((cid, i) => {
    const gc = allClients.find(c => c.id === cid);
    if (!gc) return null;
    return /*#__PURE__*/React.createElement("div", {
      key: cid,
      style: {
        marginLeft: i === 0 ? 0 : -8,
        border: `2px solid ${C.card}`,
        borderRadius: "50%"
      }
    }, /*#__PURE__*/React.createElement(Avatar, {
      name: gc.name,
      idx: allClients.findIndex(c => c.id === cid),
      size: 22
    }));
  }))), /*#__PURE__*/React.createElement("button", {
    onClick: () => onEditGroup(g),
    style: {
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: "6px 10px",
      cursor: "pointer",
      color: C.sub,
      fontSize: 12
    }
  }, "✎"), activeSavedGroupId === g.id ? /*#__PURE__*/React.createElement("button", {
    onClick: onStopGroup,
    style: {
      background: C.warn + "22",
      border: `1px solid ${C.warn}55`,
      borderRadius: 6,
      padding: "6px 12px",
      cursor: "pointer",
      color: C.warn,
      fontSize: 12,
      fontWeight: 700
    }
  }, "⏹ Stop") : /*#__PURE__*/React.createElement("button", {
    onClick: () => onStartGroup(g),
    style: {
      background: g.color + "22",
      border: `1px solid ${g.color}55`,
      borderRadius: 6,
      padding: "6px 12px",
      cursor: "pointer",
      color: g.color,
      fontSize: 12,
      fontWeight: 700
    }
  }, "▶ Start"))))) : /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 18
    }
  }, sessionGroup.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      borderRadius: 12,
      padding: "14px",
      textAlign: "center",
      border: `1px dashed ${C.border}`,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.muted
    }
  }, "No temporary Group set for today. This resets when the app fully closes.")) : /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      borderRadius: 12,
      padding: "12px 14px",
      marginBottom: 12,
      border: `1px solid ${C.gold}44`
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.gold,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 8
    }
  }, "Today's Group (", sessionGroup.length, ")"), sessionGroup.map(cid => {
    const gc = allClients.find(c => c.id === cid);
    if (!gc) return null;
    return /*#__PURE__*/React.createElement("div", {
      key: cid,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 0"
      }
    }, /*#__PURE__*/React.createElement(Avatar, {
      name: gc.name,
      idx: allClients.findIndex(c => c.id === cid),
      size: 24
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        fontSize: 13,
        color: C.text,
        fontWeight: 600
      }
    }, gc.name), /*#__PURE__*/React.createElement("button", {
      onClick: () => onRemoveFromSession(cid),
      style: {
        background: "none",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "4px 8px",
        cursor: "pointer",
        color: C.warn,
        fontSize: 12
      }
    }, "✕"));
  })), /*#__PURE__*/React.createElement("button", {
    onClick: onOpenSessionPicker,
    style: {
      width: "100%",
      background: C.gold + "18",
      border: `1px solid ${C.gold}55`,
      borderRadius: 10,
      padding: "10px",
      cursor: "pointer",
      color: C.gold,
      fontSize: 13,
      fontWeight: 700
    }
  }, sessionGroup.length > 0 ? "✎ Edit Today's Group" : "＋ Set Today's Group")), /*#__PURE__*/React.createElement(SecLabel, {
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
    onEditCategory: onEditCategory,
    onDeleteCategory: onDeleteCategory,
    onEditProgType: onEditProgType,
    onDeleteProgType: onDeleteProgType,
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
    onAddProgType: onAddProgType,
    onEditCategory: onEditCategory,
    onDeleteCategory: onDeleteCategory,
    onEditProgType: onEditProgType,
    onDeleteProgType: onDeleteProgType
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
  onEditSetType,
  onDeleteSetType,
  clientBW,
  clientName,
  allClientSessions = [],
  onUpdateExercise,
  equipList,
  latList,
  restState,
  onStartRest,
  onPauseResumeRest,
  onAdjustRest,
  onDismissRest,
  focusReq,
  doneColor,
  onDeleteEntry,
  onUpdateEntry
}) {
  const today = fmtDateDMY(new Date());
  const progExNames = program ? program.exercises.map(e => e.name) : [];

  // Session-only complexes (superset/tri-set/giant set) — created fresh in the
  // Log tab, distinct from a program's permanent Complexes. Reset whenever the
  // active program changes, since they're tied to that program's own exercises.
  const [sessionComplexes, setSessionComplexes] = useState([]);
  const [editingSessionComplex, setEditingSessionComplex] = useState(undefined);

  // Session-only OVERRIDE of a permanent complex — lets the trainer adjust a
  // program-level complex just for today (different members, different rest
  // pattern) without touching the permanent definition. Keyed by the permanent
  // complex's index in program.complexes. Resets on program change, same as above.
  const [sessionComplexOverrides, setSessionComplexOverrides] = useState({});
  const [editingComplexOverrideIdx, setEditingComplexOverrideIdx] = useState(undefined);

  // Session-only VOID of a permanent complex — for when the trainer decides on
  // the day to have the client perform each exercise independently, without
  // deleting or editing the complex's permanent definition. Just a toggle:
  // voided complexes are excluded from grouping/timer behaviour but stay listed
  // (dimmed) so they're easy to re-enable. Resets on program change.
  const [voidedComplexIdxs, setVoidedComplexIdxs] = useState([]);

  // Merge permanent (program-level) and session-only complexes for use in the
  // pill bar and rest-timer logic below. Each gets a stable colour index across
  // both sources so permanent and session complexes never accidentally share a colour.
  const allComplexes = [...(program?.complexes || []).map((c, i) => ({
    ...c,
    ...(sessionComplexOverrides[i] || {}),
    _colorIdx: i,
    _permanent: true,
    _srcIdx: i,
    _overridden: !!sessionComplexOverrides[i],
    _voided: voidedComplexIdxs.includes(i)
  })), ...sessionComplexes.map((c, i) => ({
    ...c,
    _colorIdx: (program?.complexes?.length || 0) + i,
    _permanent: false,
    _srcIdx: i
  }))];
  const complexForEx = name => allComplexes.find(c => !c._voided && c.exerciseNames.includes(name));
  const [activeEx, setActiveEx] = useState(progExNames[0] || "");
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
    clusterRepsArr: [],
    clusterCount: "",
    clusterRest: "",
    dropSetCount: "",
    ascSetCount: "",
    pyrUpCount: "",
    pyrDownCount: ""
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
  // Editing an already-logged set: {sessionId, entryIdx} while active, else null.
  const [editingEntryRef, setEditingEntryRef] = useState(null);
  // Custom in-app delete confirmation — some mobile/PWA contexts silently
  // block native window.confirm(), which made the delete button look broken.
  const [confirmDelete, setConfirmDelete] = useState(null); // {sessionId, entryIdx, label}
  const [editingRestNext, setEditingRestNext] = useState(false);
  // Rest countdown itself now lives at App level (keyed per client) so multiple
  // clients' timers can run independently. These are just local read aliases.
  const restRemaining = restState.remaining;
  const restRunning = restState.running;
  const restTotal = restState.total;
  const startRestTimer = secs => onStartRest(secs, activeEx);
  const upd = (k, v) => setForm(f => ({
    ...f,
    [k]: v
  }));

  // When program changes, reset to first exercise (or empty if this program has none —
  // falling back to the global exercise library here was the bug: it made the Log page
  // show recommendation data for an exercise that isn't even part of this program).
  useEffect(() => {
    const first = program?.exercises[0]?.name || "";
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
      clusterRepsArr: [],
      clusterCount: "",
      clusterRest: "",
      dropSetCount: "",
      ascSetCount: "",
      pyrUpCount: "",
      pyrDownCount: ""
    });
    setShowBand(false);
    setTempoOverride({
      eccSecs: "",
      conSecs: ""
    });
    setEditingTempo(false);
    setSessionComplexes([]);
    setSessionComplexOverrides({});
    setVoidedComplexIdxs([]);
    setSetTypePerEx({});
  }, [program?.id]);

  // When switching exercise, clear reps/load but keep set type & rpe/rir
  const switchEx = name => {
    setActiveEx(name);
    setForm(f => ({
      ...f,
      type: setTypePerEx[name] || "Normal",
      setNo: String(nextSetNumber(name)),
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
      clusterRepsArr: [],
      clusterCount: "",
      clusterRest: "",
      dropSetCount: "",
      ascSetCount: "",
      pyrUpCount: "",
      pyrDownCount: ""
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
    setEditingEntryRef(null);
  };

  // Load an already-logged set's data into the form for editing in place.
  const startEditEntry = (sessionId, entryIdx, entry) => {
    if (entry.ex !== activeEx) setActiveEx(entry.ex);
    setForm(f => ({
      ...f,
      reps: String(entry.reps ?? ""),
      setNo: String(entry.set ?? "1"),
      type: entry.type || "Normal",
      load: entry.rawLoad != null ? String(entry.rawLoad) : entry.load != null ? String(entry.load) : "",
      rir: entry.rir ?? 2,
      rpe: entry.rpe ?? 7,
      velocity: entry.velocity != null ? String(entry.velocity) : "",
      repTime: entry.repTime != null ? String(entry.repTime) : "",
      holdDuration: entry.holdDuration != null ? String(entry.holdDuration) : "",
      mvic: entry.mvic != null ? String(entry.mvic) : "",
      force: entry.force != null ? String(entry.force) : "",
      bandLength: entry.bandLength || "",
      bandStrength: entry.bandStrength || "",
      bandUsage: entry.bandUsage || "resisted",
      bandLoadKg: entry.bandLoadKg != null ? String(entry.bandLoadKg) : "",
      comment: entry.comment || "",
      clusterReps: entry.clusterReps != null ? String(entry.clusterReps) : "",
      clusterRepsArr: entry.clusterRepsArr?.length ? entry.clusterRepsArr.map(String) : entry.clusterReps != null && entry.clusterCount != null ? Array(entry.clusterCount).fill(String(entry.clusterReps)) : [],
      clusterCount: entry.clusterCount != null ? String(entry.clusterCount) : "",
      clusterRest: entry.clusterRest != null ? String(entry.clusterRest) : "",
      dropSetCount: entry.dropSetLoads?.length ? String(entry.dropSetLoads.length) : "",
      ascSetCount: entry.ascSetLoads?.length ? String(entry.ascSetLoads.length) : "",
      pyrUpCount: entry.pyrUpCount != null ? String(entry.pyrUpCount) : "",
      pyrDownCount: entry.pyrLoads?.length && entry.pyrUpCount != null ? String(entry.pyrLoads.length - entry.pyrUpCount) : ""
    }));
    if (entry.dropSetReps?.length) setDropSetRepsArr(entry.dropSetReps.map(String));
    if (entry.dropSetMainReps != null) setDropSetMainReps(String(entry.dropSetMainReps));
    if (entry.ascSetReps?.length) setAscSetRepsArr(entry.ascSetReps.map(String));
    if (entry.ascSetMainReps != null) setAscSetMainReps(String(entry.ascSetMainReps));
    if (entry.pyrReps?.length) setPyrRepsArr(entry.pyrReps.map(String));
    if (entry.pyrMainReps != null) setPyrMainReps(String(entry.pyrMainReps));
    setShowBand(!!entry.bandStrength);
    const sessionDate = sessions.find(s => s.id === sessionId)?.date || today;
    setEditingEntryRef({
      sessionId,
      entryIdx,
      sessionDate
    });
  };
  const cancelEditEntry = () => {
    setEditingEntryRef(null);
    switchEx(activeEx); // clears form back to a fresh blank state
  };
  const bandKgLive = showBand && form.bandLoadKg ? +form.bandLoadKg : 0;
  const bandSignedLive = bandKgLive ? form.bandUsage === "assisted" ? -bandKgLive : bandKgLive : 0;

  // Zone target (load + reps + RIR), shared across the Load/Reps/RIR fields below.
  const zoneTarget = calcZoneTarget(allClientSessions, activeEx, program?.type);

  // Manual Rep Max Calculator — trainer's own rep-max/RIR choice, independent
  // of the automated zone-target suggestion above.
  const [showRMCalc, setShowRMCalc] = useState(false);
  const [rmCalcN, setRmCalcN] = useState("2");
  const [rmCalcRIR, setRmCalcRIR] = useState("1");
  const rmCalc = calcManualRM(allClientSessions, activeEx, rmCalcN, rmCalcRIR);

  // Per-exercise Set Type memory — each exercise remembers its own Set Type
  // (Normal, Cluster Set, etc.) independently, session-only. Without this,
  // switching between exercises (manually or via a complex's auto-advance)
  // would just carry over whichever Set Type happened to be active, silently
  // turning one exercise's Cluster Set into another's, or vice versa. A newly
  // visited exercise always starts at Normal unless the trainer has already
  // set something else for it this session.
  const [setTypePerEx, setSetTypePerEx] = useState({});

  // Intra-cluster rest — escalates PER GAP BETWEEN CLUSTERS within one set
  // (Gap 1→2, Gap 2→3...), NOT per set. Auto-resets to a clean default (5s,
  // flat) every time Set # changes, but stays fully editable so any specific
  // set can be given its own base/trend/increment manually.
  const [clusterRestBase, setClusterRestBase] = useState("5");
  const [clusterRestDir, setClusterRestDir] = useState("+");
  const [clusterRestIncAmt, setClusterRestIncAmt] = useState("0");
  const [clusterRestTurnsCfg, setClusterRestTurnsCfg] = useState([]);
  const prevSetNoRef = React.useRef(form.setNo);
  useEffect(() => {
    if (prevSetNoRef.current !== form.setNo) {
      setClusterRestBase("5");
      setClusterRestDir("+");
      setClusterRestIncAmt("0");
      setClusterRestTurnsCfg([]);
      prevSetNoRef.current = form.setNo;
    }
  }, [form.setNo]);

  // Live intra-cluster mini-timer sequence — walks the trainer through each
  // cluster in order, auto-counting down the computed gap rest between them
  // with its own short chime, before enabling the next cluster. Entirely
  // local/session-only; doesn't touch the main between-set rest timer at all.
  const [clusterSeqActive, setClusterSeqActive] = useState(false);
  const [clusterSeqIdx, setClusterSeqIdx] = useState(0); // 0-based: which cluster is currently active
  const [clusterSeqRemaining, setClusterSeqRemaining] = useState(0); // seconds left in the current gap countdown, 0 = not resting
  // True the moment a gap countdown finishes, until the trainer explicitly taps
  // "Continue" to move on — keeps the heading correctly showing which cluster
  // JUST finished (not the next one) all the way through the rest, only
  // advancing once the trainer confirms it's time to move on.
  const [clusterSeqCompleted, setClusterSeqCompleted] = useState(false);
  const clusterCountNum = +form.clusterCount || 0;
  const clusterNumGaps = Math.max(0, clusterCountNum - 1);
  const clusterGapSeq = clusterRestBase && clusterNumGaps > 0 ? Array.from({
    length: clusterNumGaps
  }, (_, i) => calcClusterGapRest(+clusterRestBase, clusterRestDir, +clusterRestIncAmt, i + 1, clusterRestTurnsCfg)) : [];

  // Reset the sequence whenever the cluster setup changes meaningfully, so a
  // stale in-progress sequence never lingers against a different configuration.
  useEffect(() => {
    setClusterSeqActive(false);
    setClusterSeqIdx(0);
    setClusterSeqRemaining(0);
    setClusterSeqCompleted(false);
  }, [form.setNo, form.clusterCount, activeEx]);
  const playClusterChime = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [880, 1175].forEach((freq, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g);
        g.connect(ctx.destination);
        o.type = "sine";
        o.frequency.value = freq;
        g.gain.value = 0.15;
        const startAt = ctx.currentTime + i * 0.11;
        o.start(startAt);
        o.stop(startAt + 0.12);
      });
    } catch {}
    try {
      navigator.vibrate && navigator.vibrate(120);
    } catch {}
  };

  // Distinct "rest complete" chime — the work-complete chime above rises
  // (880→1175Hz); this one deliberately falls (1175→700Hz) so the trainer can
  // tell, by ear alone, whether a contraction just ended (time to rest) or a
  // rest period just ended (contraction fully complete, ready to continue) —
  // without needing to look at the screen. Vibration pattern also differs
  // (double-pulse vs single) for the same reason.
  const playRestCompleteChime = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [1175, 700].forEach((freq, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g);
        g.connect(ctx.destination);
        o.type = "sine";
        o.frequency.value = freq;
        g.gain.value = 0.15;
        const startAt = ctx.currentTime + i * 0.11;
        o.start(startAt);
        o.stop(startAt + 0.12);
      });
    } catch {}
    try {
      navigator.vibrate && navigator.vibrate([70, 50, 70]);
    } catch {}
  };

  // "Get ready" countdown beep (3...2...1...) — a third, distinct tone from
  // both chimes above: a single square-wave note (vs. their two-note sine
  // pairs), so the pre-contraction countdown is unmistakably different from
  // either "work complete" or "rest complete". Played once per number as the
  // countdown ticks down, immediately before every contraction across all 7
  // iso protocols.
  const playCountdownBeep = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.type = "square";
      o.frequency.value = 500;
      g.gain.value = 0.1;
      o.start(ctx.currentTime);
      o.stop(ctx.currentTime + 0.1);
    } catch {}
    try {
      navigator.vibrate && navigator.vibrate(40);
    } catch {}
  };

  // Ballistic-specific beep — acoustically distinguishes the two possible
  // durations (0.5s vs 1s) rather than always sounding identical: a short,
  // sharp single note for the shorter duration, a slightly longer note for
  // the longer one. Separate from playClusterChime (used everywhere else)
  // since those durations don't vary and don't need this distinction.
  const playBallisticBeep = holdSecs => {
    const isShort = (+holdSecs || 1) <= 0.5;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.type = "sine";
      o.frequency.value = isShort ? 1400 : 950; // shorter duration -> higher, sharper pitch
      g.gain.value = 0.18;
      const dur = isShort ? 0.08 : 0.18; // shorter duration -> shorter beep, longer -> longer beep
      o.start(ctx.currentTime);
      o.stop(ctx.currentTime + dur);
    } catch {}
    try {
      navigator.vibrate && navigator.vibrate(isShort ? 60 : 140);
    } catch {}
  };

  // 1s tick for the cluster mini-timer, independent of the main rest timer.
  useEffect(() => {
    if (clusterSeqRemaining <= 0) return;
    const t = setTimeout(() => {
      setClusterSeqRemaining(r => {
        if (r <= 1) {
          playClusterChime();
          setClusterSeqCompleted(true);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [clusterSeqRemaining]);

  // Drop Set sequence — same state-machine shape as the Cluster Set sequence,
  // but reps are entered AFTER each drop (since actual reps-to-fatigue can't be
  // predicted in advance), and the "rest" is really just a short transition
  // (~15s) for changing the load — true drop sets deliberately use minimal/no
  // rest, since the whole mechanism relies on continuing under accumulated
  // fatigue rather than recovering from it. The main/top set (form.load,
  // form.reps) is the client's regular working set — it is NOT itself "Drop
  // 1"; Drop 1 is the first reduction AFTER it.
  const [dropSetPct, setDropSetPct] = useState("20"); // base % (Main set -> Drop 1)
  const [dropPctDir, setDropPctDir] = useState("+");
  const [dropPctIncAmt, setDropPctIncAmt] = useState("0");
  const [dropPctTurnsCfg, setDropPctTurnsCfg] = useState([]);
  const [dropSetRepsArr, setDropSetRepsArr] = useState([]); // filled in AFTER each drop completes
  const [dropSetMainReps, setDropSetMainReps] = useState(""); // snapshot of the top set's reps, taken when the sequence starts
  const [dropSetActive, setDropSetActive] = useState(false);
  const [dropSetIdx, setDropSetIdx] = useState(0);
  const [dropSetRemaining, setDropSetRemaining] = useState(0);
  const [dropSetCompleted, setDropSetCompleted] = useState(false);
  const dropSetCountNum = +form.dropSetCount || 0;
  const dropSetLoads = calcDropSetLoads(+form.load || 0, +dropSetPct, dropPctDir, +dropPctIncAmt, dropPctTurnsCfg, dropSetCountNum);
  // Reference-only suggestion for each drop's reps. A "fresh 1RM" estimate at
  // the new load would be scientifically wrong here — it ignores that the
  // client is already fatigued from the stage just performed. Instead, use the
  // standard coaching heuristic: a well-calibrated ~20-25% drop is specifically
  // sized to let the client repeat a SIMILAR rep count to the stage before it
  // (weight decrease roughly offsets accumulated fatigue) — so suggest the
  // PREVIOUS stage's actual reps (main set for Drop 1, prior drop after that).
  // Falls back recursively through earlier drops (ultimately to the main set)
  // if a nearer actual hasn't been entered yet, so every drop box always has a
  // suggestion — 1 drop or 10, filled in order or not.
  const dropSetSuggestedReps = dropIdx => {
    if (dropIdx === 0) {
      const mainReps = +dropSetMainReps || +form.reps;
      return mainReps > 0 ? mainReps : null;
    }
    const prevActual = +dropSetRepsArr[dropIdx - 1];
    return prevActual > 0 ? prevActual : dropSetSuggestedReps(dropIdx - 1);
  };
  useEffect(() => {
    setDropSetActive(false);
    setDropSetIdx(0);
    setDropSetRemaining(0);
    setDropSetCompleted(false);
    setDropSetRepsArr(Array(dropSetCountNum).fill(""));
    setDropSetMainReps("");
  }, [form.setNo, form.dropSetCount, activeEx]);

  // Ascending Set ("Run the Rack") sequence — the mirror image of Drop Set's
  // state machine, load INCREASING instead of decreasing. Unlike a drop set,
  // there's no "offsetting" mechanism here — load and fatigue climb together,
  // so this is a considerably more demanding technique, not just Drop Set's
  // symmetrical opposite. Reps are entered AFTER each increase for the same
  // reason as Drop Set (actual reps-to-fatigue can't be predicted), and the
  // brief transition is for changing the load, not recovery. The main/
  // starting set (form.load, form.reps) is the client's regular working set —
  // it is NOT itself "Up 1"; Up 1 is the first increase after it.
  const [ascSetPct, setAscSetPct] = useState("5"); // base % (Main set -> Up 1)
  const [ascPctDir, setAscPctDir] = useState("+");
  const [ascPctIncAmt, setAscPctIncAmt] = useState("0");
  const [ascPctTurnsCfg, setAscPctTurnsCfg] = useState([]);
  const [ascSetRepsArr, setAscSetRepsArr] = useState([]); // filled in AFTER each increase completes
  const [ascSetMainReps, setAscSetMainReps] = useState(""); // snapshot of the starting set's reps, taken when the sequence starts
  const [ascSetActive, setAscSetActive] = useState(false);
  const [ascSetIdx, setAscSetIdx] = useState(0);
  const [ascSetRemaining, setAscSetRemaining] = useState(0);
  const [ascSetCompleted, setAscSetCompleted] = useState(false);
  const ascSetCountNum = +form.ascSetCount || 0;
  const ascSetLoads = calcAscSetLoads(+form.load || 0, +ascSetPct, ascPctDir, +ascPctIncAmt, ascPctTurnsCfg, ascSetCountNum);
  // Reference-only suggestion for each increase's reps. Since load AND fatigue
  // both climb here (no offsetting mechanism), reps should be expected to
  // DECLINE stage to stage, not repeat — so unlike Drop Set's "suggest the
  // same as before" heuristic, this just suggests slightly fewer than the
  // previous stage's actual reps as a starting reference, still falling back
  // recursively through earlier stages (ultimately the main set) if a nearer
  // actual hasn't been entered yet.
  const ascSetSuggestedReps = upIdx => {
    if (upIdx === 0) {
      const mainReps = +ascSetMainReps || +form.reps;
      return mainReps > 0 ? Math.max(1, mainReps - 1) : null;
    }
    const prevActual = +ascSetRepsArr[upIdx - 1];
    return prevActual > 0 ? Math.max(1, prevActual - 1) : ascSetSuggestedReps(upIdx - 1);
  };
  useEffect(() => {
    setAscSetActive(false);
    setAscSetIdx(0);
    setAscSetRemaining(0);
    setAscSetCompleted(false);
    setAscSetRepsArr(Array(ascSetCountNum).fill(""));
    setAscSetMainReps("");
  }, [form.setNo, form.ascSetCount, activeEx]);

  // Pyramid Set (continuous) — combines Ascending Set's climb with Drop Set's
  // descent into ONE continuous sequence: starting load -> ascending stages
  // (Up 1, Up 2, ...) -> a peak -> descending stages (Down 1, Down 2, ...),
  // all with no rest, using the client's regular starting set as the base.
  // Deliberately does NOT support the reverse order (descend then climb back
  // up) — asking for a near-peak effort at the point of MAXIMUM accumulated
  // fatigue is structurally backwards, not just harder, since the entire
  // reason a climb is safely achievable is doing it while still relatively
  // fresh. Ascending and descending each keep their OWN independent wave %
  // config (separate base/trend/increment/turns), since 5%-ish ascending
  // jumps and 20%-ish descending drops are different magnitudes for a reason
  // — forcing one shared pattern across both halves wouldn't make sense.
  const [pyrUpPct, setPyrUpPct] = useState("5");
  const [pyrUpDir, setPyrUpDir] = useState("+");
  const [pyrUpIncAmt, setPyrUpIncAmt] = useState("0");
  const [pyrUpTurnsCfg, setPyrUpTurnsCfg] = useState([]);
  const [pyrDownPct, setPyrDownPct] = useState("20");
  const [pyrDownDir, setPyrDownDir] = useState("+");
  const [pyrDownIncAmt, setPyrDownIncAmt] = useState("0");
  const [pyrDownTurnsCfg, setPyrDownTurnsCfg] = useState([]);
  const [pyrRepsArr, setPyrRepsArr] = useState([]); // covers BOTH up and down stages, one combined array
  const [pyrMainReps, setPyrMainReps] = useState(""); // snapshot of the starting set's reps, taken when the sequence starts
  const [pyrActive, setPyrActive] = useState(false);
  const [pyrIdx, setPyrIdx] = useState(0);
  const [pyrRemaining, setPyrRemaining] = useState(0);
  const [pyrCompleted, setPyrCompleted] = useState(false);
  const pyrUpCountNum = +form.pyrUpCount || 0;
  const pyrDownCountNum = +form.pyrDownCount || 0;
  const pyrUpLoads = calcAscSetLoads(+form.load || 0, +pyrUpPct, pyrUpDir, +pyrUpIncAmt, pyrUpTurnsCfg, pyrUpCountNum);
  const pyrPeakLoad = pyrUpLoads.length ? pyrUpLoads[pyrUpLoads.length - 1] : +form.load || 0;
  const pyrDownLoads = calcDropSetLoads(pyrPeakLoad, +pyrDownPct, pyrDownDir, +pyrDownIncAmt, pyrDownTurnsCfg, pyrDownCountNum);
  const pyrAllLoads = [...pyrUpLoads, ...pyrDownLoads]; // combined stage sequence, main/starting set excluded

  // Suggested reps per stage — ascending stages use the SAME "expect fewer
  // than before" logic as a standalone Ascending Set (load AND fatigue climb
  // together, no offsetting mechanism); descending stages switch to Drop
  // Set's "suggest the same as the previous stage's actual" logic instead,
  // since the load reduction there IS the offsetting mechanism, specifically
  // meant to let a similar rep count be maintained despite fatigue.
  const pyrSuggestedReps = idx => {
    if (idx < pyrUpCountNum) {
      if (idx === 0) {
        const mainReps = +pyrMainReps || +form.reps;
        return mainReps > 0 ? Math.max(1, mainReps - 1) : null;
      }
      const prevActual = +pyrRepsArr[idx - 1];
      return prevActual > 0 ? Math.max(1, prevActual - 1) : pyrSuggestedReps(idx - 1);
    }
    const prevActual = +pyrRepsArr[idx - 1];
    if (prevActual > 0) return prevActual;
    return idx > 0 ? pyrSuggestedReps(idx - 1) : null;
  };
  useEffect(() => {
    setPyrActive(false);
    setPyrIdx(0);
    setPyrRemaining(0);
    setPyrCompleted(false);
    setPyrRepsArr(Array(pyrUpCountNum + pyrDownCountNum).fill(""));
    setPyrMainReps("");
  }, [form.setNo, form.pyrUpCount, form.pyrDownCount, activeEx]);
  useEffect(() => {
    if (pyrRemaining <= 0) return;
    const t = setTimeout(() => setPyrRemaining(r => r - 1), 1000);
    return () => clearTimeout(t);
  }, [pyrRemaining]);

  // Negative Set breakdown — deliberately a SEPARATE, dedicated eccentric/
  // concentric input from the general tempo override editor elsewhere on this
  // page (not synced with it), since a true "Negative" set is an intentional,
  // focused technique with its own tempo decisions, not just an adjustment to
  // the exercise's usual prescribed tempo. Resets when switching exercises
  // (tempo is exercise-specific) but persists across sets of the same
  // exercise, since the eccentric/concentric timing is usually consistent
  // for the whole exercise within a session.
  const [negEccSecs, setNegEccSecs] = useState("4");
  const [negConSecs, setNegConSecs] = useState("1");
  useEffect(() => {
    setNegEccSecs("4");
    setNegConSecs("1");
  }, [activeEx]);

  // Ovrc Iso-Strength+Hypertrophy — a genuine two-phase combo protocol (not a
  // single-parameter type like the other five Iso types), so it gets its own
  // dedicated config + live guided sequence, matching the Cluster/Drop Set
  // pattern rather than the simpler Contractions+Duration Iso box. Config
  // persists across sets of the same exercise (reset on exercise change),
  // matching Negative Set's tempo config.
  const [comboRounds, setComboRounds] = useState("5"); // Phase 1: number of max-effort rounds
  const [comboContractSecs, setComboContractSecs] = useState("3"); // Phase 1: contraction duration per round
  const [comboRestSecs, setComboRestSecs] = useState("5"); // Phase 1: rest between rounds
  const [comboHoldPct, setComboHoldPct] = useState("50"); // Phase 2: submaximal hold effort %
  const [comboHoldSecs, setComboHoldSecs] = useState("45"); // Phase 2: hold duration
  const [comboCycleRestSecs, setComboCycleRestSecs] = useState("90"); // dedicated rest before repeating the WHOLE protocol
  useEffect(() => {
    setComboRounds("5");
    setComboContractSecs("3");
    setComboRestSecs("5");
    setComboHoldPct("50");
    setComboHoldSecs("45");
    setComboCycleRestSecs("90");
  }, [activeEx]);

  // Live guided sequence — walks through Phase 1 (rounds of contract+rest)
  // then Phase 2 (the extended submaximal hold), with its own countdown and
  // chime, mirroring the exact state-machine shape used for Cluster/Drop Sets:
  // heading stays accurate through each countdown, an explicit "COMPLETED!"
  // + "Continue" step between phases rather than silently advancing.
  const [comboActive, setComboActive] = useState(false);
  const [comboStage, setComboStage] = useState("ready"); // "ready" | "precontract" | "contract" | "contractend" | "rest" | "roundrestdone" | "phase1done" | "prehold" | "hold" | "holdend" | "phase2done" | "cyclerest" | "done"
  const [comboRoundIdx, setComboRoundIdx] = useState(0); // 0-based, which Phase 1 round
  const [comboRemaining, setComboRemaining] = useState(0);
  const [comboPaused, setComboPaused] = useState(false); // pauses the countdown in place, without losing progress
  const [comboPrecount, setComboPrecount] = useState(0); // 3,2,1 "get ready" countdown before each round's contraction AND before Phase 2's hold
  const [comboPhaseAuto, setComboPhaseAuto] = useState(false); // dedicated toggle, separate from isoAutoContinue, just for the Phase 1 -> Phase 2 transition
  useEffect(() => {
    setComboActive(false);
    setComboStage("ready");
    setComboRoundIdx(0);
    setComboRemaining(0);
    setComboPaused(false);
    setComboPrecount(0);
  }, [form.setNo, activeEx]);

  // "Get ready" 3-2-1 countdown — fires before EVERY round's contraction
  // (Phase 1) and before Phase 2's hold, giving the client an audible/visual
  // cue right before each active-effort stage begins, matching standard
  // "3...2...1...GO" coaching cadence.
  useEffect(() => {
    if (comboPrecount <= 0 || comboPaused) return;
    const t = setTimeout(() => {
      playCountdownBeep();
      setComboPrecount(p => {
        if (p > 1) return p - 1;
        if (comboStage === "precontract") {
          setComboStage("contract");
          setComboRemaining(+comboContractSecs || 3);
        } else if (comboStage === "prehold") {
          setComboStage("hold");
          setComboRemaining(+comboHoldSecs || 45);
        }
        return 0;
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [comboPrecount, comboPaused]);

  // 1s tick — purely counts down; all stage/round transitions happen in the
  // separate effect below once remaining actually reaches 0, keeping the two
  // concerns (ticking vs. transitioning) cleanly separated. Paused simply
  // skips ticking altogether, leaving comboRemaining exactly where it was.
  useEffect(() => {
    if (comboRemaining <= 0 || comboPaused) return;
    const t = setTimeout(() => {
      setComboRemaining(r => {
        if (r <= 1) {
          // "contract" and "hold" are both active-effort stages (Phase 2's
          // hold is sustained work, not rest) — use the work-complete chime.
          // "rest" and "cyclerest" are genuine recovery periods — use the
          // distinct falling tone instead.
          if (comboStage === "contract" || comboStage === "hold") playClusterChime();else playRestCompleteChime();
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [comboRemaining, comboPaused]);

  // Transition effect — fires whenever the countdown actually lands on 0
  // while the sequence is active, advancing to whatever comes next:
  //  contract   -> rest (more rounds left) or phase1done (that was the last round)
  //  rest       -> contract, automatically starting the next round's countdown
  //  hold       -> cyclerest, a dedicated (longer) recovery period before the
  //                trainer would repeat the WHOLE protocol again — the compound
  //                fatigue from 5 rounds of max effort PLUS an extended
  //                submaximal hold genuinely warrants more than the normal
  //                between-set rest this exercise might otherwise use.
  //  cyclerest  -> done
  // "ready" and "phase1done"/"done" are intentionally NOT handled here — they
  // require an explicit trainer tap (Start / Continue) to proceed, not an
  // automatic transition.
  useEffect(() => {
    if (!comboActive || comboRemaining !== 0) return;
    if (comboStage === "contract") {
      setComboStage("contractend");
    } else if (comboStage === "rest") {
      setComboRoundIdx(i => i + 1);
      if (isoAutoContinue) {
        setComboStage("precontract");
        setComboPrecount(3);
      } else {
        setComboStage("roundrestdone");
      }
    } else if (comboStage === "hold") {
      setComboStage("holdend");
    } else if (comboStage === "cyclerest") {
      setComboStage("done");
    }
  }, [comboRemaining, comboActive]);

  // The brief ~1s "END!" flash for Phase 1 rounds and Phase 2's hold — after
  // it elapses, THIS is where the actual transition to rest/phase1done (from
  // a round) or cyclerest (from the hold) happens.
  useEffect(() => {
    if (comboStage !== "contractend" && comboStage !== "holdend") return;
    if (comboPaused) return;
    const t = setTimeout(() => {
      if (comboStage === "contractend") {
        if (comboRoundIdx < (+comboRounds || 1) - 1) {
          setComboStage("rest");
          setComboRemaining(+comboRestSecs || 5);
        } else if (comboPhaseAuto) {
          setComboStage("prehold");
          setComboPrecount(3);
        } else {
          setComboStage("phase1done");
        }
      } else {
        if (isoAutoContinue) {
          setComboStage("cyclerest");
          setComboRemaining(+comboCycleRestSecs || 90);
        } else {
          setComboStage("phase2done");
        }
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [comboStage, comboPaused]);

  // Simple timed Iso sequence — for the 5 types that are just "N contractions
  // at a single fixed duration each" (Max, Endurance, Sustained, Holds, GPP).
  // Kept deliberately separate from Combo's two-phase machine and Ballistic's
  // sub-second one, even though the underlying shape (contract, countdown,
  // beep, explicit Continue, repeat) is similar — matching the existing
  // pattern of each set type owning its own simple, independent state rather
  // than a shared configurable engine. Duration comes from form.holdDuration
  // (already selected per-type in the box above); count comes from
  // form.reps (Contractions).
  const [isoSeqActive, setIsoSeqActive] = useState(false);
  const [isoSeqIdx, setIsoSeqIdx] = useState(0); // 0-based, which contraction
  const [isoSeqRemaining, setIsoSeqRemaining] = useState(0);
  const [isoSeqResting, setIsoSeqResting] = useState(false); // true = isoSeqRemaining counts down REST, not the work contraction
  const [isoSeqPrecount, setIsoSeqPrecount] = useState(0); // 3,2,1 "get ready" countdown before each contraction; 0 = not counting
  const [isoSeqJustEnded, setIsoSeqJustEnded] = useState(false); // brief ~1s "END!" flash right when a contraction finishes, before rest/completed
  const [isoSeqCompleted, setIsoSeqCompleted] = useState(false);
  const [isoSeqPaused, setIsoSeqPaused] = useState(false);
  const [isoRestSel, setIsoRestSel] = useState(String(ISO_REST_SECS["Ovrc Iso-Max"] || 5)); // configurable rest between contractions
  const [isoAutoContinue, setIsoAutoContinue] = useState(false); // false = Manual (tap Continue between contractions), true = Auto (advances on its own after rest)
  useEffect(() => {
    setIsoSeqActive(false);
    setIsoSeqIdx(0);
    setIsoSeqRemaining(0);
    setIsoSeqResting(false);
    setIsoSeqPrecount(0);
    setIsoSeqJustEnded(false);
    setIsoSeqCompleted(false);
    setIsoSeqPaused(false);
    setIsoRestSel(String(ISO_REST_SECS[form.type] || 5));
  }, [form.setNo, activeEx, form.type]);

  // "Get ready" 3-2-1 countdown, immediately before the actual work countdown
  // starts. Beeps once per number, then hands off to the real work countdown.
  useEffect(() => {
    if (isoSeqPrecount <= 0 || isoSeqPaused) return;
    const t = setTimeout(() => {
      playCountdownBeep();
      setIsoSeqPrecount(p => {
        if (p > 1) return p - 1;
        setIsoSeqRemaining(+form.holdDuration || 3);
        return 0;
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [isoSeqPrecount, isoSeqPaused]);
  useEffect(() => {
    if (isoSeqRemaining <= 0 || isoSeqPaused) return;
    const t = setTimeout(() => {
      setIsoSeqRemaining(r => {
        if (r > 1) return r - 1;
        // Landed on 0 — if this was the WORK countdown, chime (rising tone)
        // and show a brief "END!" flash before moving on (the actual
        // rest-or-completed transition happens in the separate effect below,
        // once the flash's own short timer elapses). If this was the REST
        // countdown, chime with the DISTINCT falling tone instead, so the
        // trainer can tell which one just happened without looking.
        if (!isoSeqResting) {
          playClusterChime();
          setIsoSeqJustEnded(true);
          return 0;
        }
        playRestCompleteChime();
        setIsoSeqResting(false);
        if (isoAutoContinue) {
          setIsoSeqIdx(i => i + 1);
          setIsoSeqPrecount(3);
          return 0;
        }
        setIsoSeqCompleted(true);
        return 0;
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [isoSeqRemaining, isoSeqPaused]);

  // The brief ~1s "END!" flash itself — after it elapses, THIS is where the
  // actual transition to rest (more contractions left) or completed (last
  // one) happens, kept separate from the work-countdown effect above so the
  // flash has its own independent timer.
  useEffect(() => {
    if (!isoSeqJustEnded || isoSeqPaused) return;
    const t = setTimeout(() => {
      setIsoSeqJustEnded(false);
      if (isoSeqIdx < (+form.reps || 1) - 1) {
        setIsoSeqResting(true);
        setIsoSeqRemaining(+isoRestSel || ISO_REST_SECS[form.type] || 5);
      } else {
        setIsoSeqCompleted(true);
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [isoSeqJustEnded, isoSeqPaused]);

  // Ballistic sequence — 0.5-1s contractions are shorter than a single 1s
  // tick of the countdown system above, so a traditional "3...2...1..."
  // countdown isn't meaningful here. Instead: tap to start, a "GO!" cue shows
  // immediately, then a beep fires precisely after the selected duration
  // (using a raw sub-second timeout rather than the 1s-tick system). The rest
  // AFTER that beep, though, uses the normal 1s-tick countdown — it's a
  // multi-second period, so a real countdown genuinely helps there. Pause on
  // the "ready to start" screen only (nothing meaningful to pause mid-flight
  // during the sub-second contraction itself); Stop aborts entirely at any point.
  const [ballisticActive, setBallisticActive] = useState(false);
  const [ballisticIdx, setBallisticIdx] = useState(0);
  const [ballisticGo, setBallisticGo] = useState(false); // true while the sub-second timer is running
  const [ballisticPrecount, setBallisticPrecount] = useState(0); // 3,2,1 "get ready" countdown before each contraction
  const [ballisticJustEnded, setBallisticJustEnded] = useState(false); // brief ~1s "END!" flash right when a contraction finishes, before rest/completed
  const [ballisticRestRemaining, setBallisticRestRemaining] = useState(0);
  const [ballisticCompleted, setBallisticCompleted] = useState(false);
  const [ballisticPaused, setBallisticPaused] = useState(false);
  const [ballisticRestSel, setBallisticRestSel] = useState(String(ISO_REST_SECS["Ovrc Iso-Ballistic"] || 5)); // configurable rest between contractions
  useEffect(() => {
    setBallisticActive(false);
    setBallisticIdx(0);
    setBallisticGo(false);
    setBallisticPrecount(0);
    setBallisticJustEnded(false);
    setBallisticRestRemaining(0);
    setBallisticCompleted(false);
    setBallisticPaused(false);
    setBallisticRestSel(String(ISO_REST_SECS["Ovrc Iso-Ballistic"] || 5));
  }, [form.setNo, activeEx, form.type]);
  useEffect(() => {
    if (ballisticPrecount <= 0 || ballisticPaused) return;
    const t = setTimeout(() => {
      playCountdownBeep();
      setBallisticPrecount(p => {
        if (p > 1) return p - 1;
        setBallisticGo(true);
        return 0;
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [ballisticPrecount, ballisticPaused]);
  useEffect(() => {
    if (!ballisticGo) return;
    const ms = Math.round((+form.holdDuration || 0.5) * 1000);
    const t = setTimeout(() => {
      playBallisticBeep(form.holdDuration);
      setBallisticGo(false);
      setBallisticJustEnded(true);
    }, ms);
    return () => clearTimeout(t);
  }, [ballisticGo]);
  // The brief ~1s "END!" flash — after it elapses, THIS is where the actual
  // transition to rest (more contractions left) or completed (last one) happens.
  useEffect(() => {
    if (!ballisticJustEnded || ballisticPaused) return;
    const t = setTimeout(() => {
      setBallisticJustEnded(false);
      if (ballisticIdx < (+form.reps || 1) - 1) {
        setBallisticRestRemaining(+ballisticRestSel || ISO_REST_SECS["Ovrc Iso-Ballistic"] || 5);
      } else {
        setBallisticCompleted(true);
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [ballisticJustEnded, ballisticPaused]);
  useEffect(() => {
    if (ballisticRestRemaining <= 0 || ballisticPaused) return;
    const t = setTimeout(() => {
      setBallisticRestRemaining(r => {
        if (r <= 1) {
          playRestCompleteChime();
          if (isoAutoContinue) {
            setBallisticIdx(i => i + 1);
            setBallisticPrecount(3);
            return 0;
          }
          setBallisticCompleted(true);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [ballisticRestRemaining, ballisticPaused]);
  useEffect(() => {
    if (dropSetRemaining <= 0) return;
    const t = setTimeout(() => {
      setDropSetRemaining(r => {
        if (r <= 1) {
          playClusterChime();
          setDropSetCompleted(true);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [dropSetRemaining]);
  useEffect(() => {
    if (ascSetRemaining <= 0) return;
    const t = setTimeout(() => {
      setAscSetRemaining(r => {
        if (r <= 1) {
          playClusterChime();
          setAscSetCompleted(true);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [ascSetRemaining]);

  // When arriving here via a pill tap (quick-switch), jump straight to whichever
  // exercise that client's rest timer belongs to, rather than leaving them on
  // whatever exercise happened to be selected last.
  useEffect(() => {
    if (focusReq?.exName && program?.exercises?.some(e => e.name === focusReq.exName)) {
      switchEx(focusReq.exName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReq?.token]);
  const effLoadLive = Math.max(0, (form.load ? +form.load : 0) + bandSignedLive);
  const vol = form.reps && effLoadLive ? +form.reps * effLoadLive : 0;
  const sessions = program?.sessions || [];

  // Suggested Set # = smallest positive integer not already used today for this
  // exercise. Naturally auto-increments in the normal case (1,2,3 logged → next
  // is 4), but also fills gaps left by a deleted set (1,3 logged, 2 missing →
  // next suggestion is 2, so redoing a deleted set reuses its original number).
  const nextSetNumber = (exName, extraUsed) => {
    const todaySession = sessions.at(-1);
    const used = new Set(todaySession && todaySession.date === today ? todaySession.entries.filter(e => e.ex === exName).map(e => e.set) : []);
    if (extraUsed != null) used.add(extraUsed);
    let n = 1;
    while (used.has(n)) n++;
    return n;
  };
  // Group recent history by session (last 5 sessions that have this exercise)
  const recentSessions = sessions.filter(s => s.entries.some(e => e.ex === activeEx)).slice(-5).reverse().map(s => ({
    sid: s.id,
    date: s.date,
    sets: s.entries.map((e, idx) => ({
      e,
      idx
    })).filter(({
      e
    }) => e.ex === activeEx)
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
    // Effective tempo: for Negative sets, the dedicated Negative breakdown
    // fields take priority (they're intentionally a separate, focused input —
    // not synced with the general tempo override); otherwise session override
    // > program-prescribed default, as before.
    const exDefSub = program?.exercises.find(e => e.name === activeEx);
    const eccUsed = isNegativeSet(form.type) && negEccSecs !== "" ? +negEccSecs : tempoOverride.eccSecs !== "" ? +tempoOverride.eccSecs : exDefSub?.eccSecs || null;
    const conUsed = isNegativeSet(form.type) && negConSecs !== "" ? +negConSecs : tempoOverride.conSecs !== "" ? +tempoOverride.conSecs : exDefSub?.conSecs || null;
    // Rest applied to this set: session override > exercise default (recorded regardless of timer toggle)
    const restApplied = restOverride !== "" ? +restOverride : calcIncrementalRest(exDefSub?.restSecs, exDefSub?.restIncrementDir, exDefSub?.restIncrementAmt, +form.setNo, exDefSub?.restTurns);
    const entryFields = {
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
      // legacy uniform value, kept for older data
      clusterRepsArr: isClusterSet(form.type) && (form.clusterRepsArr || []).length > 0 ? form.clusterRepsArr.map(v => +v || 0) : null,
      clusterCount: isClusterSet(form.type) && form.clusterCount ? +form.clusterCount : null,
      clusterGaps: (() => {
        if (!isClusterSet(form.type) || !clusterRestBase) return null;
        const numGaps = Math.max(0, (+form.clusterCount || 0) - 1);
        if (numGaps <= 0) return null;
        return Array.from({
          length: numGaps
        }, (_, i) => calcClusterGapRest(+clusterRestBase, clusterRestDir, +clusterRestIncAmt, i + 1, clusterRestTurnsCfg));
      })(),
      clusterRest: isClusterSet(form.type) && form.clusterRest ? +form.clusterRest : null,
      // legacy field, kept for older data compatibility
      dropSetLoads: isDropSet(form.type) && dropSetLoads.length > 0 ? dropSetLoads : null,
      dropSetReps: isDropSet(form.type) && dropSetLoads.length > 0 ? dropSetLoads.map((_, i) => +dropSetRepsArr[i] || 0) : null,
      dropSetMainReps: isDropSet(form.type) && dropSetLoads.length > 0 ? +dropSetMainReps || +form.reps || 0 : null,
      ascSetLoads: isAscendingSet(form.type) && ascSetLoads.length > 0 ? ascSetLoads : null,
      ascSetReps: isAscendingSet(form.type) && ascSetLoads.length > 0 ? ascSetLoads.map((_, i) => +ascSetRepsArr[i] || 0) : null,
      ascSetMainReps: isAscendingSet(form.type) && ascSetLoads.length > 0 ? +ascSetMainReps || +form.reps || 0 : null,
      pyrLoads: isPyramidSet(form.type) && pyrAllLoads.length > 0 ? pyrAllLoads : null,
      pyrReps: isPyramidSet(form.type) && pyrAllLoads.length > 0 ? pyrAllLoads.map((_, i) => +pyrRepsArr[i] || 0) : null,
      pyrMainReps: isPyramidSet(form.type) && pyrAllLoads.length > 0 ? +pyrMainReps || +form.reps || 0 : null,
      pyrUpCount: isPyramidSet(form.type) && pyrAllLoads.length > 0 ? pyrUpCountNum : null,
      // where in pyrLoads/pyrReps the descending stages begin
      comboRounds: isComboIso(form.type) ? +comboRounds || null : null,
      comboContractSecs: isComboIso(form.type) ? +comboContractSecs || null : null,
      comboRestSecs: isComboIso(form.type) ? +comboRestSecs || null : null,
      comboHoldPct: isComboIso(form.type) ? +comboHoldPct || null : null,
      comboHoldSecs: isComboIso(form.type) ? +comboHoldSecs || null : null,
      restApplied: restApplied || null,
      equipUsed: equipOverride || null,
      latUsed: latOverride || null,
      date: today
    };
    if (editingEntryRef) {
      // Editing an existing set: overwrite in place, no new timer, no re-add.
      const {
        sessionId,
        entryIdx
      } = editingEntryRef;
      onUpdateEntry(sessionId, entryIdx, entryFields);
      setEditingEntryRef(null);
    } else {
      onAddEntry(entryFields);
    }
    setForm(f => ({
      ...f,
      setNo: String(nextSetNumber(activeEx, +f.setNo)),
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
      clusterRepsArr: [],
      clusterCount: "",
      clusterRest: "",
      dropSetCount: "",
      ascSetCount: "",
      pyrUpCount: "",
      pyrDownCount: ""
    }));
    setShowBand(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);

    // Complex-aware rest + auto-advance: within a round, no rest and move
    // straight to the next exercise; at the end of a round, rest using the
    // COMPLEX's own duration (not the individual exercise's setting), then
    // cycle back to the first exercise, ready for the next round.
    const cxForActive = !editingEntryRef ? complexForEx(activeEx) : null;
    if (cxForActive) {
      const idx = cxForActive.exerciseNames.indexOf(activeEx);
      const isLastInRound = idx === cxForActive.exerciseNames.length - 1;
      if (isLastInRound) {
        if (restTimerOn) {
          const roundRest = cxForActive.restSecs != null ? calcIncrementalRest(cxForActive.restSecs, cxForActive.restIncrementDir, cxForActive.restIncrementAmt, +form.setNo, cxForActive.restTurns) : cxForActive.restBetweenRounds; // legacy complexes saved before the wave system
          startRestTimer(roundRest);
        }
        switchEx(cxForActive.exerciseNames[0]);
      } else {
        switchEx(cxForActive.exerciseNames[idx + 1]);
      }
    } else if (!editingEntryRef && restTimerOn && restApplied) {
      // Auto-start countdown only when the Rest Timer toggle is on, and only for
      // freshly-logged sets — editing a past mistake shouldn't kick off a new rest.
      startRestTimer(restApplied);
    }
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
  if (progExNames.length === 0) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "48px 24px",
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 42,
      marginBottom: 14
    }
  }, "🏋️"), /*#__PURE__*/React.createElement("div", {
    style: {
      color: C.sub,
      fontSize: 14,
      lineHeight: 1.6
    }
  }, "\"", program.name, "\" has no exercises yet.", /*#__PURE__*/React.createElement("br", null), "Go to Programs → ✎ Edit to add some."));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "16px 14px"
    }
  }, (program?.type === "Activation Strength" || program?.type === "General Strength") && (() => {
    const isActivation = program.type === "Activation Strength";
    const target = isActivation ? "General Strength" : "Max Strength";
    const checkFn = isActivation ? calcActivationGraduation : calcGeneralStrengthGraduation;
    const readyNames = [...new Set(program.exercises.map(e => e.name))].filter(name => checkFn(sessions, name).ready);
    if (readyNames.length === 0) return null;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        background: C.accent + "18",
        border: `1px solid ${C.accent}55`,
        borderRadius: 10,
        padding: "10px 14px",
        marginBottom: 12
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: C.accent,
        fontWeight: 700
      }
    }, "✅ ", readyNames.length, " exercise", readyNames.length !== 1 ? "s" : "", " ready to graduate to ", target, ": ", readyNames.join(", ")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.sub,
        marginTop: 2
      }
    }, isActivation ? `Consistent sessions, load progressing, comfortable RPE — consider moving ${clientName || "this client"} to a General Strength program.` : `12+ sessions, load progressing, 8+ weeks of consistent training, comfortable RPE — consider moving ${clientName || "this client"} to a Max Strength program.`));
  })(), confirmDelete && /*#__PURE__*/React.createElement(Sheet, {
    title: "🗑 DELETE SET?",
    onClose: () => setConfirmDelete(null)
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      color: C.text,
      lineHeight: 1.6,
      marginBottom: 20,
      textAlign: "center"
    }
  }, "Delete ", /*#__PURE__*/React.createElement("strong", null, confirmDelete.label), "?", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: C.muted
    }
  }, "This cannot be undone.")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setConfirmDelete(null),
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
    onClick: () => {
      onDeleteEntry(confirmDelete.sessionId, confirmDelete.entryIdx);
      // Deleted sets now cascade-renumber (Set 2 becomes Set 1, etc.),
      // so the next suggested Set # for this exercise is simply the
      // original count before deletion — after removing one and
      // renumbering, that's exactly where the sequence continues from.
      const todaySession = sessions.at(-1);
      if (confirmDelete.ex === activeEx && todaySession && todaySession.date === today && confirmDelete.sessionId === todaySession.id) {
        const originalCount = todaySession.entries.filter(e => e.ex === confirmDelete.ex).length;
        setForm(f => ({
          ...f,
          setNo: String(originalCount)
        }));
      }
      setConfirmDelete(null);
    },
    style: {
      flex: 1,
      background: C.warn,
      color: "#fff",
      border: "none",
      borderRadius: 10,
      padding: "13px",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 18,
      letterSpacing: 2,
      cursor: "pointer"
    }
  }, "DELETE"))), editingSessionComplex !== undefined && /*#__PURE__*/React.createElement(ComplexEditorModal, {
    exerciseNames: progExNames,
    complex: editingSessionComplex,
    colorIdx: editingSessionComplex ? (program?.complexes?.length || 0) + editingSessionComplex._srcIdx : allComplexes.length,
    onSave: fields => {
      if (editingSessionComplex) setSessionComplexes(cs => cs.map((c, i) => i === editingSessionComplex._srcIdx ? fields : c));else setSessionComplexes(cs => [...cs, fields]);
      setEditingSessionComplex(undefined);
    },
    onDelete: () => {
      setSessionComplexes(cs => cs.filter((_, i) => i !== editingSessionComplex._srcIdx));
      setEditingSessionComplex(undefined);
    },
    onClose: () => setEditingSessionComplex(undefined)
  }), editingComplexOverrideIdx !== undefined && (() => {
    const effective = allComplexes.find(c => c._permanent && c._srcIdx === editingComplexOverrideIdx);
    if (!effective) return null;
    return /*#__PURE__*/React.createElement(ComplexEditorModal, {
      exerciseNames: progExNames,
      complex: effective,
      colorIdx: editingComplexOverrideIdx,
      isOverrideMode: true,
      onSave: fields => {
        setSessionComplexOverrides(o => ({
          ...o,
          [editingComplexOverrideIdx]: fields
        }));
        setEditingComplexOverrideIdx(undefined);
      },
      onDelete: () => {
        // "Delete" here means clearing the session-only override, reverting
        // to the program's original permanent complex — never actually
        // deletes the permanent complex itself, which stays Programs-only.
        setSessionComplexOverrides(o => {
          const n = {
            ...o
          };
          delete n[editingComplexOverrideIdx];
          return n;
        });
        setEditingComplexOverrideIdx(undefined);
      },
      onClose: () => setEditingComplexOverrideIdx(undefined)
    });
  })(), /*#__PURE__*/React.createElement("div", {
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
      overflowY: "visible",
      paddingBottom: 6,
      paddingTop: 10,
      scrollbarWidth: "none",
      msOverflowStyle: "none"
    }
  }, progExNames.map(name => {
    const isActive = name === activeEx;
    // count today's sets already logged for this exercise
    const todaySets = sessions.at(-1)?.date === today ? sessions.at(-1).entries.filter(e => e.ex === name).length : 0;
    const cx = complexForEx(name);
    const cxColor = cx ? complexColorFor(cx._colorIdx) : null;
    return /*#__PURE__*/React.createElement("button", {
      key: name,
      onClick: () => switchEx(name),
      style: {
        background: isActive ? cxColor || C.accent : C.card2,
        color: isActive ? "#1A0800" : C.sub,
        border: `1.5px solid ${isActive ? cxColor || C.accent : cxColor || C.border}`,
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
    }, cx && /*#__PURE__*/React.createElement("span", {
      onClick: e => {
        if (!cx._permanent) {
          e.stopPropagation();
          setEditingSessionComplex({
            ...cx,
            _srcIdx: cx._srcIdx
          });
        }
      },
      style: {
        position: "absolute",
        top: -9,
        right: -4,
        background: cxColor,
        color: "#1A0800",
        fontSize: 9,
        fontWeight: 700,
        borderRadius: 8,
        padding: "1px 6px",
        lineHeight: 1.4,
        whiteSpace: "nowrap",
        cursor: cx._permanent ? "default" : "pointer"
      }
    }, complexLabelNumbered(allComplexes, cx._colorIdx)), /*#__PURE__*/React.createElement("span", {
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
    onClick: () => setEditingSessionComplex(null),
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
  }, "🔗 Create Complex"), progExNames.length > 1 && /*#__PURE__*/React.createElement("button", {
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
  }, "⚡ Complex sets"))), allComplexes.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(SecLabel, {
    text: "Active Complexes"
  }), allComplexes.map((cx, i) => {
    const color = complexColorFor(cx._colorIdx);
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: C.card,
        borderRadius: 12,
        padding: "10px 12px",
        marginBottom: 8,
        border: `1px solid ${color}44`,
        opacity: cx._voided ? 0.55 : 1
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "'Bebas Neue',cursive",
        fontSize: 16,
        color,
        letterSpacing: 1,
        flexShrink: 0
      }
    }, complexLabelNumbered(allComplexes, cx._colorIdx)), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: C.text,
        textDecoration: cx._voided ? "line-through" : "none"
      }
    }, cx.exerciseNames.join(" → ")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: C.muted
      }
    }, cx._voided ? "⏸ Voided for today — each exercise runs independently" : /*#__PURE__*/React.createElement(React.Fragment, null, "💤 ", fmtComplexRest(cx), cx._permanent ? cx._overridden ? " · Permanent (session-adjusted)" : " · Permanent" : " · Session only"))), cx._permanent ? cx._voided ? /*#__PURE__*/React.createElement("button", {
      onClick: () => setVoidedComplexIdxs(v => v.filter(x => x !== cx._srcIdx)),
      style: {
        background: C.accent + "18",
        border: `1px solid ${C.accent}55`,
        borderRadius: 6,
        padding: "6px 10px",
        cursor: "pointer",
        color: C.accent,
        fontSize: 11,
        fontWeight: 700,
        flexShrink: 0
      }
    }, "▶ Re-enable") : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
      onClick: () => setEditingComplexOverrideIdx(cx._srcIdx),
      style: {
        background: "none",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        cursor: "pointer",
        color: C.sub,
        fontSize: 12,
        flexShrink: 0
      }
    }, "✎"), cx._overridden && /*#__PURE__*/React.createElement("button", {
      onClick: () => setSessionComplexOverrides(o => {
        const n = {
          ...o
        };
        delete n[cx._srcIdx];
        return n;
      }),
      title: "Revert to the program's original complex for the rest of this session",
      style: {
        background: "none",
        border: `1px solid ${C.gold}44`,
        borderRadius: 6,
        padding: "6px 10px",
        cursor: "pointer",
        color: C.gold,
        fontSize: 12,
        flexShrink: 0
      }
    }, "↺"), /*#__PURE__*/React.createElement("button", {
      onClick: () => setVoidedComplexIdxs(v => [...v, cx._srcIdx]),
      title: "Skip the complex grouping for today — each exercise runs on its own",
      style: {
        background: "none",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        cursor: "pointer",
        color: C.sub,
        fontSize: 12,
        flexShrink: 0
      }
    }, "⏸")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
      onClick: () => setEditingSessionComplex({
        ...cx,
        _srcIdx: cx._srcIdx
      }),
      style: {
        background: "none",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        cursor: "pointer",
        color: C.sub,
        fontSize: 12,
        flexShrink: 0
      }
    }, "✎"), /*#__PURE__*/React.createElement("button", {
      onClick: () => setEditingSessionComplex({
        ...cx,
        _srcIdx: cx._srcIdx,
        _startDeleteConfirm: true
      }),
      style: {
        background: "none",
        border: `1px solid ${C.warn}44`,
        borderRadius: 6,
        padding: "6px 10px",
        cursor: "pointer",
        color: C.warn,
        fontSize: 12,
        flexShrink: 0
      }
    }, "🗑")));
  })), /*#__PURE__*/React.createElement("div", {
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
  }))), (restRunning || restRemaining > 0 || restTotal > 0) && /*#__PURE__*/React.createElement("div", {
    style: {
      background: restRemaining === 0 ? (doneColor || C.accent) + "22" : C.card2,
      borderRadius: 14,
      padding: "16px",
      marginBottom: 12,
      border: `1px solid ${restRemaining === 0 ? doneColor || C.accent : C.border}`,
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
      color: restRemaining === 0 ? doneColor || C.accent : C.text,
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
    onClick: () => onAdjustRest(-10),
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
    onClick: () => restRemaining === 0 ? onDismissRest() : onPauseResumeRest(),
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
  }, restRemaining === 0 ? "Dismiss" : restRunning ? "Pause" : "Resume"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onAdjustRest(10),
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
    onClick: () => onDismissRest(),
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
  }, "✕")), restRemaining > 0 && (() => {
    const cx = complexForEx(activeEx);
    if (!cx || cx.exerciseNames[0] !== activeEx) return null;
    return /*#__PURE__*/React.createElement("button", {
      onClick: () => onDismissRest(),
      style: {
        width: "100%",
        marginTop: 8,
        background: "none",
        border: `1px dashed ${C.border}`,
        borderRadius: 8,
        padding: "8px",
        cursor: "pointer",
        color: C.sub,
        fontSize: 11,
        fontWeight: 700
      }
    }, "✓ Done with ", complexLabelNumbered(allComplexes, cx._colorIdx), " — Skip Rest & Continue");
  })()), (() => {
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
  }, !isIsoType(form.type) && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: isClusterSet(form.type) ? "Total Reps (auto)" : "Reps"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "1",
    placeholder: "8",
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
  }), zoneTarget && !isClusterSet(form.type) && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 6,
      background: C.blue + "12",
      border: `1px solid ${C.blue}33`,
      borderRadius: 8,
      padding: "6px 10px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.blue,
      fontWeight: 700
    }
  }, "🎯 ", zoneTarget.maxReps, "RM, ", zoneTarget.targetRIR, " RIR"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: C.muted
    }
  }, "→ Execute ", zoneTarget.recommendedReps, " reps")), /*#__PURE__*/React.createElement("button", {
    onClick: () => upd("reps", zoneTarget.recommendedReps),
    style: {
      background: C.blue,
      color: "#fff",
      border: "none",
      borderRadius: 6,
      padding: "5px 12px",
      cursor: "pointer",
      fontSize: 11,
      fontWeight: 700,
      flexShrink: 0
    }
  }, "Use"))), !isOvrcIso(form.type) && /*#__PURE__*/React.createElement("div", {
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
  }), (() => {
    const rec = calcRecommendedLoad(sessions, activeEx);
    const isActivation = program?.type === "Activation Strength";

    // True beginner, zero session history yet — no numeric load exists to
    // suggest, so give qualitative guidance instead of a fabricated number.
    if (!rec && isActivation) {
      return /*#__PURE__*/React.createElement("div", {
        style: {
          marginTop: 6,
          background: C.accent + "12",
          border: `1px solid ${C.accent}33`,
          borderRadius: 8,
          padding: "8px 10px"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 11,
          color: C.accent,
          fontWeight: 700,
          marginBottom: 4
        }
      }, "🌱 No load history yet"), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 10,
          color: C.sub,
          lineHeight: 1.5,
          marginBottom: 6
        }
      }, "Start light — empty bar, bodyweight, or the lightest plates available. Priority is learning the movement, not the number."), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 9,
          color: C.accent
        }
      }, "Aim for 12-15 reps, 4-5 RIR — this should feel easy."), /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          gap: 8,
          marginTop: 8
        }
      }, /*#__PURE__*/React.createElement("button", {
        onClick: () => upd("reps", 13),
        style: {
          flex: 1,
          background: "none",
          border: `1px solid ${C.accent}55`,
          borderRadius: 6,
          padding: "6px 10px",
          cursor: "pointer",
          fontSize: 11,
          fontWeight: 700,
          color: C.accent
        }
      }, "Use Reps (13)"), /*#__PURE__*/React.createElement("button", {
        onClick: () => upd("rir", 4),
        style: {
          flex: 1,
          background: "none",
          border: `1px solid ${C.accent}55`,
          borderRadius: 6,
          padding: "6px 10px",
          cursor: "pointer",
          fontSize: 11,
          fontWeight: 700,
          color: C.accent
        }
      }, "Use RIR (4)")));
    }
    if (!rec) return null;

    // Real session data now exists — show the normal gold recommendation,
    // plus (for Activation Strength specifically) a graduation-readiness check.
    const grad = isActivation ? calcActivationGraduation(sessions, activeEx) : null;
    return /*#__PURE__*/React.createElement(React.Fragment, null, grad?.ready && /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 6,
        background: C.accent + "18",
        border: `1px solid ${C.accent}55`,
        borderRadius: 8,
        padding: "8px 10px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: C.accent,
        fontWeight: 700
      }
    }, "✅ Ready to graduate"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.sub,
        marginTop: 2,
        lineHeight: 1.5
      }
    }, grad.sessionCount, " sessions completed (", grad.freqPerWeek, "x/week avg), load progressing, RPE ", grad.avgRPE3, " avg — comfortable at this level. Consider moving ", clientName || "this client", " to a General Strength program.")), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: 6,
        background: C.gold + "12",
        border: `1px solid ${C.gold}33`,
        borderRadius: 8,
        padding: "6px 10px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: C.gold,
        fontWeight: 700
      }
    }, "💡 Suggested: ", rec.newLoad, "kg", rec.est1RM ? ` · Est 1RM ~${rec.est1RM}kg` : ""), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.muted
      }
    }, rec.reason), rec.repRangeLo && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.gold,
        marginTop: 2
      }
    }, "Aim for ", rec.repRangeLo, "-", rec.repRangeHi, " reps", rec.suggestedRIR != null ? `, ${rec.suggestedRIR} RIR` : "")), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 4,
        flexShrink: 0
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => upd("load", rec.newLoad),
      style: {
        background: C.gold,
        color: "#1A1200",
        border: "none",
        borderRadius: 6,
        padding: "5px 12px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 700
      }
    }, "Use Load"), rec.repRangeLo && /*#__PURE__*/React.createElement("button", {
      onClick: () => upd("reps", Math.round((rec.repRangeLo + rec.repRangeHi) / 2)),
      style: {
        background: "none",
        border: `1px solid ${C.gold}55`,
        borderRadius: 6,
        padding: "5px 12px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 700,
        color: C.gold
      }
    }, "Use Reps"), rec.suggestedRIR != null && /*#__PURE__*/React.createElement("button", {
      onClick: () => upd("rir", rec.suggestedRIR),
      style: {
        background: "none",
        border: `1px solid ${C.gold}55`,
        borderRadius: 6,
        padding: "5px 12px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 700,
        color: C.gold
      }
    }, "Use RIR"), /*#__PURE__*/React.createElement("button", {
      onClick: () => setForm(f => ({
        ...f,
        load: "",
        reps: "",
        rir: 2
      })),
      style: {
        background: "none",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "5px 12px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 700,
        color: C.sub
      }
    }, "↺ Reset"))));
  })(), zoneTarget && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 6,
      background: C.blue + "12",
      border: `1px solid ${C.blue}33`,
      borderRadius: 8,
      padding: "6px 10px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.blue,
      fontWeight: 700
    }
  }, "🎯 ", zoneTarget.progType, " target: ", zoneTarget.target, "kg"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: C.muted
    }
  }, zoneTarget.pct, "% of ~", zoneTarget.best1RM, "kg best Est 1RM (~", zoneTarget.maxReps, "RM at this load)")), /*#__PURE__*/React.createElement("button", {
    onClick: () => upd("load", zoneTarget.target),
    style: {
      background: C.blue,
      color: "#fff",
      border: "none",
      borderRadius: 6,
      padding: "5px 12px",
      cursor: "pointer",
      fontSize: 11,
      fontWeight: 700,
      flexShrink: 0
    }
  }, "Use"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setForm(f => ({
      ...f,
      load: "",
      reps: "",
      rir: 2
    })),
    style: {
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: "5px 12px",
      cursor: "pointer",
      fontSize: 11,
      fontWeight: 700,
      color: C.sub,
      flexShrink: 0,
      marginLeft: 6
    }
  }, "↺ Reset")))), isClusterSet(form.type) && /*#__PURE__*/React.createElement("div", {
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
  }, "⏱ Cluster Set breakdown"), (() => {
    const cx = complexForEx(activeEx);
    if (!cx) return null;
    const idx = cx.exerciseNames.indexOf(activeEx);
    const isLast = idx === cx.exerciseNames.length - 1;
    const label = complexLabelNumbered(allComplexes, cx._colorIdx);
    const color = complexColorFor(cx._colorIdx);
    return /*#__PURE__*/React.createElement("div", {
      style: {
        background: color + "18",
        border: `1px solid ${color}44`,
        borderRadius: 8,
        padding: "8px 10px",
        marginBottom: 10
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color,
        fontWeight: 700
      }
    }, "🔗 Part of ", label, ": ", cx.exerciseNames.join(" → ")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.sub,
        marginTop: 2
      }
    }, isLast ? "Logging this completes the round — rest timer starts, then cycles back to " + cx.exerciseNames[0] + "." : `Logging this will jump straight to ${cx.exerciseNames[idx + 1]} — no rest.`));
  })(), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Number of clusters"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "1",
    placeholder: "3",
    value: form.clusterCount,
    onChange: e => {
      const cc = Math.max(0, +e.target.value || 0);
      upd("clusterCount", e.target.value);
      // Resize the per-cluster reps array to match, preserving
      // existing values and padding new slots with the last entry.
      setForm(f => {
        const arr = [...(f.clusterRepsArr || [])];
        const fill = arr.length ? arr[arr.length - 1] : "2";
        while (arr.length < cc) arr.push(fill);
        arr.length = cc;
        const total = arr.reduce((s, v) => s + (+v || 0), 0);
        return {
          ...f,
          clusterRepsArr: arr,
          reps: total > 0 ? String(total) : f.reps
        };
      });
    },
    style: ss
  })), (+form.clusterCount || 0) > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Reps per cluster (each cluster can differ)"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      flexWrap: "wrap"
    }
  }, (form.clusterRepsArr || []).map((v, ci) => /*#__PURE__*/React.createElement("div", {
    key: ci,
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 2
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 9,
      color: C.muted
    }
  }, "Cluster ", ci + 1), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0",
    value: v,
    placeholder: "2",
    onChange: e => {
      const val = e.target.value;
      setForm(f => {
        const arr = [...(f.clusterRepsArr || [])];
        arr[ci] = val;
        const total = arr.reduce((s, x) => s + (+x || 0), 0);
        return {
          ...f,
          clusterRepsArr: arr,
          reps: total > 0 ? String(total) : f.reps
        };
      });
    },
    style: {
      ...ss,
      width: 52,
      padding: "6px 4px",
      textAlign: "center"
    }
  }))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.gold,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 8
    }
  }, "Rest between clusters (this set)"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Base rest (s)"
  }), /*#__PURE__*/React.createElement("select", {
    value: clusterRestBase,
    onChange: e => setClusterRestBase(e.target.value),
    style: ss
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "Select…"), CLUSTER_REST_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, fmtRest(v))))), clusterRestBase && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
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
    value: clusterRestDir,
    onChange: e => setClusterRestDir(e.target.value),
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
    t: "Increment per gap"
  }), /*#__PURE__*/React.createElement("select", {
    value: clusterRestIncAmt,
    onChange: e => setClusterRestIncAmt(e.target.value),
    style: ss
  }, CLUSTER_INCREMENT_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v === 0 ? "None (flat rest)" : fmtRest(v)))))), +clusterRestIncAmt > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, clusterRestTurnsCfg.map((t, ti) => /*#__PURE__*/React.createElement("div", {
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
    onClick: () => setClusterRestTurnsCfg(rt => rt.filter((_, i) => i !== ti)),
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
    t: "Switch trend after gap #"
  }), /*#__PURE__*/React.createElement("select", {
    value: t.afterSet,
    onChange: e => {
      const nt = [...clusterRestTurnsCfg];
      nt[ti] = {
        ...nt[ti],
        afterSet: +e.target.value
      };
      setClusterRestTurnsCfg(nt);
    },
    style: ss
  }, TURN_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, "Gap ", v)))), /*#__PURE__*/React.createElement("div", {
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
      const nt = [...clusterRestTurnsCfg];
      nt[ti] = {
        ...nt[ti],
        dir: e.target.value
      };
      setClusterRestTurnsCfg(nt);
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
      const nt = [...clusterRestTurnsCfg];
      nt[ti] = {
        ...nt[ti],
        amt: +e.target.value
      };
      setClusterRestTurnsCfg(nt);
    },
    style: ss
  }, CLUSTER_INCREMENT_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v === 0 ? "None (flat)" : fmtRest(v)))))))), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const lastGap = clusterRestTurnsCfg.length ? clusterRestTurnsCfg[clusterRestTurnsCfg.length - 1].afterSet : 2;
      setClusterRestTurnsCfg(rt => [...rt, {
        afterSet: Math.min(20, lastGap + 1),
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
  }, "🌊 + Add trend change")), (() => {
    const numGaps = Math.max(0, (+form.clusterCount || 0) - 1);
    if (numGaps <= 0) return /*#__PURE__*/React.createElement("div", {
      style: {
        background: C.gold + "12",
        border: `1px solid ${C.gold}33`,
        borderRadius: 8,
        padding: "8px 10px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: C.gold,
        fontWeight: 700
      }
    }, "⚠️ Set \"Number of clusters\" above to 2 or more to see the gap pattern"));
    const gaps = Array.from({
      length: numGaps
    }, (_, i) => calcClusterGapRest(+clusterRestBase, clusterRestDir, +clusterRestIncAmt, i + 1, clusterRestTurnsCfg));
    return /*#__PURE__*/React.createElement("div", {
      style: {
        background: C.gold + "12",
        border: `1px solid ${C.gold}33`,
        borderRadius: 8,
        padding: "8px 10px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: C.gold,
        fontWeight: 700
      }
    }, "Gap pattern: ", gaps.map(g => fmtRest(g)).join(" → ")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.muted,
        marginTop: 2
      }
    }, form.clusterCount, " clusters → ", numGaps, " gap", numGaps !== 1 ? "s" : "", " · resets to 5s flat for the next set unless you change it again"));
  })())), (form.clusterRepsArr || []).length >= 2 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      paddingTop: 10,
      borderTop: `1px solid #FFB02033`
    }
  }, !clusterSeqActive ? /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setClusterSeqActive(true);
      setClusterSeqIdx(0);
      setClusterSeqRemaining(0);
      setClusterSeqCompleted(false);
    },
    style: {
      width: "100%",
      background: C.gold,
      color: "#1A1200",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "▶ Start Cluster Sequence") : /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      border: `1px solid ${C.gold}55`,
      borderRadius: 10,
      padding: "12px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 8,
      color: clusterSeqCompleted ? C.accent : C.gold
    }
  }, "Cluster ", clusterSeqIdx + 1, " of ", form.clusterRepsArr.length, " — ", form.clusterRepsArr[clusterSeqIdx] || "?", " reps", clusterSeqCompleted ? " COMPLETED!" : ""), clusterSeqRemaining > 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 36,
      color: C.gold,
      letterSpacing: 1
    }
  }, clusterSeqRemaining, "s"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      marginBottom: 8
    }
  }, "Resting before Cluster ", clusterSeqIdx + 2), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setClusterSeqRemaining(0);
      setClusterSeqCompleted(true);
    },
    style: {
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.sub,
      fontSize: 11,
      fontWeight: 700
    }
  }, "Skip Rest")) : clusterSeqCompleted ? /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setClusterSeqIdx(i => i + 1);
      setClusterSeqCompleted(false);
    },
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "Continue to Cluster ", clusterSeqIdx + 2) : clusterSeqIdx < form.clusterRepsArr.length - 1 ? /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const gap = clusterGapSeq[clusterSeqIdx] || 5;
      setClusterSeqRemaining(gap);
    },
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "Complete Cluster ", clusterSeqIdx + 1, " — Rest ", clusterGapSeq[clusterSeqIdx] || 5, "s") : /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const cx = complexForEx(activeEx);
      if (cx) {
        // Part of an active complex — completing the last cluster IS
        // effectively "logging this set", so submit immediately and let
        // the existing complex logic auto-advance to the next exercise
        // (or complete the round + rest, if this was the last one).
        submit();
      } else {
        setClusterSeqActive(false);
      }
    },
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, complexForEx(activeEx) ? `✓ Complete Final Cluster — Log & Continue` : `✓ Complete Final Cluster — Ready to Log Set`))), (form.clusterRepsArr || []).length > 0 && (() => {
    const numGaps = Math.max(0, (+form.clusterCount || 0) - 1);
    const gaps = clusterRestBase && numGaps > 0 ? Array.from({
      length: numGaps
    }, (_, i) => calcClusterGapRest(+clusterRestBase, clusterRestDir, +clusterRestIncAmt, i + 1, clusterRestTurnsCfg)) : [];
    const total = form.clusterRepsArr.reduce((s, v) => s + (+v || 0), 0);
    return /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: C.gold,
        marginTop: 8,
        fontWeight: 600
      }
    }, form.clusterRepsArr.map(v => v || "0").join("+"), " reps", gaps.length > 0 ? ` (${gaps.map(g => fmtRest(g)).join(" → ")} rest between)` : "", " = ", /*#__PURE__*/React.createElement("strong", null, total, " total reps"));
  })()), isDropSet(form.type) && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#A855F715",
      borderRadius: 10,
      padding: "12px 14px",
      border: `1px solid #A855F733`,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#A855F7',
      fontWeight: 700,
      letterSpacing: 1.5,
      textTransform: "uppercase",
      marginBottom: 10
    }
  }, "📉 Drop Set breakdown"), (() => {
    const cx = complexForEx(activeEx);
    if (!cx) return null;
    const idx = cx.exerciseNames.indexOf(activeEx);
    const isLast = idx === cx.exerciseNames.length - 1;
    const label = complexLabelNumbered(allComplexes, cx._colorIdx);
    const color = complexColorFor(cx._colorIdx);
    return /*#__PURE__*/React.createElement("div", {
      style: {
        background: color + "18",
        border: `1px solid ${color}44`,
        borderRadius: 8,
        padding: "8px 10px",
        marginBottom: 10
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color,
        fontWeight: 700
      }
    }, "🔗 Part of ", label, ": ", cx.exerciseNames.join(" → ")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.sub,
        marginTop: 2
      }
    }, isLast ? "Logging this completes the round — rest timer starts, then cycles back to " + cx.exerciseNames[0] + "." : `Logging this will jump straight to ${cx.exerciseNames[idx + 1]} — no rest.`));
  })(), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Number of drops"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "1",
    placeholder: "3",
    value: form.dropSetCount,
    onChange: e => {
      const dc = Math.max(0, +e.target.value || 0);
      upd("dropSetCount", e.target.value);
      setDropSetRepsArr(arr => {
        const na = [...arr];
        while (na.length < dc) na.push("");
        na.length = dc;
        return na;
      });
    },
    style: ss
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Base Drop % (Main set → Drop 1)"
  }), /*#__PURE__*/React.createElement("select", {
    value: dropSetPct,
    onChange: e => setDropSetPct(e.target.value),
    style: ss
  }, [5, 10, 15, 20, 25, 30, 35, 40, 45, 50].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, "%")))), /*#__PURE__*/React.createElement("div", {
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
    value: dropPctDir,
    onChange: e => setDropPctDir(e.target.value),
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
    t: "Increment per drop"
  }), /*#__PURE__*/React.createElement("select", {
    value: dropPctIncAmt,
    onChange: e => setDropPctIncAmt(e.target.value),
    style: ss
  }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v === 0 ? "None (flat %)" : `${v}%`))))), +dropPctIncAmt > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, dropPctTurnsCfg.map((t, ti) => /*#__PURE__*/React.createElement("div", {
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
      color: '#A855F7',
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase"
    }
  }, "🌊 Turn ", ti + 1), /*#__PURE__*/React.createElement("button", {
    onClick: () => setDropPctTurnsCfg(rt => rt.filter((_, i) => i !== ti)),
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
    t: "Switch trend after drop #"
  }), /*#__PURE__*/React.createElement("select", {
    value: t.afterSet,
    onChange: e => {
      const nt = [...dropPctTurnsCfg];
      nt[ti] = {
        ...nt[ti],
        afterSet: +e.target.value
      };
      setDropPctTurnsCfg(nt);
    },
    style: ss
  }, TURN_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, "Drop ", v)))), /*#__PURE__*/React.createElement("div", {
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
      const nt = [...dropPctTurnsCfg];
      nt[ti] = {
        ...nt[ti],
        dir: e.target.value
      };
      setDropPctTurnsCfg(nt);
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
      const nt = [...dropPctTurnsCfg];
      nt[ti] = {
        ...nt[ti],
        amt: +e.target.value
      };
      setDropPctTurnsCfg(nt);
    },
    style: ss
  }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v === 0 ? "None (flat)" : `${v}%`))))))), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const lastDrop = dropPctTurnsCfg.length ? dropPctTurnsCfg[dropPctTurnsCfg.length - 1].afterSet : 2;
      setDropPctTurnsCfg(rt => [...rt, {
        afterSet: Math.min(20, lastDrop + 1),
        dir: "+",
        amt: 0
      }]);
    },
    style: {
      width: "100%",
      background: "none",
      border: `1px dashed ${'#A855F7'}55`,
      borderRadius: 8,
      padding: "8px",
      cursor: "pointer",
      color: '#A855F7',
      fontSize: 12,
      fontWeight: 700,
      marginBottom: 8
    }
  }, "🌊 + Add trend change")), +dropPctIncAmt > 0 && dropSetCountNum >= 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#A855F7',
      marginBottom: 8,
      fontWeight: 600,
      lineHeight: 1.6
    }
  }, "Preview: ", Array.from({
    length: dropSetCountNum
  }, (_, i) => `${i === 0 ? "Main" : "Drop" + i}→Drop${i + 1} ${calcDropPct(+dropSetPct, dropPctDir, +dropPctIncAmt, i + 1, dropPctTurnsCfg)}%`).join(" · ")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: C.muted,
      marginBottom: 10,
      lineHeight: 1.4
    }
  }, "True drop sets use minimal-to-no rest between drops — the load reduction itself is what lets you keep training despite accumulated fatigue."), dropSetLoads.length > 0 && (() => {
    // Reuse the SAME session-history recommendation already powering
    // the gold box elsewhere on this page — no new formula, just the
    // same rep-range logic applied here too, for consistency. Only
    // available once real session history exists for this exercise;
    // for the first few sessions this stays blank and the trainer's
    // own judgment is the suggestion, same as it's always been.
    const mainSetRec = calcRecommendedLoad(sessions, activeEx);
    const mainSetSuggestedReps = mainSetRec?.repRangeLo ? Math.round((mainSetRec.repRangeLo + mainSetRec.repRangeHi) / 2) : null;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 8
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
        fontSize: 10,
        color: '#A855F7',
        fontWeight: 700,
        width: 60,
        flexShrink: 0
      }
    }, "Main set"), /*#__PURE__*/React.createElement("div", {
      style: {
        background: C.card2,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 12,
        color: C.text,
        flex: 1
      }
    }, form.load || "—", "kg"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: C.muted,
        width: 64,
        textAlign: "center"
      }
    }, form.reps || "—", " reps"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 9,
        color: C.muted,
        width: 38,
        flexShrink: 0
      }
    }, mainSetSuggestedReps != null ? `~${mainSetSuggestedReps}r` : "")), /*#__PURE__*/React.createElement(Lbl, {
      t: "Drop loads (auto) & reps (fill in after each drop)"
    }), dropSetLoads.map((load, di) => /*#__PURE__*/React.createElement("div", {
      key: di,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 6
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        color: C.muted,
        width: 44,
        flexShrink: 0
      }
    }, "Drop ", di + 1), /*#__PURE__*/React.createElement("div", {
      style: {
        background: C.card2,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 12,
        color: C.text,
        flex: 1
      }
    }, load, "kg"), /*#__PURE__*/React.createElement("input", {
      type: "number",
      min: "0",
      placeholder: "reps",
      value: dropSetRepsArr[di] || "",
      onChange: e => setDropSetRepsArr(arr => {
        const na = [...arr];
        na[di] = e.target.value;
        return na;
      }),
      style: {
        ...ss,
        width: 64,
        textAlign: "center"
      }
    }), dropSetSuggestedReps(di) != null && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 9,
        color: C.muted,
        width: 38,
        flexShrink: 0
      }
    }, "~", dropSetSuggestedReps(di), "r"))));
  })(), dropSetLoads.length >= 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      paddingTop: 10,
      borderTop: `1px solid #A855F733`
    }
  }, !dropSetActive ? /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setDropSetActive(true);
      setDropSetIdx(0);
      setDropSetRemaining(0);
      setDropSetCompleted(false);
      setDropSetMainReps(form.reps || "");
    },
    style: {
      width: "100%",
      background: '#A855F7',
      color: "#1A1200",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "▶ Start Drop Sequence") : /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      border: `1px solid ${'#A855F7'}55`,
      borderRadius: 10,
      padding: "12px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 8,
      color: dropSetCompleted ? C.accent : '#A855F7'
    }
  }, "Drop ", dropSetIdx + 1, " of ", dropSetLoads.length, " — ", dropSetLoads[dropSetIdx], "kg", dropSetCompleted ? " COMPLETED!" : ""), dropSetRemaining > 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 36,
      color: '#A855F7',
      letterSpacing: 1
    }
  }, dropSetRemaining, "s"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      marginBottom: 8
    }
  }, "Changing load to ", dropSetLoads[dropSetIdx + 1], "kg"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setDropSetRemaining(0);
      setDropSetCompleted(true);
    },
    style: {
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.sub,
      fontSize: 11,
      fontWeight: 700
    }
  }, "Skip")) : dropSetCompleted ? /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setDropSetIdx(i => i + 1);
      setDropSetCompleted(false);
    },
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "Continue to Drop ", dropSetIdx + 2) : dropSetIdx < dropSetLoads.length - 1 ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: `Reps completed at ${dropSetLoads[dropSetIdx]}kg`
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0",
    autoFocus: true,
    value: dropSetRepsArr[dropSetIdx] || "",
    onChange: e => setDropSetRepsArr(arr => {
      const na = [...arr];
      na[dropSetIdx] = e.target.value;
      return na;
    }),
    style: ss
  }), dropSetSuggestedReps(dropSetIdx) != null && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: C.muted,
      marginTop: 3
    }
  }, "~", dropSetSuggestedReps(dropSetIdx), " reps — similar to the previous stage (a well-calibrated drop % roughly offsets the added fatigue)")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setDropSetRemaining(15),
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "Complete Drop ", dropSetIdx + 1, " — Change to ", dropSetLoads[dropSetIdx + 1], "kg")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: `Reps completed at ${dropSetLoads[dropSetIdx]}kg`
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0",
    autoFocus: true,
    value: dropSetRepsArr[dropSetIdx] || "",
    onChange: e => setDropSetRepsArr(arr => {
      const na = [...arr];
      na[dropSetIdx] = e.target.value;
      return na;
    }),
    style: ss
  }), dropSetSuggestedReps(dropSetIdx) != null && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: C.muted,
      marginTop: 3
    }
  }, "~", dropSetSuggestedReps(dropSetIdx), " reps — similar to the previous stage (a well-calibrated drop % roughly offsets the added fatigue)")), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      upd("reps", (+dropSetMainReps || +form.reps || 0) + dropSetRepsArr.reduce((s, v) => s + (+v || 0), 0));
      const cx = complexForEx(activeEx);
      if (cx) submit();else setDropSetActive(false);
    },
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, complexForEx(activeEx) ? `✓ Complete Final Drop — Log & Continue` : `✓ Complete Final Drop — Ready to Log Set`)))), (form.reps || dropSetRepsArr.some(v => v)) && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#A855F7',
      marginTop: 8,
      fontWeight: 600
    }
  }, form.load, "kg×", form.reps || "?", ", ", dropSetLoads.map((l, i) => `${l}kg×${dropSetRepsArr[i] || "?"}`).join(", "), " = ", /*#__PURE__*/React.createElement("strong", null, (+form.reps || 0) + dropSetRepsArr.reduce((s, v) => s + (+v || 0), 0), " total reps"))), isAscendingSet(form.type) && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#22C55E15",
      borderRadius: 10,
      padding: "12px 14px",
      border: `1px solid #22C55E33`,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#22C55E',
      fontWeight: 700,
      letterSpacing: 1.5,
      textTransform: "uppercase",
      marginBottom: 10
    }
  }, "📈 Ascending Set breakdown"), (() => {
    const cx = complexForEx(activeEx);
    if (!cx) return null;
    const idx = cx.exerciseNames.indexOf(activeEx);
    const isLast = idx === cx.exerciseNames.length - 1;
    const label = complexLabelNumbered(allComplexes, cx._colorIdx);
    const color = complexColorFor(cx._colorIdx);
    return /*#__PURE__*/React.createElement("div", {
      style: {
        background: color + "18",
        border: `1px solid ${color}44`,
        borderRadius: 8,
        padding: "8px 10px",
        marginBottom: 10
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color,
        fontWeight: 700
      }
    }, "🔗 Part of ", label, ": ", cx.exerciseNames.join(" → ")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.sub,
        marginTop: 2
      }
    }, isLast ? "Logging this completes the round — rest timer starts, then cycles back to " + cx.exerciseNames[0] + "." : `Logging this will jump straight to ${cx.exerciseNames[idx + 1]} — no rest.`));
  })(), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Number of increases"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "1",
    placeholder: "3",
    value: form.ascSetCount,
    onChange: e => {
      const ac = Math.max(0, +e.target.value || 0);
      upd("ascSetCount", e.target.value);
      setAscSetRepsArr(arr => {
        const na = [...arr];
        while (na.length < ac) na.push("");
        na.length = ac;
        return na;
      });
    },
    style: ss
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Base Increase % (Main set → Up 1)"
  }), /*#__PURE__*/React.createElement("select", {
    value: ascSetPct,
    onChange: e => setAscSetPct(e.target.value),
    style: ss
  }, [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, "%")))), /*#__PURE__*/React.createElement("div", {
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
    value: ascPctDir,
    onChange: e => setAscPctDir(e.target.value),
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
    t: "Increment per stage"
  }), /*#__PURE__*/React.createElement("select", {
    value: ascPctIncAmt,
    onChange: e => setAscPctIncAmt(e.target.value),
    style: ss
  }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v === 0 ? "None (flat %)" : `${v}%`))))), +ascPctIncAmt > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, ascPctTurnsCfg.map((t, ti) => /*#__PURE__*/React.createElement("div", {
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
      color: '#22C55E',
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase"
    }
  }, "🌊 Turn ", ti + 1), /*#__PURE__*/React.createElement("button", {
    onClick: () => setAscPctTurnsCfg(rt => rt.filter((_, i) => i !== ti)),
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
    t: "Switch trend after increase #"
  }), /*#__PURE__*/React.createElement("select", {
    value: t.afterSet,
    onChange: e => {
      const nt = [...ascPctTurnsCfg];
      nt[ti] = {
        ...nt[ti],
        afterSet: +e.target.value
      };
      setAscPctTurnsCfg(nt);
    },
    style: ss
  }, TURN_OPTIONS.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, "Up ", v)))), /*#__PURE__*/React.createElement("div", {
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
      const nt = [...ascPctTurnsCfg];
      nt[ti] = {
        ...nt[ti],
        dir: e.target.value
      };
      setAscPctTurnsCfg(nt);
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
      const nt = [...ascPctTurnsCfg];
      nt[ti] = {
        ...nt[ti],
        amt: +e.target.value
      };
      setAscPctTurnsCfg(nt);
    },
    style: ss
  }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v === 0 ? "None (flat)" : `${v}%`))))))), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const lastUp = ascPctTurnsCfg.length ? ascPctTurnsCfg[ascPctTurnsCfg.length - 1].afterSet : 2;
      setAscPctTurnsCfg(rt => [...rt, {
        afterSet: Math.min(20, lastUp + 1),
        dir: "+",
        amt: 0
      }]);
    },
    style: {
      width: "100%",
      background: "none",
      border: `1px dashed ${'#22C55E'}55`,
      borderRadius: 8,
      padding: "8px",
      cursor: "pointer",
      color: '#22C55E',
      fontSize: 12,
      fontWeight: 700,
      marginBottom: 8
    }
  }, "🌊 + Add trend change")), +ascPctIncAmt > 0 && ascSetCountNum >= 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#22C55E',
      marginBottom: 8,
      fontWeight: 600,
      lineHeight: 1.6
    }
  }, "Preview: ", Array.from({
    length: ascSetCountNum
  }, (_, i) => `${i === 0 ? "Main" : "Up" + i}→Up${i + 1} ${calcDropPct(+ascSetPct, ascPctDir, +ascPctIncAmt, i + 1, ascPctTurnsCfg)}%`).join(" · ")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: C.muted,
      marginBottom: 10,
      lineHeight: 1.4
    }
  }, "Unlike a drop set, load AND fatigue both climb together here — there's no offsetting mechanism, so this is a considerably more demanding technique. Also known as \"Run the Rack.\""), ascSetCountNum >= 1 && (() => {
    const est1RM = getBest1RM(sessions, activeEx);
    const suggestedLoad = calcAscSetSuggestedMainLoad(est1RM, +ascSetPct, ascPctDir, +ascPctIncAmt, ascPctTurnsCfg, ascSetCountNum);
    const suggestedReps = calcAscSetSuggestedMainReps(est1RM, suggestedLoad);
    if (suggestedLoad == null) return null;
    // Recompute the final stage's load at this suggested starting
    // point, to tell the trainer whether the rep cap (10) or the
    // 85% ceiling ended up being the binding constraint — and flag
    // it plainly if the rep cap pushed the final stage over 85%.
    const finalLoad = calcAscSetLoads(suggestedLoad, +ascSetPct, ascPctDir, +ascPctIncAmt, ascPctTurnsCfg, ascSetCountNum).slice(-1)[0];
    const finalPct1RM = finalLoad != null && est1RM ? Math.round(finalLoad / est1RM * 100) : null;
    const overCeiling = finalPct1RM != null && finalPct1RM > 85;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 8,
        background: '#22C55E' + "12",
        border: `1px solid #22C55E33`,
        borderRadius: 8,
        padding: "8px 10px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: '#22C55E',
        fontWeight: 700
      }
    }, "💡 Suggested start: ", suggestedLoad, "kg", suggestedReps != null ? ` × ${suggestedReps}` : ""), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.muted
      }
    }, overCeiling ? `Reps at the starting load are capped at 10 for a practical starting point — as a result, the final Up stage lands at ~${finalPct1RM}% of Est 1RM (${est1RM}kg), a bit above the usual 85% ceiling.` : `Keeps the final Up stage at or below 85% of Est 1RM (${est1RM}kg) — a heavier starting load risks the last stage landing at or past what's actually liftable.`)), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        upd("load", suggestedLoad);
        if (suggestedReps != null) upd("reps", suggestedReps);
      },
      style: {
        background: '#22C55E',
        color: "#04170B",
        border: "none",
        borderRadius: 6,
        padding: "5px 12px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 700,
        flexShrink: 0,
        marginLeft: 8
      }
    }, "Use"));
  })(), ascSetLoads.length > 0 && (() => {
    const mainSetRec = calcRecommendedLoad(sessions, activeEx);
    const mainSetSuggestedReps = mainSetRec?.repRangeLo ? Math.round((mainSetRec.repRangeLo + mainSetRec.repRangeHi) / 2) : null;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 8
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
        fontSize: 10,
        color: '#22C55E',
        fontWeight: 700,
        width: 60,
        flexShrink: 0
      }
    }, "Main set"), /*#__PURE__*/React.createElement("div", {
      style: {
        background: C.card2,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 12,
        color: C.text,
        flex: 1
      }
    }, form.load || "—", "kg"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: C.muted,
        width: 64,
        textAlign: "center"
      }
    }, form.reps || "—", " reps"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 9,
        color: C.muted,
        width: 38,
        flexShrink: 0
      }
    }, mainSetSuggestedReps != null ? `~${mainSetSuggestedReps}r` : "")), /*#__PURE__*/React.createElement(Lbl, {
      t: "Up loads (auto) & reps (fill in after each increase)"
    }), ascSetLoads.map((load, ui) => /*#__PURE__*/React.createElement("div", {
      key: ui,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 6
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        color: C.muted,
        width: 44,
        flexShrink: 0
      }
    }, "Up ", ui + 1), /*#__PURE__*/React.createElement("div", {
      style: {
        background: C.card2,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 12,
        color: C.text,
        flex: 1
      }
    }, load, "kg"), /*#__PURE__*/React.createElement("input", {
      type: "number",
      min: "0",
      placeholder: "reps",
      value: ascSetRepsArr[ui] || "",
      onChange: e => setAscSetRepsArr(arr => {
        const na = [...arr];
        na[ui] = e.target.value;
        return na;
      }),
      style: {
        ...ss,
        width: 64,
        textAlign: "center"
      }
    }), ascSetSuggestedReps(ui) != null && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 9,
        color: C.muted,
        width: 38,
        flexShrink: 0
      }
    }, "~", ascSetSuggestedReps(ui), "r"))));
  })(), ascSetLoads.length >= 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      paddingTop: 10,
      borderTop: `1px solid #22C55E33`
    }
  }, !ascSetActive ? /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setAscSetActive(true);
      setAscSetIdx(0);
      setAscSetRemaining(0);
      setAscSetCompleted(false);
      setAscSetMainReps(form.reps || "");
    },
    style: {
      width: "100%",
      background: '#22C55E',
      color: "#04170B",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "▶ Start Ascending Sequence") : /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      border: `1px solid ${'#22C55E'}55`,
      borderRadius: 10,
      padding: "12px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 8,
      color: ascSetCompleted ? C.accent : '#22C55E'
    }
  }, "Up ", ascSetIdx + 1, " of ", ascSetLoads.length, " — ", ascSetLoads[ascSetIdx], "kg", ascSetCompleted ? " COMPLETED!" : ""), ascSetRemaining > 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 36,
      color: '#22C55E',
      letterSpacing: 1
    }
  }, ascSetRemaining, "s"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      marginBottom: 8
    }
  }, "Changing load to ", ascSetLoads[ascSetIdx + 1], "kg"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setAscSetRemaining(0);
      setAscSetCompleted(true);
    },
    style: {
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.sub,
      fontSize: 11,
      fontWeight: 700
    }
  }, "Skip")) : ascSetCompleted ? /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setAscSetIdx(i => i + 1);
      setAscSetCompleted(false);
    },
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "Continue to Up ", ascSetIdx + 2) : ascSetIdx < ascSetLoads.length - 1 ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: `Reps completed at ${ascSetLoads[ascSetIdx]}kg`
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0",
    autoFocus: true,
    value: ascSetRepsArr[ascSetIdx] || "",
    onChange: e => setAscSetRepsArr(arr => {
      const na = [...arr];
      na[ascSetIdx] = e.target.value;
      return na;
    }),
    style: ss
  }), ascSetSuggestedReps(ascSetIdx) != null && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: C.muted,
      marginTop: 3
    }
  }, "~", ascSetSuggestedReps(ascSetIdx), " reps — expect fewer than the previous stage, since load and fatigue both increase together")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setAscSetRemaining(15),
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "Complete Up ", ascSetIdx + 1, " — Change to ", ascSetLoads[ascSetIdx + 1], "kg")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: `Reps completed at ${ascSetLoads[ascSetIdx]}kg`
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "0",
    autoFocus: true,
    value: ascSetRepsArr[ascSetIdx] || "",
    onChange: e => setAscSetRepsArr(arr => {
      const na = [...arr];
      na[ascSetIdx] = e.target.value;
      return na;
    }),
    style: ss
  }), ascSetSuggestedReps(ascSetIdx) != null && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: C.muted,
      marginTop: 3
    }
  }, "~", ascSetSuggestedReps(ascSetIdx), " reps — expect fewer than the previous stage, since load and fatigue both increase together")), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      upd("reps", (+ascSetMainReps || +form.reps || 0) + ascSetRepsArr.reduce((s, v) => s + (+v || 0), 0));
      const cx = complexForEx(activeEx);
      if (cx) submit();else setAscSetActive(false);
    },
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, complexForEx(activeEx) ? `✓ Complete Final Up — Log & Continue` : `✓ Complete Final Up — Ready to Log Set`)))), (form.reps || ascSetRepsArr.some(v => v)) && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#22C55E',
      marginTop: 8,
      fontWeight: 600
    }
  }, form.load, "kg×", form.reps || "?", ", ", ascSetLoads.map((l, i) => `${l}kg×${ascSetRepsArr[i] || "?"}`).join(", "), " = ", /*#__PURE__*/React.createElement("strong", null, (+form.reps || 0) + ascSetRepsArr.reduce((s, v) => s + (+v || 0), 0), " total reps"))), isPyramidSet(form.type) && (() => {
    const est1RM = getBest1RM(sessions, activeEx);
    const suggestedLoad = calcAscSetSuggestedMainLoad(est1RM, +pyrUpPct, pyrUpDir, +pyrUpIncAmt, pyrUpTurnsCfg, pyrUpCountNum);
    const suggestedReps = calcAscSetSuggestedMainReps(est1RM, suggestedLoad);
    const finalUpLoad = pyrUpLoads.length ? calcAscSetLoads(suggestedLoad || 0, +pyrUpPct, pyrUpDir, +pyrUpIncAmt, pyrUpTurnsCfg, pyrUpCountNum).slice(-1)[0] : null;
    const finalPct1RM = finalUpLoad != null && est1RM ? Math.round(finalUpLoad / est1RM * 100) : null;
    const overCeiling = finalPct1RM != null && finalPct1RM > 85;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        background: "#A855F715",
        borderRadius: 10,
        padding: "12px 14px",
        border: `1px solid #A855F733`,
        marginBottom: 12
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: '#A855F7',
        fontWeight: 700,
        letterSpacing: 1.5,
        textTransform: "uppercase",
        marginBottom: 10
      }
    }, "🔺 Pyramid Set breakdown"), (() => {
      const cx = complexForEx(activeEx);
      if (!cx) return null;
      const idx = cx.exerciseNames.indexOf(activeEx);
      const isLast = idx === cx.exerciseNames.length - 1;
      const label = complexLabelNumbered(allComplexes, cx._colorIdx);
      const color = complexColorFor(cx._colorIdx);
      return /*#__PURE__*/React.createElement("div", {
        style: {
          background: color + "18",
          border: `1px solid ${color}44`,
          borderRadius: 8,
          padding: "8px 10px",
          marginBottom: 10
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 11,
          color,
          fontWeight: 700
        }
      }, "🔗 Part of ", label, ": ", cx.exerciseNames.join(" → ")), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 9,
          color: C.sub,
          marginTop: 2
        }
      }, isLast ? "Logging this completes the round — rest timer starts, then cycles back to " + cx.exerciseNames[0] + "." : `Logging this will jump straight to ${cx.exerciseNames[idx + 1]} — no rest.`));
    })(), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.muted,
        marginBottom: 10,
        lineHeight: 1.4
      }
    }, "Climbs to a peak, then descends — combining Ascending Set and Drop Set into one continuous sequence, using the fatigue-compensation mechanism of a drop to keep training productively once the peak has been reached."), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: '#A855F7',
        fontWeight: 700,
        letterSpacing: 1,
        textTransform: "uppercase",
        marginBottom: 6
      }
    }, "▲ Ascending phase"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 8
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: "Number of increases"
    }), /*#__PURE__*/React.createElement("input", {
      type: "number",
      min: "0",
      placeholder: "2",
      value: form.pyrUpCount,
      onChange: e => {
        const uc = Math.max(0, +e.target.value || 0);
        upd("pyrUpCount", e.target.value);
        setPyrRepsArr(arr => {
          const na = [...arr];
          while (na.length < uc + pyrDownCountNum) na.push("");
          return na;
        });
      },
      style: ss
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 6
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: "Base Increase % (Main set → Up 1)"
    }), /*#__PURE__*/React.createElement("select", {
      value: pyrUpPct,
      onChange: e => setPyrUpPct(e.target.value),
      style: ss
    }, [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20].map(v => /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, v, "%")))), /*#__PURE__*/React.createElement("div", {
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
      value: pyrUpDir,
      onChange: e => setPyrUpDir(e.target.value),
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
      t: "Increment per stage"
    }), /*#__PURE__*/React.createElement("select", {
      value: pyrUpIncAmt,
      onChange: e => setPyrUpIncAmt(e.target.value),
      style: ss
    }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, v === 0 ? "None (flat %)" : `${v}%`))))), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: '#A855F7',
        fontWeight: 700,
        letterSpacing: 1,
        textTransform: "uppercase",
        marginBottom: 6,
        marginTop: 4
      }
    }, "▼ Descending phase (from the peak)"), /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 8
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: "Number of drops"
    }), /*#__PURE__*/React.createElement("input", {
      type: "number",
      min: "0",
      placeholder: "2",
      value: form.pyrDownCount,
      onChange: e => {
        const dc = Math.max(0, +e.target.value || 0);
        upd("pyrDownCount", e.target.value);
        setPyrRepsArr(arr => {
          const na = [...arr];
          while (na.length < pyrUpCountNum + dc) na.push("");
          return na;
        });
      },
      style: ss
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 6
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: "Base Drop % (Peak → Down 1)"
    }), /*#__PURE__*/React.createElement("select", {
      value: pyrDownPct,
      onChange: e => setPyrDownPct(e.target.value),
      style: ss
    }, [10, 15, 20, 25, 30, 35, 40, 45, 50].map(v => /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, v, "%")))), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8,
        marginBottom: 10
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 70
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: "Trend"
    }), /*#__PURE__*/React.createElement("select", {
      value: pyrDownDir,
      onChange: e => setPyrDownDir(e.target.value),
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
      t: "Increment per stage"
    }), /*#__PURE__*/React.createElement("select", {
      value: pyrDownIncAmt,
      onChange: e => setPyrDownIncAmt(e.target.value),
      style: ss
    }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, v === 0 ? "None (flat %)" : `${v}%`))))), pyrUpCountNum >= 1 && suggestedLoad != null && /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 8,
        background: '#A855F7' + "12",
        border: `1px solid #A855F733`,
        borderRadius: 8,
        padding: "8px 10px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: '#A855F7',
        fontWeight: 700
      }
    }, "💡 Suggested start: ", suggestedLoad, "kg", suggestedReps != null ? ` × ${suggestedReps}` : ""), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.muted
      }
    }, overCeiling ? `Reps at the starting load are capped at 10 for a practical starting point — as a result, the peak stage lands at ~${finalPct1RM}% of Est 1RM (${est1RM}kg), a bit above the usual 85% ceiling.` : `Keeps the peak stage at or below 85% of Est 1RM (${est1RM}kg) — a heavier starting load risks the peak landing at or past what's actually liftable.`)), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        upd("load", suggestedLoad);
        if (suggestedReps != null) upd("reps", suggestedReps);
      },
      style: {
        background: '#A855F7',
        color: "#fff",
        border: "none",
        borderRadius: 6,
        padding: "5px 12px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: 700,
        flexShrink: 0,
        marginLeft: 8
      }
    }, "Use")), pyrAllLoads.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 8
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
        fontSize: 10,
        color: '#A855F7',
        fontWeight: 700,
        width: 60,
        flexShrink: 0
      }
    }, "Main set"), /*#__PURE__*/React.createElement("div", {
      style: {
        background: C.card2,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 12,
        color: C.text,
        flex: 1
      }
    }, form.load || "—", "kg"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: C.muted,
        width: 64,
        textAlign: "center"
      }
    }, form.reps || "—", " reps")), /*#__PURE__*/React.createElement(Lbl, {
      t: "Stage loads (auto) & reps (fill in as you go)"
    }), pyrAllLoads.map((load, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 6
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        color: i < pyrUpCountNum ? C.muted : '#A855F7',
        width: 52,
        flexShrink: 0
      }
    }, i < pyrUpCountNum ? `Up ${i + 1}` : `Down ${i - pyrUpCountNum + 1}`, i === pyrUpCountNum - 1 && pyrDownCountNum > 0 ? " ▲" : ""), /*#__PURE__*/React.createElement("div", {
      style: {
        background: C.card2,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 12,
        color: C.text,
        flex: 1
      }
    }, load, "kg"), /*#__PURE__*/React.createElement("input", {
      type: "number",
      min: "0",
      placeholder: "reps",
      value: pyrRepsArr[i] || "",
      onChange: e => setPyrRepsArr(arr => {
        const na = [...arr];
        na[i] = e.target.value;
        return na;
      }),
      style: {
        ...ss,
        width: 64,
        textAlign: "center"
      }
    }), pyrSuggestedReps(i) != null && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 9,
        color: C.muted,
        width: 38,
        flexShrink: 0
      }
    }, "~", pyrSuggestedReps(i), "r")))), pyrAllLoads.length >= 1 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 10,
        paddingTop: 10,
        borderTop: `1px solid #A855F733`
      }
    }, !pyrActive ? /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setPyrActive(true);
        setPyrIdx(0);
        setPyrRemaining(0);
        setPyrCompleted(false);
        setPyrMainReps(form.reps || "");
      },
      style: {
        width: "100%",
        background: '#A855F7',
        color: "#fff",
        border: "none",
        borderRadius: 8,
        padding: "10px",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 700
      }
    }, "▶ Start Pyramid Sequence") : /*#__PURE__*/React.createElement("div", {
      style: {
        background: C.card,
        border: `1px solid ${'#A855F7'}55`,
        borderRadius: 10,
        padding: "12px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1,
        textTransform: "uppercase",
        marginBottom: 8,
        color: pyrCompleted ? C.accent : '#A855F7'
      }
    }, pyrIdx < pyrUpCountNum ? `Up ${pyrIdx + 1}` : `Down ${pyrIdx - pyrUpCountNum + 1}`, " of ", pyrAllLoads.length, " — ", pyrAllLoads[pyrIdx], "kg", pyrCompleted ? " COMPLETED!" : ""), pyrRemaining > 0 ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Bebas Neue',cursive",
        fontSize: 36,
        color: '#A855F7',
        letterSpacing: 1
      }
    }, pyrRemaining, "s"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.muted,
        marginBottom: 8
      }
    }, "Changing load to ", pyrAllLoads[pyrIdx + 1], "kg"), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setPyrRemaining(0);
        setPyrCompleted(true);
      },
      style: {
        background: "none",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 14px",
        cursor: "pointer",
        color: C.sub,
        fontSize: 11,
        fontWeight: 700
      }
    }, "Skip")) : pyrCompleted ? /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setPyrIdx(i => i + 1);
        setPyrCompleted(false);
      },
      style: {
        width: "100%",
        background: C.accent,
        color: "#001A12",
        border: "none",
        borderRadius: 8,
        padding: "10px",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 700
      }
    }, "Continue to ", pyrIdx + 1 < pyrUpCountNum ? `Up ${pyrIdx + 2}` : `Down ${pyrIdx + 2 - pyrUpCountNum}`) : pyrIdx < pyrAllLoads.length - 1 ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 8
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: `Reps completed at ${pyrAllLoads[pyrIdx]}kg`
    }), /*#__PURE__*/React.createElement("input", {
      type: "number",
      min: "0",
      autoFocus: true,
      value: pyrRepsArr[pyrIdx] || "",
      onChange: e => setPyrRepsArr(arr => {
        const na = [...arr];
        na[pyrIdx] = e.target.value;
        return na;
      }),
      style: ss
    }), pyrSuggestedReps(pyrIdx) != null && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.muted,
        marginTop: 3
      }
    }, "~", pyrSuggestedReps(pyrIdx), " reps")), /*#__PURE__*/React.createElement("button", {
      onClick: () => setPyrRemaining(15),
      style: {
        width: "100%",
        background: C.accent,
        color: "#001A12",
        border: "none",
        borderRadius: 8,
        padding: "10px",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 700
      }
    }, "Complete — Change to ", pyrAllLoads[pyrIdx + 1], "kg")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 8
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: `Reps completed at ${pyrAllLoads[pyrIdx]}kg`
    }), /*#__PURE__*/React.createElement("input", {
      type: "number",
      min: "0",
      autoFocus: true,
      value: pyrRepsArr[pyrIdx] || "",
      onChange: e => setPyrRepsArr(arr => {
        const na = [...arr];
        na[pyrIdx] = e.target.value;
        return na;
      }),
      style: ss
    }), pyrSuggestedReps(pyrIdx) != null && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.muted,
        marginTop: 3
      }
    }, "~", pyrSuggestedReps(pyrIdx), " reps")), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        upd("reps", (+pyrMainReps || +form.reps || 0) + pyrRepsArr.reduce((s, v) => s + (+v || 0), 0));
        const cx = complexForEx(activeEx);
        if (cx) submit();else setPyrActive(false);
      },
      style: {
        width: "100%",
        background: C.accent,
        color: "#001A12",
        border: "none",
        borderRadius: 8,
        padding: "10px",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 700
      }
    }, complexForEx(activeEx) ? `✓ Complete Final Stage — Log & Continue` : `✓ Complete Final Stage — Ready to Log Set`)))), (form.reps || pyrRepsArr.some(v => v)) && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: '#A855F7',
        marginTop: 8,
        fontWeight: 600
      }
    }, form.load, "kg×", form.reps || "?", ", ", pyrAllLoads.map((l, i) => `${l}kg×${pyrRepsArr[i] || "?"}`).join(", "), " = ", /*#__PURE__*/React.createElement("strong", null, (+form.reps || 0) + pyrRepsArr.reduce((s, v) => s + (+v || 0), 0), " total reps")));
  })(), isNegativeSet(form.type) && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#38BDF815",
      borderRadius: 10,
      padding: "12px 14px",
      border: `1px solid #38BDF833`,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#38BDF8',
      fontWeight: 700,
      letterSpacing: 1.5,
      textTransform: "uppercase",
      marginBottom: 10
    }
  }, "⬇ Negative Set breakdown"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Eccentric (lowering)"
  }), /*#__PURE__*/React.createElement("select", {
    value: negEccSecs,
    onChange: e => setNegEccSecs(e.target.value),
    style: ss
  }, Array.from({
    length: 12
  }, (_, i) => i + 1).map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, "s")))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Concentric (lifting)"
  }), /*#__PURE__*/React.createElement("select", {
    value: negConSecs,
    onChange: e => setNegConSecs(e.target.value),
    style: ss
  }, Array.from({
    length: 8
  }, (_, i) => i + 1).map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, "s"))))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#38BDF8',
      fontWeight: 600,
      marginBottom: 10
    }
  }, "Reps: ", form.reps || "—", " · Target TUT: ", form.reps ? `${Math.round(+form.reps * (+negEccSecs + +negConSecs))}s` : "—"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: C.muted,
      lineHeight: 1.5
    }
  }, "Eccentric strength typically exceeds concentric strength by roughly 20-40%, which is the basis for negatives — the muscle can handle more load, or more time under tension, being lowered than it could lift unassisted. If using a heavier-than-normal load (supra-maximal), a spotter is usually needed to assist the concentric (lifting) phase. Research generally supports 2-6s eccentric durations for a meaningful stimulus; longer \"super slow\" protocols exist but evidence for added benefit beyond that range is weaker.")), isIsoType(form.type) && !isComboIso(form.type) && (() => {
    const meta = ISO_META[form.type];
    const yielding = isYieldIso(form.type);
    const overcoming = isOvrcIso(form.type);
    return /*#__PURE__*/React.createElement("div", {
      style: {
        background: meta.color + "15",
        borderRadius: 10,
        padding: "12px 14px",
        border: `1px solid ${meta.color}33`,
        marginBottom: 12
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: meta.color,
        letterSpacing: 1.5,
        textTransform: "uppercase",
        fontWeight: 700,
        marginBottom: 10
      }
    }, meta.icon, " ", meta.label), overcoming ? /*#__PURE__*/React.createElement("div", {
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
      t: "Contractions"
    }), /*#__PURE__*/React.createElement("input", {
      type: "number",
      min: "1",
      placeholder: "3",
      value: form.reps,
      onChange: e => upd("reps", e.target.value),
      style: ss
    })), /*#__PURE__*/React.createElement("div", {
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
    }, v, "s")) : form.type === "Ovrc Iso-Max" ? [3, 4, 5].map(v => /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, v, "s")) : form.type === "Ovrc Iso-Endurance" ? [6, 7, 8, 9, 10].map(v => /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, v, "s")) : Array.from({
      length: 6
    }, (_, i) => 15 + i).map(v => /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, v, "s"))))) : /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 12
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: "Contractions"
    }), /*#__PURE__*/React.createElement("input", {
      type: "number",
      min: "1",
      placeholder: "1",
      value: form.reps,
      onChange: e => upd("reps", e.target.value),
      style: ss
    })), yielding && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
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
    }, v, "s (", Math.floor(v / 60), ":", String(v % 60).padStart(2, "0"), " min)")) : Array.from({
      length: 7
    }, (_, i) => 15 + i * 5).map(v => /*#__PURE__*/React.createElement("option", {
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
        background: meta.color + "15",
        borderRadius: 10,
        padding: "12px 14px",
        border: `1px solid ${meta.color}33`,
        marginBottom: 12
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        fontWeight: 700,
        color: meta.color,
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
    }, "Estimated subjectively (similar to RPE) unless you have force measurement equipment. Guide: 60% = moderately challenging · 75% = hard but holdable · 85% = very difficult."))), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: meta.color + "cc",
        letterSpacing: 1,
        textTransform: "uppercase",
        fontWeight: 700,
        marginBottom: 8
      }
    }, "⚡ Force measurement", /*#__PURE__*/React.createElement("span", {
      style: {
        color: C.muted,
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
        color: meta.color,
        letterSpacing: 1
      }
    }, (+form.force / 9.81).toFixed(1), " kgf"))), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: C.muted,
        lineHeight: 1.5
      }
    }, "Enter peak force from a force plate, dynamometer or load cell.", yielding && form.mvic && form.force ? ` Estimated 100% MVIC ≈ ${(+form.force / (+form.mvic / 100)).toFixed(0)} N (${(+form.force / (+form.mvic / 100) / 9.81).toFixed(1)} kgf).` : ""), form.type === "Ovrc Iso-Ballistic" ?
    // Ballistic: too short (0.5-1s) for a traditional countdown —
    // tap to start, "GO!" fires immediately, beep lands precisely
    // after the selected duration via a sub-second timer instead
    // of the normal 1s-tick system. Pause only applies between
    // contractions (nothing meaningful to pause mid-flight).
    (+form.reps || 0) >= 1 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 10,
        paddingTop: 10,
        borderTop: `1px solid ${meta.color}33`
      }
    }, !ballisticActive && (+form.reps || 0) > 1 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 10
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: "Rest between contractions (s)"
    }), /*#__PURE__*/React.createElement("select", {
      value: ballisticRestSel,
      onChange: e => setBallisticRestSel(e.target.value),
      style: ss
    }, (ISO_REST_RANGES["Ovrc Iso-Ballistic"] || [5]).map(v => /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, v, "s")))), !ballisticActive && (+form.reps || 0) > 1 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 10
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: "Between contractions"
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setIsoAutoContinue(false),
      style: {
        flex: 1,
        background: !isoAutoContinue ? meta.color : "none",
        border: `1px solid ${meta.color}55`,
        borderRadius: 8,
        padding: "8px",
        cursor: "pointer",
        color: !isoAutoContinue ? "#fff" : C.sub,
        fontSize: 12,
        fontWeight: 700
      }
    }, "Manual"), /*#__PURE__*/React.createElement("button", {
      onClick: () => setIsoAutoContinue(true),
      style: {
        flex: 1,
        background: isoAutoContinue ? meta.color : "none",
        border: `1px solid ${meta.color}55`,
        borderRadius: 8,
        padding: "8px",
        cursor: "pointer",
        color: isoAutoContinue ? "#fff" : C.sub,
        fontSize: 12,
        fontWeight: 700
      }
    }, "Auto")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.muted,
        marginTop: 2
      }
    }, isoAutoContinue ? "Advances on its own after each rest period" : "Tap Continue between contractions")), !ballisticActive ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setBallisticActive(true);
        setBallisticIdx(0);
        setBallisticGo(false);
        setBallisticCompleted(false);
        setBallisticPaused(false);
      },
      disabled: !form.holdDuration,
      style: {
        width: "100%",
        background: form.holdDuration ? meta.color : C.card2,
        color: form.holdDuration ? "#fff" : C.muted,
        border: "none",
        borderRadius: 8,
        padding: "10px",
        cursor: form.holdDuration ? "pointer" : "not-allowed",
        fontSize: 13,
        fontWeight: 700
      }
    }, "▶ Start Sequence"), !form.holdDuration && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.warn,
        marginTop: 6,
        textAlign: "center"
      }
    }, "Select a Hold Duration above first")) : /*#__PURE__*/React.createElement("div", {
      style: {
        background: C.card,
        border: `1px solid ${meta.color}55`,
        borderRadius: 10,
        padding: "12px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1,
        textTransform: "uppercase",
        marginBottom: 8,
        color: ballisticCompleted ? C.accent : ballisticJustEnded ? C.warn : ballisticPrecount > 0 || ballisticRestRemaining > 0 ? C.muted : meta.color
      }
    }, ballisticPrecount > 0 ? `Get Ready — Contraction ${ballisticIdx + 1}` : ballisticJustEnded ? `Contraction ${ballisticIdx + 1} of ${form.reps}` : ballisticRestRemaining > 0 ? `Resting — Before Contraction ${ballisticIdx + 2}` : `Contraction ${ballisticIdx + 1} of ${form.reps}${ballisticCompleted ? " COMPLETED!" : ""}`), ballisticPrecount > 0 ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Bebas Neue',cursive",
        fontSize: 56,
        color: C.warn,
        letterSpacing: 1
      }
    }, ballisticPrecount, ballisticPaused ? " ⏸" : ""), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.muted,
        marginBottom: 8
      }
    }, ballisticPaused ? "Paused" : "Get ready…"), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setBallisticActive(false);
        setBallisticIdx(0);
        setBallisticGo(false);
        setBallisticPrecount(0);
        setBallisticJustEnded(false);
        setBallisticCompleted(false);
        setBallisticPaused(false);
      },
      style: {
        background: "none",
        border: `1px solid ${C.warn}55`,
        borderRadius: 6,
        padding: "6px 14px",
        cursor: "pointer",
        color: C.warn,
        fontSize: 11,
        fontWeight: 700
      }
    }, "■ Stop")) : ballisticJustEnded ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Bebas Neue',cursive",
        fontSize: 48,
        color: C.warn,
        letterSpacing: 1
      }
    }, "END!", ballisticPaused ? " ⏸" : "")) : ballisticGo ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Bebas Neue',cursive",
        fontSize: 48,
        color: meta.color,
        letterSpacing: 1
      }
    }, "GO!"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.muted
      }
    }, "Contract as hard and fast as possible")) : ballisticRestRemaining > 0 ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Bebas Neue',cursive",
        fontSize: 36,
        color: C.gold,
        letterSpacing: 1
      }
    }, ballisticRestRemaining, "s", ballisticPaused ? " ⏸" : ""), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.muted,
        marginBottom: 8
      }
    }, ballisticPaused ? "Paused" : "Recover before the next contraction"), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8,
        justifyContent: "center"
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setBallisticPaused(p => !p),
      style: {
        background: "none",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 14px",
        cursor: "pointer",
        color: C.sub,
        fontSize: 11,
        fontWeight: 700
      }
    }, ballisticPaused ? "▶ Resume" : "⏸ Pause"), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setBallisticRestRemaining(0);
        setBallisticCompleted(true);
      },
      style: {
        background: "none",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 14px",
        cursor: "pointer",
        color: C.sub,
        fontSize: 11,
        fontWeight: 700
      }
    }, "Skip Rest"), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setBallisticActive(false);
        setBallisticIdx(0);
        setBallisticGo(false);
        setBallisticPrecount(0);
        setBallisticJustEnded(false);
        setBallisticRestRemaining(0);
        setBallisticCompleted(false);
        setBallisticPaused(false);
      },
      style: {
        background: "none",
        border: `1px solid ${C.warn}55`,
        borderRadius: 6,
        padding: "6px 14px",
        cursor: "pointer",
        color: C.warn,
        fontSize: 11,
        fontWeight: 700
      }
    }, "■ Stop"))) : ballisticCompleted ? ballisticIdx < (+form.reps || 1) - 1 ? /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setBallisticIdx(i => i + 1);
        setBallisticCompleted(false);
      },
      style: {
        width: "100%",
        background: C.accent,
        color: "#001A12",
        border: "none",
        borderRadius: 8,
        padding: "10px",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 700
      }
    }, "Continue to Contraction ", ballisticIdx + 2) : /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        const cx = complexForEx(activeEx);
        if (cx) submit();else setBallisticActive(false);
      },
      style: {
        width: "100%",
        background: C.accent,
        color: "#001A12",
        border: "none",
        borderRadius: 8,
        padding: "10px",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 700
      }
    }, complexForEx(activeEx) ? `✓ Complete — Log & Continue` : `✓ Complete — Ready to Log Set`) : /*#__PURE__*/React.createElement("button", {
      onClick: () => setBallisticPrecount(3),
      style: {
        width: "100%",
        background: meta.color,
        color: "#fff",
        border: "none",
        borderRadius: 8,
        padding: "10px",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 700
      }
    }, "Start Contraction ", ballisticIdx + 1, " — ", form.holdDuration, "s"))) :
    // Max, Endurance, Sustained, Holds, GPP — a normal countdown
    // sequence, cycling through however many Contractions are set,
    // each held for form.holdDuration (already selected above).
    (+form.reps || 0) >= 1 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 10,
        paddingTop: 10,
        borderTop: `1px solid ${meta.color}33`
      }
    }, !isoSeqActive && (+form.reps || 0) > 1 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 10
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: "Rest between contractions (s)"
    }), /*#__PURE__*/React.createElement("select", {
      value: isoRestSel,
      onChange: e => setIsoRestSel(e.target.value),
      style: ss
    }, (ISO_REST_RANGES[form.type] || [5]).map(v => /*#__PURE__*/React.createElement("option", {
      key: v,
      value: v
    }, v, "s")))), !isoSeqActive && (+form.reps || 0) > 1 && /*#__PURE__*/React.createElement("div", {
      style: {
        marginBottom: 10
      }
    }, /*#__PURE__*/React.createElement(Lbl, {
      t: "Between contractions"
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setIsoAutoContinue(false),
      style: {
        flex: 1,
        background: !isoAutoContinue ? meta.color : "none",
        border: `1px solid ${meta.color}55`,
        borderRadius: 8,
        padding: "8px",
        cursor: "pointer",
        color: !isoAutoContinue ? "#fff" : C.sub,
        fontSize: 12,
        fontWeight: 700
      }
    }, "Manual"), /*#__PURE__*/React.createElement("button", {
      onClick: () => setIsoAutoContinue(true),
      style: {
        flex: 1,
        background: isoAutoContinue ? meta.color : "none",
        border: `1px solid ${meta.color}55`,
        borderRadius: 8,
        padding: "8px",
        cursor: "pointer",
        color: isoAutoContinue ? "#fff" : C.sub,
        fontSize: 12,
        fontWeight: 700
      }
    }, "Auto")), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9,
        color: C.muted,
        marginTop: 2
      }
    }, isoAutoContinue ? "Advances on its own after each rest period" : "Tap Continue between contractions")), !isoSeqActive ? (() => {
      const missingHold = !form.holdDuration;
      const missingMvic = yielding && !form.mvic;
      const canStart = !missingHold && !missingMvic;
      return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
        onClick: () => {
          setIsoSeqActive(true);
          setIsoSeqIdx(0);
          setIsoSeqRemaining(0);
          setIsoSeqCompleted(false);
          setIsoSeqPaused(false);
        },
        disabled: !canStart,
        style: {
          width: "100%",
          background: canStart ? meta.color : C.card2,
          color: canStart ? "#fff" : C.muted,
          border: "none",
          borderRadius: 8,
          padding: "10px",
          cursor: canStart ? "pointer" : "not-allowed",
          fontSize: 13,
          fontWeight: 700
        }
      }, "▶ Start Sequence"), !canStart && /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 10,
          color: C.warn,
          marginTop: 6,
          textAlign: "center"
        }
      }, missingHold && missingMvic ? "Select a Hold Duration and % MVIC above first" : missingHold ? "Select a Hold Duration above first" : "Select a % MVIC above first"));
    })() : /*#__PURE__*/React.createElement("div", {
      style: {
        background: C.card,
        border: `1px solid ${meta.color}55`,
        borderRadius: 10,
        padding: "12px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1,
        textTransform: "uppercase",
        marginBottom: 8,
        color: isoSeqCompleted ? C.accent : isoSeqJustEnded ? C.warn : isoSeqPrecount > 0 || isoSeqResting ? C.muted : meta.color
      }
    }, isoSeqPrecount > 0 ? `Get Ready — Contraction ${isoSeqIdx + 1}` : isoSeqJustEnded ? `Contraction ${isoSeqIdx + 1} of ${form.reps}` : isoSeqResting ? `Resting — Before Contraction ${isoSeqIdx + 2}` : `Contraction ${isoSeqIdx + 1} of ${form.reps}${isoSeqCompleted ? " COMPLETED!" : ""}`), isoSeqPrecount > 0 ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Bebas Neue',cursive",
        fontSize: 56,
        color: C.warn,
        letterSpacing: 1
      }
    }, isoSeqPrecount, isoSeqPaused ? " ⏸" : ""), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.muted,
        marginBottom: 8
      }
    }, isoSeqPaused ? "Paused" : "Get ready…"), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setIsoSeqActive(false);
        setIsoSeqIdx(0);
        setIsoSeqRemaining(0);
        setIsoSeqResting(false);
        setIsoSeqPrecount(0);
        setIsoSeqJustEnded(false);
        setIsoSeqCompleted(false);
        setIsoSeqPaused(false);
      },
      style: {
        background: "none",
        border: `1px solid ${C.warn}55`,
        borderRadius: 6,
        padding: "6px 14px",
        cursor: "pointer",
        color: C.warn,
        fontSize: 11,
        fontWeight: 700
      }
    }, "■ Stop")) : isoSeqJustEnded ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Bebas Neue',cursive",
        fontSize: 48,
        color: C.warn,
        letterSpacing: 1
      }
    }, "END!", isoSeqPaused ? " ⏸" : "")) : isoSeqRemaining > 0 ? /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center"
      }
    }, !isoSeqResting && /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Bebas Neue',cursive",
        fontSize: 48,
        color: meta.color,
        letterSpacing: 1,
        marginBottom: 2
      }
    }, "GO!"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'Bebas Neue',cursive",
        fontSize: isoSeqResting ? 36 : 44,
        color: isoSeqResting ? C.gold : meta.color,
        letterSpacing: 1
      }
    }, isoSeqRemaining, "s", isoSeqPaused ? " ⏸" : ""), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 10,
        color: C.muted,
        marginBottom: 8
      }
    }, isoSeqPaused ? "Paused" : isoSeqResting ? "Recover before the next contraction" : overcoming ? "Contract as hard as possible" : `Sustain the hold`), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8,
        justifyContent: "center"
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setIsoSeqPaused(p => !p),
      style: {
        background: "none",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 14px",
        cursor: "pointer",
        color: C.sub,
        fontSize: 11,
        fontWeight: 700
      }
    }, isoSeqPaused ? "▶ Resume" : "⏸ Pause"), isoSeqResting && /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setIsoSeqRemaining(0);
        setIsoSeqResting(false);
        setIsoSeqCompleted(true);
      },
      style: {
        background: "none",
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 14px",
        cursor: "pointer",
        color: C.sub,
        fontSize: 11,
        fontWeight: 700
      }
    }, "Skip Rest"), /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setIsoSeqActive(false);
        setIsoSeqIdx(0);
        setIsoSeqRemaining(0);
        setIsoSeqResting(false);
        setIsoSeqPrecount(0);
        setIsoSeqJustEnded(false);
        setIsoSeqCompleted(false);
        setIsoSeqPaused(false);
      },
      style: {
        background: "none",
        border: `1px solid ${C.warn}55`,
        borderRadius: 6,
        padding: "6px 14px",
        cursor: "pointer",
        color: C.warn,
        fontSize: 11,
        fontWeight: 700
      }
    }, "■ Stop"))) : isoSeqCompleted ? isoSeqIdx < (+form.reps || 1) - 1 ? /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setIsoSeqIdx(i => i + 1);
        setIsoSeqCompleted(false);
      },
      style: {
        width: "100%",
        background: C.accent,
        color: "#001A12",
        border: "none",
        borderRadius: 8,
        padding: "10px",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 700
      }
    }, "Continue to Contraction ", isoSeqIdx + 2) : /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        const cx = complexForEx(activeEx);
        if (cx) submit();else setIsoSeqActive(false);
      },
      style: {
        width: "100%",
        background: C.accent,
        color: "#001A12",
        border: "none",
        borderRadius: 8,
        padding: "10px",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 700
      }
    }, complexForEx(activeEx) ? `✓ Complete — Log & Continue` : `✓ Complete — Ready to Log Set`) : /*#__PURE__*/React.createElement("button", {
      onClick: () => {
        setIsoSeqResting(false);
        setIsoSeqPrecount(3);
      },
      style: {
        width: "100%",
        background: meta.color,
        color: "#fff",
        border: "none",
        borderRadius: 8,
        padding: "10px",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 700
      }
    }, "Start Contraction ", isoSeqIdx + 1, " — ", form.holdDuration, "s"))));
  })(), isComboIso(form.type) && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#E8398A15",
      borderRadius: 10,
      padding: "12px 14px",
      border: `1px solid #E8398A33`,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "#E8398A",
      letterSpacing: 1.5,
      textTransform: "uppercase",
      fontWeight: 700,
      marginBottom: 10
    }
  }, "💥 Overcoming Iso — Strength + Hypertrophy"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: C.muted,
      marginBottom: 10,
      lineHeight: 1.5
    }
  }, "Position the muscle at a longer, stretched length before contracting — this tends to produce a stronger training stimulus. Phase 1 primes the nervous system; Phase 2's extended submaximal hold, done in an already-fatigued state, adds a hypertrophy-focused stimulus on top."), !comboActive && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "#E8398A",
      fontWeight: 700,
      marginBottom: 6,
      textTransform: "uppercase",
      letterSpacing: 1
    }
  }, "Phase 1 — Max Effort"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Rounds"
  }), /*#__PURE__*/React.createElement("select", {
    value: comboRounds,
    onChange: e => setComboRounds(e.target.value),
    style: ss
  }, [3, 4, 5, 6, 7].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v)))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Contract (s)"
  }), /*#__PURE__*/React.createElement("select", {
    value: comboContractSecs,
    onChange: e => setComboContractSecs(e.target.value),
    style: ss
  }, [2, 3, 4].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, "s")))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Rest (s)"
  }), /*#__PURE__*/React.createElement("select", {
    value: comboRestSecs,
    onChange: e => setComboRestSecs(e.target.value),
    style: ss
  }, [3, 4, 5, 6, 7, 8].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, "s"))))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: "#E8398A",
      fontWeight: 700,
      marginBottom: 6,
      textTransform: "uppercase",
      letterSpacing: 1
    }
  }, "Phase 2 — The Burn"), /*#__PURE__*/React.createElement("div", {
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
    t: "Effort %"
  }), /*#__PURE__*/React.createElement("select", {
    value: comboHoldPct,
    onChange: e => setComboHoldPct(e.target.value),
    style: ss
  }, [30, 40, 50, 60, 70].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, "%")))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Hold (s)"
  }), /*#__PURE__*/React.createElement("select", {
    value: comboHoldSecs,
    onChange: e => setComboHoldSecs(e.target.value),
    style: ss
  }, Array.from({
    length: 7
  }, (_, i) => 30 + i * 5).map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, "s"))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Rest before repeating the whole protocol (s)"
  }), /*#__PURE__*/React.createElement("select", {
    value: comboCycleRestSecs,
    onChange: e => setComboCycleRestSecs(e.target.value),
    style: ss
  }, [60, 75, 90, 105, 120].map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, "s"))), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: C.muted,
      marginTop: 2
    }
  }, "5 rounds of max effort plus an extended submaximal hold is genuinely demanding — this gives dedicated recovery before another full cycle, separate from this exercise's normal between-set rest."))), !comboActive && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Between rounds & after the hold"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setIsoAutoContinue(false),
    style: {
      flex: 1,
      background: !isoAutoContinue ? "#E8398A" : "none",
      border: "1px solid #E8398A55",
      borderRadius: 8,
      padding: "8px",
      cursor: "pointer",
      color: !isoAutoContinue ? "#fff" : C.sub,
      fontSize: 12,
      fontWeight: 700
    }
  }, "Manual"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setIsoAutoContinue(true),
    style: {
      flex: 1,
      background: isoAutoContinue ? "#E8398A" : "none",
      border: "1px solid #E8398A55",
      borderRadius: 8,
      padding: "8px",
      cursor: "pointer",
      color: isoAutoContinue ? "#fff" : C.sub,
      fontSize: 12,
      fontWeight: 700
    }
  }, "Auto")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: C.muted,
      marginTop: 2
    }
  }, isoAutoContinue ? "Advances on its own between rounds, and into recovery after the hold" : "Tap Continue between rounds, and to start recovery after the hold")), !comboActive && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "Transition from Phase 1 to Phase 2"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setComboPhaseAuto(false),
    style: {
      flex: 1,
      background: !comboPhaseAuto ? "#E8398A" : "none",
      border: "1px solid #E8398A55",
      borderRadius: 8,
      padding: "8px",
      cursor: "pointer",
      color: !comboPhaseAuto ? "#fff" : C.sub,
      fontSize: 12,
      fontWeight: 700
    }
  }, "Manual"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setComboPhaseAuto(true),
    style: {
      flex: 1,
      background: comboPhaseAuto ? "#E8398A" : "none",
      border: "1px solid #E8398A55",
      borderRadius: 8,
      padding: "8px",
      cursor: "pointer",
      color: comboPhaseAuto ? "#fff" : C.sub,
      fontSize: 12,
      fontWeight: 700
    }
  }, "Auto")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9,
      color: C.muted,
      marginTop: 2
    }
  }, comboPhaseAuto ? "Moves straight from the last round into Phase 2's hold, no tap needed" : "Tap Continue to Phase 2 after the last round finishes")), !comboActive ? /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setComboActive(true);
      setComboStage("precontract");
      setComboRoundIdx(0);
      setComboPrecount(3);
      setComboPaused(false);
    },
    style: {
      width: "100%",
      background: "#E8398A",
      color: "#fff",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "▶ Start Protocol") : /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      border: `1px solid #E8398A55`,
      borderRadius: 10,
      padding: "12px"
    }
  }, (comboStage === "precontract" || comboStage === "prehold") && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 8,
      color: "#E8398A"
    }
  }, comboStage === "precontract" ? `Get Ready — Round ${comboRoundIdx + 1}` : "Get Ready — Phase 2"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 56,
      color: C.warn,
      letterSpacing: 1
    }
  }, comboPrecount, comboPaused ? " ⏸" : ""), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      marginBottom: 8
    }
  }, comboPaused ? "Paused" : "Get ready…"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setComboActive(false);
      setComboStage("ready");
      setComboRoundIdx(0);
      setComboRemaining(0);
      setComboPrecount(0);
      setComboPaused(false);
    },
    style: {
      background: "none",
      border: `1px solid ${C.warn}55`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.warn,
      fontSize: 11,
      fontWeight: 700
    }
  }, "■ Stop"))), comboStage === "contract" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 8,
      color: "#E8398A"
    }
  }, "Round ", comboRoundIdx + 1, " of ", comboRounds, " — Max Effort"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 48,
      color: "#E8398A",
      letterSpacing: 1,
      marginBottom: 2
    }
  }, "GO!"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 44,
      color: "#E8398A",
      letterSpacing: 1
    }
  }, comboRemaining, "s", comboPaused ? " ⏸" : ""), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      marginBottom: 8
    }
  }, comboPaused ? "Paused" : "Contract as hard as possible"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setComboPaused(p => !p),
    style: {
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.sub,
      fontSize: 11,
      fontWeight: 700
    }
  }, comboPaused ? "▶ Resume" : "⏸ Pause"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setComboActive(false);
      setComboStage("ready");
      setComboRoundIdx(0);
      setComboRemaining(0);
      setComboPrecount(0);
      setComboPaused(false);
    },
    style: {
      background: "none",
      border: `1px solid ${C.warn}55`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.warn,
      fontSize: 11,
      fontWeight: 700
    }
  }, "■ Stop")))), comboStage === "contractend" && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 48,
      color: C.warn,
      letterSpacing: 1
    }
  }, "END!", comboPaused ? " ⏸" : ""), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setComboActive(false);
      setComboStage("ready");
      setComboRoundIdx(0);
      setComboRemaining(0);
      setComboPrecount(0);
      setComboPaused(false);
    },
    style: {
      background: "none",
      border: `1px solid ${C.warn}55`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.warn,
      fontSize: 11,
      fontWeight: 700,
      marginTop: 8
    }
  }, "■ Stop")), comboStage === "rest" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 8,
      color: C.muted
    }
  }, "Round ", comboRoundIdx + 1, " of ", comboRounds, " — Resting"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 36,
      color: C.gold,
      letterSpacing: 1
    }
  }, comboRemaining, "s", comboPaused ? " ⏸" : ""), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      marginBottom: 8
    }
  }, comboPaused ? "Paused" : `Rest before Round ${comboRoundIdx + 2}`), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setComboPaused(p => !p),
    style: {
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.sub,
      fontSize: 11,
      fontWeight: 700
    }
  }, comboPaused ? "▶ Resume" : "⏸ Pause"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setComboRemaining(0),
    style: {
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.sub,
      fontSize: 11,
      fontWeight: 700
    }
  }, "Skip Rest"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setComboActive(false);
      setComboStage("ready");
      setComboRoundIdx(0);
      setComboRemaining(0);
      setComboPrecount(0);
      setComboPaused(false);
    },
    style: {
      background: "none",
      border: `1px solid ${C.warn}55`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.warn,
      fontSize: 11,
      fontWeight: 700
    }
  }, "■ Stop")))), comboStage === "roundrestdone" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 8,
      color: C.accent
    }
  }, "Round ", comboRoundIdx, " COMPLETED!"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setComboStage("precontract");
      setComboPrecount(3);
    },
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "Continue to Round ", comboRoundIdx + 1)), comboStage === "phase1done" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 8,
      color: C.accent
    }
  }, "Phase 1 COMPLETED!"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setComboStage("prehold");
      setComboPrecount(3);
    },
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "Continue to Phase 2 — The Burn")), comboStage === "hold" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 8,
      color: "#E8398A"
    }
  }, "Phase 2 — Hold at ", comboHoldPct, "%"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 48,
      color: "#E8398A",
      letterSpacing: 1,
      marginBottom: 2
    }
  }, "GO!"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 44,
      color: "#E8398A",
      letterSpacing: 1
    }
  }, comboRemaining, "s", comboPaused ? " ⏸" : ""), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      marginBottom: 8
    }
  }, comboPaused ? "Paused" : `Sustain at ~${comboHoldPct}% effort`), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setComboPaused(p => !p),
    style: {
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.sub,
      fontSize: 11,
      fontWeight: 700
    }
  }, comboPaused ? "▶ Resume" : "⏸ Pause"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setComboActive(false);
      setComboStage("ready");
      setComboRoundIdx(0);
      setComboRemaining(0);
      setComboPrecount(0);
      setComboPaused(false);
    },
    style: {
      background: "none",
      border: `1px solid ${C.warn}55`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.warn,
      fontSize: 11,
      fontWeight: 700
    }
  }, "■ Stop")))), comboStage === "holdend" && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 48,
      color: C.warn,
      letterSpacing: 1
    }
  }, "END!", comboPaused ? " ⏸" : ""), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setComboActive(false);
      setComboStage("ready");
      setComboRoundIdx(0);
      setComboRemaining(0);
      setComboPrecount(0);
      setComboPaused(false);
    },
    style: {
      background: "none",
      border: `1px solid ${C.warn}55`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.warn,
      fontSize: 11,
      fontWeight: 700,
      marginTop: 8
    }
  }, "■ Stop")), comboStage === "phase2done" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 8,
      color: C.accent
    }
  }, "Phase 2 COMPLETED!"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setComboStage("cyclerest");
      setComboRemaining(+comboCycleRestSecs || 90);
    },
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, "Continue to Recovery")), comboStage === "cyclerest" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 8,
      color: C.muted
    }
  }, "Recovery — Before Repeating the Protocol"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 36,
      color: C.gold,
      letterSpacing: 1
    }
  }, comboRemaining, "s", comboPaused ? " ⏸" : ""), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: C.muted,
      marginBottom: 8
    }
  }, comboPaused ? "Paused" : "Full recovery before another complete cycle"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setComboPaused(p => !p),
    style: {
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.sub,
      fontSize: 11,
      fontWeight: 700
    }
  }, comboPaused ? "▶ Resume" : "⏸ Pause"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setComboRemaining(0),
    style: {
      background: "none",
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.sub,
      fontSize: 11,
      fontWeight: 700
    }
  }, "Skip Rest"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setComboActive(false);
      setComboStage("ready");
      setComboRoundIdx(0);
      setComboRemaining(0);
      setComboPrecount(0);
      setComboPaused(false);
    },
    style: {
      background: "none",
      border: `1px solid ${C.warn}55`,
      borderRadius: 6,
      padding: "6px 14px",
      cursor: "pointer",
      color: C.warn,
      fontSize: 11,
      fontWeight: 700
    }
  }, "■ Stop")))), comboStage === "done" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 1,
      textTransform: "uppercase",
      marginBottom: 8,
      color: C.accent
    }
  }, "COMPLETED!"), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      upd("reps", +comboRounds || 5);
      const cx = complexForEx(activeEx);
      if (cx) submit();else setComboActive(false);
    },
    style: {
      width: "100%",
      background: C.accent,
      color: "#001A12",
      border: "none",
      borderRadius: 8,
      padding: "10px",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 700
    }
  }, complexForEx(activeEx) ? `✓ Complete — Log & Continue` : `✓ Complete — Ready to Log Set`)))), !isOvrcIso(form.type) && /*#__PURE__*/React.createElement("div", {
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
    onChange: v => {
      upd("type", v);
      upd("holdDuration", "");
      setSetTypePerEx(m => ({
        ...m,
        [activeEx]: v
      }));
    },
    options: setTypeList,
    onAddOption: onAddSetType,
    addLabel: "Add set type",
    onEditOption: onEditSetType,
    onDeleteOption: onDeleteSetType
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
  }, r))), zoneTarget && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 6,
      background: C.blue + "12",
      border: `1px solid ${C.blue}33`,
      borderRadius: 8,
      padding: "6px 10px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.blue,
      fontWeight: 700
    }
  }, "🎯 ", zoneTarget.targetRIR, " RIR"), /*#__PURE__*/React.createElement("button", {
    onClick: () => upd("rir", zoneTarget.targetRIR),
    style: {
      background: C.blue,
      color: "#fff",
      border: "none",
      borderRadius: 6,
      padding: "5px 12px",
      cursor: "pointer",
      fontSize: 11,
      fontWeight: 700,
      flexShrink: 0
    }
  }, "Use"))), /*#__PURE__*/React.createElement("div", {
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
  }, r, " – ", RPE_DESC[r]))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowRMCalc(s => !s),
    style: {
      width: "100%",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      background: C.card2,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: "10px 14px",
      cursor: "pointer",
      color: C.text,
      fontSize: 13,
      fontWeight: 700
    }
  }, /*#__PURE__*/React.createElement("span", null, "🧮 Rep Max Calculator"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: C.muted,
      fontSize: 11
    }
  }, showRMCalc ? "▲" : "▼")), showRMCalc && /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.card,
      border: `1px solid ${C.border}`,
      borderRadius: 10,
      padding: "14px",
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.sub,
      marginBottom: 12,
      lineHeight: 1.5
    }
  }, "Pick any rep-max and RIR combo — calculates the %1RM, load, and reps to actually execute, independent of the automated zone target above."), /*#__PURE__*/React.createElement("div", {
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
    t: "Rep Max (N)"
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "1",
    value: rmCalcN,
    onChange: e => setRmCalcN(e.target.value),
    style: ss
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement(Lbl, {
    t: "RIR"
  }), /*#__PURE__*/React.createElement("select", {
    value: rmCalcRIR,
    onChange: e => setRmCalcRIR(e.target.value),
    style: ss
  }, [0, 1, 2, 3, 4].map(r => /*#__PURE__*/React.createElement("option", {
    key: r,
    value: r
  }, r))))), rmCalc ? /*#__PURE__*/React.createElement("div", {
    style: {
      background: C.gold + "12",
      border: `1px solid ${C.gold}33`,
      borderRadius: 8,
      padding: "12px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: C.gold,
      fontWeight: 700,
      marginBottom: 4
    }
  }, rmCalc.repMax, "RM, ", rmCalc.rir, " RIR → Execute ", rmCalc.repsToExecute, " rep", rmCalc.repsToExecute !== 1 ? "s" : ""), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 20,
      fontFamily: "'Bebas Neue',cursive",
      color: C.text,
      marginBottom: 4
    }
  }, rmCalc.load, "kg ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: C.muted,
      fontFamily: "inherit"
    }
  }, "(", rmCalc.pct, "% of ~", rmCalc.best1RM, "kg best Est 1RM)")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => upd("load", rmCalc.load),
    style: {
      flex: 1,
      background: C.gold,
      color: "#1A1200",
      border: "none",
      borderRadius: 6,
      padding: "8px",
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 700
    }
  }, "Use Load"), /*#__PURE__*/React.createElement("button", {
    onClick: () => upd("reps", rmCalc.repsToExecute),
    style: {
      flex: 1,
      background: C.gold,
      color: "#1A1200",
      border: "none",
      borderRadius: 6,
      padding: "8px",
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 700
    }
  }, "Use Reps"), /*#__PURE__*/React.createElement("button", {
    onClick: () => upd("rir", rmCalc.rir),
    style: {
      flex: 1,
      background: C.gold,
      color: "#1A1200",
      border: "none",
      borderRadius: 6,
      padding: "8px",
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 700
    }
  }, "Use RIR"))) : /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: C.muted,
      textAlign: "center",
      padding: "10px"
    }
  }, "No prior load/rep history for ", activeEx, " yet — nothing to calculate a 1RM from."))), (() => {
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
  })), editingEntryRef && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      background: C.blue + "18",
      border: `1px solid ${C.blue}44`,
      borderRadius: 10,
      padding: "8px 12px",
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: C.blue,
      fontWeight: 700
    }
  }, "✎ Editing Set ", form.setNo, " of ", editingEntryRef.sessionDate === today ? "current" : editingEntryRef.sessionDate, clientName ? ` of ${clientName}` : ""), /*#__PURE__*/React.createElement("button", {
    onClick: cancelEditEntry,
    style: {
      background: "none",
      border: "none",
      color: C.sub,
      cursor: "pointer",
      fontSize: 12,
      fontWeight: 700
    }
  }, "Cancel")), /*#__PURE__*/React.createElement("button", {
    onClick: submit,
    style: {
      width: "100%",
      background: saved ? C.accent + "CC" : editingEntryRef ? C.blue : C.accent,
      color: editingEntryRef && !saved ? "#fff" : "#001A12",
      border: "none",
      borderRadius: 10,
      padding: "14px",
      cursor: "pointer",
      fontFamily: "'Bebas Neue',cursive",
      fontSize: 20,
      letterSpacing: 2
    }
  }, saved ? editingEntryRef ? `✓  SET UPDATED!` : `✓  ${activeEx.toUpperCase()} LOGGED!` : editingEntryRef ? "UPDATE SET" : "LOG SET")), sessions.at(-1)?.date === today && sessions.at(-1).entries.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(SecLabel, {
    text: "Today's session"
  }), progExNames.map(name => {
    const todaySessionId = sessions.at(-1).id;
    const allEntries = sessions.at(-1).entries;
    const todayEntries = allEntries.map((e, idx) => ({
      e,
      idx
    })).filter(({
      e
    }) => e.ex === name);
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
    }, name, (() => {
      const cx = complexForEx(name);
      if (!cx) return null;
      return /*#__PURE__*/React.createElement("span", {
        style: {
          color: complexColorFor(cx._colorIdx),
          marginLeft: 5
        }
      }, "(", complexLabelNumbered(allComplexes, cx._colorIdx), ")");
    })()), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 6
      }
    }, todayEntries.map(({
      e,
      idx
    }) => /*#__PURE__*/React.createElement("div", {
      key: idx,
      style: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        background: C.card2,
        borderRadius: 8,
        padding: "6px 6px 6px 12px",
        border: `1px solid ${C.border}`
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 12
      }
    }, e.clusterRepsArr?.length ? `Set ${e.set}: ${e.reps}(${e.clusterRepsArr.join("; ")})*${e.load}kg` : e.dropSetLoads?.length > 0 ? `Set ${e.set}: ${e.load}kg×${e.dropSetMainReps ?? "?"}, ${e.dropSetLoads.map((l, i) => `${l}kg×${e.dropSetReps?.[i] ?? "?"}`).join(", ")}` : e.ascSetLoads?.length > 0 ? `Set ${e.set}: ${e.load}kg×${e.ascSetMainReps ?? "?"}, ${e.ascSetLoads.map((l, i) => `${l}kg×${e.ascSetReps?.[i] ?? "?"}`).join(", ")}` : e.pyrLoads?.length > 0 ? `Set ${e.set}: ${e.load}kg×${e.pyrMainReps ?? "?"}, ${e.pyrLoads.map((l, i) => `${l}kg×${e.pyrReps?.[i] ?? "?"}`).join(", ")}` : isNegativeSet(e.type) && (e.eccSecs || e.conSecs) ? `Set ${e.set}: ${e.reps}×${e.load}kg (${e.eccSecs || "?"}s ecc / ${e.conSecs || "?"}s con)` : `Set ${e.set}: ${e.reps}×${e.load}kg`), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 6,
        flexShrink: 0
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => startEditEntry(todaySessionId, idx, e),
      style: {
        background: C.blue + "18",
        border: `1px solid ${C.blue}44`,
        borderRadius: 6,
        width: 30,
        height: 30,
        cursor: "pointer",
        color: C.blue,
        fontSize: 14,
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      },
      title: "Edit this set"
    }, "✎"), /*#__PURE__*/React.createElement("button", {
      onClick: () => setConfirmDelete({
        sessionId: todaySessionId,
        entryIdx: idx,
        ex: e.ex,
        setNumber: e.set,
        label: `Set ${e.set} (${e.reps}×${e.load}kg)`
      }),
      style: {
        background: C.warn + "18",
        border: `1px solid ${C.warn}44`,
        borderRadius: 6,
        width: 30,
        height: 30,
        cursor: "pointer",
        color: C.warn,
        fontSize: 14,
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      },
      title: "Delete this set"
    }, "🗑"))))));
  })), recentSessions.length > 0 && (() => {
    const exDefaultEL = program?.exercises.find(ex => ex.name === activeEx);
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(SecLabel, {
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
    }, s.sets.length, " set", s.sets.length !== 1 ? "s" : "")), s.sets.map(({
      e,
      idx
    }) => {
      const eqShown = e.equipUsed || exDefaultEL?.eq;
      const latShown = e.latUsed || exDefaultEL?.lat;
      const isOverride = !!(e.equipUsed || e.latUsed);
      return /*#__PURE__*/React.createElement("div", {
        key: idx,
        style: {
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "7px 0",
          borderTop: `1px solid ${C.border}`
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          flex: 1
        }
      }, /*#__PURE__*/React.createElement("span", {
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
      }, " · 🔴 ", e.bandLength, " ", e.bandStrength, " ", e.bandLoadKg ? `${e.bandLoadKg}kg ` : "", "(", e.bandUsage, ")"), (e.clusterRepsArr?.length || e.clusterReps) && /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 12,
          color: C.gold
        }
      }, " · ⏱ ", e.clusterRepsArr?.length ? e.clusterRepsArr.join("+") + " reps" : `${e.clusterCount}×${e.clusterReps}`, " clusters", e.clusterGaps?.length ? ` (${e.clusterGaps.map(g => fmtRest(g)).join(" → ")})` : ""), e.dropSetLoads?.length > 0 && /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 12,
          color: '#A855F7'
        }
      }, " · 📉 ", e.load, "kg×", e.dropSetMainReps ?? "?", ", ", e.dropSetLoads.map((l, i) => `${l}kg×${e.dropSetReps?.[i] ?? "?"}`).join(", ")), e.ascSetLoads?.length > 0 && /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 12,
          color: '#22C55E'
        }
      }, " · 📈 ", e.load, "kg×", e.ascSetMainReps ?? "?", ", ", e.ascSetLoads.map((l, i) => `${l}kg×${e.ascSetReps?.[i] ?? "?"}`).join(", ")), e.pyrLoads?.length > 0 && /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 12,
          color: '#A855F7'
        }
      }, " · 🔺 ", e.load, "kg×", e.pyrMainReps ?? "?", ", ", e.pyrLoads.map((l, i) => `${l}kg×${e.pyrReps?.[i] ?? "?"}`).join(", ")), isNegativeSet(e.type) && (e.eccSecs || e.conSecs) && /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 12,
          color: '#38BDF8'
        }
      }, " · ⬇ ", e.eccSecs || "?", "s ecc / ", e.conSecs || "?", "s con"), e.restApplied && /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 12,
          color: C.blue
        }
      }, " · 💤 ", e.restApplied >= 60 ? `${Math.floor(e.restApplied / 60)}:${String(e.restApplied % 60).padStart(2, "0")}` : `${e.restApplied}s`, " rest"), (eqShown || latShown) && /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 12,
          color: C.sub
        }
      }, " · 🔧 ", eqShown || "", eqShown && latShown ? ", " : "", latShown || "", isOverride ? " (session)" : ""), e.comment && /*#__PURE__*/React.createElement("div", {
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
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 8
        }
      }, /*#__PURE__*/React.createElement("div", null, !isOvrcIso(e.type) ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
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
      }, "~", est1RM(effPeakLoad(e), effPeakReps(e)), " 1RM")) : /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 11,
          color: C.warn,
          fontWeight: 700
        }
      }, "Max effort")), /*#__PURE__*/React.createElement("div", {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: 2
        }
      }, /*#__PURE__*/React.createElement("button", {
        onClick: () => startEditEntry(s.sid, idx, e),
        style: {
          background: C.blue + "18",
          border: `1px solid ${C.blue}44`,
          borderRadius: 6,
          width: 30,
          height: 30,
          cursor: "pointer",
          color: C.blue,
          fontSize: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        },
        title: "Edit this set"
      }, "✎"), /*#__PURE__*/React.createElement("button", {
        onClick: () => setConfirmDelete({
          sessionId: s.sid,
          entryIdx: idx,
          ex: e.ex,
          setNumber: e.set,
          label: `Set ${e.set} from ${s.date} (${e.reps}×${e.load}kg)`
        }),
        style: {
          background: C.warn + "18",
          border: `1px solid ${C.warn}44`,
          borderRadius: 6,
          width: 30,
          height: 30,
          cursor: "pointer",
          color: C.warn,
          fontSize: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        },
        title: "Delete this set"
      }, "🗑"))));
    }))));
  })());
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
      const top = ee.reduce((best, e) => effPeakLoad(e) > effPeakLoad(best) ? e : best, ee[0]);
      const maxLoad = effPeakLoad(top);
      const oneRM = est1RM(maxLoad, effPeakReps(top));
      const vel = top.velocity || estVelocity(maxLoad, oneRM);
      const power = top.power || calcPower(maxLoad, vel);
      // Max reps across all sets this session for this exercise
      const maxReps = Math.max(...ee.map(effReps));
      const totalVol = ee.reduce((sum, e) => sum + effVolume(e), 0);
      const avgReps = ee.reduce((sum, e) => sum + effReps(e), 0) / ee.length;
      // TUT: prefer actual logged tempo per entry (session adjustment), else program default
      const exDef = sessions.length ? program?.exercises?.find(e => e.name === sel) : null;
      const loggedTempo = ee.filter(e => e.eccSecs || e.conSecs);
      const avgTUT = loggedTempo.length ? ee.reduce((sum, e) => sum + effReps(e) * ((e.eccSecs || exDef?.eccSecs || 2) + (e.conSecs || exDef?.conSecs || 1)), 0) / ee.length : exDef?.eccSecs || exDef?.conSecs ? effReps(top) * ((exDef.eccSecs || 2) + (exDef.conSecs || 1)) : null;
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
        const top = ee.reduce((best, e) => effPeakLoad(e) > effPeakLoad(best) ? e : best, ee[0]);
        const maxLoad = effPeakLoad(top);
        const oneRM = est1RM(maxLoad, effPeakReps(top));
        const vel = top.velocity || estVelocity(maxLoad, oneRM);
        row[`load_${ex.name}`] = maxLoad;
        row[`onerm_${ex.name}`] = oneRM;
        row[`power_${ex.name}`] = top.power || calcPower(maxLoad, vel);
        const totalVol = ee.reduce((sum, e) => sum + effVolume(e), 0);
        const avgReps = ee.reduce((sum, e) => sum + effReps(e), 0) / ee.length;
        // TUT: prefer actual logged tempo per entry, else program-prescribed default
        const prescEx = (program?.exercises || []).find(e => e.name === ex.name);
        const loggedT = ee.filter(e => e.eccSecs || e.conSecs);
        // TUT: for iso sets use holdDuration×reps; else use tempo
        const isoEntries = ee.filter(e => e.holdDuration);
        const avgTUT = isoEntries.length ? isoEntries.reduce((sum, e) => sum + e.holdDuration * e.reps, 0) / isoEntries.length : loggedT.length ? ee.reduce((sum, e) => sum + effReps(e) * ((e.eccSecs || prescEx?.eccSecs || 2) + (e.conSecs || prescEx?.conSecs || 1)), 0) / ee.length : prescEx?.eccSecs || prescEx?.conSecs ? Math.max(...ee.map(e => e.reps)) * ((prescEx.eccSecs || 2) + (prescEx.conSecs || 1)) : null;
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
    const b1RM = est1RM(bestLoad, effReps(top));
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

  // One-time migration: older sessions may have been saved with a date string
  // missing the year (e.g. "11 Aug" instead of "11 Aug 2026") due to a browser
  // locale-formatting bug that's now fixed at the source. Backfill the current
  // year onto any date string that's missing one, so History displays correctly
  // without needing every affected client to re-log anything.
  useEffect(() => {
    setClients(cs => {
      let changed = false;
      const fixed = cs.map(c => ({
        ...c,
        programs: c.programs.map(p => ({
          ...p,
          sessions: (p.sessions || []).map(s => {
            const parts = (s.date || "").trim().split(/\s+/);
            if (parts.length === 2) {
              changed = true;
              return {
                ...s,
                date: `${s.date} ${new Date().getFullYear()}`
              };
            }
            return s;
          })
        }))
      }));
      return changed ? fixed : cs;
    });
  }, []);
  const [tab, setTab] = useState("programs");
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showAddClient, setShowAddClient] = useState(false);
  const [showDataSync, setShowDataSync] = useState(false);
  const [editClientTarget, setEditClientTarget] = useState(null);
  const [customExercises, setCustomExercises] = useState(() => migrateList('forge_customEx', EX_LIST));
  const [customEquipment, setCustomEquipment] = useState(() => migrateList('forge_customEquip', EQUIP_LIST));
  const [customLaterality, setCustomLaterality] = useState(() => migrateList('forge_customLat', LAT_LIST));
  const [customCategories, setCustomCategories] = useState(() => migrateList('forge_customCats', CATEGORIES));
  const [customProgTypes, setCustomProgTypes] = useState(() => migrateList('forge_customPT', PROG_TYPES));
  const [customSetTypes, setCustomSetTypes] = useState(() => migrateList('forge_customST', SET_TYPES));

  // One-time migration: "Activation Strength" was added as a new default
  // Program Type after most users had already migrated their Program Type
  // list once (migrateList only merges defaults in on that very first run),
  // so it would otherwise never appear for existing installs. Backfill it in
  // if it's missing, without disturbing anything else the trainer has added.
  useEffect(() => {
    setCustomProgTypes(pts => pts.includes("Activation Strength") ? pts : ["Activation Strength", ...pts]);
  }, []);

  // Same backfill pattern for "Ovrc Iso-Endurance" — added as a new default
  // Set Type after most users had already migrated their Set Type list once.
  // Inserted right after "Ovrc Iso-Max" if present, for a sensible ordering
  // alongside its sibling iso types; otherwise just appended.
  useEffect(() => {
    setCustomSetTypes(sts => {
      if (sts.includes("Ovrc Iso-Endurance")) return sts;
      const idx = sts.indexOf("Ovrc Iso-Max");
      if (idx === -1) return [...sts, "Ovrc Iso-Endurance"];
      return [...sts.slice(0, idx + 1), "Ovrc Iso-Endurance", ...sts.slice(idx + 1)];
    });
  }, []);

  // Backfill "Ovrc Iso-Sustained" — inserted right after "Ovrc Iso-Endurance"
  // (its sibling in the Overcoming family), otherwise appended. Also cleans up
  // "Yielding Iso-ShortHolds" if present — an earlier, briefly-live name for
  // effectively the same duration range, since real-world testing showed this
  // is better framed as an Overcoming (max-effort-to-fatigue) protocol rather
  // than a submaximal Yielding hold.
  useEffect(() => {
    setCustomSetTypes(sts => {
      let out = sts.filter(t => t !== "Yielding Iso-ShortHolds");
      if (out.includes("Ovrc Iso-Sustained")) return out;
      const idx = out.indexOf("Ovrc Iso-Endurance");
      if (idx === -1) return [...out, "Ovrc Iso-Sustained"];
      return [...out.slice(0, idx + 1), "Ovrc Iso-Sustained", ...out.slice(idx + 1)];
    });
  }, []);

  // Backfill "Ascending Set" — inserted right after "Drop Set" (its mirror-
  // image sibling), otherwise appended.
  useEffect(() => {
    setCustomSetTypes(sts => {
      if (sts.includes("Ascending Set")) return sts;
      const idx = sts.indexOf("Drop Set");
      if (idx === -1) return [...sts, "Ascending Set"];
      return [...sts.slice(0, idx + 1), "Ascending Set", ...sts.slice(idx + 1)];
    });
  }, []);

  // Backfill "Pyramid Set (continuous)" — combining Ascending Set's climb
  // with Drop Set's descent into one continuous sequence — inserted right
  // after "Ascending Set" (both its component techniques), otherwise appended.
  useEffect(() => {
    setCustomSetTypes(sts => {
      if (sts.includes("Pyramid Set (continuous)")) return sts;
      const idx = sts.indexOf("Ascending Set");
      if (idx === -1) return [...sts, "Pyramid Set (continuous)"];
      return [...sts.slice(0, idx + 1), "Pyramid Set (continuous)", ...sts.slice(idx + 1)];
    });
  }, []);

  // Backfill "Ovrc Iso-Strength+Hypertrophy" — the two-phase combo protocol —
  // inserted right after "Ovrc Iso-Sustained" (last of the Overcoming family),
  // otherwise appended.
  useEffect(() => {
    setCustomSetTypes(sts => {
      if (sts.includes("Ovrc Iso-Strength+Hypertrophy")) return sts;
      const idx = sts.indexOf("Ovrc Iso-Sustained");
      if (idx === -1) return [...sts, "Ovrc Iso-Strength+Hypertrophy"];
      return [...sts.slice(0, idx + 1), "Ovrc Iso-Strength+Hypertrophy", ...sts.slice(idx + 1)];
    });
  }, []);

  // ── Multi-client rest timer — keyed by clientId so each client's countdown
  // runs independently, even while viewing a different client's screen. ──────
  const [restTimers, setRestTimers] = useState({}); // { [clientId]: {remaining, running, total, label} }

  // Genuinely distinct chime "melodies" per client slot — not just a pitch shift,
  // but different note counts, intervals, waveforms and rhythms, so each one is
  // recognizable as a different chime character rather than the same beep pitched up/down.
  const CHIME_PATTERNS = [{
    notes: [523, 659],
    gaps: [0, 0.13],
    dur: 0.16,
    wave: "sine"
  },
  // rising 2-note
  {
    notes: [784, 784],
    gaps: [0, 0.11],
    dur: 0.09,
    wave: "triangle"
  },
  // sharp double-pulse
  {
    notes: [988, 784, 659],
    gaps: [0, 0.12, 0.24],
    dur: 0.14,
    wave: "sine"
  },
  // descending 3-note
  {
    notes: [659, 659, 659],
    gaps: [0, 0.09, 0.18],
    dur: 0.07,
    wave: "square"
  },
  // triple-pulse same note
  {
    notes: [523, 659, 784],
    gaps: [0, 0.09, 0.18],
    dur: 0.12,
    wave: "triangle"
  },
  // fast ascending arpeggio
  {
    notes: [1175, 659, 1175],
    gaps: [0, 0.14, 0.28],
    dur: 0.13,
    wave: "sine"
  } // high-low-high
  ];
  const chimeForClient = cid => CHIME_PATTERNS[Math.max(0, clients.findIndex(c => c.id === cid)) % CHIME_PATTERNS.length];

  // Done-state colour matches each client's own Avatar initials colour (avCol),
  // so the alert colour is instantly recognizable as "theirs" everywhere.
  const doneColorForClient = cid => avCol(Math.max(0, clients.findIndex(c => c.id === cid)));
  const playRestAlert = (pattern = CHIME_PATTERNS[0]) => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      pattern.notes.forEach((freq, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g);
        g.connect(ctx.destination);
        o.type = pattern.wave;
        o.frequency.value = freq;
        g.gain.value = 0.15;
        const startAt = ctx.currentTime + pattern.gaps[i];
        o.start(startAt);
        o.stop(startAt + pattern.dur);
      });
    } catch {}
    try {
      navigator.vibrate && navigator.vibrate([200, 100, 200]);
    } catch {}
  };

  // Single global 1s tick — decrements every running timer across all clients
  useEffect(() => {
    const anyRunning = Object.values(restTimers).some(t => t.running && t.remaining > 0);
    if (!anyRunning) return;
    const t = setTimeout(() => {
      setRestTimers(prev => {
        const next = {
          ...prev
        };
        const completedClientIds = [];
        Object.keys(next).forEach(cid => {
          const timer = next[cid];
          if (timer.running && timer.remaining > 0) {
            const newRemaining = timer.remaining - 1;
            next[cid] = {
              ...timer,
              remaining: newRemaining,
              running: newRemaining > 0
            };
            if (newRemaining === 0) completedClientIds.push(cid);
          }
        });
        completedClientIds.forEach(cid => playRestAlert(chimeForClient(cid)));
        return next;
      });
    }, 1000);
    return () => clearTimeout(t);
  }, [restTimers]);
  const startRestFor = (clientId, secs, label) => {
    if (!secs || secs <= 0) return;
    setRestTimers(prev => ({
      ...prev,
      [clientId]: {
        remaining: secs,
        running: true,
        total: secs,
        label: label || ""
      }
    }));
  };
  const pauseResumeRestFor = clientId => setRestTimers(prev => {
    const t = prev[clientId];
    if (!t) return prev;
    return {
      ...prev,
      [clientId]: {
        ...t,
        running: !t.running
      }
    };
  });
  const adjustRestFor = (clientId, delta) => setRestTimers(prev => {
    const t = prev[clientId];
    if (!t) return prev;
    return {
      ...prev,
      [clientId]: {
        ...t,
        remaining: Math.max(0, t.remaining + delta)
      }
    };
  });
  const dismissRestFor = clientId => setRestTimers(prev => {
    const next = {
      ...prev
    };
    delete next[clientId];
    return next;
  });
  const exList = customExercises;
  const equipList = customEquipment;
  const latList = customLaterality;
  const categoryList = customCategories;
  const progTypeList = customProgTypes;
  const setTypeList = customSetTypes;
  const onAddEx = name => setCustomExercises(l => [...l, name]);
  const onAddEquip = name => setCustomEquipment(l => [...l, name]);
  const onAddLat = name => setCustomLaterality(l => [...l, name]);
  const onAddCategory = name => setCustomCategories(l => [...l, name]);
  const onAddProgType = name => setCustomProgTypes(l => [...l, name]);
  const onEditCategory = (o, n) => setCustomCategories(l => l.map(x => x === o ? n : x));
  const onDeleteCategory = v => setCustomCategories(l => l.filter(x => x !== v));
  const onEditProgType = (o, n) => setCustomProgTypes(l => l.map(x => x === o ? n : x));
  const onDeleteProgType = v => setCustomProgTypes(l => l.filter(x => x !== v));
  const onAddSetType = name => setCustomSetTypes(l => [...l, name]);
  const onEditSetType = (o, n) => setCustomSetTypes(l => l.map(x => x === o ? n : x));
  const onDeleteSetType = v => setCustomSetTypes(l => l.filter(x => x !== v));

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
      localStorage.setItem('forge_customCats', JSON.stringify(customCategories));
    } catch {}
  }, [customCategories]);
  useEffect(() => {
    try {
      localStorage.setItem('forge_customLat', JSON.stringify(customLaterality));
    } catch {}
  }, [customLaterality]);
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

  // Track recently-active clients so the trainer can quickly bounce back and
  // forth between two (or more) clients they're running in the same session,
  // regardless of whether a rest timer happens to be running for them.
  const [recentClients, setRecentClients] = useState([]);
  // Explicit "session group" — trainer pre-selects who they're training together
  // (duo/trio/group) before a session, rather than relying purely on recency.
  const [sessionGroup, setSessionGroup] = useState(() => sessGet('forge_sessionGroup', [])); // array of client ids
  useEffect(() => {
    try {
      sessionStorage.setItem('forge_sessionGroup', JSON.stringify(sessionGroup));
    } catch {}
  }, [sessionGroup]);
  // Which SAVED group (if any) is the source of the current sessionGroup — lets
  // the Programs page show "⏹ Stop" on the specific group card that's running.
  const [activeSavedGroupId, setActiveSavedGroupId] = useState(() => sessGet('forge_activeSavedGroupId', null));
  useEffect(() => {
    try {
      sessionStorage.setItem('forge_activeSavedGroupId', JSON.stringify(activeSavedGroupId));
    } catch {}
  }, [activeSavedGroupId]);
  const [showGroupPicker, setShowGroupPicker] = useState(false);

  // ── Saved Groups — persistent, named, coloured client groupings (distinct
  // from the ad-hoc sessionGroup above, which resets when the app closes) ──
  const [savedGroups, setSavedGroups] = useState(() => lsGet('forge_savedGroups', [])); // {id, name, color, clientIds}
  useEffect(() => {
    try {
      localStorage.setItem('forge_savedGroups', JSON.stringify(savedGroups));
    } catch {}
  }, [savedGroups]);
  const [editingGroup, setEditingGroup] = useState(undefined); // undefined=closed, null=new, {..}=edit
  const GROUP_COLORS = [C.accent, C.blue, "#AA44FF", C.gold, "#FF5060", "#FF8020", "#44AAFF", "#00C896"];
  const addSavedGroup = (name, color, clientIds) => {
    setSavedGroups(gs => [...gs, {
      id: `grp${Date.now()}`,
      name,
      color,
      clientIds
    }]);
  };
  const updateSavedGroup = (id, fields) => setSavedGroups(gs => gs.map(g => g.id === id ? {
    ...g,
    ...fields
  } : g));
  const deleteSavedGroup = id => setSavedGroups(gs => gs.filter(g => g.id !== id));
  const startSavedGroup = group => {
    setSessionGroup(group.clientIds);
    setActiveSavedGroupId(group.id);
    // Always land on the Log tab — whether or not the active client is already
    // a member of this group, tapping Start should take you straight to logging.
    if (group.clientIds.length > 0 && !group.clientIds.includes(activeClientId)) {
      quickSwitchClient(group.clientIds[0]); // switches client AND tab to "log"
    } else {
      setTab("log"); // already on a member of the group — just jump tabs
    }
  };
  const stopSavedGroup = () => {
    setSessionGroup([]);
    setActiveSavedGroupId(null);
  };
  const prevClientRef = React.useRef(activeClientId);
  useEffect(() => {
    if (prevClientRef.current !== activeClientId) {
      const prev = prevClientRef.current;
      setRecentClients(rc => [prev, ...rc.filter(x => x !== prev && x !== activeClientId)].slice(0, 4));
      prevClientRef.current = activeClientId;
    }
  }, [activeClientId]);
  // Quick-switch used by the in-session pill bar — keeps current tab (usually Log)
  // instead of resetting to Programs like the main client switcher does.
  // Jumping to a client via a pill should land directly on their Log tab,
  // focused on whichever exercise their timer belongs to (if any).
  const [focusReq, setFocusReq] = useState(null); // {exName, token}
  const quickSwitchClient = id => {
    setActiveClientId(id);
    setTab("log");
    const t = restTimers[id];
    if (t?.label) setFocusReq({
      exName: t.label,
      token: Date.now()
    });
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
    clusterRepsArr,
    clusterCount,
    clusterGaps,
    clusterRest,
    dropSetLoads,
    dropSetReps,
    dropSetMainReps,
    ascSetLoads,
    ascSetReps,
    ascSetMainReps,
    pyrLoads,
    pyrReps,
    pyrMainReps,
    pyrUpCount,
    comboRounds,
    comboContractSecs,
    comboRestSecs,
    comboHoldPct,
    comboHoldSecs,
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
      clusterRepsArr,
      clusterCount,
      clusterGaps,
      clusterRest,
      dropSetLoads,
      dropSetReps,
      dropSetMainReps,
      ascSetLoads,
      ascSetReps,
      ascSetMainReps,
      pyrLoads,
      pyrReps,
      pyrMainReps,
      pyrUpCount,
      comboRounds,
      comboContractSecs,
      comboRestSecs,
      comboHoldPct,
      comboHoldSecs,
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

  // Delete a single logged set (identified by session id + its index within that
  // session's entries array), scoped to the currently active program. Any
  // remaining sets for the SAME exercise numbered after the deleted one get
  // shifted down by one, so the sequence stays continuous (delete Set 1 of 2 →
  // the old Set 2 becomes the new Set 1) rather than leaving a numbering gap.
  const deleteEntry = (sessionId, entryIdx) => {
    if (!activeProgram) return;
    updClient(activeClientId, c => ({
      ...c,
      programs: c.programs.map(p => {
        if (p.id !== c.activeProgramId) return p;
        return {
          ...p,
          sessions: p.sessions.map(s => {
            if (s.id !== sessionId) return s;
            const deleted = s.entries[entryIdx];
            const remaining = s.entries.filter((_, i) => i !== entryIdx);
            if (!deleted) return {
              ...s,
              entries: remaining
            };
            const renumbered = remaining.map(e => e.ex === deleted.ex && e.set > deleted.set ? {
              ...e,
              set: e.set - 1
            } : e);
            return {
              ...s,
              entries: renumbered
            };
          })
        };
      })
    }));
  };

  // Overwrite a single logged set in place (used when editing a mistaken entry).
  const updateEntry = (sessionId, entryIdx, updatedFields) => {
    if (!activeProgram) return;
    updClient(activeClientId, c => ({
      ...c,
      programs: c.programs.map(p => {
        if (p.id !== c.activeProgramId) return p;
        return {
          ...p,
          sessions: p.sessions.map(s => s.id !== sessionId ? s : {
            ...s,
            entries: s.entries.map((e, i) => i === entryIdx ? {
              ...e,
              ...updatedFields
            } : e)
          })
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
  }, /*#__PURE__*/React.createElement("style", null, `
        button:active { filter: brightness(0.8); transform: scale(0.97); }
        button { transition: filter 0.08s ease, transform 0.08s ease; }
      `), /*#__PURE__*/React.createElement("div", {
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
  }, "v67.18.0")), /*#__PURE__*/React.createElement("button", {
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
  }, "⚙️")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowGroupPicker(true),
    style: {
      background: sessionGroup.length > 0 ? C.accent + "18" : C.card2,
      border: `1px solid ${sessionGroup.length > 0 ? C.accent + "55" : C.border}`,
      borderRadius: 22,
      padding: "7px 12px",
      cursor: "pointer",
      color: sessionGroup.length > 0 ? C.accent : C.muted,
      fontSize: 12,
      fontWeight: 700
    }
  }, "👥 ", sessionGroup.length > 0 ? `Group (${sessionGroup.length})` : "Set Group"), /*#__PURE__*/React.createElement("button", {
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
  }, "▾")))), (() => {
    const pillIds = sessionGroup.length > 0 ? sessionGroup : recentClients;
    const visible = pillIds.filter(cid => cid !== activeClientId && clients.some(c => c.id === cid));
    if (visible.length === 0) return null;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 8,
        overflowX: "auto",
        padding: "8px 14px",
        background: C.card2,
        borderBottom: `1px solid ${C.border}`
      }
    }, visible.map(cid => {
      const c = clients.find(cl => cl.id === cid);
      const t = restTimers[cid];
      const hasTimer = !!t;
      const isDone = hasTimer && t.remaining === 0;
      const doneColor = doneColorForClient(cid);
      return /*#__PURE__*/React.createElement("div", {
        key: cid,
        style: {
          display: "flex",
          alignItems: "center",
          gap: 2,
          flexShrink: 0,
          background: isDone ? doneColor : C.card,
          border: `1px solid ${isDone ? doneColor : C.border}`,
          borderRadius: 20,
          padding: "6px 6px 6px 12px"
        }
      }, /*#__PURE__*/React.createElement("button", {
        onClick: () => quickSwitchClient(cid),
        style: {
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 0
        }
      }, /*#__PURE__*/React.createElement(Avatar, {
        name: c.name,
        idx: clients.findIndex(x => x.id === cid),
        size: 18
      }), /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 11,
          color: isDone ? "#0B0B16" : C.text,
          fontWeight: 700
        }
      }, c.name.split(" ")[0]), hasTimer && /*#__PURE__*/React.createElement("span", {
        style: {
          fontSize: 12,
          fontFamily: "'Bebas Neue',cursive",
          letterSpacing: 1,
          color: isDone ? "#0B0B16" : C.gold
        }
      }, isDone ? "Done!" : `${Math.floor(t.remaining / 60)}:${String(t.remaining % 60).padStart(2, "0")}`)), sessionGroup.length > 0 && /*#__PURE__*/React.createElement("button", {
        onClick: e => {
          e.stopPropagation();
          setSessionGroup(sg => sg.filter(id => id !== cid));
        },
        title: "Remove from today's Group",
        style: {
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "4px 6px",
          color: isDone ? "#0B0B16" : C.muted,
          fontSize: 13,
          lineHeight: 1
        }
      }, "✕"));
    }));
  })(), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: "auto",
      paddingBottom: 70
    }
  }, tab === "programs" && activeClient && /*#__PURE__*/React.createElement(ProgramsTab, {
    client: activeClient,
    clientIdx: clientIdx,
    allClients: clients,
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
    onEditCategory: onEditCategory,
    onDeleteCategory: onDeleteCategory,
    onEditProgType: onEditProgType,
    onDeleteProgType: onDeleteProgType,
    customExercises: customExercises,
    onEditEx: onEditEx,
    onDeleteEx: onDeleteEx,
    customEquipment: customEquipment,
    onEditEquip: onEditEquip,
    onDeleteEquip: onDeleteEquip,
    customLaterality: customLaterality,
    onEditLat: onEditLat,
    onDeleteLat: onDeleteLat,
    savedGroups: savedGroups,
    onStartGroup: startSavedGroup,
    onNewGroup: () => setEditingGroup(null),
    onEditGroup: g => setEditingGroup(g),
    activeSavedGroupId: activeSavedGroupId,
    onStopGroup: stopSavedGroup,
    sessionGroup: sessionGroup,
    onOpenSessionPicker: () => setShowGroupPicker(true),
    onRemoveFromSession: cid => setSessionGroup(sg => sg.filter(id => id !== cid))
  }), tab === "log" && /*#__PURE__*/React.createElement(LogTab, {
    program: activeProgram,
    onAddEntry: addEntry,
    exList: exList,
    onAddEx: onAddEx,
    setTypeList: setTypeList,
    onAddSetType: onAddSetType,
    onEditSetType: onEditSetType,
    onDeleteSetType: onDeleteSetType,
    clientBW: activeClient?.bw,
    clientName: activeClient?.name,
    allClientSessions: activeClient?.programs.flatMap(p => p.sessions) || [],
    equipList: equipList,
    latList: latList,
    restState: restTimers[activeClientId] || {
      remaining: 0,
      running: false,
      total: 0,
      label: ""
    },
    onStartRest: (secs, label) => startRestFor(activeClientId, secs, label),
    onPauseResumeRest: () => pauseResumeRestFor(activeClientId),
    onAdjustRest: delta => adjustRestFor(activeClientId, delta),
    onDismissRest: () => dismissRestFor(activeClientId),
    onDeleteEntry: deleteEntry,
    onUpdateEntry: updateEntry,
    focusReq: focusReq,
    doneColor: doneColorForClient(activeClientId),
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
    },
    savedGroups: savedGroups,
    onEditGroup: g => {
      setEditingGroup(g);
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
  }), showGroupPicker && /*#__PURE__*/React.createElement(SessionGroupModal, {
    clients: clients,
    selected: sessionGroup,
    onSave: ids => {
      setSessionGroup(ids);
      setActiveSavedGroupId(null);
      setShowGroupPicker(false);
    },
    onClose: () => setShowGroupPicker(false)
  }), editingGroup !== undefined && /*#__PURE__*/React.createElement(GroupEditorModal, {
    clients: clients,
    group: editingGroup,
    colors: GROUP_COLORS,
    onSave: fields => {
      if (editingGroup) updateSavedGroup(editingGroup.id, fields);else addSavedGroup(fields.name, fields.color, fields.clientIds);
      setEditingGroup(undefined);
    },
    onDelete: id => {
      deleteSavedGroup(id);
      setEditingGroup(undefined);
    },
    onClose: () => setEditingGroup(undefined)
  }));
}
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
