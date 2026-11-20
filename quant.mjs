// Answer checking and scoring for the site. A port of generators.check_answer and score.py;
// tests/test_engine.py runs both on the same fixtures and requires identical output, so
// change them together. Answers themselves are never computed here: bank.json holds them.

export const AXES = ["counting", "conditional", "expectation", "markov", "distributions", "estimation"];
export const K = 8;
export const MIN_FOR_VERDICT = 5;

const DEC = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const FRAC = /^[+-]?\d+\/\d+$/;  // Python Fraction: no sign on the denominator

// Number for "3/8", "0.375", ".375", "37.5%"; null if not a number.
export function parseAnswer(text) {
  let s = String(text).trim().replace(/ /g, "");
  const pct = s.endsWith("%");
  if (pct) s = s.slice(0, -1);
  let v;
  if (FRAC.test(s)) {
    const [n, d] = s.split("/").map(Number);
    if (d === 0) return null;
    v = n / d;
  } else if (DEC.test(s)) v = Number(s);
  else return null;
  return pct ? v / 100 : v;
}

export function checkAnswer(q, text) {
  const v = parseAnswer(text);
  if (v === null) return null;
  return Math.abs(v - q.value) <= Math.max(q.abs_tol, q.rel_tol * Math.abs(q.value));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), n = s.length, m = n >> 1;
  return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const shrunk = (rs) => rs.reduce((a, b) => a + b, 0) / (rs.length + K);
const num = (c) => (c ? 1 : 0);

// Correction for guessing. A multiple-choice question has a 1-in-4 floor: answered at
// random it is right a quarter of the time, where a typed answer is right essentially
// never. Counting both as a plain 1 would inflate every axis the moment the user switches
// mode, and the radar's whole job is to compare axes against each other.
//
// So an MC attempt earns the standard chance-corrected credit, (p - 1/4) / (3/4): 1 for
// right, -1/3 for wrong, which makes a pure guesser score 0 on average -- exactly what a
// typed wrong answer scores. Attempts recorded before the mode existed carry no `mode`
// field and were all typed, so they default to the uncorrected scale, which is correct.
const MC_OPTIONS = 4;
export function credit(a) {
  const right = num(a.correct);
  if (a.mode !== "mc") return right;
  const g = 1 / MC_OPTIONS;
  return (right - g) / (1 - g);
}


export function score(attempts) {
  const out = {};
  if (!attempts.length) {
    for (const a of AXES) out[a] = { axis: a, n: 0, n_correct: 0, accuracy: NaN, speed: null, raw_accuracy: null, median_seconds: null };
    return out;
  }
  const overall = attempts.reduce((s, a) => s + credit(a), 0) / attempts.length;
  const byD = new Map();
  for (const a of attempts) {
    if (!byD.has(a.difficulty)) byD.set(a.difficulty, []);
    byD.get(a.difficulty).push(a);
  }
  const baseAcc = new Map(), baseLt = new Map();
  const correct = attempts.filter((a) => a.correct);
  const globLt = correct.length ? median(correct.map((a) => Math.log(a.seconds))) : null;
  for (const [d, xs] of byD) {
    baseAcc.set(d, overall + shrunk(xs.map((a) => credit(a) - overall)));
    const lts = xs.filter((a) => a.correct).map((a) => Math.log(a.seconds));
    baseLt.set(d, lts.length ? median(lts) : globLt);
  }
  for (const axis of AXES) {
    const xs = attempts.filter((a) => a.axis === axis);
    const accuracy = Math.min(1, Math.max(0, overall + shrunk(xs.map((a) => credit(a) - baseAcc.get(a.difficulty)))));
    const cs = xs.filter((a) => a.correct);
    const speed = cs.length ? 1 / (1 + Math.exp(shrunk(cs.map((a) => Math.log(a.seconds) - baseLt.get(a.difficulty))))) : null;
    out[axis] = {
      axis, n: xs.length, n_correct: cs.length, accuracy, speed,
      raw_accuracy: xs.length ? cs.length / xs.length : null,
      median_seconds: cs.length ? median(cs.map((a) => a.seconds)) : null,
    };
  }
  return out;
}

export function workOnNext(scores) {
  const all = AXES.map((a) => scores[a]);
  const thin = all.filter((s) => s.n < MIN_FOR_VERDICT);
  if (thin.length) {
    const s = thin.reduce((a, b) => (b.n < a.n ? b : a));
    return [s.axis, `only ${s.n} attempt${s.n !== 1 ? "s" : ""} -- not enough to know`];
  }
  const s = all.reduce((a, b) => (b.accuracy < a.accuracy ? b : a));
  let reason = `lowest accuracy (${Math.round(s.accuracy * 100)}% adjusted, ${s.n_correct}/${s.n} raw)`;
  const timed = all.filter((x) => x.speed !== null);
  const slow = timed.length ? timed.reduce((a, b) => (b.speed < a.speed ? b : a)) : null;
  if (slow && slow.axis !== s.axis && slow.speed < 0.4) reason += `; slowest is ${slow.axis} (speed ${slow.speed.toFixed(2)})`;
  return [s.axis, reason];
}

// --- skills -------------------------------------------------------------------------
// The radar scores what a question EXERCISES, not what it is about. A question loads on
// several skills summing to 1 and contributes fractional attempts to each, so a
// markov-only session still says something about setup and execution instead of leaving
// five vertices empty. Topic survives as a table, not a second hexagon.
// This is score() with counts replaced by weight sums; fed a one-hot table it reproduces
// score() exactly, which is what tests/test_skills.py asserts.

export const SKILLS = ["setup", "counting", "conditioning", "linearity", "approximation", "execution"];
export const SLIP = new Set(["double", "half", "square", "sqrt", "off_by_one_up", "off_by_one_down"]);
export const CONCEPT = new Set(["complement", "odds"]);
export const EXEC_SHIFT = 0.5;

export const ACTIVITY = {
  setup: "Stop before computing: write the sample space, state or recursion, check it, then solve. Drill the first thirty seconds, not the whole problem.",
  counting: "Enumeration and symmetry: count the same set two ways and make them agree, and name the bijection before trusting it.",
  conditioning: "Condition on the right thing — tower rule and first-step analysis. Write P(A|B) and P(B|A) side by side every time.",
  linearity: "Decompose into indicators. Most of these get easy the moment you stop hunting for the distribution and just add up expectations.",
  approximation: "No-calculator work: e^-λ, 1/e, orders of magnitude. Estimation at difficulty 3 is the whole axis.",
  execution: "Not a gap in method — redo problems you ALREADY got right, against a clock. More new problems will not fix this one.",
};

// Re-aim one attempt's evidence using the mistake it actually made. A right answer, or a
// wrong one we cannot classify, is left alone. A slip is half evidence about execution. A
// wrong QUANTITY is not evidence about arithmetic at all, so execution is dropped and the
// rest renormalised -- otherwise every conceptual miss would also say "your arithmetic is bad".
export function route(vec, correct, errorKind) {
  const out = {};
  if (correct || !errorKind) { for (const s of SKILLS) out[s] = vec[s] || 0; return out; }
  if (SLIP.has(errorKind)) {
    for (const s of SKILLS) out[s] = (1 - EXEC_SHIFT) * (vec[s] || 0) + EXEC_SHIFT * (s === "execution" ? 1 : 0);
    return out;
  }
  if (CONCEPT.has(errorKind)) {
    const rest = SKILLS.reduce((t, s) => t + (s === "execution" ? 0 : (vec[s] || 0)), 0);
    if (rest <= 0) { for (const s of SKILLS) out[s] = vec[s] || 0; return out; }
    for (const s of SKILLS) out[s] = s === "execution" ? 0 : (vec[s] || 0) / rest;
    return out;
  }
  for (const s of SKILLS) out[s] = vec[s] || 0;
  return out;
}

const wShrunk = (pairs, k = K) =>
  pairs.reduce((t, [w, r]) => t + w * r, 0) / (pairs.reduce((t, [w]) => t + w, 0) + k);

// `weigh(attempt)` returns {skill: weight} summing to 1.
export function skillScore(attempts, weigh) {
  const out = {};
  if (!attempts.length) {
    for (const s of SKILLS) out[s] = { skill: s, n: 0, n_correct: 0, accuracy: NaN, speed: null, raw_accuracy: null, median_seconds: null };
    return out;
  }
  const overall = attempts.reduce((t, a) => t + credit(a), 0) / attempts.length;
  const byD = new Map();
  for (const a of attempts) {
    if (!byD.has(a.difficulty)) byD.set(a.difficulty, []);
    byD.get(a.difficulty).push(a);
  }
  const baseAcc = new Map(), baseLt = new Map();
  const correct = attempts.filter((a) => a.correct);
  const globLt = correct.length ? median(correct.map((a) => Math.log(a.seconds))) : null;
  for (const [d, xs] of byD) {
    baseAcc.set(d, overall + shrunk(xs.map((a) => credit(a) - overall)));
    const lts = xs.filter((a) => a.correct).map((a) => Math.log(a.seconds));
    baseLt.set(d, lts.length ? median(lts) : globLt);
  }
  const weighed = attempts.map((a) => [a, weigh(a)]);
  for (const s of SKILLS) {
    const xs = weighed.filter(([, v]) => (v[s] || 0) > 0);
    const n = xs.reduce((t, [, v]) => t + v[s], 0);
    const accuracy = Math.min(1, Math.max(0, overall +
      wShrunk(xs.map(([a, v]) => [v[s], credit(a) - baseAcc.get(a.difficulty)]))));
    const cs = xs.filter(([a]) => a.correct);
    const nc = cs.reduce((t, [, v]) => t + v[s], 0);
    const speed = cs.length
      ? 1 / (1 + Math.exp(wShrunk(cs.map(([a, v]) => [v[s], Math.log(a.seconds) - baseLt.get(a.difficulty)]))))
      : null;
    out[s] = {
      skill: s, n, n_correct: nc, accuracy, speed,
      raw_accuracy: n > 0 ? nc / n : null,
      median_seconds: cs.length ? median(cs.map(([a]) => a.seconds)) : null,
    };
  }
  return out;
}

// (skill, why, what to actually do). Thin evidence outranks measured weakness.
export function skillWorkOnNext(scores) {
  const all = SKILLS.map((s) => scores[s]);
  const thin = all.filter((s) => s.n < MIN_FOR_VERDICT);
  if (thin.length) {
    const s = thin.reduce((a, b) => (b.n < a.n ? b : a));
    return [s.skill, `only ${s.n.toFixed(1)} attempts' worth -- not enough to know`, ACTIVITY[s.skill]];
  }
  const s = all.reduce((a, b) => (b.accuracy < a.accuracy ? b : a));
  let why = `lowest accuracy (${Math.round(s.accuracy * 100)}% adjusted, over ${s.n.toFixed(1)} attempts' worth)`;
  const timed = all.filter((x) => x.speed !== null);
  const slow = timed.length ? timed.reduce((a, b) => (b.speed < a.speed ? b : a)) : null;
  if (slow && slow.skill !== s.skill && slow.speed < 0.4) why += `; slowest is ${slow.skill} (speed ${slow.speed.toFixed(2)})`;
  return [s.skill, why, ACTIVITY[s.skill]];
}

// --- target a skill -----------------------------------------------------------------
// The (topic, difficulty) cell that exercises `skill` hardest: mean loading of its
// generators, first cell in bank order on a tie. A port of skills.cell_for_skill, and
// tests/test_skills.py checks the two pick the same cell for every skill.
// Why it exists: the mixed picker hands `approximation` ~3% of all evidence, because it
// lives only in estimation d3 -- without this the sixth vertex practically never fills.
export function cellForSkill(skill, questions, table) {
  if (!SKILLS.includes(skill)) throw new Error(`unknown skill ${skill}`);
  const cells = new Map();
  for (const q of questions) {
    const k = `${q.axis}|${q.d}`;
    if (!cells.has(k)) cells.set(k, new Set());
    cells.get(k).add(q.gen);
  }
  let best = null, bestLoad = -Infinity;
  for (const [k, gens] of cells) {
    const d = k.split("|")[1];
    const loads = [...gens].map((g) => (table[`${g}|${d}`] || {})[skill] || 0);
    const load = loads.reduce((t, x) => t + x, 0) / loads.length;
    if (load > bestLoad) { best = k; bestLoad = load; }
  }
  const [axis, d] = best.split("|");
  return { axis, d: +d, load: bestLoad };
}

// Which skill Skill=auto drills next. NOT simply the advice: drilling only the lowest
// accuracy never revisits a vertex once it looks fine, so a weak skill that got lucky in
// its first five attempts stays unvisited for good (test/autosim.mjs: 4 of 30 simulated
// users were stuck on the wrong skill for 300+ questions). Ranking by a lower confidence
// bound keeps thin vertices in rotation until their estimate has earned trust.
export const AUTO_C = 0.5;
export function autoSkill(scores, c = AUTO_C) {
  const all = SKILLS.map((s) => scores[s]);
  const thin = all.filter((s) => s.n < MIN_FOR_VERDICT);
  if (thin.length) return thin.reduce((a, b) => (b.n < a.n ? b : a)).skill;
  return all.reduce((a, b) => (b.accuracy - c / Math.sqrt(b.n) < a.accuracy - c / Math.sqrt(a.n) ? b : a)).skill;
}
