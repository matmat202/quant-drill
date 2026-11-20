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

// --- mock test ------------------------------------------------------------------------
// An assessment, not a drill: TEST_N questions against one clock, no verdict until the end.
// Every axis appears at least once (all six, then the rest from a second shuffle, so no axis
// three times), the tiers lean to interview difficulty, and no generator is dealt twice --
// two "six dice, max is k" questions in ten would test one idea twice.
export const TEST_N = 10, TEST_SECONDS = 20 * 60;
const TEST_TIERS = [2, 2, 3];
function shuffled(xs, rnd) {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export function testDraw(bank, rnd = Math.random, n = TEST_N) {
  const axes = [];
  while (axes.length < n) axes.push(...shuffled(AXES, rnd));
  const out = [], gens = new Set();
  for (const axis of axes.slice(0, n)) {
    const tier = TEST_TIERS[Math.floor(rnd() * TEST_TIERS.length)];
    // Prefer the drawn tier and a fresh generator; relax the tier, then the generator,
    // rather than deal fewer than n.
    const fresh = (x) => x.axis === axis && !gens.has(x.gen) && !out.includes(x);
    const pools = [bank.filter((x) => fresh(x) && x.d === tier), bank.filter(fresh), bank.filter((x) => x.axis === axis && !out.includes(x))];
    const pool = pools.find((p) => p.length);
    if (!pool) continue;
    const q = pool[Math.floor(rnd() * pool.length)];
    out.push(q); gens.add(q.gen);
  }
  return out;
}

// rows: one per dealt question, { q, correct, seconds } once answered, { q } if the clock
// ran out first. Unreached questions count against the score, as they do on the real thing.
export function testSummary(rows) {
  const answered = rows.filter((r) => r.correct !== undefined);
  const byAxis = {};
  for (const r of rows) {
    const b = (byAxis[r.q.axis] ||= { right: 0, n: 0 });
    b.n++; if (r.correct) b.right++;
  }
  return { n: rows.length, answered: answered.length, right: answered.filter((r) => r.correct).length,
           seconds: Math.round(answered.reduce((t, r) => t + r.seconds, 0) * 10) / 10, byAxis };
}

// Past tests, newest first, rebuilt from stored attempts: each carries test=<start epoch>.
// Only ANSWERED questions are stored, so the out-of count comes from test_n (the dealt
// count, stamped on every attempt) and the time from test_s (stamped by endTest, so a test
// the clock ended reads 20:00, not the sum of its few answers). Attempts written before
// those fields existed fall back to TEST_N and to last-answer minus start. The weakest
// axis is the lowest right/answered among the axes that test reached -- unreached
// questions have no axis on record -- ties to the most missed, then AXES order; null when
// nothing answered was wrong. `missed` lists the wrong answers' qids in the order taken.
export function testHistory(hist) {
  const by = new Map();
  for (const a of hist) if (a.test !== undefined) (by.get(a.test) || by.set(a.test, []).get(a.test)).push(a);
  const out = [];
  for (const [id, xs] of by) {
    const n = Math.max(...xs.map((a) => a.test_n || 0)) || TEST_N;
    const stamped = xs.map((a) => a.test_s).filter((v) => v !== undefined);
    const seconds = stamped.length ? Math.max(...stamped) : Math.max(...xs.map((a) => a.t)) - id;
    const ax = {};
    for (const a of xs) { const b = (ax[a.axis] ||= { right: 0, n: 0 }); b.n++; if (a.correct) b.right++; }
    let weakest = null;
    for (const axis of AXES) {
      const b = ax[axis];
      if (!b || b.right === b.n) continue;
      const w = weakest && ax[weakest];
      if (!w || b.right / b.n < w.right / w.n || (b.right / b.n === w.right / w.n && b.n - b.right > w.n - w.right)) weakest = axis;
    }
    out.push({ id, n, answered: xs.length, right: xs.filter((a) => a.correct).length,
               seconds: Math.min(TEST_SECONDS, Math.max(0, seconds)), weakest,
               missed: xs.filter((a) => !a.correct).sort((a, b) => a.t - b.t).map((a) => a.qid) });
  }
  return out.sort((a, b) => b.id - a.id);
}
