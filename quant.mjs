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

export function score(attempts) {
  const out = {};
  if (!attempts.length) {
    for (const a of AXES) out[a] = { axis: a, n: 0, n_correct: 0, accuracy: NaN, speed: null, raw_accuracy: null, median_seconds: null };
    return out;
  }
  const overall = attempts.reduce((s, a) => s + num(a.correct), 0) / attempts.length;
  const byD = new Map();
  for (const a of attempts) {
    if (!byD.has(a.difficulty)) byD.set(a.difficulty, []);
    byD.get(a.difficulty).push(a);
  }
  const baseAcc = new Map(), baseLt = new Map();
  const correct = attempts.filter((a) => a.correct);
  const globLt = correct.length ? median(correct.map((a) => Math.log(a.seconds))) : null;
  for (const [d, xs] of byD) {
    baseAcc.set(d, overall + shrunk(xs.map((a) => num(a.correct) - overall)));
    const lts = xs.filter((a) => a.correct).map((a) => Math.log(a.seconds));
    baseLt.set(d, lts.length ? median(lts) : globLt);
  }
  for (const axis of AXES) {
    const xs = attempts.filter((a) => a.axis === axis);
    const accuracy = Math.min(1, Math.max(0, overall + shrunk(xs.map((a) => num(a.correct) - baseAcc.get(a.difficulty)))));
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
